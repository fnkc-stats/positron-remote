// New environment images on request (fnkc-ctl build, the extension's Build Environment): starts the env-image
// workflow of the infrastructure repository on GitHub with an R series and a Positron version, follows the run, and
// returns the published image pinned by its digest, ready for container.json. GitHub is reached with the gh command
// (gh auth login), which also needs the right to run workflows in that repository.
import { randomBytes } from 'node:crypto';
import { run } from '../exec.ts';
import type { Logger } from '../log.ts';
import type { ClientConfig } from './config.ts';
import { tagDigest } from './image-download.ts';

const WORKFLOW = 'env-image.yml';
const POSITRON_RE = /^[0-9]{4}\.[0-9]{2}\.[0-9]+-[0-9]+$/;

export interface BuildRequest {
  /** R series: a folder under env/versions, e.g. 4.6. */
  series: string;
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

async function gh(args: string[]): Promise<string> {
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

/** The R series the repository can build, and its team Positron version. */
export async function buildOptions(cfg: ClientConfig): Promise<{ series: string[]; teamPositron?: string }> {
  const repo = repository(cfg);
  const [dirs, args] = await Promise.all([
    gh(['api', `repos/${repo}/contents/env/versions?ref=main`, '--jq', '.[] | select(.type == "dir") | .name']),
    gh(['api', `repos/${repo}/contents/env/positron.args?ref=main`, '-H', 'Accept: application/vnd.github.raw']),
  ]);
  return {
    series: dirs.split('\n').map((l) => l.trim()).filter((l) => /^[0-9]+\.[0-9]+$/.test(l)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
    teamPositron: /^POSITRON_VERSION=(.+)$/m.exec(args)?.[1].trim(),
  };
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

/** The image variant CI publishes: the series, or <series>-positron-<version> for another Positron than the team's. */
export function variantOf(req: BuildRequest, teamPositron: string | undefined): string {
  return req.positron === teamPositron ? req.series : `${req.series}-positron-${req.positron}`;
}

/** The tag env-image.yml publishes the multi-architecture image under (image.yml, publish-manifest). */
export function publishedTag(variant: string, headSha: string, runId: number, attempt: number): string {
  return `${variant}-${headSha}-${runId}-${attempt}`;
}

/** Where the images go: ghcr.io/<owner of the repository, lower case>/r-env. */
export function imageRepository(cfg: ClientConfig): { registry: string; repository: string } {
  return { registry: 'ghcr.io', repository: `${repository(cfg).split('/')[0].toLowerCase()}/r-env` };
}

/** Starts the workflow and returns its run, found by the id put into its name. */
export async function startBuild(cfg: ClientConfig, req: BuildRequest, log: Logger): Promise<BuildRun> {
  const repo = repository(cfg);
  if (!/^[0-9]+\.[0-9]+$/.test(req.series)) throw new Error(`not an R series: ${req.series}`);
  if (!POSITRON_RE.test(req.positron)) throw new Error(`not a Positron version: ${req.positron}`);
  const releases = await positronReleases();
  if (!releases.includes(req.positron)) {
    throw new Error(`Positron ${req.positron} is not a release (posit-dev/positron on GitHub); recent ones: ${releases.slice(0, 5).join(', ')}`);
  }
  const request = randomBytes(6).toString('hex');
  await gh(['workflow', 'run', WORKFLOW, '-R', repo, '--ref', 'main', '-f', `series=${req.series}`, '-f', `positron=${req.positron}`, '-f', `request=${request}`]);
  log.info(`Started ${WORKFLOW} in ${repo}: R ${req.series}, Positron ${req.positron}`);
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
 * Waits for the run to finish (a build takes up to two hours) and returns the image to pin. Stopping the wait
 * (signal) leaves the run going: run fnkc-ctl build --wait <run id> to wait again.
 */
export async function finishBuild(cfg: ClientConfig, req: BuildRequest, runId: number, log: Logger, signal?: AbortSignal): Promise<string> {
  const repo = repository(cfg);
  let last = '';
  for (;;) {
    const v = JSON.parse(await gh(['run', 'view', String(runId), '-R', repo, '--json', 'status,conclusion,headSha,attempt,url,jobs'])) as {
      status: string; conclusion: string; headSha: string; attempt: number; url: string; jobs: { name: string; status: string }[];
    };
    if (v.status === 'completed') {
      if (v.conclusion !== 'success') throw new Error(`the build ended: ${v.conclusion} (${v.url})`);
      const { teamPositron } = await buildOptions(cfg);
      const tag = publishedTag(variantOf(req, teamPositron), v.headSha, runId, v.attempt);
      const { registry, repository: imageRepo } = imageRepository(cfg);
      const digest = await tagDigest(registry, imageRepo, tag);
      return `${registry}/${imageRepo}@${digest}`;
    }
    const running = v.jobs.filter((j) => j.status === 'in_progress').map((j) => j.name).join(', ');
    const now = running ? `running: ${running}` : v.status;
    if (now !== last) log.info(`Build ${now}`);
    last = now;
    await new Promise<void>((res, rej) => {
      const stop = () => { clearTimeout(t); rej(new Error(`stopped waiting; the build goes on: ${v.url}`)); };
      const t = setTimeout(() => { signal?.removeEventListener('abort', stop); res(); }, 30_000);
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  }
}

/** container.json with "image" replaced, other fields kept. */
export function pinImage(containerJson: string, image: string): string {
  const m = JSON.parse(containerJson) as Record<string, unknown>;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('container.json is not a JSON object');
  return `${JSON.stringify({ ...m, image }, null, 2)}\n`;
}
