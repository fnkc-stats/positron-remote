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

/** A project name (looked up under gitRemotes) or a full git URL. */
export function projectSource(arg: string, gitRemotes: string[]): ProjectSource {
  if (/:\/\/|^[^/]+@[^/]+:/.test(arg)) {
    const url = checkRepository(arg);
    return { name: repositoryName(url), urls: [url] };
  }
  const name = checkProject(arg);
  if (!gitRemotes.length) throw new Error('gitRemotes is not set in the config; or give a full git URL');
  const url = checkRepository(`${gitRemotes[0].replace(/\/+$/, '')}/${name}.git`);
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
