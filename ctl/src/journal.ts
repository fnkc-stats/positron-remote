// The server's record of requests: one line per agent request (serve) and per admin command in the system
// journal, tag fnkc-ctl (journalctl -t fnkc-ctl). All users share the fnkc account, so this is the only place that
// says who asked for what, when, with which client, and what came of it; the messages themselves go to the user.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CodedError, hostError } from './errors.ts';
import type { Logger } from './log.ts';
import { CTL_VERSION } from './protocol.ts';

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
      code: error instanceof CodedError ? error.code : undefined,
      error: failed ? (error instanceof Error ? error.message : String(error)) : undefined,
      warnings: this.warnings.length ? this.warnings.join(' | ') : undefined,
      ctl: CTL_VERSION,
    }), failed);
  }
}

/** The fields of a line formatLine wrote; undefined for a line it did not write (another program's, a cut one). */
export function parseLine(line: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const re = /([A-Za-z][\w-]*)=("(?:[^"\\]|\\.)*"|[^\s"]+)(?: |$)/y;
  while (re.lastIndex < line.length) {
    const m = re.exec(line);
    if (!m) return undefined;
    try { out[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) as string : m[2]; } catch { return undefined; }
  }
  return Object.keys(out).length ? out : undefined;
}

export type JournalRecord = { time?: string; line: string };

// A support export (admin support-export) keeps only what says how a request went: no user, address, project,
// revision, image, key or message text, which the raw journal has. An allow-list, so a field added later stays out.
// Values are checked too: `command` is whatever a client sent, and the versions come from the client.
const COMMAND = /^[a-z][a-z-]{0,39}$/;
const VERSION = /^[\w.+-]{1,64}$/;
const SUPPORT: Record<string, RegExp> = {
  command: COMMAND, result: /^(ok|error)$/, ms: /^\d{1,12}$/, client: VERSION, positron: VERSION, ctl: VERSION,
  created: /^(true|false)$/, updatePending: /^(true|false)$/, lostWork: /^(true|false)$/,
};

/** What went wrong as a class (errors.ts), never as the message; lines from before `code` are classified by wording. */
export function errorCategory(f: Record<string, string>): string | undefined {
  if (f.result !== 'error') return undefined;
  if (f.code && COMMAND.test(f.code)) return f.code;
  const e = hostError(f.error ?? '');
  return e instanceof CodedError ? e.code : 'other';
}

/** One journal line for a support ticket; `identifiers` keeps every field (the raw line: review it before sharing). */
export function supportRecord(r: JournalRecord, identifiers = false): Fields | undefined {
  const f = parseLine(r.line);
  if (!f) return undefined;
  const out: Fields = { time: r.time };
  if (identifiers) return Object.assign(out, f, { category: errorCategory(f) });
  for (const [k, ok] of Object.entries(SUPPORT)) if (f[k] !== undefined && ok.test(f[k])) out[k] = f[k];
  if (out.command === undefined && f.command !== undefined) out.command = 'other';
  out.category = errorCategory(f);
  if (f.warnings) out.warnings = f.warnings.split(' | ').length;
  return out;
}

export type SupportExport = { ctl: string; node: string; since: string; identifiers: boolean; skipped: number; requests: Fields[] };

export function supportExport(records: JournalRecord[], since: string, identifiers = false): SupportExport {
  const requests: Fields[] = [];
  let skipped = 0;
  for (const r of records) {
    const s = supportRecord(r, identifiers);
    if (s) requests.push(s); else skipped++;
  }
  return { ctl: CTL_VERSION, node: process.version, since, identifiers, skipped, requests };
}

export function formatSupportExport(x: SupportExport): string {
  const head = `# fnkc-ctl support export: fnkc-ctl ${x.ctl}, node ${x.node}, since ${x.since}; ${x.requests.length} request(s)` +
    `${x.skipped ? `, ${x.skipped} line(s) of another format left out` : ''}; ` +
    `${x.identifiers ? 'WITH users, addresses, projects and messages: review before sharing' : 'users, addresses, projects, images and messages omitted'}\n`;
  return head + x.requests.map((r) => `${formatLine(r)}\n`).join('');
}

type Run = (cmd: string, args: string[], opts: { encoding: 'utf8'; maxBuffer: number; timeout: number }) =>
  { status: number | null; stdout: string; stderr: string; error?: Error };

/** The fnkc-ctl lines of the system journal since `since` (journalctl's syntax: today, -7d, "2026-11-20 10:00"). */
export function readJournal(since: string, run: Run = spawnSync as unknown as Run): JournalRecord[] {
  const r = run('journalctl', ['-q', '--no-pager', '-t', 'fnkc-ctl', '-o', 'json', '--since', since],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  if (r.error) throw new Error(`could not read the journal: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`journalctl failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  const out: JournalRecord[] = [];
  for (const l of r.stdout.split('\n')) {
    if (!l.trim()) continue;
    let e: { MESSAGE?: unknown; __REALTIME_TIMESTAMP?: unknown };
    try { e = JSON.parse(l) as typeof e; } catch { continue; }
    // journalctl writes a message that is not printable UTF-8 as an array of bytes
    const m = typeof e.MESSAGE === 'string' ? e.MESSAGE : Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE as number[]).toString('utf8') : undefined;
    if (m === undefined) continue;
    const us = Number(e.__REALTIME_TIMESTAMP);
    out.push({ time: Number.isFinite(us) && us > 0 ? new Date(us / 1000).toISOString().replace(/\.\d+Z$/, 'Z') : undefined, line: m });
  }
  return out;
}
