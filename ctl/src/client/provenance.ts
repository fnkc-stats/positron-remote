// The proof a host checks before it runs an image (provenance.ts): the image's GitHub artifact attestations and the
// image's top manifest (the bytes its digest names). Both are fetched here, where GitHub and the registry are
// reachable, and cached by the repository whose workflow must have signed it and the digest: neither ever changes for
// these two, so each is fetched once per computer. A proof the host refuses is forgotten and fetched again (open.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexOf, parseReference, sha256 } from '../oci.ts';
import { Registry } from './image-download.ts';
import { snappyDecode } from './snappy.ts';
import { run } from '../exec.ts';

const MAX_BUNDLE = 1024 * 1024;

export interface ProvenanceProof {
  /** Sigstore bundles, one JSON object per line (the format of gh attestation verify --bundle). */
  bundle: string;
  /** The image's top manifest or index, base64: the host verifies the attestation against these bytes offline. */
  subject: string;
}

/** GitHub has no attestation for the image: it was not built by the repository's workflow (or not yet). */
export class NoProvenance extends Error {}

function proofDir(cacheDir: string, repository: string, image: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid provenance repository');
  return join(cacheDir, 'provenance', repository.replace('/', '__'), hexOf(parseReference(image).digest));
}

/** The proof for `image`, from this computer's cache or else from GitHub and the registry. */
export async function provenanceProof(cacheDir: string, repository: string, image: string): Promise<ProvenanceProof> {
  const { registry, repository: repo, digest } = parseReference(image);
  const dir = proofDir(cacheDir, repository, image);
  const bundleFile = join(dir, 'bundle.jsonl');
  const subjectFile = join(dir, 'subject');
  if (existsSync(bundleFile) && existsSync(subjectFile)) {
    const subject = readFileSync(subjectFile);
    if (sha256(subject) === digest) return { bundle: readFileSync(bundleFile, 'utf8'), subject: subject.toString('base64') };
  }
  const token = await githubToken();
  const [bundle, subject] = await Promise.all([provenanceBundle(repository, image, fetch, token), new Registry(registry, repo).manifest(digest)]);
  mkdirSync(dir, { recursive: true });
  for (const [file, data] of [[bundleFile, bundle], [subjectFile, subject]] as const) {
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
  }
  return { bundle, subject: subject.toString('base64') };
}

/**
 * A GitHub token for the API, if this computer has one: GH_TOKEN or GITHUB_TOKEN (CI), or the login of the gh command
 * (people who use Build Environment have one). It raises GitHub's limit from 60 requests an hour per address to 5000
 * per account; without one the public attestations are fetched anonymously. Sent to api.github.com only.
 */
export async function githubToken(env: NodeJS.ProcessEnv = process.env, command: typeof run = run): Promise<string | undefined> {
  const fromEnv = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const r = await command('gh', ['auth', 'token'], { timeoutMs: 5000 });
    const token = r.stdout.trim();
    return r.code === 0 && /^[A-Za-z0-9_.-]+$/.test(token) ? token : undefined;
  } catch {
    return undefined; // no gh on this computer
  }
}

/** Forgets a cached proof (the host refused it), so the next request fetches it again. */
export function forgetProof(cacheDir: string, repository: string, image: string): void {
  rmSync(proofDir(cacheDir, repository, image), { recursive: true, force: true });
}

/**
 * The image's attestations from the GitHub API (public repository: no credentials). The API includes each bundle
 * when it is small and otherwise links it; a linked bundle is snappy-compressed.
 */
export async function provenanceBundle(repository: string, image: string, get: typeof fetch = fetch, token?: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid provenance repository');
  const { digest } = parseReference(image);
  const endpoint = `https://api.github.com/repos/${repository}/attestations/${encodeURIComponent(digest)}`;
  const ask = (auth?: string) => get(endpoint, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  let response = await ask(token);
  // A token that GitHub no longer accepts: the attestations are public, so ask without it
  if (token && response.status === 401) response = await ask();
  if (response.status === 404) throw new NoProvenance(`no GitHub build provenance exists for ${image}`);
  if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : '';
    throw new Error(`GitHub API rate limit reached while fetching provenance for ${image}${when}` +
      (token ? '' : ' (60 requests an hour without a login: run gh auth login, or set GH_TOKEN)'));
  }
  if (!response.ok) throw new Error(`could not fetch provenance for ${image}: GitHub API HTTP ${response.status}`);
  const apiBytes = await response.arrayBuffer();
  if (apiBytes.byteLength > 16 * MAX_BUNDLE) throw new Error(`GitHub provenance response for ${image} is too large`);
  const result = JSON.parse(Buffer.from(apiBytes).toString('utf8')) as { attestations?: { bundle?: unknown; bundle_url?: unknown }[] };
  const attestations = (result.attestations ?? []).slice(0, 10);
  if (!attestations.length) throw new NoProvenance(`no GitHub build provenance exists for ${image}`);
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
