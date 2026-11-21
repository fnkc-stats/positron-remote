// The image a project container runs. container.json pins the project's R environment (env/Dockerfile), which has no
// Positron server; the server of each Positron build is one more layer on top (env/positron.Dockerfile), published
// as positron-<version>-<environment digest> (positron.yml). Open derives that tag from the pin and this computer's
// Positron, checks that the image is built on the pin (r-env.base) for this Positron (positron.commit), and the
// host runs it after checking the same (agent.ts). The repository does not change: everyone keeps the pin, each
// Positron build gets its server, and a new Positron needs only new server layers, not new pins.
// Projects that still pin an image with a server built in (before environments were separate) run that image.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_LABEL } from '../layout.ts';
import type { Logger } from '../log.ts';
import { hexOf, parseReference } from '../oci.ts';
import { imageLabels, tagDigest } from './image-download.ts';

export interface PositronClientBuild {
  version: string;
  commit: string;
}

/** The tag of the environment `environment` with the server of Positron `version` (positron.yml). */
export function positronTag(environment: string, version: string): string {
  return `positron-${version}-${hexOf(parseReference(environment).digest)}`;
}

/** The project's environment has no image for this Positron yet: Build Environment makes it in a few minutes. */
export class NoPositronImage extends Error {
  readonly environment: string;
  readonly positron: string;
  constructor(environment: string, positron: string, series?: string) {
    super(`the project's environment${series ? ` (R ${series})` : ''} has no image for your Positron ${positron} yet. ` +
      `An administrator adds the Positron server to it once (a few minutes): FNKC Projects: Build Environment, ` +
      `or fnkc-ctl build ${environment} --positron ${positron}. Then open the project again.`);
    this.environment = environment;
    this.positron = positron;
  }
}

/**
 * The team's Positron version: env/positron.args on the main branch of the infrastructure repository (what new
 * environments are built with). Read from GitHub when `online`, else (or when GitHub does not answer) the version
 * read last time; undefined if it was never read. Never throws.
 */
export async function teamPositron(cacheDir: string, envRepository: string, online = true): Promise<string | undefined> {
  const file = join(cacheDir, 'team-positron.json');
  if (online && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(envRepository)) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${envRepository}/main/env/positron.args`, { signal: AbortSignal.timeout(10_000) });
      const version = res.ok ? /^POSITRON_VERSION=([0-9]{4}\.[0-9]{2}\.[0-9]+-[0-9]+)\s*$/m.exec(await res.text())?.[1] : undefined;
      if (version) {
        try { writeJson(file, { version }); } catch { /* shown without the cache */ }
        return version;
      }
    } catch { /* offline: the version read last time */ }
  }
  return readJson<{ version?: string }>(file)?.version;
}

/** The two ways out when this Positron differs from the team's: an administrator builds for it, or Positron is updated. */
export function teamPositronNote(mine: string, team: string | undefined): string | undefined {
  if (!team || team === mine) return undefined;
  return `The team uses Positron ${team}: projects open from yours once an administrator builds the environment for it, or after you update Positron to ${team}.`;
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}
function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}

/** An image's labels, kept per digest in the cache: a digest's labels never change. */
async function labelsOf(cacheDir: string, registry: string, repository: string, digest: string): Promise<Record<string, string>> {
  const file = join(cacheDir, 'images', 'labels', `${hexOf(digest)}.json`);
  const cached = readJson<Record<string, string>>(file);
  if (cached) return cached;
  const labels = await imageLabels(registry, repository, digest);
  writeJson(file, labels);
  return labels;
}

const reason = (e: unknown) => {
  // fetch only says "fetch failed"; the reason (no network, refused, DNS) is its cause
  const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
  return [(e as Error).message, cause?.code ?? cause?.message].filter(Boolean).join(': ');
};

/** Forgets the image chosen for this pin and Positron build: the next imageToRun looks it up in the registry again. */
export function forgetChoice(cacheDir: string, pinned: string, commit: string) {
  rmSync(join(cacheDir, 'images', 'positron', `${hexOf(parseReference(pinned).digest)}-${commit}.json`), { force: true });
}

/**
 * The image to run for the pinned `image`: undefined to run the pin itself (an image with a server built in, or
 * this computer cannot tell; the host then checks it), or the environment's image for this Positron. Throws
 * NoPositronImage if that is not published yet.
 */
export async function imageToRun(cacheDir: string, pinned: string, client: PositronClientBuild, log: Logger): Promise<{ image: string } | undefined> {
  const { registry, repository, digest } = parseReference(pinned);
  // The choice made before, for this pin and this Positron build: Open works without the registry from then on
  const chosen = join(cacheDir, 'images', 'positron', `${hexOf(digest)}-${client.commit}.json`);
  const before = readJson<{ image: string }>(chosen);
  if (before) return before;
  let labels: Record<string, string>;
  try {
    labels = await labelsOf(cacheDir, registry, repository, digest);
  } catch (e) {
    log.warn(`could not read the labels of ${pinned} (${reason(e)}); the host checks the image`);
    return undefined;
  }
  if (labels[IMAGE_LABEL.positronCommit]) return undefined; // a server is built in: run it, if it is this Positron
  const tag = positronTag(pinned, client.version);
  let found: string;
  try {
    found = await tagDigest(registry, repository, tag);
  } catch (e) {
    if (/HTTP 404/.test((e as Error).message)) throw new NoPositronImage(pinned, client.version, labels[IMAGE_LABEL.rSeries]);
    throw new Error(`could not look up ${tag} in ${registry}/${repository}: ${reason(e)}`);
  }
  const l = await labelsOf(cacheDir, registry, repository, found);
  if (l[IMAGE_LABEL.base] !== pinned || l[IMAGE_LABEL.positronCommit] !== client.commit) {
    throw new Error(`${repository}:${tag} is not the project's environment for this Positron (built on ` +
      `'${l[IMAGE_LABEL.base] ?? ''}' for commit ${l[IMAGE_LABEL.positronCommit] ?? '?'}, this Positron is ${client.commit})`);
  }
  const image = { image: `${registry}/${repository}@${found}` };
  log.info(`The project's environment with the server of your Positron ${client.version}: ${image.image}`);
  writeJson(chosen, image);
  return image;
}
