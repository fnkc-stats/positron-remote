// Updates of the extension: CI publishes each version as a GitHub release of the infrastructure repository
// (extension.yml: tag fnkc-projects-v<version>, assets fnkc-projects.vsix and its .sha256). The repository is public,
// so the newest release is read without credentials. The extension asks once a day and on request; the vsix is
// checked against its checksum before Positron installs it.
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const VSIX = 'fnkc-projects.vsix';
/** The release's server requirements (extension.yml writes it from `fnkc-ctl --version --json`). */
export const COMPAT = 'fnkc-projects-compat.json';

/** What a release needs from every server it talks to (protocol.ts: PROTOCOL_VERSION, CAPABILITIES). */
export interface Requirements {
  protocol: number;
  capabilities: string[];
}
const TAG_RE = /^fnkc-projects-v([0-9]+\.[0-9]+\.[0-9]+)$/;

export interface Release {
  version: string;
  /** The release page (its notes). */
  url: string;
  vsix: string;
  sha256: string;
  /** Absent for releases published before the requirements file existed. */
  requires?: Requirements;
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
  const compat = asset(COMPAT);
  return { version, url: r.html_url, vsix, sha256, requires: compat ? await requirements(compat) : undefined };
}

async function requirements(url: string): Promise<Requirements> {
  const res = await get(url, 'application/json');
  if (!res.ok) throw new Error(`release requirements: HTTP ${res.status}`);
  const v = await res.json() as Partial<Requirements>;
  if (!Number.isInteger(v.protocol) || !Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === 'string')) {
    throw new Error('release requirements: unexpected content');
  }
  return { protocol: v.protocol!, capabilities: v.capabilities };
}

/** One configured server, as its ping answered (or why it could not be asked). */
export interface ServerState {
  host: string;
  version?: string;
  protocol?: number;
  capabilities?: string[];
  error?: string;
}

/**
 * Whether the servers are ready for a release: upgrades go server first, so a client is offered only once every
 * server it uses can serve it. `behind`: servers that answered without what the release needs; `unknown`: servers
 * that could not be asked. A release without requirements (published before they existed) is not held back.
 */
export function serverReadiness(requires: Requirements | undefined, servers: ServerState[]): { behind: string[]; unknown: string[] } {
  if (!requires) return { behind: [], unknown: [] };
  const behind = servers.filter((s) => !s.error && (s.protocol !== requires.protocol ||
    !requires.capabilities.every((c) => s.capabilities?.includes(c)))).map((s) => `'${s.host}' (fnkc-ctl ${s.version ?? 'unknown'})`);
  const unknown = servers.filter((s) => s.error).map((s) => `'${s.host}'`);
  return { behind, unknown };
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
