// The environment images an administrator looks after (the Images panel, fnkc-ctl images): what is published in the
// registry, which image each Gitea template pins, and which images each host holds and its containers use.
// Everything here only reads: the registry anonymously (public images), the templates with git like Open does, the
// hosts with the agent's images command. Each source can fail on its own; the rest is still shown.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log.ts';
import { imageManifest, isIndex, MANIFEST_TYPES } from '../oci.ts';
import type { ContainerInfo, HostImage } from '../protocol.ts';
import { gh, imageRepository } from './build.ts';
import type { ClientConfig } from './config.ts';
import { Registry } from './image-download.ts';
import type { HostListing } from './open.ts';
import { projectSource, ProjectUnreachable, readProjectRevision } from './project.ts';
import { OlderHost, transportFor } from './transport.ts';

// What CI publishes, each also as -amd64 / -arm64 for one architecture before it joins them into one image:
//   <series>-env-<commit>-<run id>-<attempt>   an R environment, what container.json pins (image.yml);
//   positron-<version>-<environment digest>     the server of one Positron on an environment (positron.yml);
//   <variant>-<commit>-<run id>-<attempt>       from before environments: an image with the server built in.
const ENV_RE = /^([0-9]+\.[0-9]+)-env-([0-9a-f]{40})-([0-9]+)-([0-9]+)(?:-(amd64|arm64))?$/;
const LAYER_RE = /^positron-([0-9]{4}\.[0-9]{2}\.[0-9]+-[0-9]+)-([0-9a-f]{64})(?:-(amd64|arm64))?$/;
const LEGACY_RE = /^(.+)-([0-9a-f]{40})-([0-9]+)-([0-9]+)(?:-(amd64|arm64))?$/;

export interface TagInfo {
  kind: 'environment' | 'positron' | 'legacy' | 'other';
  /** Images of one variant replace each other: "4.6-env", "positron-<version>-<environment>", or a legacy "4.6". */
  variant: string;
  series?: string;
  commit?: string;
  runId?: number;
  attempt?: number;
  /** A Positron layer: its Positron version, and the digest (hex) of the environment it is built on. */
  positron?: string;
  baseHex?: string;
  /** Set on the single-architecture tags CI pushes before it joins them into one image. */
  arch?: string;
}

export function parseTag(tag: string): TagInfo {
  let m = ENV_RE.exec(tag);
  if (m) return { kind: 'environment', variant: `${m[1]}-env`, series: m[1], commit: m[2], runId: Number(m[3]), attempt: Number(m[4]), arch: m[5] };
  m = LAYER_RE.exec(tag);
  if (m) return { kind: 'positron', variant: `positron-${m[1]}-${m[2]}`, positron: m[1], baseHex: m[2], arch: m[3] };
  m = LEGACY_RE.exec(tag);
  if (m) return { kind: 'legacy', variant: m[1], series: /^([0-9]+\.[0-9]+)(?:-|$)/.exec(m[1])?.[1], commit: m[2], runId: Number(m[3]), attempt: Number(m[4]), arch: m[5] };
  return { kind: 'other', variant: tag, series: /^([0-9]+\.[0-9]+)$/.exec(tag)?.[1] };
}

/** One image in the registry, under the tag CI published it with. */
export interface PublishedImage extends TagInfo {
  tag: string;
  /** What container.json pins: <registry>/<repository>@sha256:... */
  reference: string;
  digest: string;
  /** Linux architectures the image has. */
  architectures: string[];
  /** Later or earlier builds that produced exactly this image (same digest), newest first. */
  alsoTags?: string[];
  /** The single-architecture tags of this image (and of alsoTags): removed together with it. */
  archTags?: string[];
  /** The tag of its attestation (sha256-<digest>: GHCR has no referrers API): removed together with it. */
  attestationTag?: string;
  /** Only one architecture was published: CI did not finish joining it with the other one. */
  incomplete?: boolean;
  /** Download size of one architecture (amd64 if there is one), in bytes. */
  size?: number;
  created?: string;
  labels: Record<string, string>;
}

export interface RegistryListing {
  /** e.g. ghcr.io/fnkc-stats/r-env */
  repository: string;
  images: PublishedImage[];
  /** Tags that could not be read (the others are listed). */
  problems: string[];
  error?: string;
}

type CachedTag = Omit<PublishedImage, keyof TagInfo | 'tag' | 'reference' | 'alsoTags' | 'archTags' | 'attestationTag'>;

/** An attestation pushed to the registry (actions/attest push-to-registry): the tag names its subject's digest. */
const ATTESTATION_TAG = /^sha256-[0-9a-f]{64}$/;
/** positron.yml's index before it is attested, verified and promoted to its positron-* tag: never shown or run. */
const STAGING_TAG = /^staging-/;

/** Runs `fn` on every item, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** Architectures of an index (attestations and other non-Linux entries are skipped). */
function indexArchitectures(index: Buffer): { arch: string; digest: string }[] {
  const list = (JSON.parse(index.toString('utf8')) as { manifests?: { digest?: string; mediaType?: string; platform?: { os?: string; architecture?: string } }[] }).manifests ?? [];
  return list.filter((m) => m.platform?.os === 'linux' && m.platform.architecture && m.platform.architecture !== 'unknown'
    && typeof m.digest === 'string' && MANIFEST_TYPES.includes(m.mediaType ?? ''))
    .map((m) => ({ arch: m.platform!.architecture!, digest: m.digest! }));
}

async function describeTag(reg: Registry, tag: string): Promise<CachedTag> {
  const top = await reg.manifestOf(tag);
  let manifest = top.body;
  let architectures: string[];
  if (isIndex(top.body)) {
    const archs = indexArchitectures(top.body);
    if (!archs.length) throw new Error('the image has no Linux architecture');
    architectures = archs.map((a) => a.arch);
    manifest = (await reg.manifestOf((archs.find((a) => a.arch === 'amd64') ?? archs[0]).digest)).body;
  } else architectures = [];
  const m = imageManifest(manifest);
  const config = JSON.parse((await reg.smallBlob(m.config.digest)).toString('utf8')) as { created?: string; architecture?: string; config?: { Labels?: Record<string, string> | null } };
  if (!architectures.length && config.architecture) architectures = [config.architecture];
  return {
    digest: top.digest, architectures, size: m.layers.reduce((n, l) => n + l.size, m.config.size),
    created: config.created, labels: config.config?.Labels ?? {},
  };
}

/**
 * The images in the registry, newest first. Each tag's description is kept in the cache: CI tags are unique per
 * build, so a refresh reads only the tag list and the tags that are new since last time. Positron tags are the
 * exception (a corrected recipe or a rollback moves them): their digest is checked at every refresh.
 */
export async function listPublished(cfg: ClientConfig, log: Logger, where = imageRepository(cfg)): Promise<RegistryListing> {
  const { registry, repository } = where;
  const name = `${registry}/${repository}`;
  const reg = new Registry(registry, repository);
  let tags: string[];
  try {
    tags = await reg.tags();
  } catch (e) {
    return { repository: name, images: [], problems: [], error: `cannot read ${name}: ${(e as Error).message}` };
  }
  const file = join(cfg.cacheDir, 'registry', `${name.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`);
  let cache: Record<string, CachedTag> = {};
  try { cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, CachedTag>; } catch { /* first time */ }

  // One entry per image: the joined tag, or the single-architecture tags of a build that has none
  const set = new Set(tags);
  const shown = tags.filter((t) => {
    if (ATTESTATION_TAG.test(t) || STAGING_TAG.test(t)) return false;
    const p = parseTag(t);
    return !p.arch || !set.has(t.slice(0, -(p.arch.length + 1)));
  });
  const problems: string[] = [];
  const described = await mapLimit(shown, 6, async (tag) => {
    try {
      const known = cache[tag];
      const info = known && (parseTag(tag).kind !== 'positron' || (await reg.manifestOf(tag)).digest === known.digest)
        ? known : await describeTag(reg, tag);
      cache[tag] = info;
      const archTags = ['amd64', 'arm64'].map((a) => `${tag}-${a}`).filter((t) => set.has(t));
      return { ...parseTag(tag), ...info, tag, reference: `${name}@${info.digest}`, incomplete: !!parseTag(tag).arch || undefined,
        archTags: archTags.length ? archTags : undefined } as PublishedImage;
    } catch (e) {
      problems.push(`${tag}: ${(e as Error).message}`);
      log.warn(`registry: ${tag}: ${(e as Error).message}`);
      return undefined;
    }
  });
  try {
    mkdirSync(join(cfg.cacheDir, 'registry'), { recursive: true });
    for (const t of Object.keys(cache)) if (!set.has(t)) delete cache[t];
    writeFileSync(`${file}.tmp`, JSON.stringify(cache));
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    log.warn(`registry cache: ${(e as Error).message}`);
  }
  // A rebuild of unchanged sources often gives the same image: one entry per digest, under its newest tag
  const images: PublishedImage[] = [];
  for (const img of described.filter((x): x is PublishedImage => !!x).sort(newestFirst)) {
    const same = images.find((i) => i.digest === img.digest);
    if (same) {
      (same.alsoTags ??= []).push(img.tag);
      if (img.archTags) (same.archTags ??= []).push(...img.archTags);
    } else images.push(img);
  }
  for (const img of images) {
    const t = img.digest.replace(':', '-');
    if (set.has(t)) img.attestationTag = t;
  }
  return { repository: name, images, problems };
}

const newestFirst = (a: { created?: string; runId?: number }, b: { created?: string; runId?: number }) =>
  (b.created ?? '').localeCompare(a.created ?? '') || (b.runId ?? 0) - (a.runId ?? 0);

/** The Gitea template of an R series and the image its container.json pins. */
export interface TemplatePin {
  series: string;
  repository: string;
  image?: string;
  /** Gitea was unreachable: the pin is the one read last time. */
  stale?: boolean;
  error?: string;
}

/** Reads container.json of each series' template, as Open reads a project's (git, only that file). */
export async function templatePins(cfg: ClientConfig, series: string[], pattern: string, log: Logger): Promise<TemplatePin[]> {
  if (!pattern.includes('{series}')) throw new Error(`the template repository setting must contain {series}, e.g. template-r-{series}`);
  return Promise.all(series.map(async (s): Promise<TemplatePin> => {
    const repository = pattern.replaceAll('{series}', s);
    if (!cfg.gitRemotes.length) return { series: s, repository, error: 'gitRemotes is not set: the templates in Gitea cannot be read' };
    try {
      const { image, stale } = await readProjectRevision(projectSource(repository, cfg.gitRemotes), cfg.cacheDir, { info: () => {}, warn: () => {} }, 5);
      return { series: s, repository, image, stale: stale || undefined };
    } catch (e) {
      log.warn(`template ${repository}: ${(e as Error).message}`);
      if (!(e instanceof ProjectUnreachable)) return { series: s, repository, error: (e as Error).message };
      return { series: s, repository, error: `not found or unreachable in Gitea (${e.reasons[0] ?? e.message})` };
    }
  }));
}

export interface HostImages {
  host: string;
  ssh?: string;
  images: HostImage[];
  error?: string;
  /** The host's fnkc-ctl predates the images command. */
  older?: boolean;
}

export async function listHostImages(cfg: ClientConfig, log: Logger): Promise<HostImages[]> {
  return Promise.all(cfg.hosts.map(async (h): Promise<HostImages> => {
    try {
      return { host: h.name, ssh: h.ssh, images: await transportFor(h, cfg, log).images() };
    } catch (e) {
      return { host: h.name, ssh: h.ssh, images: [], error: (e as Error).message, older: e instanceof OlderHost || undefined };
    }
  }));
}

// ---- The overview: the three sources joined by digest ----

const digestOf = (ref: string) => /sha256[:-]([0-9a-f]{64})$/.exec(ref)?.[1];
const DAY = 24 * 60 * 60 * 1000;

type Use = { host: string; containers: number; running: number };

/** A published image with where it is used. */
export interface ImageRow extends PublishedImage {
  /** The newest image of its variant (the newest environment of the series). */
  newest: boolean;
  /** Templates that pin it. */
  templates: string[];
  /** Hosts that have it or one of its Positron layers, with the project containers (of all users) made from them. */
  hosts: Use[];
  /** The asking user's projects that run on it. */
  projects: { host: string; project: string }[];
  /** Not newest, no template pins it, no container on a reachable host uses it (or one of its layers). */
  unused: boolean;
  /** An environment: its Positron servers (positron.yml), newest Positron first. */
  layers: LayerRow[];
}

/** The server of one Positron on an environment: what project containers run. */
export interface LayerRow extends PublishedImage {
  hosts: Use[];
  projects: { host: string; project: string }[];
  /** No container uses it, and its environment is unused or its Positron is not the team's any more (after a while). */
  unused: boolean;
}

export interface SeriesGroup {
  /** "4.6", or "other" for tags that name no R series. */
  series: string;
  rows: ImageRow[];
  /** Positron layers whose environment is not in the registry (any more). */
  orphans: LayerRow[];
  template?: TemplatePin;
  /** Whether the template pins the newest environment of the series. */
  templateState: 'newest' | 'older' | 'not-published' | 'unknown' | 'none';
}

export interface HostImageRow extends HostImage {
  /** The registry's entry for this image, if it is (still) published. */
  published?: PublishedImage;
  templates: string[];
}

export interface HostGroup extends HostImages {
  rows: HostImageRow[];
  /** All environment images together, on disk. */
  size: number;
}

export interface Overview {
  registry: RegistryListing;
  series: SeriesGroup[];
  hosts: HostGroup[];
  /** Hosts whose containers were not counted (unreachable, older): "unused" leaves them out. */
  unchecked: string[];
  templatesError?: string;
  /** The team's Positron (env/positron.args on main), if it could be read. */
  teamPositron?: string;
}

export interface OverviewOptions {
  teamPositron?: string;
  /** A layer for another Positron than the team's counts as unused only this long after it was built. */
  layerGraceDays?: number;
  now?: number;
}

const ageDays = (created: string | undefined, now: number) => (created ? (now - Date.parse(created)) / DAY : Infinity);

export function overview(
  registry: RegistryListing, templates: TemplatePin[], hosts: HostImages[], projects: HostListing[], templatesError?: string,
  opts: OverviewOptions = {},
): Overview {
  const now = opts.now ?? Date.now();
  const grace = opts.layerGraceDays ?? 60;
  const pinnedBy = (digest?: string) => templates.filter((t) => t.image && digestOf(t.image) === digest).map((t) => t.repository);
  const ownProjects = projects.flatMap((l) => l.containers.map((c: ContainerInfo) => ({ host: l.host, project: c.project, digest: digestOf(c.image) })));
  const unchecked = hosts.filter((h) => h.error).map((h) => h.host);
  const usesOf = (digest?: string): Use[] => hosts.flatMap((h) => h.images.filter((i) => i.references.some((r) => digestOf(r) === digest))
    .map((i) => ({ host: h.host, containers: i.containers, running: i.running })));
  const projectsOf = (digest?: string) => ownProjects.filter((p) => p.digest === digest).map(({ host, project }) => ({ host, project }));
  const seriesOf = (img: PublishedImage) => img.labels['r-env.r-series'] ?? img.series ?? 'other';
  const inUse = (r: { hosts: Use[]; projects: unknown[] }) => r.projects.length > 0 || r.hosts.some((h) => h.containers > 0);

  // Positron layers, by the environment they are built on
  const layers = new Map<string, LayerRow[]>();
  for (const img of registry.images.filter((i) => i.kind === 'positron')) {
    const d = digestOf(img.digest);
    const row: LayerRow = { ...img, hosts: usesOf(d), projects: projectsOf(d), unused: false };
    const base = img.baseHex ?? digestOf(img.labels['r-env.base'] ?? '') ?? '';
    if (!layers.has(base)) layers.set(base, []);
    layers.get(base)!.push(row);
  }
  for (const l of layers.values()) l.sort((a, b) => (b.positron ?? '').localeCompare(a.positron ?? '', undefined, { numeric: true }));

  const groups = new Map<string, ImageRow[]>();
  const seenVariant = new Set<string>();
  const attached = new Set<string>();
  // Once a series has environments, its images with the server built in are only kept while something uses them
  const withEnvironments = new Set(registry.images.filter((i) => i.kind === 'environment' && !i.incomplete).map(seriesOf));
  for (const img of registry.images.filter((i) => i.kind !== 'positron')) { // newest first
    const digest = digestOf(img.digest);
    const newest = !seenVariant.has(img.variant) && !img.incomplete && !(img.kind === 'legacy' && withEnvironments.has(seriesOf(img)));
    if (newest) seenVariant.add(img.variant);
    const own = img.kind === 'environment' ? layers.get(digest ?? '') ?? [] : [];
    if (own.length) attached.add(digest ?? '');
    const byHost = new Map<string, Use>();
    for (const u of [...usesOf(digest), ...own.flatMap((l) => l.hosts)]) {
      const h = byHost.get(u.host) ?? { host: u.host, containers: 0, running: 0 };
      byHost.set(u.host, { host: u.host, containers: h.containers + u.containers, running: h.running + u.running });
    }
    const row: ImageRow = {
      ...img, newest, templates: pinnedBy(digest), hosts: [...byHost.values()],
      projects: [...projectsOf(digest), ...own.flatMap((l) => l.projects)], unused: false, layers: own,
    };
    row.unused = !newest && !row.templates.length && !inUse(row);
    for (const l of own) {
      l.unused = !inUse(l) && (row.unused || (!!opts.teamPositron && l.positron !== opts.teamPositron && ageDays(l.created, now) > grace));
    }
    const series = seriesOf(img);
    if (!groups.has(series)) groups.set(series, []);
    groups.get(series)!.push(row);
  }
  const orphans = new Map<string, LayerRow[]>();
  for (const [base, list] of layers) {
    if (attached.has(base)) continue;
    for (const l of list) {
      l.unused = !inUse(l);
      const s = seriesOf(l);
      if (!orphans.has(s)) orphans.set(s, []);
      orphans.get(s)!.push(l);
    }
  }

  const allSeries = new Set([...groups.keys(), ...orphans.keys(), ...templates.map((t) => t.series)]);
  const kindOrder = { environment: 0, legacy: 1, other: 2, positron: 3 };
  const series = [...allSeries].sort((a, b) => (a === 'other' ? 1 : b === 'other' ? -1 : b.localeCompare(a, undefined, { numeric: true })))
    .map((s): SeriesGroup => {
      const rows = (groups.get(s) ?? []).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.variant.localeCompare(b.variant) || newestFirst(a, b));
      const template = templates.find((t) => t.series === s);
      const newest = rows.find((r) => r.newest && r.kind === 'environment') ?? rows.find((r) => r.newest && r.variant === s);
      let templateState: SeriesGroup['templateState'] = 'none';
      if (template?.image) {
        const d = digestOf(template.image);
        templateState = newest && digestOf(newest.digest) === d ? 'newest' : rows.some((r) => digestOf(r.digest) === d) ? 'older' : registry.error ? 'unknown' : 'not-published';
      } else if (template) templateState = 'unknown';
      return { series: s, rows, orphans: orphans.get(s) ?? [], template, templateState };
    });

  const byDigest = new Map(registry.images.map((i) => [digestOf(i.digest), i]));
  const hostGroups = hosts.map((h): HostGroup => {
    const rows = h.images.map((i): HostImageRow => {
      const d = i.references.map(digestOf).find((x) => x && byDigest.has(x));
      // A layer counts as the template's when the template pins its environment
      const bases = [...i.references.map(digestOf), digestOf(i.labels['r-env.base'] ?? '')];
      return { ...i, published: d ? byDigest.get(d) : undefined, templates: [...new Set(bases.flatMap((x) => pinnedBy(x)))] };
    });
    return { ...h, rows, size: rows.reduce((n, r) => n + r.size, 0) };
  });
  return { registry, series, hosts: hostGroups, unchecked, templatesError, teamPositron: opts.teamPositron };
}

/** The team's Positron version, from env/positron.args on main (public, read without credentials). */
export async function teamPositron(envRepository: string): Promise<string | undefined> {
  const res = await fetch(`https://raw.githubusercontent.com/${envRepository}/main/env/positron.args`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return undefined;
  return /^POSITRON_VERSION=(.+)$/m.exec(await res.text())?.[1].trim();
}

/** Reads all sources at once; failures end up in the overview, it is never thrown. */
export async function loadOverview(
  cfg: ClientConfig, templatePattern: string, log: Logger, projects: Promise<HostListing[]>,
): Promise<Overview> {
  const registryP = listPublished(cfg, log);
  const hostsP = listHostImages(cfg, log);
  const teamP = teamPositron(cfg.envRepository).catch((e: Error) => { log.warn(`team Positron: ${e.message}`); return undefined; });
  const registry = await registryP;
  const known = [...new Set(registry.images.map((i) => i.labels['r-env.r-series'] ?? i.series).filter((s): s is string => !!s))];
  let templates: TemplatePin[] = [];
  let templatesError: string | undefined;
  try {
    templates = await templatePins(cfg, known, templatePattern, log);
  } catch (e) {
    templatesError = (e as Error).message;
  }
  const [hosts, listed, team] = await Promise.all([hostsP, projects.catch(() => [] as HostListing[]), teamP]);
  return overview(registry, templates, hosts, listed, templatesError, { teamPositron: team });
}

// ---- Cleanup of the registry (fnkc-ctl images --cleanup) ----

/** One image to delete from the registry, with all its tags (and those of its architectures). */
export interface Removal {
  reference: string;
  digest: string;
  tags: string[];
  what: string;
  reason: string;
}

export interface CleanupPlan {
  removals: Removal[];
  /** Why the plan must not be applied as it is (sources that could not be read). */
  blockers: string[];
}

/** Digests (hex) named anywhere in a text, e.g. a list of the pins of all projects. */
export const digestsIn = (text: string) => new Set([...text.matchAll(/sha256[:-]([0-9a-f]{64})/g)].map((m) => m[1]));

/**
 * What can go from the registry: unused images (ImageRow.unused, LayerRow.unused) at least `olderThanDays` old,
 * except those in `keep` (pins of projects, which the overview does not see: it reads only the templates). An
 * environment goes with all its layers. Never the newest environment of a series, or anything a template pins or a
 * container on a reachable host uses.
 */
export function cleanupPlan(o: Overview, opts: { olderThanDays?: number; keep?: Set<string>; now?: number } = {}): CleanupPlan {
  const now = opts.now ?? Date.now();
  const min = opts.olderThanDays ?? 30;
  const keep = opts.keep ?? new Set<string>();
  const old = (img: PublishedImage) => ageDays(img.created, now) >= min;
  const kept = (img: PublishedImage) => keep.has(digestOf(img.digest) ?? '');
  const removal = (img: PublishedImage, what: string, reason: string): Removal => ({
    reference: img.reference, digest: img.digest, what, reason, tags: [img.tag, ...(img.alsoTags ?? []), ...(img.archTags ?? []),
      ...(img.attestationTag ? [img.attestationTag] : [])],
  });
  const removals: Removal[] = [];
  for (const g of o.series) {
    for (const r of g.rows) {
      const name = r.kind === 'environment' ? `R ${g.series} environment of ${dayOf(r.created)}` : `${r.tag} (${dayOf(r.created)})`;
      if (r.unused && old(r) && !kept(r) && !r.layers.some(kept)) {
        removals.push(removal(r, name, r.kind === 'legacy' ? 'server built in (from before environments), unused' : 'not the newest, not pinned, unused'));
        for (const l of r.layers) removals.push(removal(l, `Positron ${l.positron} on the ${name}`, 'its environment goes'));
        continue;
      }
      for (const l of r.layers) {
        // A kept environment keeps the team's server, or its projects would not open
        if (l.unused && old(l) && !kept(l) && !(kept(r) && l.positron === o.teamPositron)) removals.push(removal(l, `Positron ${l.positron} on the ${name}`, `not the team's Positron (${o.teamPositron ?? '?'}), unused`));
      }
    }
    for (const l of g.orphans) if (l.unused && old(l) && !kept(l)) removals.push(removal(l, `Positron ${l.positron} (R ${g.series})`, 'its environment is not in the registry'));
  }
  const blockers = o.unchecked.map((h) => `the containers on ${h} could not be counted`);
  if (o.registry.error) blockers.push(`the registry could not be read: ${o.registry.error}`);
  // An unreadable tag may be what makes an image look unused (a layer whose environment is pinned)
  const n = o.registry.problems.length;
  if (n) blockers.push(`${n} tag${n === 1 ? '' : 's'} could not be read (see 'Tags that could not be read'; try again, or remove a broken tag by hand)`);
  if (o.templatesError) blockers.push(`the templates could not be read: ${o.templatesError}`);
  for (const g of o.series) if (g.template?.error) blockers.push(`template ${g.template.repository}: ${g.template.error}`);
  return { removals, blockers };
}

export function cleanupText(plan: CleanupPlan): string {
  const lines = plan.removals.length ? [`To remove from the registry (${plan.removals.length}):`] : ['Nothing to remove from the registry.'];
  for (const r of plan.removals) lines.push(`  ${r.what}: ${r.reason}`, `      ${r.reference}`);
  if (plan.removals.length) lines.push('', 'Only the templates and the hosts are checked: pass the pins of all projects with --keep <file> (any text with sha256 digests).');
  if (plan.blockers.length) lines.push('', 'Not safe to apply now:', ...plan.blockers.map((b) => `  ${b}`));
  return lines.join('\n');
}

// ---- Words and links shared by the panel and the command line ----

export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export const dayOf = (iso?: string) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : 'date unknown');
export const shortCommit = (c?: string) => (c ? c.slice(0, 7) : '');

/** "R 4.6.2 · Positron 2026.11.1-4" from an image's labels. */
export function contentsText(labels: Record<string, string>): string {
  return [labels['r-env.r-version'] && `R ${labels['r-env.r-version']}`, labels['positron.version'] && `Positron ${labels['positron.version']}`]
    .filter(Boolean).join(' · ');
}

/** GitHub pages about how an image was built: its CI run, its commit, the package list it was built from. */
export function buildLinks(envRepository: string, img: TagInfo): { run?: string; commit?: string; packages?: string } {
  const base = `https://github.com/${envRepository}`;
  return {
    run: img.runId ? `${base}/actions/runs/${img.runId}${img.attempt && img.attempt > 1 ? `/attempts/${img.attempt}` : ''}` : undefined,
    commit: img.commit ? `${base}/commit/${img.commit}` : undefined,
    packages: img.commit && img.series ? `${base}/blob/${img.commit}/env/versions/${img.series}/renv.lock` : undefined,
  };
}

export const compareLink = (envRepository: string, older: string, newer: string) => `https://github.com/${envRepository}/compare/${older}...${newer}`;

/** How to remove an unused image from a host by hand (Docker refuses while any container uses it). */
export function removalCommand(host: { ssh?: string }, img: HostImage): string {
  return `${host.ssh ? 'sudo ' : ''}docker image rm ${img.id}`;
}

const layerMarks = (l: LayerRow) => [dayOf(l.created), ...l.hosts.map((h) => `on ${h.host}${h.containers ? ` (${h.containers} container${h.containers > 1 ? 's' : ''})` : ''}`),
  l.unused && 'unused'].filter(Boolean).join(', ');

/** The overview as text (fnkc-ctl images). */
export function overviewText(o: Overview): string {
  const lines: string[] = [];
  lines.push(`Published in ${o.registry.repository}${o.registry.error ? `: ${o.registry.error}` : ''}${o.teamPositron ? ` (team Positron ${o.teamPositron})` : ''}`);
  for (const g of o.series) {
    const t = g.template;
    const tpl = !t ? '' : t.error ? `template ${t.repository}: ${t.error}` : `template ${t.repository}: ${TEMPLATE_STATE[g.templateState]}${t.stale ? ' (Gitea unreachable, as read last time)' : ''}`;
    lines.push('', `R ${g.series}${tpl ? `   ${tpl}` : ''}`);
    for (const r of g.rows) {
      const marks = [r.newest && 'newest', ...r.templates.map((x) => `pinned by ${x}`), r.incomplete && `only ${r.architectures.join(', ')}`,
        ...r.hosts.map((h) => `on ${h.host}${h.containers ? ` (${h.containers} container${h.containers > 1 ? 's' : ''})` : ''}`),
        r.unused && 'unused'].filter(Boolean);
      lines.push(`  ${dayOf(r.created)}  ${shortCommit(r.commit).padEnd(7)}  ${contentsText(r.labels).padEnd(34)}  ${marks.join(', ')}`);
      lines.push(`      ${r.reference}`);
      if (r.alsoTags?.length) lines.push(`      also published as ${r.alsoTags.join(', ')}`);
      for (const l of r.layers) lines.push(`      Positron ${(l.positron ?? '?').padEnd(13)} ${layerMarks(l)}`);
    }
    for (const l of g.orphans) lines.push(`  Positron ${l.positron} on an environment not in the registry  ${layerMarks(l)}`, `      ${l.reference}`);
  }
  if (o.registry.problems.length) lines.push('', 'Tags that could not be read:', ...o.registry.problems.map((p) => `  ${p}`));
  if (o.templatesError) lines.push('', `Templates: ${o.templatesError}`);
  for (const h of o.hosts) {
    lines.push('', `On ${h.host}${h.error ? `: ${h.error}` : `: ${h.rows.length} image${h.rows.length === 1 ? '' : 's'}, ${sizeText(h.size)}`}`);
    for (const r of h.rows) {
      const use = r.containers ? `${r.containers} container${r.containers > 1 ? 's' : ''} (${r.running} running)` : 'no containers';
      const p = r.published;
      lines.push(`  ${dayOf(r.created)}  ${(p?.kind === 'positron' ? 'server' : p ? shortCommit(p.commit) || 'tag' : 'local').padEnd(7)}  ${contentsText(r.labels).padEnd(34)}  ${sizeText(r.size).padStart(7)}  ${use}`);
    }
  }
  return lines.join('\n');
}

export const TEMPLATE_STATE: Record<SeriesGroup['templateState'], string> = {
  newest: 'pins the newest environment',
  older: 'pins an older environment',
  'not-published': 'pins an image that is not in the registry',
  unknown: 'pin unknown',
  none: 'no template',
};

export interface PackageVersion { id: number; name: string; metadata?: { container?: { tags?: string[] } } }

/**
 * The GHCR versions of the plan's images. A version that also carries a tag the plan keeps (a rebuild reproduced
 * one architecture byte for byte, so a kept image shares that manifest) is skipped, not deleted.
 */
export function versionsToDelete(plan: CleanupPlan, versions: PackageVersion[]): { remove: PackageVersion[]; skip: PackageVersion[] } {
  const tags = new Set(plan.removals.flatMap((r) => r.tags));
  const digests = new Set(plan.removals.map((r) => r.digest));
  const remove: PackageVersion[] = [];
  const skip: PackageVersion[] = [];
  for (const v of versions) {
    const vt = v.metadata?.container?.tags ?? [];
    if (!digests.has(v.name) && !vt.some((t) => tags.has(t))) continue;
    (vt.every((t) => tags.has(t)) ? remove : skip).push(v);
  }
  return { remove, skip };
}

/**
 * Deletes the plan's images from the registry with gh (an administrator with the right to delete packages:
 * gh auth refresh -s delete:packages). Each image goes with all its tags; returns what was deleted.
 */
export async function applyCleanup(cfg: ClientConfig, plan: CleanupPlan, log: Logger): Promise<string[]> {
  if (plan.blockers.length) throw new Error(`not applied: ${plan.blockers.join('; ')}`);
  const owner = cfg.envRepository.split('/')[0];
  const path = async () => {
    for (const kind of ['orgs', 'users']) {
      const p = `/${kind}/${owner}/packages/container/r-env/versions`;
      if (await gh(['api', `${p}?per_page=1`]).then(() => true, () => false)) return p;
    }
    throw new Error(`cannot list the packages of ${owner} with gh (gh auth refresh -s read:packages,delete:packages)`);
  };
  const base = await path();
  const versions = (JSON.parse(await gh(['api', '--paginate', '--slurp', `${base}?per_page=100`])) as PackageVersion[][]).flat();
  const { remove, skip } = versionsToDelete(plan, versions);
  for (const v of skip) log.warn(`kept ${v.name}: also tagged ${(v.metadata?.container?.tags ?? []).join(', ')}, which stay`);
  const deleted: string[] = [];
  for (const v of remove) {
    await gh(['api', '-X', 'DELETE', `${base}/${v.id}`]);
    deleted.push(`${v.name} (${(v.metadata?.container?.tags ?? []).join(', ') || 'untagged'})`);
    log.info(`deleted ${v.name}`);
  }
  return deleted;
}
