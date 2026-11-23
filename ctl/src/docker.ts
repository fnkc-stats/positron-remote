// The docker CLI of the host the agent runs on.
import { spawn } from 'node:child_process';
import { run, runOk, type RunOptions } from './exec.ts';

/** The parts of `docker container inspect` that are used here. */
export interface ContainerJson {
  Name: string;
  /** ID of the container's image (sha256:...). */
  Image?: string;
  Config: { Image: string; Env: string[] | null; Labels: Record<string, string> | null };
  /** StartedAt: the last start (ISO 8601; 0001-01-01… if it never started). */
  State: { Running: boolean; Status: string; StartedAt?: string };
  HostConfig?: { Memory: number };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null };
}

/**
 * The pinned image a project container runs (its FNKC_IMAGE_DIGEST), else Docker's name for it: containers are
 * created from the immutable image ID, older ones from the reference or an uploaded image's tag.
 */
export const pinnedImageOf = (c: ContainerJson): string =>
  c.Config.Env?.find((v) => v.startsWith('FNKC_IMAGE_DIGEST='))?.slice('FNKC_IMAGE_DIGEST='.length) ?? c.Config.Image;

export interface ImageJson {
  Id: string;
  Architecture: string;
  /** The image's run settings (its config's `config` section): Labels and, among others, User, Env, Entrypoint, Cmd. */
  Config?: { Labels: Record<string, string> | null; [field: string]: unknown };
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  /** Unpacked size in bytes. */
  Size?: number;
  Created?: string;
  /** The uncompressed layers (diff IDs), in order. */
  RootFS?: { Layers?: string[] | null };
}

/** Docker can't be used: no docker command ("missing"), or the daemon does not answer ("stopped"). */
export class DockerUnavailable extends Error {
  readonly reason: 'missing' | 'stopped';
  constructor(reason: 'missing' | 'stopped', message: string) {
    super(message);
    this.reason = reason;
  }
}

export class Docker {
  /** The docker command, possibly with a prefix: ["docker"], or ["wsl", "-d", "fnkc", "--exec", "docker"]. */
  readonly command: string[];
  constructor(command: string[] = ['docker']) {
    this.command = command;
  }

  run(args: string[], opts?: RunOptions) {
    return run(this.command[0], [...this.command.slice(1), ...args], { ...opts, env: this.environment(opts) });
  }

  ok(args: string[], opts?: RunOptions) {
    return runOk(this.command[0], [...this.command.slice(1), ...args], { ...opts, env: this.environment(opts) });
  }

  private environment(opts?: RunOptions): NodeJS.ProcessEnv {
    const env = { ...process.env, ...opts?.env };
    if (this.command.includes('--context')) {
      delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT;
    }
    return env;
  }

  /**
   * Calls onEvent for each container start / stop / removal (matching the label filters) as Docker reports it.
   * The stream ends when Docker stops or is not running; it is started again every retryMs until disposed,
   * and onEvent is also called when it starts again, since anything may have changed meanwhile.
   */
  watchContainers(labels: string[], onEvent: () => void, retryMs = 30_000): { dispose(): void } {
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let disposed = false;
    /** The last stream ended (Docker stopped or was not running): the next one that lasts reports a change. */
    let down = false;
    const args = [...this.command.slice(1), 'events', '--format', '{{.Action}}', '--filter', 'type=container',
      ...['start', 'die', 'destroy'].flatMap((e) => ['--filter', `event=${e}`]),
      ...labels.flatMap((l) => ['--filter', `label=${l}`])];
    const begin = () => {
      if (disposed) return;
      const started = Date.now();
      child = spawn(this.command[0], args, { env: this.environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const lasting = setTimeout(() => { if (down) { down = false; onEvent(); } }, 5_000);
      child.stdout?.on('data', () => onEvent());
      child.on('error', () => {});
      child.on('close', () => {
        clearTimeout(lasting);
        child = undefined;
        if (disposed) return;
        if (!down && Date.now() - started >= 5_000) onEvent();
        down = true;
        timer = setTimeout(begin, retryMs);
      });
    };
    begin();
    return {
      dispose: () => {
        disposed = true;
        clearTimeout(timer);
        child?.kill();
      },
    };
  }

  /** Throws DockerUnavailable if Docker cannot be used. */
  async check(): Promise<void> {
    let r;
    try {
      r = await this.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
    } catch (e) {
      // Only a missing command is "missing"; a daemon that does not answer in time is installed but not usable
      if (!/command not found|ENOENT/.test((e as Error).message)) {
        throw new DockerUnavailable('stopped', `Docker is not running on this computer (it did not answer in time)`);
      }
      throw new DockerUnavailable('missing',
        `the '${this.command[0]}' command was not found: install Docker Desktop, or Colima with the docker CLI`);
    }
    // Newer docker CLIs exit 0 with an empty server version when the daemon does not answer: that is not running
    if (r.code !== 0 || !r.stdout.trim()) {
      // The line that says why: "permission denied" (not in the docker group) may be followed by others
      const lines = r.stderr.replace(/\0/g, '').trim().split('\n');
      const why = lines.find((l) => /permission denied/i.test(l)) ?? (lines.pop() || 'the Docker daemon does not answer');
      throw new DockerUnavailable('stopped', `Docker is not running on this computer (${why})`);
    }
  }

  async container(name: string): Promise<ContainerJson | null> {
    const r = await this.run(['container', 'inspect', name]);
    if (r.code !== 0 && !/no such (object|container)/i.test(r.stderr)) throw new Error(`cannot inspect container: ${r.stderr}`);
    return r.code === 0 ? (JSON.parse(r.stdout) as ContainerJson[])[0] ?? null : null;
  }

  async image(name: string): Promise<ImageJson | null> {
    const r = await this.run(['image', 'inspect', name]);
    if (r.code !== 0 && !/no such (object|image)/i.test(r.stderr)) throw new Error(`cannot inspect image: ${r.stderr}`);
    return r.code === 0 ? (JSON.parse(r.stdout) as ImageJson[])[0] ?? null : null;
  }

  /** Every image on this Docker host (inspected, each once). */
  async images(): Promise<ImageJson[]> {
    const ids = [...new Set((await this.ok(['image', 'ls', '-q', '--no-trunc'])).split(/\s+/).filter(Boolean))];
    const all: ImageJson[] = [];
    for (let i = 0; i < ids.length; i += 200) all.push(...await this.inspectAll<ImageJson>('image', ids.slice(i, i + 200)));
    return all;
  }

  /** All containers (running or not) matching the label filters. */
  async containers(labels: string[]): Promise<ContainerJson[]> {
    const filters = labels.flatMap((l) => ['--filter', `label=${l}`]);
    const ids = (await this.ok(['ps', '-aq', ...filters])).split(/\s+/).filter(Boolean);
    return this.inspectAll<ContainerJson>('container', ids);
  }

  /**
   * Inspects objects that were listed a moment ago. Some may be gone by now (the --rm helper containers of other
   * users' starts, images or volumes removed meanwhile): Docker then prints the others and fails, and those are skipped.
   */
  async inspectAll<T>(kind: 'container' | 'image' | 'volume', ids: string[]): Promise<T[]> {
    if (!ids.length) return [];
    const r = await this.run([kind, 'inspect', ...ids]);
    if (r.code !== 0 && !onlyMissing(r.stderr)) throw new Error(`cannot inspect ${kind}s: ${r.stderr.trim()}`);
    const out = r.stdout.trim();
    return out ? (JSON.parse(out) as T[]) : [];
  }
}

/** Docker's error output names only objects that do not exist (and it reported something). */
export function onlyMissing(stderr: string): boolean {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /no such (object|container|image|volume)/i.test(l));
}

export function sshPortOf(c: ContainerJson): number | undefined {
  const b = c.NetworkSettings.Ports?.['22/tcp']?.[0];
  return b ? Number(b.HostPort) : undefined;
}
