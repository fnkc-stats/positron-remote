// The project's environment for this computer's Positron. container.json pins one image, built with the team's
// Positron server; someone on another Positron build needs the same environment with their server. Build
// Environment publishes such images as <series>-positron-<version>-<commit>-<run>-<attempt>, from the series'
// renv.lock: the r-env.lock-sha256 label tells that two images have the same R packages. Open looks for the newest
// one with the pinned image's checksum and this Positron's commit, and the host runs it instead (agent.ts). The
// repository is not changed: everyone keeps the pin, and each Positron build gets its server.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_LABEL } from '../layout.ts';
import type { Logger } from '../log.ts';
import { hexOf, parseReference } from '../oci.ts';
import { imageLabels, listTags, tagDigest } from './image-download.ts';

export interface PositronClientBuild {
  version: string;
  commit: string;
}

export interface Variant {
  image: string;
  lockSha256: string;
}

/** The pinned image serves another Positron build, and no image of its environment for this one exists yet. */
export class PositronMismatch extends Error {
  readonly series: string;
  readonly positron: string;
  constructor(series: string, built: string, positron: string) {
    super(`this project's image is built for Positron ${built}, and there is no image of the same environment for ` +
      `your Positron ${positron} yet. Build it once (it takes a few minutes): FNKC Projects: Build Environment, R ${series}, ` +
      `Positron ${positron} (or: fnkc-ctl build ${series} --positron ${positron}). Then open the project again.`);
    this.series = series;
    this.positron = positron;
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tags of multi-architecture images built for this Positron version from the series, newest run first. */
export function variantTags(tags: string[], series: string, version: string): string[] {
  const re = new RegExp(`^${escape(series)}-positron-${escape(version)}-[0-9a-f]{40}-(\\d+)-(\\d+)$`);
  const found = tags.flatMap((t) => { const m = re.exec(t); return m ? [{ t, run: Number(m[1]), attempt: Number(m[2]) }] : []; });
  return found.sort((a, b) => b.run - a.run || b.attempt - a.attempt).map((f) => f.t);
}

/** An image's labels, kept per digest in the cache: a digest's labels never change. */
async function labelsOf(cacheDir: string, registry: string, repository: string, digest: string): Promise<Record<string, string>> {
  const file = join(cacheDir, 'images', 'labels', `${hexOf(digest)}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch { /* not cached yet */ }
  const labels = await imageLabels(registry, repository, digest);
  mkdirSync(join(cacheDir, 'images', 'labels'), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(labels));
  renameSync(`${file}.tmp`, file);
  return labels;
}

/**
 * undefined: run the pinned image (it serves this Positron, or this computer cannot tell; then the host decides).
 * A Variant: the same environment for this Positron. Throws PositronMismatch if there is none.
 */
export async function positronVariant(cacheDir: string, pinned: string, client: PositronClientBuild, log: Logger): Promise<Variant | undefined> {
  const { registry, repository, digest } = parseReference(pinned);
  let labels: Record<string, string>;
  try {
    labels = await labelsOf(cacheDir, registry, repository, digest);
  } catch (e) {
    // fetch only says "fetch failed"; the reason (no network, refused, DNS) is its cause
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    const why = [(e as Error).message, cause?.code ?? cause?.message].filter(Boolean).join(': ');
    log.warn(`could not read the labels of ${pinned} (${why}); the host checks its Positron build`);
    return undefined;
  }
  if (labels[IMAGE_LABEL.positronCommit] === client.commit) return undefined;
  const lock = labels[IMAGE_LABEL.renvLock];
  const series = labels[IMAGE_LABEL.rSeries];
  // An image from before the label: nothing to compare with, the host refuses it with its usual message
  if (!lock || !series) return undefined;
  for (const tag of variantTags(await listTags(registry, repository), series, client.version)) {
    const found = await tagDigest(registry, repository, tag);
    const l = await labelsOf(cacheDir, registry, repository, found);
    if (l[IMAGE_LABEL.renvLock] !== lock || l[IMAGE_LABEL.positronCommit] !== client.commit) continue;
    const image = `${registry}/${repository}@${found}`;
    log.info(`Your Positron ${client.version}: using ${image}, the project's environment built for it (${tag})`);
    return { image, lockSha256: lock };
  }
  throw new PositronMismatch(series, labels[IMAGE_LABEL.positronVersion] ?? 'another build', client.version);
}
