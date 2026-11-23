// Which environment image a project needs: "image" in container.json at the root of its repository. Only that file
// and the commit it belongs to come to this computer: a shallow fetch of HEAD without file contents (a partial
// clone, blob:none) into a cache, then git downloads container.json alone. The repository itself is cloned inside
// the container (fnkc-projects init). If git is unreachable, the last fetched copy is used.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, runOk } from '../exec.ts';
import type { Logger } from '../log.ts';
import { checkRepository, manifestImage, repositoryName } from '../repository.ts';
import { withLock } from '../lock.ts';
import { checkProject } from '../validate.ts';

export interface ProjectSource {
  name: string;
  /** Addresses of the same repository, tried in order. */
  urls: string[];
}

/** A git remote split into its server part and host: ssh://git@gitea:2221/stats -> ssh://git@gitea:2221/, gitea. */
function splitRemote(remote: string): { server: string; host: string } {
  const r = remote.replace(/\/+$/, '');
  const scp = /^([^/@:]+@([^/:]+):)/.exec(r);
  if (scp && !r.includes('://')) return { server: scp[1], host: scp[2].toLowerCase() };
  const url = /^([a-z]+:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?)(?:\/.*)?$/.exec(r);
  if (!url) throw new Error(`gitRemotes: cannot read '${remote}'`);
  return { server: `${url[1]}/`, host: url[2].toLowerCase() };
}

/**
 * What can be given for a project:
 *   thesis                                  a repository of the organization in gitRemotes (the first remote)
 *   a.ivanova/thesis                        a repository of another owner on the same Gitea
 *   https://gitea.lan/a.ivanova/thesis/...  a link from Gitea's web pages (any page of the repository): cloned over
 *                                           SSH like the others when its host is that of a git remote
 *   ssh://git@gitea.lan:2221/a.ivanova/thesis.git, git@gitea.lan:a.ivanova/thesis.git   the git URL itself
 */
export function projectSource(arg: string, gitRemotes: string[]): ProjectSource {
  arg = arg.trim();
  const web = /^https?:\/\/([^/:]+)(?::\d+)?\/([^/?#]+)\/([^/?#]+)/.exec(arg);
  const remote = web && gitRemotes.find((r) => splitRemote(r).host === web[1].toLowerCase());
  if (web && remote) return underRemote(remote, web[2], web[3]);
  if (/:\/\/|^[^/]+@[^/]+:/.test(arg)) {
    const url = checkRepository(arg);
    return { name: repositoryName(url), urls: [url] };
  }
  if (!gitRemotes.length) throw new Error('gitRemotes is not set in the config; or give a full git URL');
  const owned = /^([^/]+)\/([^/]+)$/.exec(arg);
  if (owned) return underRemote(gitRemotes[0], owned[1], owned[2]);
  const url = checkRepository(`${gitRemotes[0].replace(/\/+$/, '')}/${checkProject(arg)}.git`);
  return { name: repositoryName(url), urls: [url] };
}

/** owner/name on the server of a git remote, as a URL of the same form as the remote. */
function underRemote(remote: string, owner: string, name: string): ProjectSource {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(owner)) throw new Error(`invalid repository owner: '${owner}'`);
  const url = checkRepository(`${splitRemote(remote).server}${owner}/${checkProject(name.replace(/\.git$/, ''))}.git`);
  return { name: repositoryName(url), urls: [url] };
}

const gitEnv = (timeout: number) => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=${timeout}`,
});

/** Require the same project manifest used by the server and initialized checkout. */
export function imageFromFile(containerJson: string | undefined, project = 'the project'): string {
  if (containerJson === undefined) {
    throw new Error(`${project} has no container.json, so it was not created from a project template. Create the repository ` +
      'in Gitea with New Repository → Template (e.g. template-r-4.6), or ask an administrator to add container.json');
  }
  return manifestImage(containerJson);
}

/**
 * No copy of the project could be fetched, now or before. The message says why in plain words (fetchFailure);
 * `reasons`: git's reason per URL.
 */
export class ProjectUnreachable extends Error {
  readonly reasons: string[];
  constructor(message: string, reasons: string[]) {
    super(message);
    this.reasons = reasons;
  }
}

/** git's reason for a failed fetch: its advice after every failure ("Could not read from remote repository …") is not one. */
function gitReason(stderr: string): string | undefined {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !/Could not read from remote repository|correct access rights|repository exists/.test(l)) ?? lines.pop();
}

/** Why a project's first fetch failed, from git's stderr: the common cases in plain words, else git's own reason. */
export function fetchFailure(src: ProjectSource, stderr: string): string {
  const path = /([^/:]+\/[^/]+?)(?:\.git)?$/.exec(src.urls[0])?.[1] ?? src.name;
  if (/Permission denied \(publickey|Too many authentication failures/.test(stderr)) {
    return 'Gitea did not accept your SSH key (Permission denied). Run Check Setup: the SSH key and ssh-agent rows show what to fix';
  }
  if (/Host key verification failed|host key for .* has changed/i.test(stderr)) {
    return "this computer does not trust the Gitea server's key. Run Check Setup: the Gitea row shows how to confirm it " +
      "with your administrator's fingerprint";
  }
  if (/does not appear to be a git repository|repository not found|cannot find repository|repository does not exist|not authorized|unauthorized/i.test(stderr)) {
    return `Gitea has no repository ${path} that you can read. Check the name (as in the Gitea address bar, e.g. ` +
      'muhina-PI-2026-1) and that you have access to it';
  }
  const why = gitReason(stderr);
  return `could not fetch project ${src.name} from ${src.urls.join(' or ')}${why ? `: ${why}` : ''}`;
}

/**
 * The cache is initialized beside its final path and renamed into place, so an interrupted first Open never leaves
 * a directory that looks initialized. A cache that is not a bare repository (left by an older client) is replaced:
 * an empty one silently, one with contents is kept aside for inspection. Call under the cache lock.
 */
export async function ensureBareCache(cache: string, log: Logger): Promise<void> {
  if (existsSync(cache)) {
    const ok = await run('git', ['--git-dir', cache, 'rev-parse', '--is-bare-repository']);
    if (ok.code === 0 && ok.stdout.trim() === 'true') return;
    if (readdirSync(cache).length) {
      const aside = `${cache}.broken-${Date.now()}`;
      renameSync(cache, aside);
      log.warn(`the project cache ${cache} was damaged; kept it as ${aside} and fetch again`);
    } else rmSync(cache, { recursive: true, force: true });
  }
  const tmp = `${cache}.init-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await runOk('git', ['init', '-q', '--bare', tmp]);
  renameSync(tmp, cache);
}

/**
 * container.json at `rev` in the cache. Trees are local (blob:none), so a commit without the file is known without
 * the network; its contents may still have to come from the server ('unreadable': that read failed, and why).
 */
async function manifestAt(cache: string, rev: string, timeout: number, timeoutMs: number):
  Promise<{ text: string } | { missing: true } | { unreadable: string }> {
  const entry = await run('git', ['-C', cache, 'ls-tree', '--name-only', rev, '--', 'container.json']);
  if (entry.code === 0 && !entry.stdout.trim()) return { missing: true };
  try {
    const r = await run('git', ['-C', cache, 'show', `${rev}:container.json`], { env: gitEnv(timeout), timeoutMs });
    return r.code === 0 ? { text: r.stdout } : { unreadable: gitReason(r.stderr) ?? `git exited with ${r.code}` };
  } catch (e) {
    return { unreadable: (e as Error).message };
  }
}

/**
 * The pin and commit of the project's default branch; `stale`: Gitea was unreachable, so they are from the last fetch.
 * refs/fnkc/last is the last commit whose container.json was read: it moves only once the new one is read and valid,
 * so a connection lost between the fetch and that read, or a fetch that times out, keeps the last usable pair. A HEAD
 * without container.json, or with an invalid one, is the project's answer, not an outage: it is an error.
 */
export async function readProjectRevision(
  src: ProjectSource, cacheDir: string, log: Logger, timeout = 10, timeoutMs = 60_000,
): Promise<{ image: string; revision: string; stale: boolean }> {
  return withLock(join(cacheDir, 'locks', `git-${src.name}`), async () => {
    // Per repository URL: repositories of the same name in different organizations never share a cache
    const key = createHash('sha256').update(src.urls[0].replace(/\.git$/, '')).digest('hex').slice(0, 12);
    const cache = join(cacheDir, 'projects', `${src.name}-${key}.git`);
    await ensureBareCache(cache, log);
    const config = (k: string, v: string) => runOk('git', ['-C', cache, 'config', k, v]);
    // A promisor remote: file contents stay on the server until one is read (manifestAt)
    for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'],
      ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none']]) await config(k, v);
    let reason = '';
    const reasons: string[] = [];
    const unreachable = (url: string, why: string) => {
      reasons.push(`${url} is unreachable: ${why}`);
      log.warn(reasons[reasons.length - 1]);
    };
    for (const url of src.urls) {
      await config('remote.origin.url', url);
      let r;
      try {
        r = await run('git', ['-C', cache, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', 'HEAD'], { env: gitEnv(timeout), timeoutMs });
      } catch (e) { // timed out
        reason = (e as Error).message;
        unreachable(url, reason);
        continue;
      }
      if (r.code !== 0) {
        reason = r.stderr.trim();
        unreachable(url, gitReason(reason) ?? `git exited with ${r.code}`);
        continue;
      }
      const revision = (await runOk('git', ['-C', cache, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
      const m = await manifestAt(cache, revision, timeout, timeoutMs);
      if ('unreadable' in m) {
        reason = m.unreadable;
        unreachable(url, `could not read container.json of ${revision.slice(0, 12)}: ${m.unreadable}`);
        continue;
      }
      const image = imageFromFile('text' in m ? m.text : undefined, src.name);
      await runOk('git', ['-C', cache, 'update-ref', 'refs/fnkc/last', revision]);
      return { image, revision, stale: false };
    }
    const has = await run('git', ['-C', cache, 'rev-parse', '-q', '--verify', 'refs/fnkc/last^{commit}']);
    if (has.code !== 0) throw new ProjectUnreachable(fetchFailure(src, reason), reasons);
    const revision = has.stdout.trim();
    const m = await manifestAt(cache, revision, timeout, timeoutMs);
    // Only in a cache left by an older client, which moved the ref before reading the file
    if ('unreadable' in m) throw new ProjectUnreachable(fetchFailure(src, reason || m.unreadable), reasons);
    log.warn('the repository is unreachable, using the copy fetched last time');
    return { image: imageFromFile('text' in m ? m.text : undefined, src.name), revision, stale: true };
  });
}

/** container.json with "image" replaced, other fields kept. */
export function pinImage(containerJson: string, image: string): string {
  const m = JSON.parse(containerJson) as Record<string, unknown>;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('container.json is not a JSON object');
  return `${JSON.stringify({ ...m, image }, null, 2)}\n`;
}
