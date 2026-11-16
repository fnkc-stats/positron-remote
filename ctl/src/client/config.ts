// The user's settings: ~/.config/positron-ctl/config.json (or POSITRON_CTL_CONFIG, or --config).
// The extension will build the same object from its own settings.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile } from '../agent-config.ts';

export interface HostConfig {
  /** Shown to the user and used in --host. */
  name: string;
  /** user@host[:port] of the server's positron account; none for Docker on this computer. */
  ssh?: string;
}

export interface ClientConfig {
  /** In the order "auto" tries them. */
  hosts: HostConfig[];
  /** Bases of project repositories, e.g. "git@gitea.example.lan:stats"; /<project>.git is appended. */
  gitRemotes: string[];
  /** Image for projects without container.json. */
  defaultImage?: string;
  /** Private key for logging in to containers; its .pub is put into new containers. */
  sshKey?: string;
  /** git-crypt key for open --unlock. */
  gitCryptKey?: string;
  /** Agent settings for Docker on this computer (allowedImages, limits, ...; see agent-config.ts). */
  local: Record<string, unknown>;
  cacheDir: string;
  sshDir: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'positron-ctl', 'config.json');

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p;
}

const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function clientConfig(file: Record<string, unknown> = {}): ClientConfig {
  const sshDir = join(homedir(), '.ssh');
  const list = (k: string): string[] => {
    const v = file[k] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`config: "${k}" must be a list of strings`);
    return v as string[];
  };
  const str = (k: string): string | undefined => {
    const v = file[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw new Error(`config: "${k}" must be a string`);
    return expandHome(v);
  };

  const rawHosts = file.hosts ?? [{ name: 'local' }];
  if (!Array.isArray(rawHosts) || !rawHosts.length) throw new Error('config: "hosts" must be a non-empty list');
  const hosts = rawHosts.map((h: unknown): HostConfig => {
    const o = (h ?? {}) as Record<string, unknown>;
    if (typeof o.name !== 'string' || !HOST_NAME_RE.test(o.name)) throw new Error(`config: invalid host name ${JSON.stringify(o.name)}`);
    if (o.ssh !== undefined && typeof o.ssh !== 'string') throw new Error(`config: "ssh" of host ${o.name} must be a string`);
    return { name: o.name, ssh: o.ssh as string | undefined };
  });
  if (new Set(hosts.map((h) => h.name)).size !== hosts.length) throw new Error('config: host names must be unique');

  let sshKey = str('sshKey');
  if (!sshKey) {
    sshKey = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((k) => join(sshDir, k)).find((k) => existsSync(`${k}.pub`));
  }
  const local = file.local ?? {};
  if (typeof local !== 'object' || Array.isArray(local)) throw new Error('config: "local" must be an object');

  return {
    hosts,
    gitRemotes: list('gitRemotes'),
    defaultImage: str('defaultImage'),
    sshKey,
    gitCryptKey: str('gitCryptKey'),
    local: local as Record<string, unknown>,
    cacheDir: str('cacheDir') ?? join(homedir(), '.cache', 'positron-ctl'),
    sshDir,
  };
}

/** Reads the config file; without one, only Docker on this computer is used. */
export function loadClientConfig(path?: string): ClientConfig {
  const p = path ?? process.env.POSITRON_CTL_CONFIG ?? DEFAULT_CONFIG_PATH;
  if (!path && !process.env.POSITRON_CTL_CONFIG && !existsSync(p)) return clientConfig();
  return clientConfig(readJsonFile(p));
}
