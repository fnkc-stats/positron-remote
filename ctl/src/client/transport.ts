// How the client reaches a host's agent: in-process for Docker on this computer, over SSH for a server.
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { userInfo } from 'node:os';
import { Agent } from '../agent.ts';
import { agentConfig } from '../agent-config.ts';
import { hostError, UnknownCommand } from '../errors.ts';
import { run, throwIfCancelled } from '../exec.ts';
import type { Logger } from '../log.ts';
import { CheckoutPinsOther, EnvironmentImageMissing } from '../image-store.ts';
import { type BusyProcess, type CheckoutState, type ContainerInfo, requireCompatible, type HostImage, type ImageMissing, type PingResult, type RemovalCheck, type Reply, type StartRequest, type StartResult, type StopResult, CTL_VERSION } from '../protocol.ts';
import { sanitizeUser } from '../validate.ts';
import type { ClientConfig, HostConfig } from './config.ts';
import { detectEngine, Engine } from './engine.ts';
import { type ImageUpload, uploadStream } from './image-download.ts';
import { parseSshTarget, type SshTarget } from './ssh.ts';

export interface Transport {
  readonly host: HostConfig;
  /** The server to jump through to reach containers; none for this computer. */
  readonly jump?: SshTarget;
  /** Cancels the host calls in progress (Open's cancel button); an operation the host has begun finishes or rolls back there. */
  signal?: AbortSignal;
  requiresProvenance?: boolean;
  /** What the host answered to the last ping (optional capabilities such as checkout-query-v1). */
  capabilities?: string[];
  ping(): Promise<PingResult>;
  start(req: StartRequest): Promise<StartResult>;
  /** With `repository`: only the container of that repository (hosts with qualified-stop-v1; see QualifiedStopUnsupported). */
  stop(project: string, repository?: string): Promise<StopResult>;
  /** What still computes in the running project. */
  busy(project: string): Promise<BusyProcess[]>;
  /** 3 more days without a window before the host stops it. */
  keep(project: string): Promise<{ until: string }>;
  list(): Promise<ContainerInfo[]>;
  /** The project's container and its checkout's pin, read-only (agent checkout; hosts with checkout-query-v1). */
  checkout(project: string): Promise<CheckoutState>;
  /** The environment images the host has (Images panel). */
  images(): Promise<HostImage[]>;
  /** What deleting the stopped project would lose, and the fingerprint that remove needs. */
  removalCheck(project: string): Promise<RemovalCheck>;
  /** Deletes the project's container, volumes and network, if it is still as the check with this fingerprint saw it. */
  remove(project: string, fingerprint: string): Promise<{ removed: string[] }>;
  /** Sends an environment image (blobs in this computer's cache) that start reported missing. */
  installImage(m: ImageMissing, u: ImageUpload): Promise<unknown>;
}

export class LocalTransport implements Transport {
  readonly host: HostConfig;
  readonly jump = undefined;
  /** Checked between agent operations; Docker commands this computer has begun run to their end. */
  signal?: AbortSignal;
  requiresProvenance?: boolean;
  capabilities?: string[];
  private readonly cfg: ClientConfig;
  private readonly log: Logger;
  private ready?: Promise<{ engine: Engine; agent: Agent }>;

  constructor(host: HostConfig, cfg: ClientConfig, log: Logger) {
    this.host = host;
    this.cfg = cfg;
    this.log = log;
  }

  /** Which Docker this computer has (Colima, Docker Desktop, WSL, ...) and an agent that uses it. */
  private setup() {
    this.ready ??= (async () => {
      const engine = new Engine(await detectEngine(this.cfg.engine), this.cfg.engine, this.cfg.cacheDir);
      // This computer usually reaches the registry, so it pulls images instead of loading them from its own cache
      const settings = { idleMinutes: LOCAL_IDLE_MINUTES, pullImages: true, ...this.cfg.local, docker: engine.docker.command };
      return { engine, agent: new Agent(agentConfig(sanitizeUser(userInfo().username), settings), this.log) };
    })();
    return this.ready;
  }

  /** Starts Docker if it is not running: ping is only called when a project is about to run here. */
  async ping() {
    const { engine, agent } = await this.setup();
    await engine.ensureRunning(this.log, this.signal);
    const p = agent.ping();
    this.requiresProvenance = p.requiresProvenance;
    this.capabilities = p.capabilities;
    return p;
  }

  async start(req: StartRequest) {
    throwIfCancelled(this.signal);
    return (await this.setup()).agent.start(req);
  }

  async stop(project: string, repository?: string) {
    return (await this.setup()).agent.stop(project, repository);
  }

  async list() {
    return (await this.setup()).agent.list();
  }

  async checkout(project: string) {
    throwIfCancelled(this.signal);
    return (await this.setup()).agent.checkout(project);
  }

  async busy(project: string) {
    return (await this.setup()).agent.busy(project);
  }

  async keep(project: string) {
    return (await this.setup()).agent.keep(project);
  }

  async images() {
    return (await this.setup()).agent.images();
  }

  async removalCheck(project: string) {
    return (await this.setup()).agent.removalCheck(project);
  }

  async remove(project: string, fingerprint: string) {
    return (await this.setup()).agent.remove(project, fingerprint);
  }

  /**
   * Calls onChange when a project container of this user starts, stops or is removed here (idle stop, docker
   * stop, a crash, Docker quitting). Never starts Docker: while it is not running, it waits for it.
   */
  watch(onChange: () => void): { dispose(): void } {
    let watcher: { dispose(): void } | undefined;
    let disposed = false;
    this.setup().then(({ agent }) => {
      if (!disposed) watcher = agent.watchContainers(onChange);
    }, (e: Error) => this.log.warn(`cannot follow this computer's containers: ${e.message}`));
    return { dispose: () => { disposed = true; watcher?.dispose(); } };
  }

  /** Only here: a server's images are the administrator's to remove (removalCommand). */
  async removeImage(id: string) {
    return (await this.setup()).agent.removeImage(id);
  }

  async installImage(m: ImageMissing, u: ImageUpload) {
    throwIfCancelled(this.signal);
    return (await this.setup()).agent.installImage(m.image, uploadStream(this.cfg.cacheDir, u));
  }
}

export const LOCAL_IDLE_MINUTES = 0;

export class SshTransport implements Transport {
  readonly host: HostConfig;
  readonly jump: SshTarget;
  signal?: AbortSignal;
  requiresProvenance?: boolean;
  capabilities?: string[];
  readonly identity?: string;
  readonly log: Logger;
  private readonly cacheDir: string;

  constructor(host: HostConfig, cfg: ClientConfig, log: Logger) {
    this.host = host;
    this.cacheDir = cfg.cacheDir;
    this.jump = parseSshTarget(host.ssh!);
    this.identity = cfg.sshKey;
    this.log = log;
  }

  private async call<T>(words: string[], input?: string | Readable, timeout = 10, pinged = false): Promise<T> {
    if (!pinged && ['start', 'stop', 'remove-check', 'remove', 'install-image'].includes(words[0])) await this.ping();
    const args = [
      '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`, '-o', 'StrictHostKeyChecking=yes',
      // A quiet connection (a start or an upload waiting for its turn on the host) is kept alive through NAT
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4',
      ...(this.jump.port ? ['-p', this.jump.port] : []),
      ...(this.identity && existsSync(this.identity) ? ['-i', this.identity] : []),
      this.jump.dest, 'fnkc-ctl', 'agent', ...words,
    ];
    // The agent's progress messages ("==> ..." / "Warning: ...") are passed on as they arrive
    const r = await run('ssh', args, {
      input, signal: this.signal, timeoutMs: words[0] === 'install-image' ? 4 * 3600_000 : words[0] === 'start' ? 30 * 60_000 : words[0] === 'stop' || words[0].startsWith('remove') ? 10 * 60_000 : 30_000,
      onStderr: (line) => {
        const m = /^(==>|Warning:)\s*(.*)$/.exec(line);
        if (m?.[1] === '==>') this.log.info(`[${this.host.name}] ${m[2]}`);
        else if (m) this.log.warn(`[${this.host.name}] ${m[2]}`);
      },
    });
    const last = r.stdout.trim().split('\n').pop() ?? '';
    let reply: Reply<T>;
    try {
      reply = JSON.parse(last) as Reply<T>;
    } catch {
      const why = r.stderr.trim().split('\n').filter((l) => !/^(==>|Warning:)/.test(l)).pop();
      throw new Error(`host '${this.host.name}' (${this.host.ssh}): ${why || `no answer from fnkc-ctl (exit code ${r.code})`}`);
    }
    if (!reply.ok && reply.imageMissing) throw new EnvironmentImageMissing(reply.imageMissing);
    if (!reply.ok && reply.checkoutPins) throw new CheckoutPinsOther(reply.checkoutPins);
    if (!reply.ok) throw hostError(`host '${this.host.name}': ${reply.error}`, reply.code, reply.error);
    return reply.result;
  }

  async ping() {
    const p = await this.info();
    requireCompatible(p);
    this.requiresProvenance = p.requiresProvenance;
    this.capabilities = p.capabilities;
    return p;
  }
  /** What the host runs (version, protocol, capabilities), whether or not this client can work with it. */
  info() { return this.call<PingResult>(['ping']); }
  // client: this build's version, for the server's journal (older servers ignore it)
  start(req: StartRequest) { return this.call<StartResult>(['start'], JSON.stringify({ ...req, client: CTL_VERSION })); }
  async stop(project: string, repository?: string) {
    if (repository === undefined) return this.call<StopResult>(['stop', project]);
    await this.ping();
    if (!this.capabilities?.includes(QUALIFIED_STOP)) throw new QualifiedStopUnsupported(this.host.name);
    return this.call<StopResult>(['stop', project, repository], undefined, 10, true);
  }
  list() { return this.call<ContainerInfo[]>(['list']); }
  busy(project: string) { return this.call<BusyProcess[]>(['busy', project], undefined, 10); }
  checkout(project: string) { return this.call<CheckoutState>(['checkout', project], undefined, 10); }
  keep(project: string) { return this.call<{ until: string }>(['keep', project]); }
  async images() {
    try {
      return await this.call<HostImage[]>(['images']);
    } catch (e) {
      if (e instanceof UnknownCommand) throw new OlderHost(this.host.name);
      throw e;
    }
  }
  async removalCheck(project: string) {
    try {
      return await this.call<RemovalCheck>(['remove-check', project], undefined, 10);
    } catch (e) {
      if (e instanceof UnknownCommand) {
        throw new Error(`'${this.host.name}' runs an older fnkc-ctl that cannot delete projects; this works after the server update`);
      }
      throw e;
    }
  }
  remove(project: string, fingerprint: string) { return this.call<{ removed: string[] }>(['remove', project, fingerprint]); }
  installImage(m: ImageMissing, u: ImageUpload) {
    this.log.info(`Sending the environment image to '${this.host.name}' (${Math.round(u.size / 1e6)} MB, once per image)`);
    return this.call(['install-image', m.image], uploadStream(this.cacheDir, u));
  }
}

/** Optional capability: the host's agent stop takes a repository and stops only that repository's container. */
export const QUALIFIED_STOP = 'qualified-stop-v1';

/** The host's fnkc-ctl cannot check which repository a container belongs to: a qualified stop is not sent to it. */
export class QualifiedStopUnsupported extends Error {
  constructor(host: string) {
    super(`'${host}' runs an older fnkc-ctl that cannot check which repository its container belongs to: nothing was ` +
      'stopped there. Stop it by the project name alone with --host, or after the server update');
  }
}

/** The host runs an fnkc-ctl from before agent images: it still opens projects, but cannot list its images. */
export class OlderHost extends Error {
  constructor(host: string) {
    super(`'${host}' runs an older fnkc-ctl that cannot list its images; they appear here after the server update`);
  }
}

export function transportFor(host: HostConfig, cfg: ClientConfig, log: Logger): Transport {
  return host.ssh ? new SshTransport(host, cfg, log) : new LocalTransport(host, cfg, log);
}
