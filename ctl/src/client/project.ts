// Which environment image a project needs: "image" in container.json at the root of its repository, and the
// R library ("library", optional) built for that image on the host.
// The file is fetched from git (a shallow fetch of HEAD into a cache), so no local copy of the project
// is needed. If git is unreachable, the last fetched copy is used.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, runOk } from '../exec.ts';
import type { Logger } from '../log.ts';
import { checkRepository, manifestImage, manifestLibrary, repositoryId } from '../repository.ts';
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
    const name = arg.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '');
    checkProject(name);
    return { name: repositoryId(arg), urls: [checkRepository(arg)] };
  }
  const name = checkProject(arg);
  if (!gitRemotes.length) throw new Error('gitRemotes is not set in the config; or give a full git URL');
  const url = checkRepository(`${gitRemotes[0].replace(/\/+$/, '')}/${name}.git`);
  return { name: repositoryId(url), urls: [url] };
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
): Promise<{ image: string; library?: string; revision: string }> {
  return withLock(join(cacheDir, 'locks', `git-${src.name}`), async () => {
    const cache = join(cacheDir, 'projects', `${src.name}.git`);
    if (!existsSync(cache)) {
      mkdirSync(cache, { recursive: true });
      await runOk('git', ['init', '-q', '--bare', cache]);
    }
    let fetched = false;
    for (const url of src.urls) {
      const r = await run('git', ['-C', cache, 'fetch', '-q', '--depth', '1', url, 'HEAD'], { env: gitEnv(timeout), timeoutMs: 60_000 });
      if (r.code === 0) {
        await runOk('git', ['-C', cache, 'update-ref', 'refs/positron/last', 'FETCH_HEAD']);
        fetched = true;
        break;
      }
      log.warn(`${url} is unreachable: ${r.stderr.trim().split('\n').pop() ?? ''}`);
    }
    const has = await run('git', ['-C', cache, 'rev-parse', '-q', '--verify', 'refs/positron/last']);
    if (has.code !== 0) throw new Error(`could not fetch project ${src.name} from ${src.urls.join(' or ')}`);
    if (!fetched) log.warn('the repository is unreachable, using the copy fetched last time');

    const show = async (path: string) => {
      const r = await run('git', ['-C', cache, 'show', `refs/positron/last:${path}`]);
      return r.code === 0 ? r.stdout : undefined;
    };
    const manifest = await show('container.json');
    const image = imageFromFile(manifest);
    const library = manifestLibrary(manifest!);
    const revision = has.stdout.trim();
    return { image, ...(library ? { library } : {}), revision };
  });
}
