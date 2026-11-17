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
} as const;
