// What the client asks the agent and what it gets back. Over SSH, a request is one JSON object on stdin
// and the reply is one JSON line on stdout; progress messages go to stderr.

export interface StartRequest {
  project: string;
  /** Environment image with a specific tag, from the project's container.json. */
  image: string;
  /** Version and commit of the user's Positron client; the host prepares the matching server. */
  positron: { version: string; commit: string };
  /** Key for logging in to the container. Ignored on a server: there the key comes from the host's config. */
  sshPublicKey?: string;
}

export interface StartResult {
  container: string;
  /** Port of the container's sshd on the host's 127.0.0.1. */
  sshPort: number;
  /** The container was created anew (first start, or the image or key changed). */
  created: boolean;
}

export interface ContainerInfo {
  project: string;
  container: string;
  running: boolean;
  state: string;
  image: string;
  sshPort?: number;
}

export interface PingResult {
  version: string;
  user: string;
}

export type Reply<T> = { ok: true; result: T } | { ok: false; error: string };

export const CTL_VERSION = '0.1.0';
