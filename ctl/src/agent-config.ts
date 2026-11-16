// Settings of the host side. On a server they come from the admin's file (/etc/positron-ctl/agent.json);
// locally, from the "local" section of the user's config. Requests cannot change any of them.
import { readFileSync } from 'node:fs';
import { checkLimit, checkUser } from './validate.ts';

export interface Limits {
  /** docker --memory, e.g. "64g" */
  memory?: string;
  /** docker --cpus, e.g. "16" */
  cpus?: string;
  /** docker --pids-limit */
  pids?: number;
}

export interface AgentConfig {
  /** Whose containers these are: they are named positron-<user>-<project>. */
  user: string;
  /** Image prefixes that may be started, e.g. "ghcr.io/fnkc-stats/". Empty: any image. */
  allowedImages: string[];
  /** Server: users' keys as <keysDir>/<user>.pub. Unset (locally): the key comes with the request. */
  keysDir?: string;
  limits: Limits;
  /** Where to download the Positron server from; same placeholders as remoteSSH.serverDownloadUrlTemplate. */
  serverUrlTemplate: string;
  quality: string;
  /** A folder with positron-reh-linux-<arch>-<version>.tar.gz files used instead of downloading. */
  serverArchiveDir?: string;
  /** The docker command. */
  docker: string;
}

export const DEFAULT_SERVER_URL_TEMPLATE =
  'https://cdn.posit.co/positron/${quality}/reh/${arch-long}/positron-reh-${os}-${arch}-${version}.tar.gz';

export const DEFAULT_ALLOWED_IMAGES = ['ghcr.io/fnkc-stats/'];

/** Fills in defaults and checks the values. `file` is the JSON settings (agent.json or the "local" section). */
export function agentConfig(user: string, file: Record<string, unknown> = {}): AgentConfig {
  const str = (k: string) => {
    const v = file[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new Error(`agent config: "${k}" must be a string`);
    return v;
  };
  const allowed = file.allowedImages ?? DEFAULT_ALLOWED_IMAGES;
  if (!Array.isArray(allowed) || !allowed.every((p) => typeof p === 'string')) {
    throw new Error('agent config: "allowedImages" must be a list of strings');
  }
  const l = (file.limits ?? {}) as Record<string, unknown>;
  const limits: Limits = {};
  if (l.memory !== undefined) limits.memory = checkLimit('memory', l.memory);
  if (l.cpus !== undefined) limits.cpus = checkLimit('cpus', String(l.cpus));
  if (l.pids !== undefined) {
    if (!Number.isInteger(l.pids) || (l.pids as number) <= 0) throw new Error('agent config: "limits.pids" must be a positive integer');
    limits.pids = l.pids as number;
  }
  return {
    user: checkUser(user),
    allowedImages: allowed as string[],
    keysDir: str('keysDir'),
    limits,
    serverUrlTemplate: str('serverUrlTemplate') ?? DEFAULT_SERVER_URL_TEMPLATE,
    quality: str('quality') ?? 'releases',
    serverArchiveDir: str('serverArchiveDir'),
    docker: str('docker') ?? 'docker',
  };
}

export function readJsonFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('expected a JSON object');
    return v as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}
