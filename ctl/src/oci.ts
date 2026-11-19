// Image manifests as registries serve them (OCI and Docker v2 formats), shared by the client, which downloads an
// image by its pinned digest, and the host, which checks what the client sends against that digest.
import { createHash } from 'node:crypto';
import type { Arch } from './layout.ts';

export const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
export const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
/** Layers `docker load` unpacks everywhere: plain or gzip-compressed tar. */
const LAYER_TYPES = [
  'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
  'application/vnd.docker.image.rootfs.diff.tar.gzip',
];

/** Largest manifest or index accepted (real ones are a few KB). */
export const MAX_MANIFEST = 4 * 1024 ** 2;
/** Largest image accepted, all blobs together (r-env is about 1 GB compressed). */
export const MAX_IMAGE = 32 * 1024 ** 3;

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}

export interface ImageManifest {
  config: Descriptor;
  layers: Descriptor[];
}

export const sha256 = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
export const hexOf = (digest: string) => digest.slice('sha256:'.length);

/** "ghcr.io/org/r-env@sha256:..." -> registry API host, repository path in that registry, digest. */
export function parseReference(image: string): { registry: string; repository: string; digest: string } {
  const m = /^([a-z0-9][a-z0-9._/:-]*)@(sha256:[0-9a-f]{64})$/.exec(image);
  if (!m) throw new Error(`image must be pinned as repository@sha256:<digest>: ${image}`);
  const name = m[1].replace(/:[^/:]+$/, ''); // a tag next to the digest is ignored
  const first = name.split('/')[0];
  const hasRegistry = name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  let registry = hasRegistry ? first : 'docker.io';
  let repository = hasRegistry ? name.slice(first.length + 1) : name;
  if (registry === 'docker.io') {
    registry = 'registry-1.docker.io';
    if (!repository.includes('/')) repository = `library/${repository}`;
  }
  return { registry, repository, digest: m[2] };
}

/**
 * The tag a host gives an image that a client uploaded. Registries keep an image's digest, `docker load` does
 * not, so the host refers to an uploaded image by this tag. Only the agent creates it, after checking the image.
 */
export function uploadedTag(image: string): string {
  const [name, digest] = image.split('@');
  return `${name.replace(/:[^/:]+$/, '')}:${digest.replace(':', '-')}`;
}

function descriptor(v: unknown, what: string): Descriptor {
  const d = v as Partial<Descriptor> | null;
  if (!d || typeof d.mediaType !== 'string' || typeof d.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(d.digest)
    || !Number.isSafeInteger(d.size) || d.size! < 0) throw new Error(`image: invalid ${what} descriptor`);
  return { mediaType: d.mediaType, digest: d.digest, size: d.size! };
}

function json(body: Buffer): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(body.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* reported below */ }
  throw new Error('image: manifest is not a JSON object');
}

export const isIndex = (body: Buffer) => {
  const v = json(body);
  return INDEX_TYPES.includes(v.mediaType as string) || (v.mediaType === undefined && Array.isArray(v.manifests));
};

/** The manifest for linux/<arch> from a multi-architecture index (attestations are skipped). */
export function platformManifest(index: Buffer, arch: Arch): Descriptor {
  const want = arch === 'x64' ? 'amd64' : 'arm64';
  const list = json(index).manifests;
  if (!Array.isArray(list)) throw new Error('image: index lists no manifests');
  for (const m of list as { platform?: { os?: string; architecture?: string; variant?: string } }[]) {
    if (m?.platform?.os !== 'linux' || m.platform.architecture !== want) continue;
    if (want === 'arm64' && m.platform.variant && m.platform.variant !== 'v8') continue;
    const d = descriptor(m, 'platform manifest');
    if (!MANIFEST_TYPES.includes(d.mediaType)) throw new Error(`image: unsupported manifest type ${d.mediaType}`);
    return d;
  }
  throw new Error(`image has no linux/${want} version`);
}

/** Config and layers of a single-architecture manifest; only layer types `docker load` handles are accepted. */
export function imageManifest(body: Buffer): ImageManifest {
  const v = json(body);
  if (v.mediaType !== undefined && !MANIFEST_TYPES.includes(v.mediaType as string)) throw new Error(`image: unsupported manifest type ${String(v.mediaType)}`);
  const config = descriptor(v.config, 'config');
  if (!Array.isArray(v.layers) || !v.layers.length || v.layers.length > 256) throw new Error('image: invalid layer list');
  const layers = v.layers.map((l) => descriptor(l, 'layer'));
  for (const l of layers) if (!LAYER_TYPES.includes(l.mediaType)) throw new Error(`image: unsupported layer type ${l.mediaType}`);
  const total = layers.reduce((n, l) => n + l.size, config.size);
  if (config.size > MAX_MANIFEST || total > MAX_IMAGE) throw new Error('image is too large');
  return { config, layers };
}

/** Distinct blobs in the order they are sent: config, then layers (an image may repeat a layer). */
export function uploadBlobs(m: ImageManifest): Descriptor[] {
  const seen = new Set<string>();
  return [m.config, ...m.layers].filter((d) => !seen.has(d.digest) && seen.add(d.digest));
}

/** The architecture an image config declares, as Docker reports it ("amd64", "arm64"). */
export function configArchitecture(config: Buffer): string {
  const a = json(config).architecture;
  if (typeof a !== 'string') throw new Error('image: config names no architecture');
  return a;
}
