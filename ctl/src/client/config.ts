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
  /** Automatic uses the first configured host. None until configured: this computer is a host only by choice. */
  hosts: HostConfig[];
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

  const rawHosts = file.hosts ?? [];
  // A list given empty is a mistake in the file; no list at all is "not configured yet"
  if (!Array.isArray(rawHosts) || (file.hosts !== undefined && !rawHosts.length)) throw new Error('config: "hosts" must be a non-empty list');
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

/**
 * Positron settings (fnkcProjects.<key>) that win over the same key of config.json. Connection and secret policy is
 * personal machine configuration: only the user's own value counts, never a workspace's.
 */
export const SETTING_KEYS = ['hosts', 'gitRemotes', 'decryptionHosts', 'sshKey', 'gitCryptKey', 'localEngine', 'wslDistro',
  'envRepository', 'templateRepository'] as const;

/** Settings shows an unset string or list as empty: that is "not set", not a value. */
export function settingSet(v: unknown): boolean {
  return v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
}

/** The user's Positron settings (by key, idleMinutes included) on top of config.json: what the extension uses. */
export function withSettings(file: Record<string, unknown>, settings: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...file };
  for (const k of SETTING_KEYS) if (settingSet(settings[k])) raw[k] = settings[k];
  if (settings.idleMinutes !== undefined) raw.local = { ...(raw.local as object | undefined), idleMinutes: settings.idleMinutes };
  return raw;
}

/** Where the value in use of one setting comes from, and what else set it but lost. */
export interface SettingSource {
  /** "Positron user settings", "config.json at <path>" or "the built-in default". */
  from: string;
  /** Places that also set it, overridden by `from`. */
  overridden: string[];
  /** Nothing set it: the built-in default is in use. */
  isDefault: boolean;
  /** A workspace sets it too, which is never used for these settings. */
  workspaceIgnored?: boolean;
}

export type SettingSources = Record<string, SettingSource>;

/** The Positron settings as the extension reads them: the user's values, and which keys a workspace also sets. */
export interface SettingValues {
  user: Record<string, unknown>;
  workspace?: string[];
}

/**
 * For each setting, where the value in use comes from: the user's Positron setting, then config.json at `path`, then
 * the built-in default; and which of them it overrode. Without `settings` (the command line) only the file counts.
 */
export function settingSources(file: Record<string, unknown>, path: string, settings?: SettingValues): SettingSources {
  const out: SettingSources = {};
  const fileAt = `config.json at ${path}`;
  const add = (key: string, inSettings: boolean, inFile: boolean, fileLabel = fileAt) => {
    const set = [...(inSettings ? ['Positron user settings'] : []), ...(inFile ? [fileLabel] : [])];
    out[key] = {
      from: set[0] ?? 'the built-in default', overridden: set.slice(1), isDefault: !set.length,
      ...(settings?.workspace?.includes(key) ? { workspaceIgnored: true } : {}),
    };
  };
  // An empty sshKey in the file means "find one in ~/.ssh" (clientConfig), like no key at all
  for (const k of SETTING_KEYS) add(k, settingSet(settings?.user[k]), k === 'sshKey' ? settingSet(file[k]) : file[k] !== undefined);
  const local = file.local && typeof file.local === 'object' ? file.local as Record<string, unknown> : {};
  add('idleMinutes', settings?.user.idleMinutes !== undefined, local.idleMinutes !== undefined, `${fileAt} (local.idleMinutes)`);
  return out;
}

/** "sshKey from config.json at <path>, overriding ...": for the line of a check that reports this setting. */
export function sourceNote(sources: SettingSources | undefined, key: string, value?: unknown): string | undefined {
  const s = sources?.[key];
  if (!s) return undefined;
  return `${key}${value === undefined ? '' : ` ${String(value)}`} from ${s.from}` +
    (s.overridden.length ? `, overriding ${s.overridden.join(' and ')}` : '') +
    (s.workspaceIgnored ? '; its workspace setting is ignored (only user settings count)' : '');
}

export const NO_HOSTS = 'no hosts are configured: get config.json from your administrator and put it in ~/.config/fnkc-ctl/config.json ' +
  '(or pass --config); to run projects on this computer, add "hosts": [{ "name": "local" }]';

/** Commands that run on a host need one: without a configuration they say so instead of picking one. */
export function requireHosts(cfg: ClientConfig): void {
  if (!cfg.hosts.length) throw new Error(NO_HOSTS);
}

export function hostByName(cfg: ClientConfig, name: string): HostConfig {
  requireHosts(cfg);
  const h = cfg.hosts.find((x) => x.name === name);
  if (!h) throw new Error(`unknown host '${name}' (known: ${cfg.hosts.map((x) => x.name).join(', ')})`);
  return h;
}

/** Reads the config file; without one no host is configured (requireHosts). */
export function loadClientConfig(path?: string): ClientConfig {
  return clientConfig(readClientConfigFile(path));
}
