// Start an explicitly selected local engine. A shared daemon (Docker Desktop, WSL, system Docker) is never
// stopped automatically; Colima runs FNKC's own profile, which stops itself when quiet (colima-idle.sh).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import colimaIdle from './colima-idle.sh';
import { Docker, DockerUnavailable } from '../docker.ts';
import { run, runOk, throwIfCancelled } from '../exec.ts';
import type { Logger } from '../log.ts';

export type EngineKind = 'colima' | 'docker-desktop' | 'wsl' | 'system';

export interface EngineSettings {
  /** "auto" (default) or a specific kind. */
  engine?: EngineKind | 'auto';
  /** WSL distribution with Docker Engine. */
  wslDistro?: string;
}

export const DEFAULT_WSL_DISTRO = 'fnkc';

/**
 * FNKC's own Colima profile: stopping it never stops the user's other projects, which run in the default
 * profile (or another one). Colima names its Docker context colima-<profile>.
 */
export const COLIMA_PROFILE = 'fnkc';
/** Minutes without running containers and FNKC operations after which the profile is stopped. */
export const COLIMA_IDLE_MINUTES = 10;

/** The new profile's VM: half of this computer's cores and memory (Colima's own 2 GiB is too little for R). */
export function colimaResources(cores = cpus().length, memoryBytes = totalmem()) {
  return { cpu: Math.max(2, Math.floor(cores / 2)), memory: Math.max(2, Math.floor(memoryBytes / 2 ** 30 / 2)) };
}

const commandExists = async (cmd: string, args = ['--version']) => {
  try {
    return (await run(cmd, args, { timeoutMs: 15_000 })).code === 0;
  } catch {
    return false;
  }
};

/** wsl.exe writes its own messages in UTF-16. */
/** How long the first `colima start` may take: it downloads the virtual machine image. */
const COLIMA_START_MS = 15 * 60_000;

const wslText = (s: string) => s.replace(/\0/g, '');

async function wslDistros(): Promise<string[]> {
  try {
    const r = await run('wsl', ['--list', '--quiet'], { timeoutMs: 15_000 });
    return r.code === 0 ? wslText(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function detectEngine(s: EngineSettings, platform: NodeJS.Platform = process.platform): Promise<EngineKind> {
  if (s.engine && s.engine !== 'auto') return s.engine;
  if (platform === 'win32') {
    return (await wslDistros()).includes(s.wslDistro ?? DEFAULT_WSL_DISTRO) ? 'wsl' : 'docker-desktop';
  }
  if (platform === 'darwin') return (await commandExists('colima')) ? 'colima' : 'docker-desktop';
  return 'system';
}

export class Engine {
  readonly kind: EngineKind;
  readonly distro: string;
  readonly docker: Docker;

  private readonly stateDir: string;

  constructor(kind: EngineKind, s: EngineSettings, cacheDir: string) {
    this.kind = kind;
    this.distro = s.wslDistro ?? DEFAULT_WSL_DISTRO;
    this.stateDir = join(cacheDir, 'engine');
    this.docker = new Docker(kind === 'wsl' ? ['wsl', '-d', this.distro, '--exec', 'docker'] : ['docker', '--context', kind === 'colima' ? `colima-${COLIMA_PROFILE}` : kind === 'docker-desktop' ? (process.platform === 'darwin' ? 'desktop-linux' : 'default') : 'default']);
  }

  /**
   * Marks an FNKC operation as running (an image pull runs no container) while fn runs, so the Colima profile
   * is not stopped under it. The mark is a file's modification time, renewed every 30 s.
   */
  async hold<T>(fn: () => Promise<T>): Promise<T> {
    if (this.kind !== 'colima') return fn();
    const touch = () => {
      try {
        mkdirSync(this.stateDir, { recursive: true });
        writeFileSync(join(this.stateDir, 'colima-lease'), `${process.pid}\n`);
      } catch {
        // no mark: the profile may stop during a long pull and is started again by the next operation
      }
    };
    touch();
    const timer = setInterval(touch, 30_000);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  get label(): string {
    return { colima: 'Colima', 'docker-desktop': 'Docker Desktop', wsl: `Docker in WSL (${this.distro})`, system: 'Docker' }[this.kind];
  }

  /** Makes sure Docker answers, starting the engine if it is not running. */
  async ensureRunning(log: Logger, signal?: AbortSignal): Promise<void> {
    if (this.kind !== 'wsl') {
      const context = this.docker.command.at(-1)!;
      const endpoint = await this.docker.run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']);
      if (endpoint.code === 0 && !/^(unix|npipe):\/\//.test(endpoint.stdout.trim())) throw new Error(`local engine context '${context}' points to a non-local endpoint`);
    }
    try {
      await this.docker.check();
      await this.watchColima();
      return;
    } catch (e) {
      if (!(e instanceof DockerUnavailable) || (e.reason === 'missing' && this.kind !== 'wsl')) throw e;
    }
    if (this.kind === 'system') {
      throw new Error('Docker is not running: start the docker service (sudo systemctl start docker)');
    }
    log.info(`Starting ${this.label} (takes up to a minute${this.kind === 'colima' ? '; the first start downloads a virtual machine and takes several' : ''})`);
    await this.start(log, signal);
    await this.waitUntilReady(this.kind === 'docker-desktop' ? 180 : 90, signal);
    await this.watchColima();
  }

  /** Starts colima-idle.sh for FNKC's profile unless one already runs (it outlives Positron). */
  private async watchColima() {
    if (this.kind !== 'colima') return;
    const pidFile = join(this.stateDir, 'colima-idle.pid');
    let pid = 0;
    try {
      pid = Number(readFileSync(pidFile, 'utf8').trim());
    } catch {
      // none runs
    }
    // The pid may belong to another program by now (after a restart of the computer)
    if (pid > 0 && /colima-idle\.sh/.test((await run('ps', ['-p', String(pid), '-o', 'command='])).stdout)) return;
    mkdirSync(this.stateDir, { recursive: true });
    const script = join(this.stateDir, 'colima-idle.sh');
    writeFileSync(script, colimaIdle, { mode: 0o755 });
    detached('/bin/sh', [script, COLIMA_PROFILE, `colima-${COLIMA_PROFILE}`, join(this.stateDir, 'colima-lease'), pidFile, String(COLIMA_IDLE_MINUTES)]);
  }

  private async start(log: Logger, signal?: AbortSignal): Promise<void> {
    switch (this.kind) {
      case 'colima': {
        // Sizes only a new profile: an existing one keeps what its owner set (colima edit -p fnkc)
        const list = await run('colima', ['list', '--json'], { timeoutMs: 30_000, signal });
        const exists = list.code === 0 && list.stdout.split('\n').some((l) => {
          try { return (JSON.parse(l) as { name?: string }).name === COLIMA_PROFILE; } catch { return false; }
        });
        const { cpu, memory } = colimaResources();
        // The first start downloads the virtual machine image: minutes, not the default two (killing it then leaves
        // a half-created machine that every Open would start again); its progress goes to the log, Cancel stops it
        await runOk('colima', ['start', '-p', COLIMA_PROFILE, ...(exists ? [] : ['--cpu', String(cpu), '--memory', String(memory)])],
          { timeoutMs: COLIMA_START_MS, onStderr: (l) => log.info(l), signal });
        return;
      }
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

  private async waitUntilReady(seconds: number, signal?: AbortSignal): Promise<void> {
    let last: unknown;
    for (let i = 0; i < seconds; i++) {
      throwIfCancelled(signal);
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
