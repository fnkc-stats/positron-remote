// Start an explicitly selected local engine; its shared daemon is never stopped automatically.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Docker, DockerUnavailable } from '../docker.ts';
import { run, runOk } from '../exec.ts';
import type { Logger } from '../log.ts';

export type EngineKind = 'colima' | 'docker-desktop' | 'wsl' | 'system';

export interface EngineSettings {
  /** "auto" (default) or a specific kind. */
  engine?: EngineKind | 'auto';
  /** WSL distribution with Docker Engine. */
  wslDistro?: string;
}

export const DEFAULT_WSL_DISTRO = 'fnkc';

const commandExists = async (cmd: string, args = ['--version']) => {
  try {
    return (await run(cmd, args, { timeoutMs: 15_000 })).code === 0;
  } catch {
    return false;
  }
};

/** wsl.exe writes its own messages in UTF-16. */
const wslText = (s: string) => s.replace(/\0/g, '');

async function wslDistros(): Promise<string[]> {
  try {
    const r = await run('wsl', ['--list', '--quiet'], { timeoutMs: 15_000 });
    return r.code === 0 ? wslText(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function detectEngine(s: EngineSettings): Promise<EngineKind> {
  if (s.engine && s.engine !== 'auto') return s.engine;
  if (process.platform === 'win32') {
    return (await wslDistros()).includes(s.wslDistro ?? DEFAULT_WSL_DISTRO) ? 'wsl' : 'docker-desktop';
  }
  if (process.platform === 'darwin') return (await commandExists('colima')) ? 'colima' : 'docker-desktop';
  return 'system';
}

export class Engine {
  readonly kind: EngineKind;
  readonly distro: string;
  readonly docker: Docker;

  constructor(kind: EngineKind, s: EngineSettings, _cacheDir: string) {
    this.kind = kind;
    this.distro = s.wslDistro ?? DEFAULT_WSL_DISTRO;
    this.docker = new Docker(kind === 'wsl' ? ['wsl', '-d', this.distro, '--exec', 'docker'] : ['docker', '--context', kind === 'colima' ? 'colima' : kind === 'docker-desktop' ? (process.platform === 'darwin' ? 'desktop-linux' : 'default') : 'default']);
  }

  get label(): string {
    return { colima: 'Colima', 'docker-desktop': 'Docker Desktop', wsl: `Docker in WSL (${this.distro})`, system: 'Docker' }[this.kind];
  }

  /** Makes sure Docker answers, starting the engine if it is not running. */
  async ensureRunning(log: Logger): Promise<void> {
    if (this.kind !== 'wsl') {
      const context = this.docker.command.at(-1)!;
      const endpoint = await this.docker.run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']);
      if (endpoint.code === 0 && !/^(unix|npipe):\/\//.test(endpoint.stdout.trim())) throw new Error(`local engine context '${context}' points to a non-local endpoint`);
    }
    try {
      await this.docker.check();
      return;
    } catch (e) {
      if (!(e instanceof DockerUnavailable) || (e.reason === 'missing' && this.kind !== 'wsl')) throw e;
    }
    if (this.kind === 'system') {
      throw new Error('Docker is not running: start the docker service (sudo systemctl start docker)');
    }
    log.info(`Starting ${this.label} (takes up to a minute)`);
    await this.start();
    await this.waitUntilReady(this.kind === 'docker-desktop' ? 180 : 90);
  }

  private async start(): Promise<void> {
    switch (this.kind) {
      case 'colima':
        await runOk('colima', ['start']);
        return;
      case 'docker-desktop':
        if (process.platform === 'darwin') await runOk('open', ['-a', 'Docker']);
        else detached(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'), []);
        return;
      case 'wsl':
        if (!(await wslDistros()).includes(this.distro)) {
          throw new Error(`the WSL distribution '${this.distro}' is not installed: run the one-time setup (windows/setup-wsl.ps1)`);
        }
        // The running wsl.exe keeps the distribution alive; dockerd's own output goes to a log inside it
        detached('wsl', ['-d', this.distro, '-u', 'root', '--exec', 'sh', '-c', 'exec dockerd > /var/log/dockerd.log 2>&1']);
        return;
      case 'system':
        return;
    }
  }

  private async waitUntilReady(seconds: number): Promise<void> {
    let last: unknown;
    for (let i = 0; i < seconds; i++) {
      try {
        await this.docker.check();
        return;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`${this.label} did not start within ${seconds} s: ${(last as Error).message}`);
  }
}

/** Starts a long-running program that outlives this process (and the extension host). */
function detached(cmd: string, args: string[]) {
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
