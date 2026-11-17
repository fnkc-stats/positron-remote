// The docker CLI of the host the agent runs on.
import { run, runOk, type RunOptions } from './exec.ts';

/** The parts of `docker container inspect` that are used here. */
export interface ContainerJson {
  Name: string;
  Config: { Image: string; Env: string[] | null; Labels: Record<string, string> | null };
  State: { Running: boolean; Status: string };
  HostConfig?: { Memory: number };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null };
}

export interface ImageJson {
  Id: string;
  Architecture: string;
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

  /** Throws DockerUnavailable if Docker cannot be used. */
  async check(): Promise<void> {
    let r;
    try {
      r = await this.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
    } catch {
      throw new DockerUnavailable('missing',
        `the '${this.command[0]}' command was not found: install Docker Desktop, or Colima with the docker CLI`);
    }
    if (r.code !== 0) {
      const why = r.stderr.replace(/\0/g, '').trim().split('\n').pop() ?? '';
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

  /** All containers (running or not) matching the label filters. */
  async containers(labels: string[]): Promise<ContainerJson[]> {
    const filters = labels.flatMap((l) => ['--filter', `label=${l}`]);
    const ids = (await this.ok(['ps', '-aq', ...filters])).split(/\s+/).filter(Boolean);
    if (!ids.length) return [];
    return JSON.parse(await this.ok(['container', 'inspect', ...ids])) as ContainerJson[];
  }
}

export function sshPortOf(c: ContainerJson): number | undefined {
  const b = c.NetworkSettings.Ports?.['22/tcp']?.[0];
  return b ? Number(b.HostPort) : undefined;
}
