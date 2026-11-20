import { parseReference } from '../oci.ts';

const MAX_BUNDLE = 1024 * 1024;

/** Downloads public GitHub provenance bundles for an image digest; verification is performed by the host. */
export async function provenanceBundle(repository: string, image: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid provenance repository');
  const { digest } = parseReference(image);
  const endpoint = `https://api.github.com/repos/${repository}/attestations/${encodeURIComponent(digest)}`;
  const response = await fetch(endpoint, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not fetch provenance for ${image}: GitHub API HTTP ${response.status}`);
  const apiBytes = await response.arrayBuffer();
  if (apiBytes.byteLength > MAX_BUNDLE) throw new Error(`GitHub provenance response for ${image} is too large`);
  const result = JSON.parse(Buffer.from(apiBytes).toString('utf8')) as { attestations?: { bundle_url?: string }[] };
  const urls = (result.attestations ?? []).map((x) => x.bundle_url).filter((x): x is string => typeof x === 'string');
  if (!urls.length) throw new Error(`no GitHub build provenance exists for ${image}`);
  const bundles: string[] = [];
  let total = 0;
  for (const value of urls.slice(0, 10)) {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('GitHub returned an insecure provenance bundle URL');
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`could not download provenance for ${image}: HTTP ${r.status}`);
    const bundle = await r.text();
    total += Buffer.byteLength(bundle);
    if (total > MAX_BUNDLE) throw new Error(`provenance bundle for ${image} exceeds ${MAX_BUNDLE} bytes`);
    bundles.push(bundle.trim());
  }
  return bundles.join('\n') + '\n';
}
