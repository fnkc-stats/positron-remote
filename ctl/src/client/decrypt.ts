// Decrypting a project's data (git-crypt) when it opens. Repositories made from the template are encrypted for the
// team's personal GPG keys (git-crypt add-gpg-user): .git-crypt/keys/default/0/<fingerprint>.gpg holds the project's
// git-crypt key, encrypted for that person. This computer decrypts its own copy with the user's GnuPG (the usual
// passphrase window, or none if the passphrase is remembered) and passes the project key to `git-crypt unlock` in the
// container over SSH. The personal secret key never leaves this computer, and the project key is never written to a
// file on either side. A git-crypt key file (gitCryptKey in the config) is used instead when one is set.
import { readFileSync } from 'node:fs';
import { run } from '../exec.ts';
import type { ClientConfig, HostConfig } from './config.ts';
import { type ContainerSsh, containerSshArgs } from './ssh.ts';

/** none: no file uses git-crypt; locked / unlocked: the checkout's state; unknown: the container could not tell. */
export type DataState = 'none' | 'locked' | 'unlocked' | 'unknown';

const KEY_DIR = '.git-crypt/keys/default/0';
const MAGIC = '\0GITCRYPTKEY';

export async function dataState(c: ContainerSsh, folder: string): Promise<DataState> {
  const r = await run('ssh', [...containerSshArgs(c), `cd '${folder}' && fnkc-projects data`]);
  const s = r.stdout.trim();
  return r.code === 0 && (s === 'none' || s === 'locked' || s === 'unlocked') ? s : 'unknown';
}

/** Decryption on this computer's own Docker is always allowed; on a server only if decryptionHosts names it. */
export function decryptionApproved(cfg: ClientConfig, host: HostConfig): boolean {
  return !host.ssh || cfg.decryptionHosts.includes(host.name);
}

/** Fingerprints of the secret keys in `gpg --list-secret-keys --with-colons` (primary keys and subkeys). */
export function secretFingerprints(colons: string): string[] {
  const out: string[] = [];
  let secret = false;
  for (const line of colons.split('\n')) {
    const f = line.split(':');
    if (f[0] === 'sec' || f[0] === 'ssb') secret = true;
    else if (f[0] === 'pub' || f[0] === 'sub') secret = false;
    else if (f[0] === 'fpr' && secret && f[9]) out.push(f[9].toUpperCase());
  }
  return out;
}

/** The key file (<fingerprint>.gpg) one of the user's secret keys can open, if any. */
export function keyFileFor(files: string[], fingerprints: string[]): string | undefined {
  const mine = new Set(fingerprints.map((f) => f.toUpperCase()));
  return files.find((f) => /^[0-9A-Fa-f]{40,64}\.gpg$/.test(f) && mine.has(f.slice(0, -4).toUpperCase()));
}

/** The project's git-crypt key: from gitCryptKey, or decrypted from the repository with the user's GPG key. */
async function projectKey(cfg: ClientConfig, c: ContainerSsh, folder: string): Promise<Buffer> {
  if (cfg.gitCryptKey) return readFileSync(cfg.gitCryptKey);

  const listed = await run('gpg', ['--list-secret-keys', '--with-colons'])
    .catch(() => { throw new Error('GnuPG is not installed on this computer (macOS: GPG Suite or brew install gnupg; Windows: Gpg4win)'); });
  const mine = secretFingerprints(listed.stdout);
  if (!mine.length) throw new Error('there is no personal GPG key on this computer (gpg --list-secret-keys shows none)');

  const files = await run('ssh', [...containerSshArgs(c), `ls '${folder}/${KEY_DIR}' 2>/dev/null`]);
  const file = keyFileFor(files.stdout.split('\n').map((l) => l.trim()), mine);
  if (!file) {
    throw new Error(`the project is not encrypted for your GPG key. A team member who can decrypt it adds you with: ` +
      `git-crypt add-gpg-user ${mine[0]} (your public key must be in their keyring)`);
  }
  // base64: the key files and the key are binary, ssh output is read as text
  const blob = await run('ssh', [...containerSshArgs(c), `base64 '${folder}/${KEY_DIR}/${file}'`]);
  if (blob.code !== 0) throw new Error(`could not read ${KEY_DIR}/${file}: ${blob.stderr.trim()}`);
  // No time limit to speak of: the user may be typing the passphrase
  const key = await run('gpg', ['--quiet', '--no-tty', '--decrypt'], { input: Buffer.from(blob.stdout, 'base64'), timeoutMs: 600_000 });
  if (key.code !== 0) throw new Error(`gpg could not decrypt the project key: ${key.stderr.trim().split('\n').pop() ?? ''}`);
  return key.stdoutBytes!;
}

/** Decrypts the checkout in the container. Throws with a message for the user if it cannot. */
export async function unlockProject(cfg: ClientConfig, c: ContainerSsh, folder: string): Promise<void> {
  const key = await projectKey(cfg, c, folder);
  if (key.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) throw new Error('this is not a git-crypt key');
  const r = await run('ssh', [...containerSshArgs(c), `cd '${folder}' && git-crypt unlock /dev/stdin`], { input: key });
  if (r.code !== 0) throw new Error(`git-crypt unlock failed: ${r.stderr.trim()}`);
}
