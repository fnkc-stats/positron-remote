// Checks of everything that comes from a request. On a server the request comes from a user over SSH,
// so these checks are what keeps them within their own containers and the allowed images.

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
// Letters and digits only: the user name is the part of fnkc-<user>-<project> up to the first "-",
// so containers and volumes of different users can never get the same name.
const USER_RE = /^[a-z][a-z0-9]{0,31}$/;
const VERSION_RE = /^\d{4}\.\d{2}\.\d+-\d+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const SSH_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;

export function checkProject(p: unknown): string {
  if (typeof p !== 'string' || !PROJECT_RE.test(p)) throw new Error(`invalid project name: '${String(p)}'`);
  return p;
}

export function checkUser(u: unknown): string {
  if (typeof u !== 'string' || !USER_RE.test(u)) {
    throw new Error(`invalid user name: '${String(u)}' (lowercase letters and digits, starting with a letter)`);
  }
  return u;
}

/** A user name from an arbitrary login name: lowercase letters and digits only. */
export function sanitizeUser(name: string): string {
  let u = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
  if (!/^[a-z]/.test(u)) u = `u${u}`.slice(0, 32);
  return u;
}

export function checkVersion(v: unknown): string {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) {
    throw new Error(`not a Positron version: '${String(v)}' (expected something like 2026.07.1-5)`);
  }
  return v;
}

export function checkCommit(c: unknown): string {
  if (typeof c !== 'string' || !COMMIT_RE.test(c)) throw new Error(`not a Positron commit: '${String(c)}'`);
  return c;
}

/**
 * The environment image needs a specific tag: it pins the dependencies. With a non-empty `allowed`,
 * the image must start with one of these prefixes (e.g. "ghcr.io/fnkc-stats/").
 */
export function checkImage(image: unknown, allowed: string[] = []): string {
  if (typeof image !== 'string' || !image) throw new Error('no environment image given');
  if (!IMAGE_RE.test(image)) throw new Error(`image must be pinned as repository@sha256:<64 lowercase hex digits>: ${image}`);
  const repository = image.split('@')[0].replace(/:[^/:]+$/, '');
  if (allowed.length && !allowed.includes(repository)) {
    throw new Error(`image not allowed on this host: ${image} (allowed: ${allowed.join(', ')})`);
  }
  return image;
}

export function checkSshKey(k: unknown): string {
  const key = typeof k === 'string' ? k.trim() : '';
  if (!SSH_KEY_RE.test(key)) throw new Error('not an SSH public key (expected one line such as "ssh-ed25519 AAAA... name")');
  return key;
}

/** Docker memory and CPU limits from the host's config. */
export function checkLimit(kind: 'memory' | 'cpus', v: unknown): string {
  const re = kind === 'memory' ? /^\d+[bkmg]?$/i : /^\d+(\.\d+)?$/;
  if (typeof v !== 'string' || !re.test(v)) throw new Error(`invalid ${kind} limit: '${String(v)}'`);
  if (parseFloat(v) <= 0) throw new Error(`${kind} limit must be positive`);
  return v;
}
