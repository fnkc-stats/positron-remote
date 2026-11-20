import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

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
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
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
 * not free within a second, so the caller can say what it waits for.
 */
export async function withLock<T>(path: string, work: () => Promise<T>, timeoutMs = 120_000, onWait?: () => void): Promise<T> {
  path = `${path}.kernel`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const name = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  const windows = process.platform === 'win32';
  const script = `$m = [Threading.Mutex]::new($false, 'Local\\fnkc-${name}'); $held = $false
try {
  try { $held = $m.WaitOne(${Math.ceil(timeoutMs)}) } catch [Threading.AbandonedMutexException] { $held = $true }
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
  const waiting = onWait ? setTimeout(onWait, 1000) : undefined;
  try {
    await new Promise<void>((yes, no) => {
      child.once('error', no);
      child.once('close', () => no(new Error(stderr.trim() || 'lock helper exited before acquiring the lock')));
      child.stdout.once('data', (b: Buffer) => b.toString().trim() === 'locked' ? yes() : no(new Error('invalid lock response')));
    }).finally(() => clearTimeout(waiting));
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
