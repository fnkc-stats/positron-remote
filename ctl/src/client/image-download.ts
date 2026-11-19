// The pinned environment image for a host that does not have it. Hosts need no registry access: this computer
// downloads the image by its digest with the registry's HTTP API (no Docker needed here), keeps the blobs in
// its cache, and sends them in the format image-store.ts reads. Everything is checked against the digest here
// and checked again on the host.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

class Registry {
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
    if (!res.ok || !res.body) throw new Error(`registry: HTTP ${res.status} for ${path}`);
    return res;
  }

  async manifest(digest: string): Promise<Buffer> {
    const res = await this.get(`manifests/${digest}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_MANIFEST || sha256(body) !== digest) throw new Error(`registry: manifest ${digest} does not match its digest`);
    return body;
  }
}

/** The digest a tag points to now (an image index for a multi-architecture image): what container.json pins. */
export async function tagDigest(registry: string, repository: string, tag: string): Promise<string> {
  const res = await new Registry(registry, repository).get(`manifests/${tag}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_MANIFEST) throw new Error(`registry: manifest of ${tag} is too large`);
  return sha256(body);
}

/** Downloads one blob into the cache, checking its digest; a stalled connection fails, a slow one does not. */
async function download(reg: Registry, d: Descriptor, file: string, onBytes: (n: number) => void): Promise<void> {
  const part = `${file}.part`;
  const abort = new AbortController();
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
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The image `m` names, for the host's architecture, downloading what this computer's cache lacks. */
export async function imageUpload(cacheDir: string, m: ImageMissing, log: Logger): Promise<ImageUpload> {
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
        });
      }
    }
    return { manifests, blobs, size: manifests.reduce((n, x) => n + x.length, 0) + blobs.reduce((n, b) => n + b.size, 0) };
  } catch (e) {
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
