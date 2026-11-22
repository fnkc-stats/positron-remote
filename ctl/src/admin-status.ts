// What `fnkc-ctl admin status` and `admin projects <user>` show (root on a server): every user's projects, with the
// containers and volumes Docker has for them, including those of users removed since (offboarding leaves them for
// the administrator to decide). adminStatus is pure: the tests give it Docker's listings.
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type ContainerJson, type Docker, type ImageJson, pinnedImageOf } from './docker.ts';
import type { AgentConfig } from './agent-config.ts';
import { memoryBytes } from './capacity.ts';
import { IMAGE_LABEL, isProjectContainer, LABEL } from './layout.ts';

export interface VolumeInfo {
  name: string;
  labels?: Record<string, string> | null;
  /** Bytes, with --sizes only. */
  size?: number;
}

export interface ProjectStatus {
  user: string;
  project: string;
  /** Docker's state of the container (running, exited, created…), or "no container": only volumes are left. */
  state: string;
  running: boolean;
  /** When the container last started (Docker's State.StartedAt), ISO 8601. */
  lastStart?: string;
  memory?: string;
  /** The memory limit of the container, bytes. */
  memoryLimit?: number;
  image?: string;
  positron?: string;
  volumes: VolumeInfo[];
  /** The user has no key on this host any more (admin remove-user). */
  removedUser: boolean;
}

export interface HostStatus {
  cpus: number;
  memory: number;
  /** Memory reserved by the limits of running containers, bytes (what admission counts). */
  reserved: number;
  reserveMemory: string;
  maxProjectsPerUser: number;
  maxMemoryPerUser: string;
  running: number;
}

export interface ReleaseStatus {
  /** The release directory's name: <version>-<manifest checksum>. */
  id: string;
  /** Files its MANIFEST lists. */
  files: number;
  /** Files missing or not matching the MANIFEST ("volume-backup.sh: changed"); none for a complete release. */
  problems: string[];
}

/** What install.sh installed (ctl/server/install.sh): the active and the previous release. */
export interface InstalledRelease {
  active?: ReleaseStatus;
  previous?: ReleaseStatus;
  /** Why the layout is not as install.sh leaves it, e.g. files from an installer from before releases. */
  problems: string[];
}

export interface AdminStatus {
  host: HostStatus;
  users: string[];
  projects: ProjectStatus[];
  /** Read on the server only (readAdminStatus). */
  release?: InstalledRelease;
}

/** The program files install.sh links through current (ctl/server/install.sh LINKED). */
const LINKED = ['fnkc-ctl.cjs', 'volume-backup.sh', 'render-reviewed.py', 'refresh-trust-root.sh'];

/** The release `link` (current or previous-release) points to, with each MANIFEST file checked; undefined if none. */
function releaseAt(prefix: string, link: string): ReleaseStatus | string | undefined {
  let target: string;
  try { target = readlinkSync(join(prefix, link)); } catch { return undefined; }
  if (!/^releases\/[A-Za-z0-9._-]+$/.test(target)) return `${link} points to ${target}, not to a release`;
  const dir = join(prefix, target);
  let manifest: string;
  try { manifest = readFileSync(join(dir, 'MANIFEST'), 'utf8'); } catch { return `${link}: release ${target.slice(9)} has no MANIFEST`; }
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const line of manifest.split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) { problems.push(`MANIFEST: unreadable line '${line.slice(0, 80)}'`); continue; }
    listed.add(m[2]);
    let sum: string;
    try { sum = createHash('sha256').update(readFileSync(join(dir, m[2]))).digest('hex'); } catch { problems.push(`${m[2]}: missing`); continue; }
    if (sum !== m[1]) problems.push(`${m[2]}: changed`);
  }
  for (const f of LINKED) if (!listed.has(f)) problems.push(`${f}: not in the release`);
  return { id: target.slice('releases/'.length), files: listed.size, problems };
}

/** The installed releases under `prefix` (install.sh's /opt/fnkc-ctl), each file checked against its MANIFEST. */
export function readInstalledRelease(prefix = '/opt/fnkc-ctl'): InstalledRelease {
  const out: InstalledRelease = { problems: [] };
  for (const [key, link] of [['active', 'current'], ['previous', 'previous-release']] as const) {
    const r = releaseAt(prefix, link);
    if (typeof r === 'string') out.problems.push(r); else if (r) out[key] = r;
  }
  const plain = LINKED.filter((f) => { try { return readlinkSync(join(prefix, f)) !== `current/${f}`; } catch { return true; } });
  if (plain.length) {
    out.problems.push(plain.length === LINKED.length && !out.active
      ? `no release installed in ${prefix} (installed before releases, or not at all): run install.sh from the server bundle`
      : `not linked through ${prefix}/current: ${plain.join(', ')} (run install.sh from the server bundle again)`);
  }
  return out;
}

/**
 * The user and project a volume belongs to: its labels (volumes created since 0.5), else its name
 * (fnkc-<user>-<project>-project|data|library|ext, fnkc-ext-<user>-<project>-<arch>-<commit>). User names have no
 * hyphen (validate.ts), so the first part after fnkc- is the user.
 */
export function volumeOwner(v: VolumeInfo): { user: string; project: string } | undefined {
  const l = v.labels ?? {};
  if (l[LABEL.user] && l[LABEL.project]) return { user: l[LABEL.user], project: l[LABEL.project] };
  const ext = /^fnkc-ext-([a-z0-9]+)-(.+)-(?:x64|arm64)-[0-9a-f]{12}$/.exec(v.name);
  if (ext) return { user: ext[1], project: ext[2] };
  const m = /^fnkc-([a-z0-9]+)-(.+)-(project|data|library|ext)$/.exec(v.name);
  if (m && m[1] !== 'ext') return { user: m[1], project: m[2] };
  return undefined;
}

export function adminStatus(o: {
  containers: ContainerJson[]; volumes: VolumeInfo[]; images: ImageJson[]; users: string[];
  memory: Map<string, string>; host: Omit<HostStatus, 'reserved' | 'running'>;
}): AdminStatus {
  const byKey = new Map<string, ProjectStatus>();
  const known = new Set(o.users);
  const entry = (user: string, project: string) => {
    const key = `${user}\n${project}`;
    let p = byKey.get(key);
    if (!p) {
      p = { user, project, state: 'no container', running: false, volumes: [], removedUser: !known.has(user) };
      byKey.set(key, p);
    }
    return p;
  };
  const images = new Map(o.images.map((i) => [i.Id, i]));
  const projectContainers = o.containers.filter((c) => isProjectContainer(c));
  for (const c of projectContainers) {
    const l = c.Config.Labels ?? {};
    const p = entry(l[LABEL.user], l[LABEL.project]);
    const name = c.Name.replace(/^\//, '');
    const started = c.State.StartedAt;
    Object.assign(p, {
      state: c.State.Status, running: c.State.Running, image: pinnedImageOf(c), memory: o.memory.get(name),
      memoryLimit: c.HostConfig?.Memory || undefined,
      // Docker's zero time: created, never started
      lastStart: started && !started.startsWith('0001-') ? started : undefined,
      positron: (c.Image && images.get(c.Image)?.Config?.Labels?.[IMAGE_LABEL.positronVersion]) || undefined,
    });
  }
  for (const v of o.volumes) {
    const owner = volumeOwner(v);
    if (owner) entry(owner.user, owner.project).volumes.push(v);
  }
  const running = o.containers.filter((c) => c.State.Running);
  const projects = [...byKey.values()].sort((a, b) => a.user.localeCompare(b.user) || a.project.localeCompare(b.project));
  for (const p of projects) p.volumes.sort((a, b) => a.name.localeCompare(b.name));
  return {
    host: { ...o.host, running: running.filter((c) => isProjectContainer(c)).length,
      reserved: running.reduce((n, c) => n + (c.HostConfig?.Memory || o.host.memory), 0) },
    users: [...o.users].sort(),
    projects,
  };
}

/** Reads Docker for adminStatus. Volume sizes (`docker system df -v`, slow on a full disk) only with `sizes`. */
export async function readAdminStatus(docker: Docker, cfg: AgentConfig, users: string[], sizes: boolean,
  releasePrefix = '/opt/fnkc-ctl'): Promise<AdminStatus> {
  const [containers, images, info, volumeLines] = await Promise.all([
    docker.containers([`${LABEL.managed}=1`]), docker.images(),
    docker.ok(['info', '--format', '{{.NCPU}} {{.MemTotal}}']),
    docker.ok(['volume', 'ls', '--format', '{{json .}}']),
  ]);
  const volumes: VolumeInfo[] = volumeLines.split('\n').filter(Boolean).map((line) => {
    const v = JSON.parse(line) as { Name: string; Labels?: string };
    return { name: v.Name, labels: parseLabels(v.Labels) };
  });
  if (sizes) {
    const df = JSON.parse(await docker.ok(['system', 'df', '-v', '--format', '{{json .Volumes}}'], { timeoutMs: 10 * 60_000 })) as { Name: string; Size: string }[] | null;
    // Docker prints sizes as 1.2GB, 120kB, 0B, or N/A
    const bytes = (x: string) => memoryBytes(x.replace(/B$/, '').replace(/[kKmMgGtT]$/, (u) => u.toLowerCase()));
    const size = new Map((df ?? []).map((v) => [v.Name, bytes(v.Size)]));
    for (const v of volumes) { const n = size.get(v.name); if (n !== undefined && Number.isFinite(n)) v.size = n; }
  }
  const memory = new Map<string, string>();
  const names = containers.filter((c) => c.State.Running).map((c) => c.Name.replace(/^\//, ''));
  if (names.length) {
    const stats = await docker.run(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}', ...names], { timeoutMs: 30_000 });
    for (const line of stats.stdout.split('\n')) {
      const [name, use] = line.split('\t');
      if (name && use) memory.set(name, use);
    }
  }
  const [cpus, mem] = info.trim().split(/\s+/).map(Number);
  return { ...adminStatus({ containers, volumes, images, users, memory, host: {
    cpus, memory: mem, reserveMemory: cfg.reserveMemory, maxProjectsPerUser: cfg.maxProjectsPerUser, maxMemoryPerUser: cfg.maxMemoryPerUser,
  } }), release: readInstalledRelease(releasePrefix) };
}

/** `docker volume ls` prints labels as "a=1,b=2". */
function parseLabels(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? '').split(',').filter(Boolean)) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
const size = (n: number | undefined) => (n === undefined ? '' : n >= 1024 ** 3 ? gib(n) : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MiB` : `${Math.round(n / 1024)} KiB`);

/** The status as text for the terminal. */
export function formatAdminStatus(s: AdminStatus, now = new Date()): string {
  const h = s.host;
  const out = [
    `Host: ${h.cpus} CPUs, ${gib(h.memory)}; running projects: ${h.running}, their memory limits ${gib(h.reserved)} ` +
      `(reserved for the system: ${h.reserveMemory}); per user: ${h.maxProjectsPerUser} projects, ${h.maxMemoryPerUser}`,
    `Users with a key: ${s.users.join(', ') || 'none'}`,
  ];
  if (s.release) out.push(...formatRelease(s.release));
  let user = '';
  for (const p of s.projects) {
    if (p.user !== user) {
      user = p.user;
      out.push('', `${user}${p.removedUser ? ' (removed: no key; their projects stay until you delete them: admin remove-project)' : ''}`);
    }
    const since = p.lastStart ? `, last start ${p.lastStart.slice(0, 16).replace('T', ' ')} (${ago(p.lastStart, now)})` : '';
    const mem = p.memory ? `, memory ${p.memory}` : p.memoryLimit ? `, limit ${gib(p.memoryLimit)}` : '';
    out.push(`  ${p.project}: ${p.state}${since}${mem}${p.positron ? `, Positron ${p.positron}` : ''}`);
    if (p.image) out.push(`    image ${p.image}`);
    const total = p.volumes.every((v) => v.size !== undefined) && p.volumes.length ? p.volumes.reduce((n, v) => n + v.size!, 0) : undefined;
    out.push(`    volumes: ${p.volumes.map((v) => `${v.name}${v.size !== undefined ? ` (${size(v.size)})` : ''}`).join(', ') || 'none'}` +
      (total !== undefined ? `; ${size(total)} in all` : ''));
  }
  if (!s.projects.length) out.push('', 'No projects on this host.');
  return out.join('\n') + '\n';
}

/** The installed releases: one line, then a line for each problem (sudo /opt/fnkc-ctl/install.sh --rollback). */
export function formatRelease(r: InstalledRelease): string[] {
  const one = (x: ReleaseStatus | undefined) => (!x ? 'none'
    : `${x.id} (${x.files} files, ${x.problems.length ? `${x.problems.length} not matching its manifest` : 'all match its manifest'})`);
  const out = [`Installed release: ${one(r.active)}; previous: ${one(r.previous)}`];
  for (const p of r.active?.problems ?? []) out.push(`  ! active release: ${p}`);
  for (const p of r.previous?.problems ?? []) out.push(`  ! previous release: ${p} (install.sh --rollback refuses it)`);
  for (const p of r.problems) out.push(`  ! ${p}`);
  return out;
}

function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
