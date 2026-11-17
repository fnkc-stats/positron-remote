// Names and paths shared by the host side (agent) and the user side (client).

/** The working user inside the container; created in env/Dockerfile, change both together. */
export const CONTAINER_USER = 'analyst';
export const CONTAINER_HOME = `/home/${CONTAINER_USER}`;
/** Where Positron Remote SSH keeps its server: bin/<commit>, data/, extensions/, logs. */
export const SERVER_DATA_DIR = `${CONTAINER_HOME}/.positron-server`;

export type Arch = 'x64' | 'arm64';

/** Docker objects of one user's project on a host. */
export function projectNames(user: string, project: string) {
  const base = `positron-${user}-${project}`;
  return {
    container: base,
    projectVolume: `${base}-project`,
    dataVolume: `${base}-data`,
    /** Before extensions were shared per user: removed when the project's container is recreated. */
    legacyExtensionsVolume: `${base}-ext`,
  };
}

/**
 * Positron's extensions inside containers, shared by all projects of a user on a host. Per architecture,
 * because some extensions ship native programs (ruff, air). The user part is letters and digits only,
 * so the name never equals another user's.
 */
export const extensionsVolume = (user: string, arch: Arch, project: string, commit: string) => `positron-ext-${user}-${project}-${arch}-${commit.slice(0, 12)}`;

/** Shared per host and architecture: unpacked Positron servers, bin/<commit>, mounted read-only. */
export const serverVolume = (arch: Arch) => `positron-server-${arch}`;

/**
 * renv's package cache, shared by all users' containers on a host (agent setting sharedRenvCache). renv keeps
 * platform, R version and architecture apart inside it. Mounted at RENV_CACHE_DIR; Rprofile.R enables it there.
 */
export const RENV_CACHE_VOLUME = 'positron-renv-cache';
export const RENV_CACHE_DIR = '/var/cache/positron-renv';

/**
 * R package libraries built from a lockfile for one image (positron-ctl admin build-library), shared by every
 * project on a host that pins the same image and library. Never changed after the checks passed: an update is a
 * new lockfile, so a new volume. The name holds the image's ID (its configuration digest, so architecture and
 * system libraries) and the lockfile's sha256, both shortened; labels hold them in full.
 */
export const libraryVolume = (imageId: string, library: string) =>
  `positron-rlib-${imageId.replace(/^sha256:/, '').slice(0, 16)}-${library.replace(/^sha256:/, '').slice(0, 16)}`;
/** Where the library is mounted (read-only): the image's site library, which R and renv already use. */
export const R_SITE_LIBRARY = '/usr/local/lib/R/site-library';
/** Inside a library volume: its lockfile, build record, check results and the "ready" marker. */
export const LIBRARY_META = '.positron-library';

/** The SSH host name Positron connects to (written to ~/.ssh/positron/<project>.conf). */
export const sshAlias = (project: string, host: string) => `positron-${host}--${project}`;

export const projectFolder = (project: string) => `${CONTAINER_HOME}/${project}`;

export const LABEL = {
  managed: 'positron.managed',
  user: 'positron.user',
  project: 'positron.project',
  /** Fingerprint of the container's setup; a different one means the container is recreated. */
  setup: 'positron.setup',
  repository: 'positron.repository',
  revision: 'positron.revision',
  /** On library volumes: the lockfile's sha256 and the image ID it was built for. */
  library: 'positron.library',
  libraryImage: 'positron.library.image',
} as const;
