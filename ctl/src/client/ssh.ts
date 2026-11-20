import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
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

export function writeSshConfig(sshDir: string, project: string, hostName: string, c: ContainerSsh): string | undefined {
  const dir = join(sshDir, 'fnkc');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (file: string, text: string) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, file);
  };
  const alias = c.alias;
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) throw new Error(`invalid SSH host name: '${alias}'`);
  // Another project on another host can come out with the same name ("local-x" on the server, "x" on this computer)
  const other = connectionOfAlias(sshDir, alias);
  if (other && (other.project !== project || other.host !== hostName)) {
    throw new Error(`the SSH host name ${alias} is already used by project ${other.project} on '${other.host}': ` +
      `stop it, or remove ~/.ssh/fnkc/${alias}.conf and ${alias}.json if it is no longer used`);
  }
  write(c.knownHosts, `${alias} ${checkSshKey(c.hostKey).split(' ').slice(0, 2).join(' ')}\n`);
  write(join(dir, `${alias}.conf`), sshConfigEntry(project, hostName, c));
  write(join(dir, `${alias}.json`), JSON.stringify({ project, host: hostName, alias }));
  // The same project and host under the name of older versions: no second entry in the Remote Explorer
  const legacy = legacySshAlias(project, hostName);
  if (legacy !== alias) for (const f of [`${legacy}.conf`, `${legacy}.json`]) rmSync(join(dir, f), { force: true });
  const main = join(sshDir, 'config');
  const text = existsSync(main) ? readFileSync(main, 'utf8') : '';
  if (/^Include fnkc\/\*\.conf$/m.test(text.split(/^Host\s/im)[0])) return undefined;
  write(main, `Include fnkc/*.conf\n\n${text}`);
  return 'added container SSH configuration include';
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
