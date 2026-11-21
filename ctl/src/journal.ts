// The server's record of requests: one line per agent request (serve) and per admin command in the system
// journal, tag fnkc-ctl (journalctl -t fnkc-ctl). All users share the fnkc account, so this is the only place that
// says who asked for what, when, with which client, and what came of it; the messages themselves go to the user.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Logger } from './log.ts';

export type Fields = Record<string, string | number | boolean | undefined>;

const MAX_VALUE = 1000;

/** key=value pairs, in order; a value with spaces, quotes, = or anything outside printable ASCII is JSON-quoted. */
export function formatLine(fields: Fields): string {
  return Object.entries(fields).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => {
    let s = String(v);
    if (s.length > MAX_VALUE) s = `${s.slice(0, MAX_VALUE)}…`;
    return `${k}=${/^[\x21-\x7e]+$/.test(s) && !/["=\\]/.test(s) ? s : JSON.stringify(s)}`;
  }).join(' ');
}

export type Write = (line: string, failed: boolean) => void;

/** To the system journal through logger(1); a host without one loses the line, never the request. */
export const writeSyslog: Write = (line, failed) => {
  try {
    spawnSync('logger', ['-t', 'fnkc-ctl', '-p', failed ? 'user.warning' : 'user.info', '--', line], { stdio: 'ignore', timeout: 5000 });
  } catch { /* no logger */ }
};

/** SHA256:… of an OpenSSH public key line, as sshd logs it in "Accepted publickey for fnkc … SHA256:…". */
export function keyFingerprint(line: string): string | undefined {
  const blob = line.trim().split(/\s+/)[1];
  if (!blob) return undefined;
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** The client's address from SSH_CONNECTION ("client-ip client-port server-ip server-port"). */
export function sshClient(env = process.env): string | undefined {
  return env.SSH_CONNECTION?.split(' ')[0] || undefined;
}

/** Fields of a start request worth keeping; the request itself may be anything the client sent. */
export function startFields(raw: string): Fields {
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const positron = r.positron as Record<string, unknown> | undefined;
    return {
      project: str(r.project), revision: str(r.revision), image: str(r.image),
      positron: str(positron?.version), client: str(r.client),
    };
  } catch {
    return {};
  }
}

/** One request: fields gathered while it runs, written once at the end with its duration, result and warnings. */
export class Entry {
  private readonly t0 = Date.now();
  private readonly warnings: string[] = [];
  private done = false;
  private readonly fields: Fields;
  private readonly write: Write;

  constructor(fields: Fields, write: Write = writeSyslog) {
    this.fields = { ...fields };
    this.write = write;
  }

  set(fields: Fields): void { Object.assign(this.fields, fields); }

  /** A logger that passes messages on and keeps the warnings for the line. */
  tee(log: Logger): Logger {
    return { info: (m) => log.info(m), warn: (m) => { this.warnings.push(m); log.warn(m); } };
  }

  /** Writes the line (only the first call does). */
  end(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    const failed = error !== undefined;
    this.write(formatLine({
      ...this.fields,
      ms: Date.now() - this.t0,
      result: failed ? 'error' : 'ok',
      error: failed ? (error instanceof Error ? error.message : String(error)) : undefined,
      warnings: this.warnings.length ? this.warnings.join(' | ') : undefined,
    }), failed);
  }
}
