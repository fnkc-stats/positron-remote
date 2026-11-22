// Names and paths shared by the host side (agent) and the user side (client).

/** The working user inside the container; created in env/Dockerfile, change both together. */
export const CONTAINER_USER = 'analyst';
export const CONTAINER_HOME = `/home/${CONTAINER_USER}`;
/**
 * Where Positron Remote SSH keeps its server: bin/<commit> (in the image, see env/Dockerfile), data/ and
 * extensions/ (volumes), logs.
 */
export const SERVER_DATA_DIR = `${CONTAINER_HOME}/.positron-server`;
/** The Positron server built into an environment image, for the Positron build in its labels. */
export const serverDir = (commit: string) => `${SERVER_DATA_DIR}/bin/${commit}`;
/**
 * renv's cache for the project (renv-cache/), which <project>/renv/library links into. A volume, so the links
 * survive recreation of the container; the entrypoint points RENV_PATHS_CACHE at it.
 */
export const LIBRARY_DIR = `${CONTAINER_HOME}/.fnkc-library`;

export type Arch = 'x64' | 'arm64';

/** Docker objects of one user's project on a host. */
export function projectNames(user: string, project: string) {
  const base = `fnkc-${user}-${project}`;
  return {
    container: base,
    projectVolume: `${base}-project`,
    dataVolume: `${base}-data`,
    libraryVolume: `${base}-library`,
    /** Before extensions were shared per user: removed when the project's container is recreated. */
    legacyExtensionsVolume: `${base}-ext`,
  };
}

/**
 * Positron's extensions inside containers, shared by all projects of a user on a host. Per architecture,
 * because some extensions ship native programs (ruff, air). The user part is letters and digits only,
 * so the name never equals another user's.
 */
export const extensionsVolume = (user: string, arch: Arch, project: string, commit: string) => `fnkc-ext-${user}-${project}-${arch}-${commit.slice(0, 12)}`;

/**
 * The SSH host name Positron connects to (written to ~/.ssh/fnkc/<alias>.conf), shown in Positron's Remote Explorer
 * and window title: the repository's name for the team server (the first host with SSH in the settings), with the
 * host's name in front everywhere else ("local-thesis" on this computer), so local and server windows differ.
 */
export function sshAlias(project: string, host: string, hosts: readonly { name: string; ssh?: string }[]): string {
  return hosts.find((h) => h.ssh)?.name === host ? project : `${host}-${project}`;
}

/** The name of fnkc-ctl 0.3 and before, still recognized for windows opened with it. */
export const legacySshAlias = (project: string, host: string) => `fnkc-${host}--${project}`;

export const projectFolder = (project: string) => `${CONTAINER_HOME}/${project}`;

export const LABEL = {
  managed: 'fnkc.managed',
  user: 'fnkc.user',
  project: 'fnkc.project',
  /** Fingerprint of the container's setup; a different one means the container is recreated. */
  setup: 'fnkc.setup',
  repository: 'fnkc.repository',
  revision: 'fnkc.revision',
  /** Image and signer policy that passed provenance verification before this container was created. */
  provenance: 'fnkc.provenance',
} as const;

/** Labels of environment images (env/Dockerfile): the Positron build whose server the image contains. */
export const IMAGE_LABEL = {
  positronVersion: 'positron.version',
  positronCommit: 'positron.commit',
  /** sha256 of the renv.lock the environment was built from. */
  renvLock: 'r-env.lock-sha256',
  rSeries: 'r-env.r-series',
  /** On an image with a Positron server: the R environment image it is built on (env/positron.Dockerfile). */
  base: 'r-env.base',
} as const;

/** Internal recovery names cannot overlap any user/project container name. */
export const recoveryName = (user: string, project: string) => `fnkc.recovery.${user}.${project}`;
/** Kinds of helper containers: `read` reads a project's volumes, `ext` prepares its extensions volume. */
export type HelperKind = 'read' | 'ext';
/**
 * A helper container of a project; `id` (12 hex digits) tells concurrent ones apart. Outside project and recovery names,
 * too (those never start with fnkc.<kind>.).
 */
export const helperName = (kind: HelperKind, user: string, project: string, id: string) => `fnkc.${kind}.${user}.${project}.${id}`;
/**
 * Names of exactly this user's and project's helpers. Anchored, with the project escaped: a prefix would also match
 * other projects (fnkc.read.alice.a. starts fnkc.read.alice.a.b.<id>).
 */
export const helperPattern = (user: string, project: string) =>
  new RegExp(`^fnkc\\.(read|ext)\\.${escapeRegExp(user)}\\.${escapeRegExp(project)}\\.[0-9a-f]{12}$`);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Labels of helper containers, for operators: not fnkc.user/fnkc.project, which admission counts as projects. */
export const HELPER_LABEL = { kind: 'fnkc.helper', user: 'fnkc.helper.user', project: 'fnkc.helper.project' } as const;
export function isProjectContainer(c: { Name: string; Config: { Labels: Record<string, string> | null } }): boolean {
  const l = c.Config.Labels ?? {};
  return !!l[LABEL.user] && !!l[LABEL.project] && c.Name.replace(/^\//, '') === projectNames(l[LABEL.user], l[LABEL.project]).container;
}
