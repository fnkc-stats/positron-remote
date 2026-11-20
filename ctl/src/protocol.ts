import packageInfo from '../package.json' with { type: 'json' };
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
  /** GitHub artifact attestation bundle for the image the host will run. */
  provenanceBundle?: string;
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
  /**
   * The container runs on as it was: a new start would set it up differently (new pin, fnkc-ctl, key, limits), which
   * happens only after an explicit stop. Older clients ignore this field and connect as usual.
   */
  updatePending?: boolean;
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

/**
 * What deleting a stopped project (agent remove-check) would lose: the work that is not on Gitea, and the Docker
 * objects that go. Gitea is known only as the checkout last saw it (its origin/* refs after the last push or pull):
 * the container has no network for the check.
 */
export interface RemovalCheck {
  project: string;
  /** The container, if there is one (volumes can outlive it). */
  container?: string;
  /** The project's volumes with their size in KiB (when it could be measured) and what they hold. */
  volumes: { name: string; kib?: number; holds: string }[];
  network?: string;
  /** The checkout in the project volume; absent without a project volume. */
  git?: {
    /** No .git directory: every top-level entry of the project folder is lost. */
    missing?: boolean;
    /** git failed: nothing could be verified, so every top-level entry is listed in `topLevel`. */
    error?: string;
    branch?: string;
    /** The checkout has never seen Gitea's branches (no origin/* refs): all its commits count as unpushed. */
    noRemoteRefs?: boolean;
    /** Commits on local branches or HEAD that no origin/* ref contains: count, and up to 50 "<hash> <subject>". */
    unpushedCount: number;
    unpushed: string[];
    stashes: string[];
    /** Uncommitted changes to tracked files: git status' two-letter code and the path. */
    changed: { code: string; path: string }[];
    /** Files and folders git does not track (folders end in /). */
    untracked: string[];
    /** Ignored by .gitignore, so never pushed: data, results, caches. */
    ignored: string[];
    /** Ignored, but rebuilt by itself on the next Open (renv's library and similar): not counted as lost. */
    regenerable: string[];
    /** Editor, IDE and OS files (.vscode/, .positron/, .Rhistory, .DS_Store…), untracked or ignored: not counted as lost. */
    auxiliary: string[];
    /** Every entry of the project folder, when nothing else could be checked (missing or error). */
    topLevel?: string[];
  };
  /** Files and folders in the container's home outside the project folder (not on any volume). */
  outside: string[];
  /** Identifies this result: remove refuses if the project changed since. */
  fingerprint: string;
}

export interface PingResult {
  /** Actual installed build, independent of wire compatibility. */
  version: string;
  protocol?: number;
  capabilities?: string[];
  user: string;
  /** Whether the host refuses project starts without a valid image attestation. */
  requiresProvenance?: boolean;
}

/** The host lacks the pinned environment image: the client downloads it by digest and sends it (install-image). */
export interface ImageMissing {
  image: string;
  /** The host's architecture: the version of a multi-architecture image to send. */
  arch: 'x64' | 'arm64';
}

export type Reply<T> = { ok: true; result: T } | { ok: false; error: string; imageMissing?: ImageMissing; checkoutPins?: string };

export const CTL_VERSION = packageInfo.version;
export const PROTOCOL_VERSION = 1;
export const CAPABILITIES = ['content-removal-v1', 'explicit-snapshot-v1', 'project-locks-v1', 'resumable-init-v1', 'image-provenance-v1'];

export function requireCompatible(p: PingResult): void {
  if (p.protocol !== PROTOCOL_VERSION || !CAPABILITIES.every((c) => p.capabilities?.includes(c))) {
    throw new Error(`host runs fnkc-ctl ${p.version} with incompatible protocol/capabilities; upgrade the server before using this client (${CTL_VERSION})`);
  }
}

/** "1.4GiB / 8GiB" -> "1.4 of 8 GB" */
export function shortMemory(use: string): string {
  const m = /^([\d.]+)\s*([KMG]i?B)\s*\/\s*([\d.]+)\s*([KMG]i?B)$/.exec(use);
  if (!m) return use;
  const gb = (v: string, u: string) => Number(v) / ({ K: 2 ** 20, M: 2 ** 10, G: 1 }[u[0] as 'K' | 'M' | 'G']);
  const f = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
  return `${f(gb(m[1], m[2]))} of ${f(gb(m[3], m[4]))} GB`;
}
