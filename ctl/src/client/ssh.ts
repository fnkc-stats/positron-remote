// SSH from the user's computer: to a server's positron account, and to a project container (directly on
// this computer, or through the server with ProxyJump; the container's sshd listens on the host's 127.0.0.1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_USER, sshAlias } from '../layout.ts';

export interface SshTarget {
  /** user@host */
  dest: string;
  port?: string;
}

/** "user@host[:port]" or "ssh://user@host[:port]". */
export function parseSshTarget(s: string): SshTarget {
  const m = /^(?:ssh:\/\/)?([^@\s/]+@)?([^:@\s/]+)(?::(\d+))?\/?$/.exec(s.trim());
  if (!m) throw new Error(`invalid SSH address: '${s}' (expected user@host or user@host:port)`);
  return { dest: `${m[1] ?? ''}${m[2]}`, port: m[3] };
}

/** For ProxyJump / -J: user@host[:port] */
export const jumpOf = (t: SshTarget) => (t.port ? `${t.dest}:${t.port}` : t.dest);

export interface ContainerSsh {
  port: number;
  /** Server to go through; none for a container on this computer. */
  jump?: SshTarget;
  identity?: string;
}

const NO_HOST_KEY_CHECK = [
  // every new container has its own host key, and it is only reachable from the host itself
  '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
];

/** ssh options to run a command in a container (followed by the command). */
export function containerSshArgs(c: ContainerSsh, timeout = 10): string[] {
  return [
    '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`, ...NO_HOST_KEY_CHECK,
    '-p', String(c.port),
    ...(c.identity && existsSync(c.identity) ? ['-i', c.identity] : []),
    ...(c.jump ? ['-J', jumpOf(c.jump)] : []),
    `${CONTAINER_USER}@127.0.0.1`,
  ];
}

/** ~/.ssh/positron/<project>.conf: the host entry Positron's Remote SSH connects to. */
export function sshConfigEntry(project: string, hostName: string, c: ContainerSsh): string {
  const lines = [
    `# Written by positron-ctl: project ${project} on host '${hostName}'`,
    `Host ${sshAlias(project)}`,
    '  HostName 127.0.0.1',
    `  Port ${c.port}`,
    `  User ${CONTAINER_USER}`,
    ...(c.identity && existsSync(c.identity) ? [`  IdentityFile "${c.identity}"`] : []),
    '  ForwardAgent yes',
    ...(c.jump ? [`  ProxyJump ${jumpOf(c.jump)}`] : []),
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    '  LogLevel ERROR',
  ];
  return lines.join('\n') + '\n';
}

const INCLUDE_LINE = 'Include positron/*.conf';
const INCLUDE_RE = /^\s*Include\s+.*positron\//im;

/**
 * Writes the project's host entry and makes sure ~/.ssh/config includes these files. The Include line goes
 * at the very top: after a Host block it would only apply inside that block. Returns a message if the
 * config was changed.
 */
export function writeSshConfig(sshDir: string, project: string, hostName: string, c: ContainerSsh): string | undefined {
  const dir = join(sshDir, 'positron');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${project}.conf`), sshConfigEntry(project, hostName, c), { mode: 0o600 });

  const main = join(sshDir, 'config');
  const text = existsSync(main) ? readFileSync(main, 'utf8') : '';
  if (INCLUDE_RE.test(text)) return undefined;
  writeFileSync(main, `# Project containers started by positron-ctl\n${INCLUDE_LINE}\n\n${text}`, { mode: 0o600 });
  return `added "${INCLUDE_LINE}" at the top of ${main}`;
}

/** The host a project was last started on, from the comment line of its ~/.ssh/positron/<project>.conf. */
export function hostOfProject(sshDir: string, project: string): string | undefined {
  try {
    const first = readFileSync(join(sshDir, 'positron', `${project}.conf`), 'utf8').split('\n')[0];
    return /on host '([^']+)'/.exec(first)?.[1];
  } catch {
    return undefined;
  }
}

/** The SSH address of a git remote base (ssh://user@host:port/org or user@host:org). */
export function gitSshTarget(remote: string): { dest: string; port?: string } | undefined {
  const url = /^ssh:\/\/([^/]+)/.exec(remote);
  if (url) {
    try {
      return parseSshTarget(url[1]);
    } catch {
      return undefined;
    }
  }
  const scp = /^([^@/\s]+@[^:/\s]+):/.exec(remote);
  return scp ? { dest: scp[1] } : undefined;
}
