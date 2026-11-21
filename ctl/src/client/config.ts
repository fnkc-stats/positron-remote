// The user's settings: ~/.config/fnkc-ctl/config.json (or FNKC_CTL_CONFIG, or --config).
// The extension will build the same object from its own settings.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile } from '../agent-config.ts';
import { memoryBytes } from '../capacity.ts';
import { checkLimit } from '../validate.ts';
import type { EngineSettings } from './engine.ts';

export interface HostConfig {
  /** Shown to the user and used in --host. */
  name: string;
  /** user@host[:port] of the server's fnkc account; none for Docker on this computer. */
  ssh?: string;
}

export interface ClientConfig {
  /** Automatic uses the first configured host. */
  hosts: HostConfig[];
  /** No hosts were configured: the one host is this computer by default (the command line, tests), not a choice. */
  hostsDefault?: boolean;
  /** Bases of project repositories, e.g. "git@gitea.example.lan:stats"; /<project>.git is appended. */
  gitRemotes: string[];
  /** Private key for logging in to containers; its .pub is put into new containers. */
  sshKey?: string;
  /** git-crypt key for open --unlock. */
  gitCryptKey?: string;
  decryptionHosts: string[];
  /** GitHub repository (owner/name) whose env-image workflow builds environment images (fnkc-ctl build). */
  envRepository: string;
  /** Gitea repository of each R series' project template; {series} is replaced (Images panel). */
  templateRepository: string;
  /** Agent settings for Docker on this computer (allowedImages, limits, ...; see agent-config.ts). */
  local: Record<string, unknown>;
  /** Which Docker this computer has and how to start it (localEngine, wslDistro in the file). */
  engine: EngineSettings;
  cacheDir: string;
  sshDir: string;
  /** Most bytes downloaded environment images may take in cacheDir; the least recently used go first. */
  imageCacheLimit: number;
}

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
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error('config: "local" must be an object');

  const engine = str('localEngine') ?? 'auto';
  if (!['auto', 'colima', 'docker-desktop', 'wsl', 'system'].includes(engine)) {
    throw new Error(`config: "localEngine" must be auto, colima, docker-desktop, wsl or system, not '${engine}'`);
  }

  return {
    hosts,
    ...(file.hosts === undefined ? { hostsDefault: true } : {}),
    engine: { engine: engine as EngineSettings['engine'], wslDistro: str('wslDistro') },
    gitRemotes: list('gitRemotes'),
    sshKey,
    gitCryptKey: str('gitCryptKey'),
    decryptionHosts: list('decryptionHosts'),
    envRepository: str('envRepository') ?? 'fnkc-stats/positron-remote',
    templateRepository: str('templateRepository') ?? 'template-r-{series}',
    local: local as Record<string, unknown>,
    cacheDir: str('cacheDir') ?? join(homedir(), '.cache', 'fnkc-ctl'),
    sshDir,
    imageCacheLimit: memoryBytes(checkLimit('memory', str('imageCacheLimit') ?? '20g')),
  };
}

/** Where the config file is read from (and where Import Configuration puts it). */
export function clientConfigPath(): string {
  return process.env.FNKC_CTL_CONFIG ?? join(homedir(), '.config', 'fnkc-ctl', 'config.json');
}

/** The config file as it is (empty if there is none and no path was asked for explicitly). */
export function readClientConfigFile(path?: string): Record<string, unknown> {
  const p = path ?? clientConfigPath();
  if (!path && !process.env.FNKC_CTL_CONFIG && !existsSync(p)) return {};
  return readJsonFile(p);
}

/** Reads the config file; without one, only Docker on this computer is used. */
export function loadClientConfig(path?: string): ClientConfig {
  return clientConfig(readClientConfigFile(path));
}
