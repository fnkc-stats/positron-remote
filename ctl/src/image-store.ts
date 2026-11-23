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
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
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

/**
 * Where the host records which local image ID each uploaded image was loaded as (`<stagingDir>/loaded/<digest hex>`).
 * The tag Docker gives an uploaded image can be moved to another image; this record cannot, so project starts and the
 * backup helper (imageOnHost, host-image.ts) check the tag against it and run only the recorded image ID.
 */
export const loadedRecord = (stagingDir: string, image: string) => join(stagingDir, 'loaded', hexOf(parseReference(image).digest));

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/**
 * This host's record of loading `image`: the local image ID it was loaded as, `none` without a record, or `invalid`
 * for a record that names no image ID (damaged, or written by hand). An invalid record is refused, never taken for
 * a missing one: an image without a record is still reconnected to while a project's container runs it.
 */
function loadedRecordOf(stagingDir: string, image: string): { id: string } | 'none' | 'invalid' {
  let text: string;
  try { text = readFileSync(loadedRecord(stagingDir, image), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    return 'invalid';
  }
  const id = text.trim();
  return IMAGE_ID.test(id) ? { id } : 'invalid';
}

/** The local image ID `image` was loaded as on this host; undefined without a valid record of loading it. */
export function loadedImageId(stagingDir: string, image: string): string | undefined {
  const record = loadedRecordOf(stagingDir, image);
  return typeof record === 'object' ? record.id : undefined;
}

/**
 * How this host holds the pinned `image`: `ready` with the immutable image ID to run (pulled: Docker resolves
 * repository@digest itself; uploaded: the tag still names the image ID recorded when the agent loaded the checked
 * upload), `absent`, or an uploaded tag that cannot be trusted: no record of its upload (an older fnkc-ctl, or loaded
 * by hand), a record that names no image ID (`invalid`: damaged or edited), or moved to another image since. A pulled image without that digest is refused. When both names are there
 * for different images (normal on the containerd image store, where a pull and a load of the same content get
 * different IDs; on the classic store a moved tag), the pulled image wins: Docker resolved the digest itself. The
 * uploaded tag is then reported as `stray`, for the caller to warn about and untag. Nothing is ever run by the tag
 * itself: it can be moved to any image during maintenance.
 */
export type ImageOnHost =
  | { state: 'ready'; id: string; stray?: { tag: string; id: string } }
  | { state: 'absent' }
  | { state: 'unrecorded'; tag: string; id: string }
  | { state: 'invalid'; tag: string; id: string }
  | { state: 'moved'; tag: string; id: string; recorded: string };

export async function imageOnHost(docker: Pick<Docker, 'image'>, stagingDir: string, image: string): Promise<ImageOnHost> {
  const name = image.split('@')[0].replace(/:[^/:]+$/, '');
  const { digest } = parseReference(image);
  const pinned = `${name}@${digest}`;
  const pulled = await docker.image(pinned);
  if (pulled && !(pulled.RepoDigests ?? []).includes(pinned)) throw new Error(`Docker's image for ${pinned} does not carry that digest; refusing it`);
  const tag = uploadedTag(image);
  const uploaded = await docker.image(tag);
  if (pulled) {
    if (!IMAGE_ID.test(pulled.Id)) throw new Error(`unexpected image ID for ${pinned}: ${pulled.Id}`);
    return uploaded && uploaded.Id !== pulled.Id ? { state: 'ready', id: pulled.Id, stray: { tag, id: uploaded.Id } } : { state: 'ready', id: pulled.Id };
  }
  if (!uploaded) return { state: 'absent' };
  const record = loadedRecordOf(stagingDir, image);
  if (record === 'none') return { state: 'unrecorded', tag, id: uploaded.Id };
  if (record === 'invalid') return { state: 'invalid', tag, id: uploaded.Id };
  if (uploaded.Id !== record.id) return { state: 'moved', tag, id: uploaded.Id, recorded: record.id };
  return { state: 'ready', id: record.id };
}

/**
 * Whether `img`, inspected by its tag right after `docker load`, is the checked upload with config `config`: the tag
 * may have been moved meanwhile. On the classic image store the image ID is the config's digest. On the containerd
 * store (Docker 29's default) the ID is the digest of a manifest Docker wrote during the load, which cannot be
 * predicted, so there the uncompressed layers must be the config's diff IDs.
 */
async function isLoadedUpload(docker: Pick<Docker, 'run'>, img: ImageJson, config: Buffer, configDigest: string): Promise<boolean> {
  if (img.Id === configDigest) return true;
  const info = await docker.run(['info', '--format', '{{json .DriverStatus}}']);
  if (info.code !== 0 || !/io\.containerd\.snapshotter/.test(info.stdout)) return false;
  const diffIds = configDiffIds(config);
  const layers = img.RootFS?.Layers ?? [];
  return diffIds.length > 0 && layers.length === diffIds.length && layers.every((l, i) => l === diffIds[i]);
}

function configDiffIds(config: Buffer): string[] {
  try {
    const ids = (JSON.parse(config.toString('utf8')) as { rootfs?: { diff_ids?: unknown } }).rootfs?.diff_ids;
    return Array.isArray(ids) && ids.every((i) => typeof i === 'string' && IMAGE_ID.test(i)) ? ids as string[] : [];
  } catch { return []; }
}

function recordLoaded(stagingDir: string, image: string, id: string): void {
  const file = loadedRecord(stagingDir, image);
  mkdirSync(join(stagingDir, 'loaded'), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${id}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
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
    const config = readFileSync(join(dir, hexOf(m.config.digest)));
    const declared = configArchitecture(config);
    if (declared !== dockerArch(arch)) throw new Error(`image upload: the image is for ${declared}, this host is ${dockerArch(arch)}`);

    let unpacked = 0;
    for (const layer of m.layers) {
      unpacked += await unpackedSize(join(dir, hexOf(layer.digest)), layer.mediaType.endsWith('gzip'), policy.maxUnpackedBytes - unpacked);
    }
    const tag = uploadedTag(image);
    await locked(async () => {
      const have = await imageOnHost(docker, stagingDir, image);
      if (have.state === 'ready') return; // another upload of the same image finished first
      if (have.state !== 'absent') {
        // Never trusted, never run: the checked upload is loaded under the tag again and recorded. The untag fails
        // while a container uses that image; docker load then moves the tag itself, leaving the old image untagged.
        const why = have.state === 'moved' ? `not the image ${have.recorded} that was uploaded`
          : have.state === 'invalid' ? 'with a damaged record of its upload' : 'with no record of its upload';
        log.warn(`${have.tag} names ${have.id}, ${why}; loading the checked upload again`);
        await docker.run(['image', 'rm', '--no-prune', have.tag]);
      }
      const stored = (await docker.images()).reduce((n, img) => n + (img.Size ?? 0), 0);
      if (stored + unpacked > policy.maxStoredBytes) throw new Error('host image storage budget exhausted; remove unused images or raise the approved budget');
      await docker.ok(['load', '-q'], { input: Readable.from(dockerArchive(dir, tag, m)), timeoutMs: 30 * 60_000 });
      const img = await docker.image(tag);
      if (img?.Architecture !== dockerArch(arch)) {
        await docker.run(['image', 'rm', tag]);
        throw new Error('image upload: the loaded image is not usable on this host');
      }
      // Projects and the backup helper run an uploaded image only by the ID recorded here: without it, the next Open
      // sends the image again
      if (!IMAGE_ID.test(img.Id)) throw new Error(`image upload: unexpected image ID ${img.Id}`);
      // Only the checked upload is recorded: a tag moved between the load and this inspection is not
      if (!(await isLoadedUpload(docker, img, config, m.config.digest))) {
        throw new Error(`image upload: ${tag} names ${img.Id} after the load, not the checked upload; not recorded, so projects do not use it`);
      }
      try { recordLoaded(stagingDir, image, img.Id); } catch (e) {
        throw new Error(`could not record the loaded image ID, so projects cannot use the image: ${(e as Error).message}`);
      }
    });
    log.info('Environment image is ready on this host');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
