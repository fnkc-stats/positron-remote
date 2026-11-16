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
  /** Memory in use and the container's limit, e.g. "1.4GiB / 8GiB" (running containers only). */
  memory?: string;
}

export interface PingResult {
  version: string;
  user: string;
}

export type Reply<T> = { ok: true; result: T } | { ok: false; error: string };

export const CTL_VERSION = '0.1.0';

/** "1.4GiB / 8GiB" -> "1.4 of 8 GB" */
export function shortMemory(use: string): string {
  const m = /^([\d.]+)\s*([KMG]i?B)\s*\/\s*([\d.]+)\s*([KMG]i?B)$/.exec(use);
  if (!m) return use;
  const gb = (v: string, u: string) => Number(v) / ({ K: 2 ** 20, M: 2 ** 10, G: 1 }[u[0] as 'K' | 'M' | 'G']);
  const f = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
  return `${f(gb(m[1], m[2]))} of ${f(gb(m[3], m[4]))} GB`;
}
