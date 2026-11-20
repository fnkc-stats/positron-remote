// Which environment image a project needs: "image" in container.json at the root of its repository. Only that file
// and the commit it belongs to come to this computer: a shallow fetch of HEAD without file contents (a partial
// clone, blob:none) into a cache, then git downloads container.json alone. The repository itself is cloned inside
// the container (fnkc-projects init). If git is unreachable, the last fetched copy is used.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
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
export function imageFromFile(containerJson: string | undefined): string {
  if (containerJson === undefined) throw new Error('project requires container.json with an immutable "image"');
  return manifestImage(containerJson);
}

export async function readProjectRevision(
  src: ProjectSource, cacheDir: string, log: Logger, timeout = 10,
): Promise<{ image: string; revision: string }> {
  return withLock(join(cacheDir, 'locks', `git-${src.name}`), async () => {
    // Per repository URL: repositories of the same name in different organizations never share a cache
    const key = createHash('sha256').update(src.urls[0].replace(/\.git$/, '')).digest('hex').slice(0, 12);
    const cache = join(cacheDir, 'projects', `${src.name}-${key}.git`);
    if (!existsSync(cache)) {
      mkdirSync(cache, { recursive: true });
      await runOk('git', ['init', '-q', '--bare', cache]);
    }
    const config = (k: string, v: string) => runOk('git', ['-C', cache, 'config', k, v]);
    // A promisor remote: file contents stay on the server until one is read (git show below)
    for (const [k, v] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'],
      ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none']]) await config(k, v);
    let fetched = false;
    for (const url of src.urls) {
      await config('remote.origin.url', url);
      const r = await run('git', ['-C', cache, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', 'HEAD'], { env: gitEnv(timeout), timeoutMs: 60_000 });
      if (r.code === 0) {
        await runOk('git', ['-C', cache, 'update-ref', 'refs/fnkc/last', 'FETCH_HEAD']);
        fetched = true;
        break;
      }
      log.warn(`${url} is unreachable: ${r.stderr.trim().split('\n').pop() ?? ''}`);
    }
    const has = await run('git', ['-C', cache, 'rev-parse', '-q', '--verify', 'refs/fnkc/last']);
    if (has.code !== 0) throw new Error(`could not fetch project ${src.name} from ${src.urls.join(' or ')}`);
    if (!fetched) log.warn('the repository is unreachable, using the copy fetched last time');

    const show = async (path: string) => {
      const r = await run('git', ['-C', cache, 'show', `refs/fnkc/last:${path}`], { env: gitEnv(timeout), timeoutMs: 60_000 });
      return r.code === 0 ? r.stdout : undefined;
    };
    const image = imageFromFile(await show('container.json'));
    const revision = has.stdout.trim();
    return { image, revision };
  });
}

/** container.json with "image" replaced, other fields kept. */
export function pinImage(containerJson: string, image: string): string {
  const m = JSON.parse(containerJson) as Record<string, unknown>;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('container.json is not a JSON object');
  return `${JSON.stringify({ ...m, image }, null, 2)}\n`;
}
