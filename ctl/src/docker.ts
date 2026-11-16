// The docker CLI of the host the agent runs on.
import { run, runOk, type RunOptions } from './exec.ts';

/** The parts of `docker container inspect` that are used here. */
export interface ContainerJson {
  Name: string;
  Config: { Image: string; Env: string[] | null; Labels: Record<string, string> | null };
  State: { Running: boolean; Status: string };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null };
}

export interface ImageJson {
  Architecture: string;
}

export class Docker {
  readonly bin: string;
  constructor(bin = 'docker') {
    this.bin = bin;
  }

  run(args: string[], opts?: RunOptions) {
    return run(this.bin, args, opts);
  }

  ok(args: string[], opts?: RunOptions) {
    return runOk(this.bin, args, opts);
  }

  async available(): Promise<boolean> {
    try {
      return (await this.run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 })).code === 0;
    } catch {
      return false;
    }
  }

  async container(name: string): Promise<ContainerJson | null> {
    const r = await this.run(['container', 'inspect', name]);
    return r.code === 0 ? (JSON.parse(r.stdout) as ContainerJson[])[0] ?? null : null;
  }

  async image(name: string): Promise<ImageJson | null> {
    const r = await this.run(['image', 'inspect', name]);
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
