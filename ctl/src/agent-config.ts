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
  /** Stop a container after this many minutes without connections and CPU use; 0: never. */
  idleMinutes: number;
  /**
   * Bundled Positron extensions not installed into containers (id prefixes, any case). Default: the Jupyter
   * and Python tools and GitHub pull requests, which R projects do not use. []: install all of them.
   */
  skipExtensions: string[];
  /** Seconds per idle check (one check counts as a minute); only for testing. */
  idleCheckSeconds?: number;
  /** The docker command, possibly with a prefix (e.g. ["wsl", "-d", "positron", "--exec", "docker"]). */
  docker: string[];
}

export const DEFAULT_SERVER_URL_TEMPLATE =
  'https://cdn.posit.co/positron/${quality}/reh/${arch-long}/positron-reh-${os}-${arch}-${version}.tar.gz';

export const DEFAULT_ALLOWED_IMAGES = ['ghcr.io/fnkc-stats/'];

export const DEFAULT_SKIP_EXTENSIONS = [
  'ms-toolsai.', 'ms-python.debugpy', 'meta.pyrefly', 'charliermarsh.ruff', 'github.vscode-pull-request-github',
];

/** On a server: an open project holds ~1.5 GB of RAM, so a forgotten one is stopped after an hour. */
export const DEFAULT_IDLE_MINUTES = 60;

function nonNegativeInt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`agent config: "${name}" must be a whole number, 0 or more`);
  return v as number;
}

function stringList(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x))) {
    throw new Error(`agent config: "${name}" must be a list of extension ids or prefixes`);
  }
  return v as string[];
}

function dockerCommand(v: unknown): string[] {
  if (v === undefined) return ['docker'];
  if (typeof v === 'string' && v) return [v];
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x)) return v as string[];
  throw new Error('agent config: "docker" must be a command or a list of command words');
}

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
    idleMinutes: nonNegativeInt(file.idleMinutes, 'idleMinutes') ?? DEFAULT_IDLE_MINUTES,
    skipExtensions: stringList(file.skipExtensions, 'skipExtensions') ?? DEFAULT_SKIP_EXTENSIONS,
    idleCheckSeconds: nonNegativeInt(file.idleCheckSeconds, 'idleCheckSeconds') || undefined,
    docker: dockerCommand(file.docker),
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
