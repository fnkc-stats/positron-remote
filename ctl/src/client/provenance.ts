// The proof a host checks before it runs an image (provenance.ts): the image's GitHub artifact attestations and the
// image's top manifest (the bytes its digest names). Both are fetched here, where GitHub and the registry are
// reachable, and cached by digest: neither ever changes for a digest, so each is fetched once per computer.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexOf, parseReference, sha256 } from '../oci.ts';
import { Registry } from './image-download.ts';
import { snappyDecode } from './snappy.ts';

const MAX_BUNDLE = 1024 * 1024;

export interface ProvenanceProof {
  /** Sigstore bundles, one JSON object per line (the format of gh attestation verify --bundle). */
  bundle: string;
  /** The image's top manifest or index, base64: the host verifies the attestation against these bytes offline. */
  subject: string;
}

/** The proof for `image`, from this computer's cache or else from GitHub and the registry. */
export async function provenanceProof(cacheDir: string, repository: string, image: string): Promise<ProvenanceProof> {
  const { registry, repository: repo, digest } = parseReference(image);
  const dir = join(cacheDir, 'provenance', hexOf(digest));
  const bundleFile = join(dir, 'bundle.jsonl');
  const subjectFile = join(dir, 'subject');
  if (existsSync(bundleFile) && existsSync(subjectFile)) {
    const subject = readFileSync(subjectFile);
    if (sha256(subject) === digest) return { bundle: readFileSync(bundleFile, 'utf8'), subject: subject.toString('base64') };
  }
  const [bundle, subject] = await Promise.all([provenanceBundle(repository, image), new Registry(registry, repo).manifest(digest)]);
  mkdirSync(dir, { recursive: true });
  for (const [file, data] of [[bundleFile, bundle], [subjectFile, subject]] as const) {
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
  }
  return { bundle, subject: subject.toString('base64') };
}

/** Forgets a cached proof (the host refused it), so the next Open fetches it again. */
export function forgetProof(cacheDir: string, image: string): void {
  rmSync(join(cacheDir, 'provenance', hexOf(parseReference(image).digest)), { recursive: true, force: true });
}

/**
 * The image's attestations from the GitHub API (public repository: no credentials). The API includes each bundle
 * when it is small and otherwise links it; a linked bundle is snappy-compressed.
 */
export async function provenanceBundle(repository: string, image: string, get: typeof fetch = fetch): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid provenance repository');
  const { digest } = parseReference(image);
  const endpoint = `https://api.github.com/repos/${repository}/attestations/${encodeURIComponent(digest)}`;
  const response = await get(endpoint, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) throw new Error(`no GitHub build provenance exists for ${image}`);
  if (!response.ok) throw new Error(`could not fetch provenance for ${image}: GitHub API HTTP ${response.status}`);
  const apiBytes = await response.arrayBuffer();
  if (apiBytes.byteLength > 16 * MAX_BUNDLE) throw new Error(`GitHub provenance response for ${image} is too large`);
  const result = JSON.parse(Buffer.from(apiBytes).toString('utf8')) as { attestations?: { bundle?: unknown; bundle_url?: unknown }[] };
  const attestations = (result.attestations ?? []).slice(0, 10);
  if (!attestations.length) throw new Error(`no GitHub build provenance exists for ${image}`);
  const bundles: string[] = [];
  for (const a of attestations) {
    if (a.bundle && typeof a.bundle === 'object') {
      bundles.push(JSON.stringify(a.bundle));
    } else if (typeof a.bundle_url === 'string') {
      const url = new URL(a.bundle_url);
      if (url.protocol !== 'https:') throw new Error('GitHub returned an insecure provenance bundle URL');
      const r = await get(url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`could not download provenance for ${image}: HTTP ${r.status}`);
      const compressed = Buffer.from(await r.arrayBuffer());
      if (compressed.length > MAX_BUNDLE) throw new Error(`provenance bundle for ${image} exceeds ${MAX_BUNDLE} bytes`);
      bundles.push(JSON.stringify(JSON.parse(snappyDecode(compressed, MAX_BUNDLE).toString('utf8'))));
    }
  }
  if (!bundles.length) throw new Error(`GitHub returned no usable provenance bundle for ${image}`);
  const text = bundles.join('\n') + '\n';
  if (Buffer.byteLength(text) > MAX_BUNDLE) throw new Error(`provenance bundles for ${image} exceed ${MAX_BUNDLE} bytes`);
  return text;
}
