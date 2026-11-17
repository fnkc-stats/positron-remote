// R package libraries on a host. A library is built from a lockfile for one image (positron-ctl admin
// build-library), checked with the R environment checks (checks/), and only then marked ready. Projects that
// pin it in container.json ("library") get it mounted read-only over the image's site library.
import { createHash } from 'node:crypto';
import { BUILD_LIBRARY } from './assets.ts';
import { CHECK_FILES } from './checks.ts';
import type { Docker } from './docker.ts';
import { LABEL, LIBRARY_META, libraryVolume, R_SITE_LIBRARY } from './layout.ts';
import type { Logger } from './log.ts';
import { tarOf } from './tar.ts';

export const lockfileHash = (text: string | Buffer) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** A renv lockfile: JSON with the R version and at least one package. */
export function checkLockfile(text: string): void {
  let v: { R?: { Version?: unknown }; Packages?: Record<string, { Version?: unknown }> };
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('the lockfile is not JSON (expected a renv.lock)');
  }
  if (typeof v?.R?.Version !== 'string') throw new Error('the lockfile has no R version (expected a renv.lock)');
  const packages = Object.values(v.Packages ?? {});
  if (!packages.length || !packages.every((p) => typeof p?.Version === 'string')) throw new Error('the lockfile lists no packages with versions');
}

export type LibraryState = 'ready' | 'unfinished' | 'missing';

/** "unfinished": the volume exists, but its build or checks did not finish; build-library continues it. */
export async function libraryState(d: Docker, image: string, volume: string): Promise<LibraryState> {
  const v = await d.run(['volume', 'inspect', volume]);
  if (v.code !== 0) {
    if (/no such volume/i.test(v.stderr)) return 'missing';
    throw new Error(`cannot inspect library volume: ${v.stderr}`);
  }
  const r = await d.run(['run', '--rm', '--network', 'none', '--user', '1000:1000', '--memory', '256m', '--cpus', '1',
    '--pids-limit', '64', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '-v', `${volume}:/l:ro`, '--entrypoint', 'test', image, '-f', `/l/${LIBRARY_META}/ready`]);
  return r.code === 0 ? 'ready' : 'unfinished';
}

/** The error Start gives when a project's library is not ready on the host. */
export function libraryMissing(library: string, image: string, state: LibraryState, local: boolean): Error {
  const how = local ? 'positron-ctl build-library' : 'an administrator runs: sudo positron-ctl admin build-library';
  const what = state === 'missing' ? 'is not built on this host' : 'was not finished or did not pass its checks on this host';
  return new Error(`the project's R library ${library.slice(0, 19)}... ${what} for ${image}; ${how} ${image} <its renv.lock>`);
}

export interface BuildOptions {
  /** Parallel compiler jobs (default: the host's CPUs). */
  jobs: number;
  /** Mark ready without running the checks. */
  skipChecks: boolean;
  /** The R repository packages are built from (the host's rRepository). */
  repository: string;
}

export interface BuildResult {
  library: string;
  volume: string;
  existing: boolean;
  checks: 'passed' | 'skipped';
}

const HOURS = 60 * 60_000;

/**
 * Builds `lockfile` into the library volume for `image` (whose ID is `imageId`), runs the checks with the library
 * mounted as projects see it, and marks it ready. An unfinished build is continued, a ready library is never
 * changed. The caller holds a lock for this library; this does not hold the host lock, so other projects can
 * start during the build.
 */
export async function buildLibrary(d: Docker, image: string, imageId: string, lockfile: string, o: BuildOptions, log: Logger): Promise<BuildResult> {
  checkLockfile(lockfile);
  const library = lockfileHash(lockfile);
  const volume = libraryVolume(imageId, library);
  const state = await libraryState(d, image, volume);
  if (state === 'ready') return { library, volume, existing: true, checks: 'passed' };
  if (state === 'missing') {
    await d.ok(['volume', 'create', '--label', `${LABEL.managed}=1`, '--label', `${LABEL.library}=${library}`,
      '--label', `${LABEL.libraryImage}=${imageId}`, volume]);
  } else log.warn(`Continuing the unfinished library ${volume}`);

  const suffix = volume.replace(/^positron-rlib-/, '');
  const build = `positron-library-build-${suffix}`;
  const checks = `positron-library-check-${suffix}`;
  const helper = (script: string) => ['run', '--rm', '--user', '0', '--network', 'none', '-v', `${volume}:/library`,
    '--entrypoint', 'sh', image, '-c', script];
  try {
    await d.run(['rm', '-f', build, checks]);
    log.info(`Building ${Object.keys(JSON.parse(lockfile).Packages).length} packages from ${o.repository} into ${volume} (a full lockfile takes 20 to 60 minutes)`);
    await d.ok(['create', '--name', build, '--label', `${LABEL.managed}=1`, '--user', '0', '--cpus', String(o.jobs),
      '-e', `POSITRON_R_REPOSITORY=${o.repository}`, '-e', `POSITRON_BUILD_JOBS=${o.jobs}`,
      '-e', `POSITRON_LIBRARY_HASH=${library.slice(7)}`,
      '-e', `POSITRON_IMAGE_ID=${imageId}`, '-v', `${volume}:/library`, '-w', '/tmp',
      // R's output to stderr, which is shown as it arrives
      '--entrypoint', 'sh', image, '-c', 'exec Rscript /build/build-library.R 1>&2']);
    await d.ok(['cp', '-', `${build}:/`], { input: tarOf([
      { name: 'build/renv.lock', mode: 0o644, data: lockfile },
      { name: 'build/build-library.R', mode: 0o644, data: BUILD_LIBRARY },
    ]) });
    const r = await d.run(['start', '-a', build], { timeoutMs: 8 * HOURS, onStderr: (l) => log.info(`  ${l}`) });
    if (r.code !== 0) throw new Error(`the library build failed (see above); run build-library again to continue it`);
    // Readable for every user, not writable; the analyst user writes only the check results
    await d.ok(helper(`chmod -R a+rX,go-w /library && rm -rf /library/${LIBRARY_META}/checks && install -d -o 1000 -g 1000 /library/${LIBRARY_META}/checks`));

    if (!o.skipChecks) {
      log.info('Checking the library: package requirements and common tasks (checks/)');
      await d.ok(['create', '--name', checks, '--label', `${LABEL.managed}=1`, '--network', 'none', '--user', '1000:1000',
        '-e', 'HOME=/tmp', '-e', 'R_MAX_NUM_DLLS=500', '-w', '/tmp',
        '-v', `${volume}:${R_SITE_LIBRARY}:ro`, '-v', `${volume}:/meta`,
        '--entrypoint', 'sh', image, '-c', 'exec Rscript /checks/check.R "$0" 1>&2', `/meta/${LIBRARY_META}/checks`]);
      await d.ok(['cp', '-', `${checks}:/`], { input: tarOf(Object.entries(CHECK_FILES).map(([name, data]) => ({ name: `checks/${name}`, mode: 0o644, data }))) });
      const c = await d.run(['start', '-a', checks], { timeoutMs: 2 * HOURS, onStderr: (l) => log.info(`  ${l}`) });
      if (c.code !== 0) throw new Error(`the library did not pass the checks; it is not marked ready. Results: ${LIBRARY_META}/checks in volume ${volume}`);
    }
    const status = o.skipChecks ? 'skipped' : 'passed';
    await d.ok(helper(`chown -R 0:0 /library/${LIBRARY_META} && printf 'checks: %s\\nready: %s\\n' '${status}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /library/${LIBRARY_META}/ready`));
    return { library, volume, existing: false, checks: status };
  } finally {
    await d.run(['rm', '-f', build, checks]);
  }
}

export interface LibraryInfo {
  volume: string;
  library: string;
  image: string;
}

export async function listLibraries(d: Docker): Promise<LibraryInfo[]> {
  const out = await d.ok(['volume', 'ls', '--filter', `label=${LABEL.library}`, '--format', `{{.Name}}\t{{.Label "${LABEL.library}"}}\t{{.Label "${LABEL.libraryImage}"}}`]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [volume, library, image] = l.split('\t');
    return { volume, library, image };
  });
}
