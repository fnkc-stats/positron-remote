import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_USER, legacySshAlias } from '../layout.ts';
import { checkProject, checkSshKey } from '../validate.ts';

export interface SshTarget { dest: string; port?: string }
export function parseSshTarget(s: string): SshTarget {
  const m = /^(?:ssh:\/\/)?([A-Za-z0-9._-]+@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d+))?\/?$/.exec(s.trim());
  if (!m || (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535))) throw new Error(`invalid SSH address: '${s}'`);
  return { dest: `${m[1] ?? ''}${m[2]}`, port: m[3] };
}
export const jumpOf = (t: SshTarget) => t.port ? `${t.dest}:${t.port}` : t.dest;

export interface ContainerSsh {
  port: number;
  jump?: SshTarget;
  identity?: string;
  project: string;
  alias: string;
  knownHosts: string;
  hostKey: string;
}

function configPath(value: string): string {
  if (/[\r\n"%]/.test(value)) throw new Error('unsupported characters in SSH path');
  return `"${value.replace(/\\/g, '/')}"`;
}
function shellWord(value: string): string {
  if (/[\r\n%]/.test(value)) throw new Error('unsupported characters in proxy command');
  if (process.platform === 'win32') {
    if (/["!^&|<>]/.test(value)) throw new Error('unsupported Windows proxy argument');
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** This SSH connection has no forwarding privileges; only the broker can select a destination. */
export function proxyCommand(c: ContainerSsh): string | undefined {
  if (!c.jump) return undefined;
  checkProject(c.project);
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    ...(c.identity ? ['-i', c.identity, '-o', 'IdentitiesOnly=yes'] : []),
    ...(c.jump.port ? ['-p', c.jump.port] : []), c.jump.dest,
    'fnkc-ctl', 'agent', 'connect', c.project].map(shellWord).join(' ');
}

export function containerSshArgs(c: ContainerSsh, timeout = 10): string[] {
  const proxy = proxyCommand(c);
  return ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`, '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${configPath(c.knownHosts)}`, '-o', `HostKeyAlias=${c.alias}`,
    '-p', String(c.port), ...(c.identity ? ['-i', c.identity, '-o', 'IdentitiesOnly=yes'] : []),
    ...(proxy ? ['-o', `ProxyCommand=${proxy}`] : []), `${CONTAINER_USER}@127.0.0.1`];
}

export function sshConfigEntry(project: string, hostName: string, c: ContainerSsh): string {
  const proxy = proxyCommand(c);
  return [`# Written by fnkc-ctl: project ${project} on host '${hostName}'`,
    `Host ${c.alias}`, '  HostName 127.0.0.1', `  Port ${c.port}`, `  User ${CONTAINER_USER}`,
    ...(c.identity ? [`  IdentityFile ${configPath(c.identity)}`, '  IdentitiesOnly yes'] : []),
    '  ForwardAgent no', ...(proxy ? [`  ProxyCommand ${proxy}`] : []),
    '  StrictHostKeyChecking yes', `  UserKnownHostsFile ${configPath(c.knownHosts)}`, `  HostKeyAlias ${c.alias}`,
    '  ServerAliveInterval 30', '  ServerAliveCountMax 3'].join('\n') + '\n';
}

/** The comment above our Include line in ~/.ssh/config: what it is for and how to take it out again. */
export const INCLUDE_MARKER = '# Added by FNKC Projects: connections to project containers (~/.ssh/fnkc). ' +
  'To remove: "FNKC: Remove SSH Configuration", or fnkc-ctl ssh-config --remove';
const INCLUDE = 'Include fnkc/*.conf';

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, file);
}

/** Whether ~/.ssh/config includes our entries: before its first Host or Match block, where Include applies to all. */
export function sshIncludePresent(sshDir: string): boolean {
  const main = join(sshDir, 'config');
  const text = existsSync(main) ? readFileSync(main, 'utf8') : '';
  return new RegExp(`^${INCLUDE.replace(/[*.]/g, '\\$&')}$`, 'm').test(text.split(/^(Host|Match)\s/im)[0]);
}

/** Adds the Include line with its comment at the top of ~/.ssh/config; returns what it did, or undefined if nothing. */
export function addSshInclude(sshDir: string): string | undefined {
  const main = join(sshDir, 'config');
  const text = existsSync(main) ? readFileSync(main, 'utf8') : '';
  if (sshIncludePresent(sshDir)) {
    // An Include written by an earlier version, without the comment that says what it is
    if (text.includes(INCLUDE_MARKER)) return undefined;
    writeAtomic(main, text.replace(new RegExp(`^${INCLUDE.replace(/[*.]/g, '\\$&')}$`, 'm'), `${INCLUDE_MARKER}\n${INCLUDE}`));
    return undefined;
  }
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  writeAtomic(main, `${INCLUDE_MARKER}\n${INCLUDE}\n\n${text}`);
  return 'added one Include line for project containers to ~/.ssh/config';
}

/**
 * Takes everything FNKC Projects wrote out of ~/.ssh: the Include line with its comment, and ~/.ssh/fnkc. The next
 * Open sets it up again. Returns what it removed.
 */
export function removeSshSetup(sshDir: string): string[] {
  const done: string[] = [];
  const main = join(sshDir, 'config');
  if (existsSync(main)) {
    const text = readFileSync(main, 'utf8');
    const kept = text.split('\n').filter((l) => l !== INCLUDE_MARKER && l.trim() !== INCLUDE).join('\n').replace(/^\n+/, '');
    if (kept !== text) { writeAtomic(main, kept); done.push(`the Include line in ${main}`); }
  }
  const dir = join(sshDir, 'fnkc');
  if (existsSync(dir)) {
    const n = readdirSync(dir).filter((f) => f.endsWith('.conf')).length;
    rmSync(dir, { recursive: true, force: true });
    done.push(`${dir} (${n} project connection${n === 1 ? '' : 's'})`);
  }
  return done;
}

/** Writes the project's SSH entry; the Include line only if `include` (the caller asked the user, or it is there). */
export function writeSshConfig(sshDir: string, project: string, hostName: string, c: ContainerSsh, include = true): string | undefined {
  const dir = join(sshDir, 'fnkc');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const alias = c.alias;
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) throw new Error(`invalid SSH host name: '${alias}'`);
  // Another project on another host can come out with the same name ("local-x" on the server, "x" on this computer)
  const other = connectionOfAlias(sshDir, alias);
  if (other && (other.project !== project || other.host !== hostName)) {
    throw new Error(`the SSH host name ${alias} is already used by project ${other.project} on '${other.host}': ` +
      `stop it, or remove ~/.ssh/fnkc/${alias}.conf and ${alias}.json if it is no longer used`);
  }
  writeAtomic(c.knownHosts, `${alias} ${checkSshKey(c.hostKey).split(' ').slice(0, 2).join(' ')}\n`);
  writeAtomic(join(dir, `${alias}.conf`), sshConfigEntry(project, hostName, c));
  writeAtomic(join(dir, `${alias}.json`), JSON.stringify({ project, host: hostName, alias }));
  // The same project and host under the name of older versions: no second entry in the Remote Explorer
  const legacy = legacySshAlias(project, hostName);
  if (legacy !== alias) removeSshConfig(sshDir, legacy);
  return include ? addSshInclude(sshDir) : undefined;
}

/** Removes one project's entry (its .conf, .json and .known_hosts): Remote SSH no longer lists it. */
export function removeSshConfig(sshDir: string, alias: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) return;
  for (const ext of ['conf', 'json', 'known_hosts']) rmSync(join(sshDir, 'fnkc', `${alias}.${ext}`), { force: true });
}

/**
 * Removes the entries of `host` whose project has no container there any more (`projects`: the host's containers,
 * as a listing that started at `listedAt` found them), so Remote SSH does not offer connections that cannot work.
 * Only entries written before the listing started: an Open meanwhile has its container, the listing may not.
 */
export function pruneSshConfig(sshDir: string, host: string, projects: Set<string>, listedAt: number): string[] {
  const dir = join(sshDir, 'fnkc');
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const pruned: string[] = [];
  for (const f of files.filter((x) => x.endsWith('.json'))) {
    const alias = f.slice(0, -'.json'.length);
    const v = connectionOfAlias(sshDir, alias);
    if (!v || v.host !== host || projects.has(v.project)) continue;
    try { if (statSync(join(dir, `${alias}.conf`)).mtimeMs >= listedAt - 60_000) continue; } catch { /* no .conf: remove the rest */ }
    removeSshConfig(sshDir, alias);
    pruned.push(v.project);
  }
  return pruned;
}

/** Window identity is immutable: look up its full alias, never a project-global last-host pointer. */
export function connectionOfAlias(sshDir: string, alias: string): { project: string; host: string } | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) return undefined;
  try {
    const v = JSON.parse(readFileSync(join(sshDir, 'fnkc', `${alias}.json`), 'utf8')) as { project: string; host: string; alias?: string };
    checkProject(v.project);
    if ((v.alias ?? legacySshAlias(v.project, v.host)) !== alias) return undefined;
    return { project: v.project, host: v.host };
  } catch { return undefined; }
}

export function gitSshTarget(remote: string): SshTarget | undefined {
  const url = /^ssh:\/\/([^/]+)/.exec(remote);
  if (url) { try { return parseSshTarget(url[1]); } catch { return undefined; } }
  const scp = /^([^@/\s]+@[^:/\s]+):/.exec(remote);
  return scp ? parseSshTarget(scp[1]) : undefined;
}
