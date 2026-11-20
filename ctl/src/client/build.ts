// The Positron server for an R environment, on request (fnkc-ctl build, the extension's Build Environment): starts
// the positron workflow of the infrastructure repository on GitHub with an environment image (what container.json
// pins) and a Positron version, follows the run, and returns the published image (positron-<version>-<environment
// digest>, see variant.ts). Projects on that environment then open from that Positron by themselves; nothing is
// pinned. GitHub is reached with the gh command (gh auth login), which also needs the right to run workflows there.
import { randomBytes } from 'node:crypto';
import { run } from '../exec.ts';
import type { Logger } from '../log.ts';
import { checkImage } from '../validate.ts';
import type { ClientConfig } from './config.ts';
import { listTags, tagDigest } from './image-download.ts';
import { positronTag } from './variant.ts';

const WORKFLOW = 'positron.yml';
const POSITRON_RE = /^[0-9]{4}\.[0-9]{2}\.[0-9]+-[0-9]+$/;

export interface BuildRequest {
  /** The R environment image, as container.json pins it. */
  environment: string;
  /** Positron version, e.g. 2026.07.1-5. */
  positron: string;
}

export interface BuildRun {
  id: number;
  url: string;
}

function repository(cfg: ClientConfig): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.envRepository)) throw new Error(`envRepository must be owner/name, not '${cfg.envRepository}'`);
  return cfg.envRepository;
}

export async function gh(args: string[]): Promise<string> {
  const r = await run('gh', args, { timeoutMs: 60_000 }).catch((e: Error) => {
    throw new Error(/not found/.test(e.message) ? 'the gh command is needed: install GitHub CLI (cli.github.com), then run gh auth login' : e.message);
  });
  if (r.code !== 0) {
    const err = r.stderr.trim();
    if (/auth login|not logged/i.test(err)) throw new Error('gh is not logged in to GitHub: run gh auth login');
    throw new Error(`gh ${args[0]}: ${err || `exit code ${r.code}`}`);
  }
  return r.stdout;
}

/** Where the images are: ghcr.io/<owner of the repository, lower case>/r-env. */
export function imageRepository(cfg: ClientConfig): { registry: string; repository: string } {
  return { registry: 'ghcr.io', repository: `${repository(cfg).split('/')[0].toLowerCase()}/r-env` };
}

/** The newest environment tag of each series (<series>-env-<commit>-<run>-<attempt>, image.yml), newest series first. */
export function latestEnvironments(tags: string[]): { series: string; tag: string }[] {
  const best = new Map<string, { tag: string; run: number; attempt: number }>();
  for (const tag of tags) {
    const m = /^([0-9]+\.[0-9]+)-env-[0-9a-f]{40}-(\d+)-(\d+)$/.exec(tag);
    if (!m) continue;
    const [run, attempt] = [Number(m[2]), Number(m[3])];
    const b = best.get(m[1]);
    if (!b || run > b.run || (run === b.run && attempt > b.attempt)) best.set(m[1], { tag, run, attempt });
  }
  return [...best.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })).map(([series, b]) => ({ series, tag: b.tag }));
}

/** The newest published environment of each series and the team's Positron version. */
export async function buildOptions(cfg: ClientConfig): Promise<{ environments: { series: string; image: string }[]; teamPositron?: string }> {
  const repo = repository(cfg);
  const { registry, repository: images } = imageRepository(cfg);
  const [tags, args] = await Promise.all([
    listTags(registry, images),
    gh(['api', `repos/${repo}/contents/env/positron.args?ref=main`, '-H', 'Accept: application/vnd.github.raw']),
  ]);
  const environments = await Promise.all(latestEnvironments(tags).map(async (e) =>
    ({ series: e.series, image: `${registry}/${images}@${await tagDigest(registry, images, e.tag)}` })));
  return { environments, teamPositron: /^POSITRON_VERSION=(.+)$/m.exec(args)?.[1].trim() };
}

/** Positron releases, newest first: the published, non-draft releases of posit-dev/positron on GitHub. */
export async function positronReleases(): Promise<string[]> {
  const out = await gh(['api', 'repos/posit-dev/positron/releases?per_page=60', '--jq',
    '.[] | select(.draft == false and .prerelease == false) | .tag_name']);
  return releaseVersions(out);
}

/** Version-shaped tags only, newest first. */
export function releaseVersions(tags: string): string[] {
  const list = [...new Set(tags.split('\n').map((t) => t.trim()).filter((t) => POSITRON_RE.test(t)))];
  return list.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/** An environment given as an image, or as an R series (its newest published environment). */
export async function environmentOf(cfg: ClientConfig, arg: string): Promise<string> {
  if (/^[0-9]+\.[0-9]+$/.test(arg)) {
    const { registry, repository: images } = imageRepository(cfg);
    const e = latestEnvironments(await listTags(registry, images)).find((x) => x.series === arg);
    if (!e) throw new Error(`no published environment of R ${arg} in ${registry}/${images}`);
    return `${registry}/${images}@${await tagDigest(registry, images, e.tag)}`;
  }
  return checkImage(arg, [`${imageRepository(cfg).registry}/${imageRepository(cfg).repository}`]);
}

/** Starts the workflow and returns its run, found by the id put into its name. */
export async function startBuild(cfg: ClientConfig, req: BuildRequest, log: Logger): Promise<BuildRun> {
  const repo = repository(cfg);
  const { registry, repository: images } = imageRepository(cfg);
  checkImage(req.environment, [`${registry}/${images}`]);
  if (!POSITRON_RE.test(req.positron)) throw new Error(`not a Positron version: ${req.positron}`);
  const releases = await positronReleases();
  if (!releases.includes(req.positron)) {
    throw new Error(`Positron ${req.positron} is not a release (posit-dev/positron on GitHub); recent ones: ${releases.slice(0, 5).join(', ')}`);
  }
  const request = randomBytes(6).toString('hex');
  await gh(['workflow', 'run', WORKFLOW, '-R', repo, '--ref', 'main', '-f', `base=${req.environment}`, '-f', `positron=${req.positron}`, '-f', `request=${request}`]);
  log.info(`Started ${WORKFLOW} in ${repo}: Positron ${req.positron} for ${req.environment}`);
  // The run appears a few seconds after the request
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    const runs = JSON.parse(await gh(['run', 'list', '-R', repo, '--workflow', WORKFLOW, '--event', 'workflow_dispatch',
      '--limit', '20', '--json', 'databaseId,displayTitle,url'])) as { databaseId: number; displayTitle: string; url: string }[];
    const mine = runs.find((r) => r.displayTitle.includes(`[${request}]`));
    if (mine) return { id: mine.databaseId, url: mine.url };
  }
  throw new Error(`the run did not appear: look for "[${request}]" in the Actions tab of ${repo}`);
}

/**
 * Waits for the run to finish (a few minutes: one layer on the environment) and returns the published image.
 * Stopping the wait (signal) leaves the run going: fnkc-ctl build --wait <run id> waits again.
 */
export async function finishBuild(cfg: ClientConfig, req: BuildRequest, runId: number, log: Logger, signal?: AbortSignal): Promise<string> {
  const repo = repository(cfg);
  let last = '';
  for (;;) {
    const v = JSON.parse(await gh(['run', 'view', String(runId), '-R', repo, '--json', 'status,conclusion,url,jobs'])) as {
      status: string; conclusion: string; url: string; jobs: { name: string; status: string }[];
    };
    if (v.status === 'completed') {
      if (v.conclusion !== 'success') throw new Error(`the build ended: ${v.conclusion} (${v.url})`);
      const { registry, repository: images } = imageRepository(cfg);
      return `${registry}/${images}@${await tagDigest(registry, images, positronTag(req.environment, req.positron))}`;
    }
    const running = v.jobs.filter((j) => j.status === 'in_progress').map((j) => j.name).join(', ');
    const now = running ? `running: ${running}` : v.status;
    if (now !== last) log.info(`Build ${now}`);
    last = now;
    await new Promise<void>((res, rej) => {
      const stop = () => { clearTimeout(t); rej(new Error(`stopped waiting; the build goes on: ${v.url}`)); };
      const t = setTimeout(() => { signal?.removeEventListener('abort', stop); res(); }, 15_000);
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  }
}
