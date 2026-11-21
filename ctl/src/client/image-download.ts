// The pinned environment image for a host that does not have it. Hosts need no registry access: this computer
// downloads the image by its digest with the registry's HTTP API (no Docker needed here), keeps the blobs in
// its cache, and sends them in the format image-store.ts reads. Everything is checked against the digest here
// and checked again on the host.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '../log.ts';
import {
  type Descriptor, hexOf, imageManifest, INDEX_TYPES, isIndex, MANIFEST_TYPES, MAX_MANIFEST, parseReference,
  platformManifest, sha256, uploadBlobs,
} from '../oci.ts';
import type { ImageMissing } from '../protocol.ts';
import { withLock } from '../lock.ts';
import { Cancelled } from '../exec.ts';

/** Seconds to wait for a download to begin, and at most between two received pieces. */
const STALL_SECONDS = 60;

const blobPath = (cacheDir: string, digest: string) => join(cacheDir, 'images', 'blobs', hexOf(digest));

/** An image ready to send: its parts in upload order, all in this computer's cache. */
export interface ImageUpload {
  /** The pinned manifest or index, and the platform manifest for an index. */
  manifests: Buffer[];
  blobs: Descriptor[];
  size: number;
}

/** The registry answered with an error status (404: no such tag, manifest or blob). */
export class RegistryHttpError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`registry: HTTP ${status} for ${path}`);
    this.status = status;
  }
}

/** A registry's HTTP API for one repository, with its anonymous token: public images only. */
export class Registry {
  private readonly base: string;
  private readonly repository: string;
  private token?: string;
  constructor(registry: string, repository: string) {
    this.base = `${registry === 'localhost' || registry.startsWith('localhost:') ? 'http' : 'https'}://${registry}/v2/${repository}`;
    this.repository = repository;
  }

  /** GET with the registry's anonymous token: public images only. */
  async get(path: string, accept: string[], signal?: AbortSignal): Promise<Response> {
    const headers = (): Record<string, string> => ({ Accept: accept.join(', '), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) });
    let res = await fetch(`${this.base}/${path}`, { headers: headers(), signal });
    if (res.status === 401 && !this.token) {
      const challenge = res.headers.get('www-authenticate') ?? '';
      await res.body?.cancel();
      const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      // Tokens only over HTTPS, except from a registry on this computer (tests, a local mirror)
      const realm = fields.realm ?? '';
      if (!/^bearer /i.test(challenge) || !(realm.startsWith('https://') || (this.base.startsWith('http://') && /^http:\/\/localhost[:/]/.test(realm)))) throw new Error(`registry asks for credentials: ${challenge}`);
      const url = new URL(fields.realm);
      if (fields.service) url.searchParams.set('service', fields.service);
      url.searchParams.set('scope', fields.scope ?? `repository:${this.repository}:pull`);
      const t = await fetch(url, { signal });
      const body = (await t.json().catch(() => ({}))) as { token?: string; access_token?: string };
      this.token = body.token ?? body.access_token;
      if (!t.ok || !this.token) throw new Error(`registry token request failed: HTTP ${t.status} (is the image public?)`);
      res = await fetch(`${this.base}/${path}`, { headers: headers(), signal });
    }
    if (!res.ok || !res.body) throw new RegistryHttpError(res.status, path);
    return res;
  }

  /** Every tag of the repository, following the registry's pages (Link: <...>; rel="next"). */
  async tags(): Promise<string[]> {
    const all: string[] = [];
    let path = 'tags/list?n=1000';
    for (let page = 0; page < 100; page++) {
      const res = await this.get(path, ['application/json'], AbortSignal.timeout(30_000));
      const body = (await res.json().catch(() => ({}))) as { tags?: unknown };
      if (!Array.isArray(body.tags)) throw new Error('registry: the tag list is not a list');
      all.push(...body.tags.filter((t): t is string => typeof t === 'string'));
      const next = /<[^>]*\/tags\/list\?([^>]*)>;\s*rel="?next"?/.exec(res.headers.get('link') ?? '')?.[1];
      if (!next) return all;
      path = `tags/list?${next}`;
    }
    throw new Error('registry: too many pages of tags');
  }

  /** A manifest or index by tag or digest, with the digest of its bytes. */
  async manifestOf(reference: string): Promise<{ body: Buffer; digest: string }> {
    const res = await this.get(`manifests/${reference}`, [...INDEX_TYPES, ...MANIFEST_TYPES], AbortSignal.timeout(30_000));
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_MANIFEST) throw new Error(`registry: manifest of ${reference} is too large`);
    const digest = sha256(body);
    if (reference.startsWith('sha256:') && digest !== reference) throw new Error(`registry: manifest ${reference} does not match its digest`);
    return { body, digest };
  }

  /** A small blob (an image config), checked against its digest. */
  async smallBlob(digest: string, limit = MAX_MANIFEST): Promise<Buffer> {
    const res = await this.get(`blobs/${digest}`, ['*/*'], AbortSignal.timeout(60_000));
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > limit || sha256(body) !== digest) throw new Error(`registry: blob ${digest} does not match its digest`);
    return body;
  }

  async manifest(digest: string): Promise<Buffer> {
    const res = await this.get(`manifests/${digest}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_MANIFEST || sha256(body) !== digest) throw new Error(`registry: manifest ${digest} does not match its digest`);
    return body;
  }
}

/** The labels of an image (a digest or a tag; for an index, those of its first Linux image: all carry the same). */
export async function imageLabels(registry: string, repository: string, reference: string): Promise<Record<string, string>> {
  const reg = new Registry(registry, repository);
  const res = await reg.get(`manifests/${reference}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
  let body: Buffer = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_MANIFEST) throw new Error(`registry: manifest of ${reference} is too large`);
  if (/^sha256:/.test(reference) && sha256(body) !== reference) throw new Error(`registry: manifest ${reference} does not match its digest`);
  if (isIndex(body)) {
    const list = (JSON.parse(body.toString()) as { manifests?: { digest: string; platform?: { os?: string } }[] }).manifests ?? [];
    const first = list.find((m) => m.platform?.os === 'linux');
    if (!first) throw new Error(`registry: ${reference} has no Linux image`);
    body = await reg.manifest(first.digest);
  }
  const config = imageManifest(body).config;
  const c = await reg.get(`blobs/${config.digest}`, ['application/vnd.oci.image.config.v1+json', 'application/octet-stream', '*/*']);
  const raw = Buffer.from(await c.arrayBuffer());
  if (raw.length > MAX_MANIFEST || sha256(raw) !== config.digest) throw new Error('registry: image config does not match its digest');
  return (JSON.parse(raw.toString()) as { config?: { Labels?: Record<string, string> } }).config?.Labels ?? {};
}

/** All tags of a repository (the registry's tag list, page by page). */
export async function listTags(registry: string, repository: string): Promise<string[]> {
  const reg = new Registry(registry, repository);
  const tags: string[] = [];
  let path: string | undefined = 'tags/list?n=1000';
  for (let page = 0; path && page < 50; page++) {
    const res = await reg.get(path, ['application/json']);
    tags.push(...((await res.json()) as { tags?: string[] }).tags ?? []);
    // Link: </v2/<repository>/tags/list?last=...&n=1000>; rel="next"
    const next = /<\/v2\/[^>]*?\/(tags\/list\?[^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
    path = next?.[1];
  }
  return tags;
}

/** The digest a tag points to now (an image index for a multi-architecture image): what container.json pins. */
export async function tagDigest(registry: string, repository: string, tag: string): Promise<string> {
  const res = await new Registry(registry, repository).get(`manifests/${tag}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_MANIFEST) throw new Error(`registry: manifest of ${tag} is too large`);
  return sha256(body);
}

/** Downloads one blob into the cache, checking its digest; a stalled connection fails, a slow one does not. */
async function download(reg: Registry, d: Descriptor, file: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const part = `${file}.part`;
  const abort = new AbortController();
  const cancel = () => abort.abort(new Cancelled());
  signal?.addEventListener('abort', cancel, { once: true });
  let timer = setTimeout(() => abort.abort(new Error('download stalled')), STALL_SECONDS * 1000);
  const hash = createHash('sha256');
  let size = 0;
  try {
    const res = await reg.get(`blobs/${d.digest}`, ['*/*'], abort.signal);
    const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(new Error('download stalled')), STALL_SECONDS * 1000);
      hash.update(chunk);
      size += chunk.length;
      if (size > d.size) body.destroy(new Error('blob is larger than its manifest says'));
      onBytes(chunk.length);
    });
    await pipeline(body, createWriteStream(part));
    if (size !== d.size || `sha256:${hash.digest('hex')}` !== d.digest) throw new Error(`${d.digest} does not match its content`);
    renameSync(part, file);
  } catch (e) {
    rmSync(part, { force: true });
    throw signal?.aborted ? new Cancelled() : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** The image `m` names, for the host's architecture, downloading what this computer's cache lacks. */
export async function imageUpload(cacheDir: string, m: ImageMissing, log: Logger, signal?: AbortSignal): Promise<ImageUpload> {
  // Two Opens that need the same image (two projects, or two windows) download it once: the second waits
  const { digest } = parseReference(m.image);
  return withLock(join(cacheDir, 'locks', `image-${hexOf(digest)}`), () => downloadImage(cacheDir, m, log, signal), DOWNLOAD_QUEUE_MS,
    () => log.info('Waiting for another download of this environment image on this computer'));
}

/** How long an Open waits for another one downloading the same image. */
const DOWNLOAD_QUEUE_MS = 2 * 3600_000;

async function downloadImage(cacheDir: string, m: ImageMissing, log: Logger, signal?: AbortSignal): Promise<ImageUpload> {
  const { registry, repository, digest } = parseReference(m.image);
  mkdirSync(join(cacheDir, 'images', 'blobs'), { recursive: true });
  const reg = new Registry(registry, repository);
  const cached = (dg: string) => (existsSync(blobPath(cacheDir, dg)) ? readFileSync(blobPath(cacheDir, dg)) : undefined);
  const manifest = async (dg: string) => {
    const body = cached(dg);
    if (body && sha256(body) === dg) return body;
    const fresh = await reg.manifest(dg);
    writeFileSync(blobPath(cacheDir, dg), fresh);
    return fresh;
  };
  try {
    const manifests = [await manifest(digest)];
    if (isIndex(manifests[0])) manifests.push(await manifest(platformManifest(manifests[0], m.arch).digest));
    const blobs = uploadBlobs(imageManifest(manifests[manifests.length - 1]));
    const missing = blobs.filter((b) => !existsSync(blobPath(cacheDir, b.digest)));
    const total = missing.reduce((n, b) => n + b.size, 0);
    if (missing.length) {
      log.info(`Downloading environment image on this computer: ${m.image} (${m.arch}, ${Math.round(total / 1e6)} MB)`);
      let done = 0;
      let shown = 0;
      for (const b of missing) {
        await download(reg, b, blobPath(cacheDir, b.digest), (n) => {
          done += n;
          if (done / total >= shown + 0.25) {
            shown = Math.floor((done / total) * 4) / 4;
            log.info(`  ${Math.round(shown * 100)}% of ${Math.round(total / 1e6)} MB`);
          }
        }, signal);
      }
    }
    return { manifests, blobs, size: manifests.reduce((n, x) => n + x.length, 0) + blobs.reduce((n, b) => n + b.size, 0) };
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    throw new Error(`could not download the environment image ${m.image}: ${(e as Error).message}`);
  }
}

/** The upload stream: each part as "<size>\n" and its bytes (format in image-store.ts). */
export function uploadStream(cacheDir: string, u: ImageUpload): Readable {
  return Readable.from((async function* () {
    for (const x of u.manifests) {
      yield Buffer.from(`${x.length}\n`);
      yield x;
    }
    for (const b of u.blobs) {
      yield Buffer.from(`${b.size}\n`);
      yield* createReadStream(blobPath(cacheDir, b.digest)) as AsyncIterable<Buffer>;
    }
  })());
}

/** Cached blobs the host rejected are removed, so the next Open downloads them again. */
export function forgetImage(cacheDir: string, u: ImageUpload): void {
  for (const b of u.blobs) rmSync(blobPath(cacheDir, b.digest), { force: true });
}

/** Blobs of downloaded images in this computer's cache, oldest use first (the use time is the file's mtime). */
function cachedBlobs(cacheDir: string): { file: string; size: number; used: number }[] {
  const dir = join(cacheDir, 'images', 'blobs');
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^[0-9a-f]{64}$/.test(n)).flatMap((n) => {
    try {
      const s = statSync(join(dir, n));
      return [{ file: join(dir, n), size: s.size, used: s.mtimeMs }];
    } catch { return []; }
  }).sort((a, b) => a.used - b.used);
}

/**
 * Keeps the image cache under `limitBytes`: the least recently used blobs go first, never those of `keep` (the image
 * just sent), which are marked as used now. A removed blob is downloaded again if an Open needs it. Returns the bytes
 * freed.
 */
export function pruneImageCache(cacheDir: string, limitBytes: number, keep: ImageUpload): number {
  const now = new Date();
  const kept = new Set([...keep.blobs.map((b) => b.digest), ...keep.manifests.map((m) => sha256(m))].map((d) => blobPath(cacheDir, d)));
  for (const f of kept) { try { utimesSync(f, now, now); } catch { /* not cached */ } }
  const blobs = cachedBlobs(cacheDir);
  let total = blobs.reduce((n, b) => n + b.size, 0);
  let freed = 0;
  for (const b of blobs) {
    if (total <= limitBytes) break;
    if (kept.has(b.file)) continue;
    rmSync(b.file, { force: true });
    total -= b.size; freed += b.size;
  }
  return freed;
}

/** Empties the image cache (Clear Image Download Cache); returns the bytes freed. Downloads in progress keep their parts. */
export function clearImageCache(cacheDir: string): number {
  let freed = 0;
  for (const b of cachedBlobs(cacheDir)) { rmSync(b.file, { force: true }); freed += b.size; }
  return freed;
}

/** The bytes the image cache takes. */
export const imageCacheSize = (cacheDir: string) => cachedBlobs(cacheDir).reduce((n, b) => n + b.size, 0);
