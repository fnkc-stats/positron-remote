// The Positron server archive for a host that does not have it yet. Hosts never download it themselves (a
// server may have no access to Posit): this computer downloads it once, keeps it in the cache, and sends it.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '../log.ts';
import { MAX_SERVER_ARCHIVE } from '../positron-server.ts';
import type { ServerMissing } from '../protocol.ts';

/** Seconds to wait for the download to begin, and at most between two received pieces. */
const STALL_SECONDS = 60;

export const archivePath = (cacheDir: string, m: ServerMissing) => join(cacheDir, 'positron-server', m.archive);

/** Path of the archive in this computer's cache, downloading it first if needed. */
export async function serverArchive(cacheDir: string, m: ServerMissing, log: Logger): Promise<string> {
  const file = archivePath(cacheDir, m);
  if (existsSync(file)) return file;
  if (!/^[\w.-]+$/.test(m.archive) || !/^https:\/\//.test(m.url)) throw new Error(`unexpected server archive from host: ${m.archive} ${m.url}`);
  mkdirSync(join(cacheDir, 'positron-server'), { recursive: true });
  const part = `${file}.part`;
  log.info(`Downloading Positron server ${m.version} (${m.arch}) on this computer: ${m.url}`);

  // A stalled connection fails after STALL_SECONDS without data; a slow but moving one is never cut off
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(new Error('download stalled')), STALL_SECONDS * 1000);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new Error('download stalled')), STALL_SECONDS * 1000);
  };
  try {
    const res = await fetch(m.url, { signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} (is ${m.version} a Positron release?)`);
    const total = Number(res.headers.get('content-length') ?? 0);
    let done = 0;
    let shown = 0;
    const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      alive();
      done += chunk.length;
      if (done > MAX_SERVER_ARCHIVE) body.destroy(new Error('server archive is too large'));
      if (total && done / total >= shown + 0.25) {
        shown = Math.floor((done / total) * 4) / 4;
        log.info(`  ${Math.round(shown * 100)}% of ${Math.round(total / 1e6)} MB`);
      }
    });
    await pipeline(body, createWriteStream(part));
    renameSync(part, file);
    return file;
  } catch (e) {
    rmSync(part, { force: true });
    throw new Error(`could not download the Positron server: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** A cached archive the host rejected is removed, so the next Open downloads it again. */
export function forgetArchive(cacheDir: string, m: ServerMissing): void {
  rmSync(archivePath(cacheDir, m), { force: true });
}
