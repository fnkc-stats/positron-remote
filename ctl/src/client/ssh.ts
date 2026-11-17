import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_USER, sshAlias } from '../layout.ts';
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
    'positron-ctl', 'agent', 'connect', c.project].map(shellWord).join(' ');
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
  return [`# Written by positron-ctl: project ${project} on host '${hostName}'`,
    `Host ${sshAlias(project, hostName)}`, '  HostName 127.0.0.1', `  Port ${c.port}`, `  User ${CONTAINER_USER}`,
    ...(c.identity ? [`  IdentityFile ${configPath(c.identity)}`, '  IdentitiesOnly yes'] : []),
    '  ForwardAgent no', ...(proxy ? [`  ProxyCommand ${proxy}`] : []),
    '  StrictHostKeyChecking yes', `  UserKnownHostsFile ${configPath(c.knownHosts)}`, `  HostKeyAlias ${c.alias}`,
    '  ServerAliveInterval 30', '  ServerAliveCountMax 3'].join('\n') + '\n';
}

export function writeSshConfig(sshDir: string, project: string, hostName: string, c: ContainerSsh): string | undefined {
  const dir = join(sshDir, 'positron');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (file: string, text: string) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, file);
  };
  write(c.knownHosts, `${c.alias} ${checkSshKey(c.hostKey).split(' ').slice(0, 2).join(' ')}\n`);
  const alias = sshAlias(project, hostName);
  write(join(dir, `${alias}.conf`), sshConfigEntry(project, hostName, c));
  write(join(dir, `${alias}.json`), JSON.stringify({ project, host: hostName }));
  const main = join(sshDir, 'config');
  const text = existsSync(main) ? readFileSync(main, 'utf8') : '';
  if (/^Include positron\/\*\.conf$/m.test(text.split(/^Host\s/im)[0])) return undefined;
  write(main, `Include positron/*.conf\n\n${text}`);
  return 'added container SSH configuration include';
}

/** Window identity is immutable: look up its full alias, never a project-global last-host pointer. */
export function connectionOfAlias(sshDir: string, alias: string): { project: string; host: string } | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(alias)) return undefined;
  try {
    const v = JSON.parse(readFileSync(join(sshDir, 'positron', `${alias}.json`), 'utf8')) as { project: string; host: string };
    if (sshAlias(checkProject(v.project), v.host) !== alias) return undefined;
    return v;
  } catch { return undefined; }
}

export function gitSshTarget(remote: string): SshTarget | undefined {
  const url = /^ssh:\/\/([^/]+)/.exec(remote);
  if (url) { try { return parseSshTarget(url[1]); } catch { return undefined; } }
  const scp = /^([^@/\s]+@[^:/\s]+):/.exec(remote);
  return scp ? parseSshTarget(scp[1]) : undefined;
}
