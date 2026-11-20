// Running external commands (docker, ssh, git) without a shell: arguments are passed as they are.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Apps started from the Dock or the Start menu get a short PATH without Homebrew or Docker's own folder,
 * so the usual install locations of docker, git and git-crypt are added (missing ones only, at the end).
 */
export function extendPath(): void {
  const extra =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Docker.app/Contents/Resources/bin']
      : process.platform === 'win32'
        ? [`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Docker\\Docker\\resources\\bin`,
           `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\cmd`,
           `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\GnuPG\\bin`,
           `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\GitHub CLI`]
        : ['/usr/local/bin', '/snap/bin'];
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  process.env.PATH = parts.join(delimiter);
}

export interface RunOptions {
  /** Data for the command's stdin; a stream is piped, and its errors kill the command. */
  input?: string | Buffer | Readable;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Stream stdout into SHA-256 instead of retaining it (large Docker exports). */
  hashStdout?: boolean;
  /** Called for every line the command writes to stderr, as it arrives. */
  onStderr?: (line: string) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout as it was written, for binary output (set by run). */
  stdoutBytes?: Buffer;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, windowsHide: true, detached: process.platform !== 'win32' });
    const out: Buffer[] = [];
    const hash = opts.hashStdout ? createHash('sha256') : undefined;
    const err: Buffer[] = [];
    let partial = '';
    let failed: Error | undefined;
    let bytes = 0;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process already exited */ }
    };
    const abort = (message: string) => {
      if (failed) return;
      failed = new Error(message);
      kill('SIGTERM');
      killer = setTimeout(() => kill('SIGKILL'), 1000);
      if (opts.input && typeof opts.input !== 'string' && !Buffer.isBuffer(opts.input)) opts.input.destroy();
    };
    const bounded = (d: Buffer) => {
      bytes += d.length;
      if (bytes > 8 * 1024 * 1024) { abort(`${cmd}: output exceeded 8 MiB`); return false; }
      return true;
    };

    child.stdout.on('data', (d: Buffer) => { if (hash) hash.update(d); else if (bounded(d)) out.push(d); });
    child.stderr.on('data', (d: Buffer) => {
      if (!bounded(d)) return;
      err.push(d);
      if (!opts.onStderr) return;
      partial += d.toString();
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l) opts.onStderr(l);
    });

    const timer = setTimeout(() => abort(`${cmd}: operation timed out`), opts.timeoutMs ?? 120_000);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer); clearTimeout(killer);
      reject(e.code === 'ENOENT' ? new Error(`command not found: ${cmd}`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killer);
      if (partial && opts.onStderr) opts.onStderr(partial);
      if (failed) return reject(failed);
      const bytes = Buffer.concat(out);
      resolve({ code: code ?? -1, stdout: hash ? hash.digest('hex') : bytes.toString(), stderr: Buffer.concat(err).toString(), stdoutBytes: bytes });
    });

    // The command may exit before reading all of its input (EPIPE): its exit code tells what happened
    child.stdin.on('error', () => {});
    const input = opts.input;
    if (input === undefined) child.stdin.end();
    else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
    else {
      input.on('error', (e) => abort(e.message));
      input.pipe(child.stdin);
    }
  });
}

/** Like run, but fails unless the command exits with 0; returns stdout. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const what = [cmd, ...args.slice(0, 2)].join(' ');
    throw new Error(`${what}: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
  return r.stdout;
}
