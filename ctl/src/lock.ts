import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Host-local, cross-process lock. Never evict a live owner based on elapsed time. */
export async function withLock<T>(path: string, work: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw new Error(`operation is busy; timed out waiting for ${path}. If its pid is no longer running, an operator must remove the abandoned lock.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    await writeFile(`${path}/pid`, String(process.pid), { mode: 0o600 });
    return await work();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
