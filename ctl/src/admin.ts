// Root-managed enrollment. The gateway disables SSH forwarding; agent connect brokers owned containers.
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkSshKey, checkUser } from './validate.ts';

export interface AdminOptions {
  /** The service account users log in as. */
  account: string;
  keysDir: string;
  /** The node binary and fnkc-ctl.cjs the forced command runs. */
  node: string;
  cli: string;
}

interface Account {
  home: string;
  uid: number;
  gid: number;
}

function account(name: string): Account {
  const line = readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[0] === name);
  if (!line) throw new Error(`no user account '${name}' on this machine (see server/install.sh)`);
  const f = line.split(':');
  return { uid: Number(f[2]), gid: Number(f[3]), home: f[5] };
}

const MARK = 'fnkc-ctl:';

export function authorizedKeysLine(user: string, key: string, o: Pick<AdminOptions, 'node' | 'cli'>): string {
  const [type, data] = checkSshKey(key).split(' ');
  const cmd = `${o.node} ${o.cli} serve --user ${checkUser(user)}`;
  if (/["\\]/.test(cmd)) throw new Error(`unsupported characters in the command: ${cmd}`);
  return `command="${cmd}",restrict ${type} ${data} ${MARK}${user}`;
}

/** The lines of authorized_keys without the given user's line (other, hand-written lines are kept). */
export function withoutUser(text: string, user: string): string[] {
  return text.split('\n').filter((l) => l.trim() && !l.trimEnd().endsWith(` ${MARK}${user}`));
}

export function usersIn(text: string): string[] {
  return text.split('\n').map((l) => new RegExp(` ${MARK}([a-z0-9]+)\\s*$`).exec(l)?.[1]).filter((u): u is string => !!u);
}

function authorizedKeys(o: AdminOptions): { file: string; acc: Account; text: string } {
  const acc = account(o.account);
  const dir = join(acc.home, '.ssh');
  const file = join(dir, 'authorized_keys');
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700 });
    chownSync(dir, acc.uid, acc.gid);
  }
  return { file, acc, text: existsSync(file) ? readFileSync(file, 'utf8') : '' };
}

function writeAuthorizedKeys(file: string, acc: Account, lines: string[]) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
  // sshd ignores the file unless it belongs to the account and nobody else can write it
  chownSync(temporary, acc.uid, acc.gid);
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** keyArg: a public key file, or the key itself ("ssh-ed25519 AAAA..."). */
export function addUser(user: string, keyArg: string, o: AdminOptions): string {
  checkUser(user);
  const key = checkSshKey(existsSync(keyArg) && statSync(keyArg).isFile() ? readFileSync(keyArg, 'utf8').split(/\r?\n/)[0] : keyArg);
  mkdirSync(o.keysDir, { recursive: true, mode: 0o755 });
  const publicKey = join(o.keysDir, `${user}.pub`);
  writeFileSync(`${publicKey}.${process.pid}.tmp`, key + '\n', { mode: 0o644 });
  renameSync(`${publicKey}.${process.pid}.tmp`, publicKey);
  const { file, acc, text } = authorizedKeys(o);
  writeAuthorizedKeys(file, acc, [...withoutUser(text, user), authorizedKeysLine(user, key, o)]);
  return file;
}

export function removeUser(user: string, o: AdminOptions): boolean {
  checkUser(user);
  const { file, acc, text } = authorizedKeys(o);
  const before = usersIn(text).includes(user);
  writeAuthorizedKeys(file, acc, withoutUser(text, user));
  rmSync(join(o.keysDir, `${user}.pub`), { force: true });
  return before;
}

export function listUsers(o: AdminOptions): string[] {
  return usersIn(authorizedKeys(o).text);
}

export function adminOptions(keysDir: string | undefined, account = 'fnkc'): AdminOptions {
  return {
    account,
    keysDir: keysDir ?? '/etc/fnkc-ctl/keys',
    node: process.execPath,
    cli: resolve(process.argv[1] ?? '/opt/fnkc-ctl/fnkc-ctl.cjs'),
  };
}
