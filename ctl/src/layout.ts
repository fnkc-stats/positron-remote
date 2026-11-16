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
    extensionsVolume: `${base}-ext`,
  };
}

/** Shared per host and architecture: unpacked Positron servers, bin/<commit>, mounted read-only. */
export const serverVolume = (arch: Arch) => `positron-server-${arch}`;

/** The SSH host name Positron connects to (written to ~/.ssh/positron/<project>.conf). */
export const sshAlias = (project: string) => `positron-${project}`;

export const projectFolder = (project: string) => `${CONTAINER_HOME}/${project}`;

export const LABEL = {
  managed: 'positron.managed',
  user: 'positron.user',
  project: 'positron.project',
  /** Fingerprint of the container's setup; a different one means the container is recreated. */
  setup: 'positron.setup',
} as const;
