// What the client asks the agent and what it gets back. Over SSH, a request is one JSON object on stdin
// and the reply is one JSON line on stdout; progress messages go to stderr.

export interface StartRequest {
  project: string;
  repository: string;
  revision: string;
  /** Environment image with a specific tag, from the project's container.json. */
  image: string;
  /** Version and commit of the user's Positron client; the image must contain the server of this build. */
  positron: { version: string; commit: string };
  /** Key for logging in to the container. Ignored on a server: there the key comes from the host's config. */
  sshPublicKey?: string;
  /**
   * The image to run: `image` (an R environment, see env/positron.Dockerfile) with the server of the client's
   * Positron. Its r-env.base label must be `image`, and the checkout must pin `image`; otherwise the host answers
   * with the image the checkout pins (Reply.checkoutPins), and the client looks again for that one.
   */
  positronImage?: { image: string };
}

export interface StartResult {
  container: string;
  /** Port of the container's sshd on the host's 127.0.0.1. */
  sshPort: number;
  /** The container was created anew (first start, or the image or key changed). */
  created: boolean;
  /** The image the container runs. */
  image: string;
  /** The checkout's container.json image, when the container runs a positronImage instead. */
  pinnedImage?: string;
  revision: string;
  hostKey: string;
}

export interface ContainerInfo {
  project: string;
  repository?: string;
  container: string;
  running: boolean;
  state: string;
  image: string;
  sshPort?: number;
  /** Memory in use and the container's limit, e.g. "1.4GiB / 8GiB" (running containers only). */
  memory?: string;
}

/** An environment image on a host (agent images): what the Images panel shows under the host. */
export interface HostImage {
  /** The pins this image answers to (repository@sha256:...), as in container.json. */
  references: string[];
  /** Docker's image ID. */
  id: string;
  architecture: string;
  /** Unpacked size on the host's disk, in bytes. */
  size: number;
  created?: string;
  /** The image's r-env.* and positron.* labels (R version, Positron version, CRAN snapshot, ...). */
  labels: Record<string, string>;
  /** Project containers of all users on this host made from this image, and how many of them run. */
  containers: number;
  running: number;
  /** The asking user's own projects among them. */
  projects: string[];
}

export interface PingResult {
  version: string;
  user: string;
}

/** The host lacks the pinned environment image: the client downloads it by digest and sends it (install-image). */
export interface ImageMissing {
  image: string;
  /** The host's architecture: the version of a multi-architecture image to send. */
  arch: 'x64' | 'arm64';
}

export type Reply<T> = { ok: true; result: T } | { ok: false; error: string; imageMissing?: ImageMissing; checkoutPins?: string };

export const CTL_VERSION = '0.3.0';

/** "1.4GiB / 8GiB" -> "1.4 of 8 GB" */
export function shortMemory(use: string): string {
  const m = /^([\d.]+)\s*([KMG]i?B)\s*\/\s*([\d.]+)\s*([KMG]i?B)$/.exec(use);
  if (!m) return use;
  const gb = (v: string, u: string) => Number(v) / ({ K: 2 ** 20, M: 2 ** 10, G: 1 }[u[0] as 'K' | 'M' | 'G']);
  const f = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
  return `${f(gb(m[1], m[2]))} of ${f(gb(m[3], m[4]))} GB`;
}
