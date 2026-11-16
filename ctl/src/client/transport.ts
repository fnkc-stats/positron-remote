// How the client reaches a host's agent: in-process for Docker on this computer, over SSH for a server.
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Agent } from '../agent.ts';
import { agentConfig } from '../agent-config.ts';
import { run } from '../exec.ts';
import type { Logger } from '../log.ts';
import type { ContainerInfo, PingResult, Reply, StartRequest, StartResult } from '../protocol.ts';
import { sanitizeUser } from '../validate.ts';
import type { ClientConfig, HostConfig } from './config.ts';
import { detectEngine, Engine } from './engine.ts';
import { parseSshTarget, type SshTarget } from './ssh.ts';

export interface Transport {
  readonly host: HostConfig;
  /** The server to jump through to reach containers; none for this computer. */
  readonly jump?: SshTarget;
  ping(): Promise<PingResult>;
  start(req: StartRequest): Promise<StartResult>;
  stop(project: string): Promise<{ stopped: boolean }>;
  list(): Promise<ContainerInfo[]>;
}

export class LocalTransport implements Transport {
  readonly host: HostConfig;
  readonly jump = undefined;
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
      const settings = { ...this.cfg.local, docker: engine.docker.command };
      return { engine, agent: new Agent(agentConfig(sanitizeUser(userInfo().username), settings), this.log) };
    })();
    return this.ready;
  }

  /** Starts Docker if it is not running: ping is only called when a project is about to run here. */
  async ping() {
    const { engine, agent } = await this.setup();
    await engine.ensureRunning(this.log);
    return agent.ping();
  }

  async start(req: StartRequest) {
    return (await this.setup()).agent.start(req);
  }

  async stop(project: string) {
    const { engine, agent } = await this.setup();
    const r = await agent.stop(project);
    if (r.stopped) {
      // Any running container counts, not only projects: Docker may be in use for something else
      const running = (await agent.docker.ok(['ps', '-q'])).split(/\s+/).filter(Boolean).length;
      await engine.stopIfIdle(running, this.log);
    }
    return r;
  }

  async list() {
    return (await this.setup()).agent.list();
  }
}

export class SshTransport implements Transport {
  readonly host: HostConfig;
  readonly jump: SshTarget;
  readonly identity?: string;
  readonly log: Logger;

  constructor(host: HostConfig, cfg: ClientConfig, log: Logger) {
    this.host = host;
    this.jump = parseSshTarget(host.ssh!);
    this.identity = cfg.sshKey;
    this.log = log;
  }

  private async call<T>(words: string[], input?: string, timeout = 10): Promise<T> {
    const args = [
      '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`, '-o', 'StrictHostKeyChecking=accept-new',
      ...(this.jump.port ? ['-p', this.jump.port] : []),
      ...(this.identity && existsSync(this.identity) ? ['-i', this.identity] : []),
      this.jump.dest, 'positron-ctl', 'agent', ...words,
    ];
    // The agent's progress messages ("==> ..." / "Warning: ...") are passed on as they arrive
    const r = await run('ssh', args, {
      input,
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
      throw new Error(`host '${this.host.name}' (${this.host.ssh}): ${why || `no answer from positron-ctl (exit code ${r.code})`}`);
    }
    if (!reply.ok) throw new Error(`host '${this.host.name}': ${reply.error}`);
    return reply.result;
  }

  ping() { return this.call<PingResult>(['ping']); }
  start(req: StartRequest) { return this.call<StartResult>(['start'], JSON.stringify(req)); }
  stop(project: string) { return this.call<{ stopped: boolean }>(['stop', project]); }
  list() { return this.call<ContainerInfo[]>(['list']); }
}

export function transportFor(host: HostConfig, cfg: ClientConfig, log: Logger): Transport {
  return host.ssh ? new SshTransport(host, cfg, log) : new LocalTransport(host, cfg, log);
}
