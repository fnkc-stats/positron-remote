// Environment images on a host. A host needs no registry access: when the pinned image is missing, start
// answers imageMissing, the client downloads the image by its digest on its own computer and sends it through
// the agent connection (install-image), and the host checks every byte against the pinned digest before
// `docker load`. The digest proves the content is what the reference names, not who published it: any enrolled
// user can upload an image they built under an allowed repository name (operations.md, Environment images).
//
// Upload format, on stdin: parts, each "<size in bytes>\n" followed by that many bytes, in this order:
//   1. the manifest or index the pinned digest names;
//   2. for an index, the manifest for the host's architecture;
//   3. the config, then each distinct layer in manifest order.
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { Docker, ImageJson } from './docker.ts';
import type { Arch } from './layout.ts';
import type { Logger } from './log.ts';
import {
  configArchitecture, type Descriptor, hexOf, imageManifest, type ImageManifest, isIndex, MAX_MANIFEST,
  parseReference, platformManifest, sha256, uploadBlobs, uploadedTag,
} from './oci.ts';
import { CodedError, ImageRejected } from './errors.ts';
import type { ImageMissing } from './protocol.ts';
import { TAR_END, tarHeader, tarPadding } from './tar.ts';

/** Thrown by start when the pinned image is not on the host: the client sends it (install-image), then retries. */
export class EnvironmentImageMissing extends CodedError {
  readonly missing: ImageMissing;
  constructor(missing: ImageMissing) {
    super('image-missing', `environment image ${missing.image} (${missing.arch}) is not on this host yet`);
    this.missing = missing;
  }
}

/** The existing checkout pins another environment than the request named: the client chooses again for this one. */
export class CheckoutPinsOther extends CodedError {
  readonly pinned: string;
  constructor(pinned: string) {
    super('checkout-pins', `the checkout on the host pins ${pinned}`);
    this.pinned = pinned;
  }
}

/** The name Docker knows the pinned image by on this host (pulled: the reference itself; uploaded: its tag). */
export async function localImage(docker: Docker, image: string): Promise<{ ref: string; img: ImageJson } | null> {
  for (const ref of [image, uploadedTag(image)]) {
    const img = await docker.image(ref);
    if (img) return { ref, img };
  }
  return null;
}

export const dockerArch = (arch: Arch) => (arch === 'x64' ? 'amd64' : 'arm64');

/** Reads the upload's parts from a stream. */
export class PartReader {
  private readonly it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private readonly source: Readable;
  private readonly deadline: number;
  private readonly idleMs: number;
  constructor(source: Readable, idleMs = 60_000, totalMs = 4 * 3600_000) {
    this.source = source;
    this.idleMs = idleMs;
    this.deadline = Date.now() + totalMs;
    this.it = source[Symbol.asyncIterator]();
  }

  private async more(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.min(this.idleMs, this.deadline - Date.now());
    if (remaining <= 0) throw new Error('image upload timed out');
    const r = await Promise.race([this.it.next(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('image upload timed out waiting for data or EOF'));
        this.source.destroy();
      }, remaining);
    })]).finally(() => clearTimeout(timer));
    if (r.done) return false;
    const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value as Uint8Array);
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return true;
  }

  /** The size line of the next part. */
  async size(max: number): Promise<number> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString();
        this.buf = this.buf.subarray(i + 1);
        if (!/^\d{1,15}$/.test(line) || Number(line) > max) throw new Error('image upload: invalid part size');
        return Number(line);
      }
      if (this.buf.length > 16 || !(await this.more())) throw new Error('image upload: malformed or incomplete');
    }
  }

  /** The next `n` bytes, as they arrive. */
  async *take(n: number): AsyncGenerator<Buffer> {
    while (n > 0) {
      if (!this.buf.length && !(await this.more())) throw new Error('image upload ended early');
      const part = this.buf.subarray(0, Math.min(n, this.buf.length));
      this.buf = this.buf.subarray(part.length);
      n -= part.length;
      yield part;
    }
  }

  /** A whole part held in memory (manifests). */
  async part(max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of this.take(await this.size(max))) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async end(): Promise<void> {
    if (this.buf.length || (await this.more())) throw new Error('image upload: unexpected data after the last layer');
  }
}

/** The tar stream `docker load` reads: the checked blobs and a manifest.json that tags the image. */
async function* dockerArchive(dir: string, tag: string, m: ImageManifest): AsyncGenerator<Buffer> {
  const name = (d: Descriptor) => `blobs/sha256/${hexOf(d.digest)}`;
  for (const d of uploadBlobs(m)) {
    yield tarHeader(name(d), 0o644, d.size);
    yield* createReadStream(join(dir, hexOf(d.digest))) as AsyncIterable<Buffer>;
    yield tarPadding(d.size);
  }
  const manifest = Buffer.from(JSON.stringify([{ Config: name(m.config), RepoTags: [tag], Layers: m.layers.map(name) }]));
  yield tarHeader('manifest.json', 0o644, manifest.length);
  yield manifest;
  yield tarPadding(manifest.length);
  yield TAR_END;
}

/**
 * Receives an upload into a private folder under `stagingDir`, checks it against `image`'s digest and the host's
 * architecture, and loads it with `locked` (the host lock) held only for `docker load`. Nothing reaches Docker
 * before every byte has been checked; the folder is removed in any case.
 */
export interface UploadPolicy {
  reserveBytes: number;
  maxUnpackedBytes: number;
  maxStoredBytes: number;
}
export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  reserveBytes: 2 * 1024 ** 3, maxUnpackedBytes: 64 * 1024 ** 3, maxStoredBytes: 128 * 1024 ** 3,
};

/** Bound decompression before Docker gets any bytes. Never extracts paths or executes image code. */
export async function unpackedSize(path: string, gzip: boolean, budget: number): Promise<number> {
  const file = createReadStream(path);
  const stream = gzip ? file.pipe(createGunzip()) : file;
  file.on('error', (e) => stream.destroy(e));
  let size = 0;
  try {
    for await (const part of stream) {
      size += (part as Buffer).length;
      if (size > budget) throw new Error('image exceeds unpacked storage budget');
    }
    return size;
  } finally { file.destroy(); stream.destroy(); }
}

export async function receiveImage(
  docker: Docker, image: string, arch: Arch, source: Readable, stagingDir: string, log: Logger,
  locked: (work: () => Promise<void>) => Promise<void>,
  policy: UploadPolicy = DEFAULT_UPLOAD_POLICY,
): Promise<void> {
  const { digest } = parseReference(image);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  // The caller holds the ingestion lock: these can only be remnants of interrupted uploads.
  for (const entry of readdirSync(stagingDir)) if (/^upload-[A-Za-z0-9]+$/.test(entry)) rmSync(join(stagingDir, entry), { recursive: true, force: true });
  const dir = mkdtempSync(join(stagingDir, 'upload-'));
  try {
    const r = new PartReader(source);
    const top = await r.part(MAX_MANIFEST);
    if (sha256(top) !== digest) throw new ImageRejected('image upload: the manifest does not match the pinned digest');
    let manifest = top;
    if (isIndex(top)) {
      const d = platformManifest(top, arch);
      manifest = await r.part(MAX_MANIFEST);
      if (sha256(manifest) !== d.digest) throw new ImageRejected(`image upload: the ${dockerArch(arch)} manifest does not match the index`);
    }
    const m = imageManifest(manifest);
    const blobs = uploadBlobs(m);
    const total = blobs.reduce((n, b) => n + b.size, 0);
    const fs = statfsSync(stagingDir);
    if (total + policy.reserveBytes > fs.bavail * fs.bsize) throw new Error('insufficient image staging space (including reserve)');
    let done = 0;
    let shown = 0;
    log.info(`Receiving environment image ${image} (${Math.round(total / 1e6)} MB)`);
    for (const b of blobs) {
      if ((await r.size(b.size)) !== b.size) throw new ImageRejected(`image upload: ${b.digest} has the wrong size`);
      const hash = createHash('sha256');
      const counted = async function* (parts: AsyncIterable<Buffer>) {
        for await (const p of parts) {
          hash.update(p);
          done += p.length;
          if (done / total >= shown + 0.25) {
            shown = Math.floor((done / total) * 4) / 4;
            log.info(`  ${Math.round(shown * 100)}%`);
          }
          yield p;
        }
      };
      await pipeline(Readable.from(counted(r.take(b.size))), createWriteStream(join(dir, hexOf(b.digest)), { mode: 0o600 }));
      if (`sha256:${hash.digest('hex')}` !== b.digest) throw new ImageRejected(`image upload: ${b.digest} does not match its content`);
    }
    await r.end();
    const declared = configArchitecture(readFileSync(join(dir, hexOf(m.config.digest))));
    if (declared !== dockerArch(arch)) throw new Error(`image upload: the image is for ${declared}, this host is ${dockerArch(arch)}`);

    let unpacked = 0;
    for (const layer of m.layers) {
      unpacked += await unpackedSize(join(dir, hexOf(layer.digest)), layer.mediaType.endsWith('gzip'), policy.maxUnpackedBytes - unpacked);
    }
    const tag = uploadedTag(image);
    await locked(async () => {
      if (await localImage(docker, image)) return; // another upload of the same image finished first
      const stored = (await docker.images()).reduce((n, img) => n + (img.Size ?? 0), 0);
      if (stored + unpacked > policy.maxStoredBytes) throw new Error('host image storage budget exhausted; remove unused images or raise the approved budget');
      await docker.ok(['load', '-q'], { input: Readable.from(dockerArchive(dir, tag, m)), timeoutMs: 30 * 60_000 });
      const img = await docker.image(tag);
      if (img?.Architecture !== dockerArch(arch)) {
        await docker.run(['image', 'rm', tag]);
        throw new Error('image upload: the loaded image is not usable on this host');
      }
    });
    log.info('Environment image is ready on this host');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
