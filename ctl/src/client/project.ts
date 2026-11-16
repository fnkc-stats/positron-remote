// Which environment image a project needs: "image" in container.json at the root of its repository.
// The file is fetched from git (a shallow fetch of HEAD into a cache), so no local copy of the project
// is needed. If git is unreachable, the last fetched copy is used.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, runOk } from '../exec.ts';
import type { Logger } from '../log.ts';
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
    return { name: checkProject(name), urls: [arg] };
  }
  const name = checkProject(arg);
  if (!gitRemotes.length) throw new Error('gitRemotes is not set in the config; or give a full git URL');
  return { name, urls: gitRemotes.map((b) => `${b.replace(/\/+$/, '')}/${name}.git`) };
}

const gitEnv = (timeout: number) => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o ConnectTimeout=${timeout}`,
});

/** The image from container.json (or, for older projects, from .devcontainer/devcontainer.json). */
export function imageFromFiles(containerJson: string | undefined, devcontainerJson: string | undefined): string | undefined {
  if (containerJson !== undefined) {
    let v: unknown;
    try {
      v = JSON.parse(containerJson);
    } catch (e) {
      throw new Error(`container.json is not valid JSON: ${(e as Error).message}`);
    }
    const image = (v as Record<string, unknown> | null)?.image;
    if (typeof image !== 'string' || !image) throw new Error('container.json has no "image"');
    return image;
  }
  // devcontainer.json may contain comments (JSONC), so the image is taken with a pattern
  return devcontainerJson?.match(/"image"\s*:\s*"([^"]+)"/)?.[1];
}

export async function readProjectImage(
  src: ProjectSource, cacheDir: string, defaultImage: string | undefined, log: Logger, timeout = 10,
): Promise<string> {
  const cache = join(cacheDir, 'projects', `${src.name}.git`);
  if (!existsSync(cache)) {
    mkdirSync(cache, { recursive: true });
    await runOk('git', ['init', '-q', '--bare', cache]);
  }
  let fetched = false;
  for (const url of src.urls) {
    const r = await run('git', ['-C', cache, 'fetch', '-q', '--depth', '1', url, 'HEAD'], { env: gitEnv(timeout) });
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
  const image = imageFromFiles(await show('container.json'), await show('.devcontainer/devcontainer.json'));
  if (image) return image;
  if (!defaultImage) throw new Error(`project ${src.name} has no container.json with "image", and defaultImage is not set`);
  log.warn(`project ${src.name} has no container.json, using defaultImage ${defaultImage}`);
  return defaultImage;
}
