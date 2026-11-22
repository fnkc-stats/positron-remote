// Helper containers: short-lived containers that work on a user's volumes for the agent (reading a checkout, the
// removal check, preparing the extensions volume). The user controls those volumes, so a helper may never finish on
// its own (a FIFO, a symlink to /dev/zero): every helper has a deadline, and none may outlive it.
import { randomBytes } from 'node:crypto';
import type { Docker } from './docker.ts';
import type { RunResult } from './exec.ts';
import { HELPER_LABEL, type HelperKind, helperName, helperPattern } from './layout.ts';
import type { Logger } from './log.ts';

/**
 * Options of every helper. docker-init as PID 1 lets the container die on a signal; no log driver keeps its output off
 * the daemon's disk; the name lets the agent remove it when the docker CLI is killed (Docker does not pass SIGKILL on,
 * so --rm alone would leave it running). No network, no capabilities and no privilege gain; the image is read-only.
 * The caller adds the user, memory and process limits, and any capability it needs back.
 */
export const HELPER_OPTIONS = ['--init', '--log-driver', 'none', '--read-only', '--stop-timeout', '1', '--network', 'none',
  '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cpus', '1'];

export interface Helper {
  kind: HelperKind;
  user: string;
  project: string;
  /** Options after HELPER_OPTIONS, then the image and its command. */
  args: string[];
  timeoutMs: number;
  /** Exit codes that mean the container ran to its end (and --rm removed it). */
  exited: number[];
  onStderr?: (line: string) => void;
}

/**
 * Runs a helper container for at most `timeoutMs`. Unless the docker CLI reports one of the `exited` codes, the
 * container may still run after the CLI is gone: it is removed by its name. Helpers of this project that a previous
 * agent left behind (it died while its helper ran, so it never removed it) are removed first: the caller holds the
 * project's lock, so no other helper of this project runs.
 */
export async function runHelper(docker: Docker, log: Logger, h: Helper): Promise<RunResult> {
  await removeHelpers(docker, log, h.user, h.project);
  const name = helperName(h.kind, h.user, h.project, randomBytes(6).toString('hex'));
  const labels = ['--label', `${HELPER_LABEL.kind}=${h.kind}`, '--label', `${HELPER_LABEL.user}=${h.user}`, '--label', `${HELPER_LABEL.project}=${h.project}`];
  let clean = false;
  try {
    const r = await docker.run(['run', '--rm', '--name', name, ...labels, ...HELPER_OPTIONS, ...h.args], { timeoutMs: h.timeoutMs, onStderr: h.onStderr });
    clean = h.exited.includes(r.code);
    return r;
  } finally {
    if (!clean) await removeHelper(docker, log, name);
  }
}

/**
 * Removes the helper containers of this user's project, whatever their state. Matched by the exact name pattern, never
 * by a prefix or Docker's name filter (a substring match): project a's prefix also matches project a.b.
 */
export async function removeHelpers(docker: Docker, log: Logger, user: string, project: string): Promise<void> {
  const pattern = helperPattern(user, project);
  let names: string[];
  try {
    names = (await docker.ok(['ps', '-a', '--format', '{{.Names}}'], { timeoutMs: 30_000 })).split('\n').map((n) => n.trim());
  } catch (e) {
    log.warn(`could not list leftover helper containers: ${(e as Error).message}`);
    return;
  }
  for (const name of names.filter((n) => pattern.test(n))) await removeHelper(docker, log, name);
}

async function removeHelper(docker: Docker, log: Logger, name: string): Promise<void> {
  const rm = await docker.run(['rm', '-f', name], { timeoutMs: 30_000 }).catch((e: Error) => ({ code: -1, stderr: e.message }));
  if (rm.code !== 0 && !/no such container|already in progress/i.test(rm.stderr)) log.warn(`could not remove the helper container ${name}: ${rm.stderr.trim()}`);
}
