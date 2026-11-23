import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LockBusy } from './errors.ts';
import { Cancelled, throwIfCancelled } from './exec.ts';

// Kernel-owned locks: a killed client closes stdin, releasing the helper's lock. Files are never
// unlinked: unlinking a locked inode would allow two owners. Old mkdir locks fail closed on migration.
const POSIX_LOCK = `
import fcntl, os, select, sys, time
path, timeout = sys.argv[1], float(sys.argv[2])
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
if os.geteuid() == 0:
    parent = os.stat(os.path.dirname(path))
    os.fchown(fd, parent.st_uid, parent.st_gid)
end = time.monotonic() + timeout
said = False
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if not said:
            print("waiting", flush=True)
            said = True
        if time.monotonic() >= end:
            raise TimeoutError("operation is busy; timed out waiting for " + path)
        if select.select([sys.stdin], [], [], 0.05)[0]:
            sys.exit(1)
print("locked", flush=True)
sys.stdin.buffer.read()
`;

/**
 * What happens when a lock helper dies while its lock is held. The CLI and the agent end the process (default): a
 * mutation must not go on without exclusion. A long-lived host process (the extension) sets its own: ending the
 * process would take every other extension down with it.
 */
let onLockLost: (path: string) => void = () => process.kill(process.pid, 'SIGTERM');
export function setLockLossHandler(handler: (path: string) => void): void { onLockLost = handler; }

/**
 * Runs `work` holding the lock `path`, waiting at most `timeoutMs` for it. `onWait` is called once if the lock is
 * still held by someone else a second after the helper found it busy, so the caller can say what it waits for. The
 * second counts from the helper's report, not from its start: a slow interpreter start on a free lock is no wait.
 * `signal` (the user's Cancel) stops the wait with Cancelled; once the lock is held, `work` alone watches it.
 */
export async function withLock<T>(
  path: string, work: () => Promise<T>, timeoutMs = 120_000, onWait?: () => void, signal?: AbortSignal,
): Promise<T> {
  throwIfCancelled(signal);
  path = `${path}.kernel`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  const windows = process.platform === 'win32';
  const script = `$m = [Threading.Mutex]::new($false, 'Local\\fnkc-${name}'); $held = $false
try {
  try {
    $held = $m.WaitOne(0)
    if (-not $held) { [Console]::Out.WriteLine('waiting'); [Console]::Out.Flush(); $held = $m.WaitOne(${Math.ceil(timeoutMs)}) }
  } catch [Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { throw 'operation is busy; timed out waiting for lock' }
  [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadToEnd() | Out-Null
} finally { if ($held) { $m.ReleaseMutex() }; $m.Dispose() }`;
  const child = spawn(windows ? 'powershell.exe' : 'python3', windows
    ? ['-NoProfile', '-NonInteractive', '-Command', script]
    : ['-c', POSIX_LOCK, path, String(timeoutMs / 1000)], { windowsHide: true });
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-4096); });
  let released = false;
  const closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()));
  let waiting: NodeJS.Timeout | undefined;
  let acquired = false;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((yes, no) => {
      // Only while waiting: ending the helper after it took the lock would leave `work` without exclusion
      onAbort = () => { if (acquired) return; child.kill(); no(new Cancelled()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.once('error', no);
      // The helper's TimeoutError (Python prints a traceback, PowerShell its own lines): only its message matters
      child.once('close', () => no(/operation is busy/.test(stderr)
        ? new LockBusy(`operation is busy; timed out waiting for ${windows ? 'lock' : path}`)
        : new Error(stderr.trim() || 'lock helper exited before acquiring the lock')));
      // Line protocol: an optional `waiting` (the lock was busy at the first try), then `locked`
      let out = '';
      const onData = (b: Buffer) => {
        out += b.toString();
        let nl: number;
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          if (line === 'waiting') { if (onWait && !waiting) waiting = setTimeout(onWait, 1000); continue; }
          child.stdout.removeListener('data', onData);
          if (line !== 'locked') return no(new Error('invalid lock response'));
          acquired = true;
          return yes();
        }
      };
      child.stdout.on('data', onData);
    }).finally(() => { clearTimeout(waiting); if (onAbort) signal?.removeEventListener('abort', onAbort); });
    // Unexpected loss of the kernel lock must not leave a mutation running without exclusion.
    const lost = () => { if (!released) onLockLost(path); };
    child.once('exit', lost);
    try { return await work(); }
    finally { released = true; child.removeListener('exit', lost); }
  } finally {
    released = true;
    child.stdin.end();
    await closed;
  }
}
