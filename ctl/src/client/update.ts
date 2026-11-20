// Updates of the extension: CI publishes each version as a GitHub release of the infrastructure repository
// (extension.yml: tag fnkc-projects-v<version>, assets fnkc-projects.vsix and its .sha256). The repository is public,
// so the newest release is read without credentials. The extension asks once a day and on request; the vsix is
// checked against its checksum before Positron installs it.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const VSIX = 'fnkc-projects.vsix';
const TAG_RE = /^fnkc-projects-v([0-9]+\.[0-9]+\.[0-9]+)$/;

export interface Release {
  version: string;
  /** The release page (its notes). */
  url: string;
  vsix: string;
  sha256: string;
}

/** a > b, for versions major.minor.patch. */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

const get = (url: string, accept: string) => fetch(url, { headers: { accept, 'user-agent': 'fnkc-projects' }, signal: AbortSignal.timeout(30_000) });

/** The newest release of the extension in `repository` (owner/name), or undefined if there is none. */
export async function latestRelease(repository: string): Promise<Release | undefined> {
  const res = await get(`https://api.github.com/repos/${repository}/releases/latest`, 'application/vnd.github+json');
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub releases of ${repository}: HTTP ${res.status}`);
  const r = await res.json() as { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] };
  const version = TAG_RE.exec(r.tag_name)?.[1];
  const asset = (name: string) => r.assets.find((a) => a.name === name)?.browser_download_url;
  const vsix = asset(VSIX);
  const sha256 = asset(`${VSIX}.sha256`);
  if (!version || !vsix || !sha256) return undefined;
  return { version, url: r.html_url, vsix, sha256 };
}

/** Downloads the release's vsix to `file` after checking it against the published checksum. */
export async function downloadRelease(release: Release, file: string): Promise<void> {
  const [vsix, sum] = await Promise.all([get(release.vsix, 'application/octet-stream'), get(release.sha256, 'text/plain')]);
  if (!vsix.ok || !sum.ok) throw new Error(`download of FNKC Projects ${release.version} failed: HTTP ${vsix.ok ? sum.status : vsix.status}`);
  const body = Buffer.from(await vsix.arrayBuffer());
  const want = (await sum.text()).trim().split(/\s+/)[0];
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== want) throw new Error(`FNKC Projects ${release.version}: the download does not match its checksum (${got}, expected ${want})`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, body);
  renameSync(`${file}.tmp`, file);
}
