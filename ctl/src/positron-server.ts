// The Positron server that Remote SSH runs inside a container. Instead of a separate image per Positron
// version, every host keeps unpacked servers in a shared volume (bin/<commit>), mounted read-only into all
// project containers. A new Positron version only means one more archive on each host: the client downloads
// it on its own computer and sends it through the agent connection, so hosts need no access to Posit.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { AgentConfig } from './agent-config.ts';
import type { Docker } from './docker.ts';
import { type Arch, serverVolume } from './layout.ts';
import type { Logger } from './log.ts';
import type { ServerMissing } from './protocol.ts';

export function serverUrl(template: string, quality: string, version: string, arch: Arch): string {
  const values: Record<string, string> = {
    quality,
    version,
    os: 'linux',
    arch,
    'arch-long': arch === 'x64' ? 'x86_64' : 'arm64',
  };
  const url = template.replace(/\$\{([a-z-]+)\}/g, (m, k: string) => values[k] ?? m);
  if (url.includes('${')) throw new Error(`unknown placeholder in serverUrlTemplate: ${url}`);
  return url;
}

export const archiveName = (version: string, arch: Arch) => `positron-reh-linux-${arch}-${version}.tar.gz`;

// Runs in a throwaway container of the environment image, as root and without network: the archive
// arrives on stdin. It is unpacked next to the others, checked, and only then renamed to bin/<commit>.
const INSTALL_SCRIPT = `set -e
c="$1"; t="$(mktemp -d /srv/.tmp-XXXXXXXXXX)"
trap 'rm -rf "$t"' EXIT
tar -xzf - -C "$t" --strip-components=1 --no-same-owner
got="$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\\([0-9a-f]\\{40\\}\\)".*/\\1/p' "$t/product.json" | head -n 1)"
if [ "$got" != "$c" ]; then rm -rf "$t"; echo "the archive is for commit \${got:-unknown}, expected $c" >&2; exit 3; fi
if [ ! -x "$t/bin/positron-server" ]; then rm -rf "$t"; echo "no bin/positron-server in the archive" >&2; exit 3; fi
[ ! -e "/srv/$c" ] || { echo "incomplete server tree exists; administrator repair required" >&2; exit 3; }
mv "$t" "/srv/$c"`;

function helperArgs(arch: Arch, image: string, script: string, args: string[]): string[] {
  return ['run', '--rm', '-i', '--user', '0', '--network', 'none', '--memory', '1g', '--cpus', '1', '--pids-limit', '128', '-v', `${serverVolume(arch)}:/srv`,
    '--platform', arch === 'x64' ? 'linux/amd64' : 'linux/arm64',
    '--entrypoint', 'sh', image, '-c', script, 'sh', ...args];
}

/**
 * Thrown when the host has no server for the client's Positron and no archive in serverArchiveDir. Hosts do
 * not download it themselves (a server may have no access to Posit): the client downloads `missing.url` on
 * its own computer and sends the archive with installServer (agent install-server), then retries.
 */
export class PositronServerMissing extends Error {
  readonly missing: ServerMissing;
  constructor(missing: ServerMissing) {
    super(`Positron server ${missing.version} (${missing.arch}) is not on this host yet: ${missing.archive}`);
    this.missing = missing;
  }
}

const installed = async (docker: Docker, image: string, arch: Arch, commit: string) =>
  (await docker.run(helperArgs(arch, image, 'test -x "/srv/$1/bin/positron-server"', [commit]))).code === 0;

/**
 * Makes sure bin/<commit> is in the host's server volume. `ref` is Docker's name for the pinned `image` on this
 * host, used for the helper container; `image` is what the client names when it sends the server.
 */
export async function ensureServer(
  docker: Docker, cfg: AgentConfig, image: string, ref: string, arch: Arch,
  version: string, commit: string, log: Logger,
): Promise<void> {
  if (await installed(docker, ref, arch, commit)) return;
  const local = cfg.serverArchiveDir && join(cfg.serverArchiveDir, archiveName(version, arch));
  if (local && existsSync(local)) {
    log.info(`Installing Positron server ${version} (${arch}) from ${local}`);
    await installServer(docker, ref, arch, commit, createReadStream(local), statSync(local).size, log);
    return;
  }
  throw new PositronServerMissing({
    version, commit, arch, image, archive: archiveName(version, arch),
    url: serverUrl(cfg.serverUrlTemplate, cfg.quality, version, arch),
  });
}

/** Largest server archive accepted from a client (they are about 100-200 MB). */
export const MAX_SERVER_ARCHIVE = 1024 ** 3;

/**
 * Unpacks a server archive into bin/<commit> unless that is already there. The archive is checked by the
 * install script (its product.json must name `commit`, bin/positron-server must exist) before it is published.
 */
export async function installServer(
  docker: Docker, image: string, arch: Arch, commit: string, source: Readable, total: number, log: Logger,
): Promise<void> {
  if (await installed(docker, image, arch, commit)) {
    source.destroy();
    return;
  }
  let done = 0;
  let shown = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      if (done > MAX_SERVER_ARCHIVE) return cb(new Error('server archive is too large'));
      if (total && done / total >= shown + 0.25) {
        shown = Math.floor((done / total) * 4) / 4;
        log.info(`  ${Math.round(shown * 100)}% of ${Math.round(total / 1e6)} MB`);
      }
      cb(null, chunk);
    },
  });
  source.on('error', (e) => progress.destroy(e));
  const r = await docker.run(helperArgs(arch, image, INSTALL_SCRIPT, [commit]), { input: source.pipe(progress) });
  if (r.code !== 0) throw new Error(`could not install the Positron server: ${r.stderr.trim() || `exit code ${r.code}`}`);
  log.info('Positron server is ready on this host');
}

// Positron installs its bundled ("bootstrap") extensions into the extensions folder once per Positron version,
// recording the version in extensions/.version. For R projects about half of them (Jupyter, Python tools)
// only take memory, so fnkc-ctl prepares the folder itself before the first connection: it installs the
// bundled extensions except the skipped ones, removes skipped ones a previous bootstrap installed, and writes
// .version so Positron does not install them again. Done once per extensions volume, Positron version and
// skip list (remembered in extensions/.fnkc-ctl).
const EXTENSIONS_SCRIPT = `set -e
B="/srv/$1"; E=/ext; want="$2"; skip="$3"
[ "$(cat "$E/.fnkc-ctl" 2>/dev/null)" = "$want" ] && exit 0
cli() { HOME=/tmp "$B/bin/positron-server" --extensions-dir "$E" "$@"; }
skipped() { id="$(echo "$1" | tr '[:upper:]' '[:lower:]')"; for p in $skip; do case "$id" in "$p"*) return 0 ;; esac; done; return 1; }
for f in "$B"/extensions/bootstrap/*.vsix; do
  [ -e "$f" ] || continue
  id="$(basename "$f" .vsix | sed 's/-[0-9][^-]*$//')"
  if skipped "$id"; then continue; fi
  cli --install-extension "$f" >/dev/null 2>&1 || { echo "could not install $id" >&2; exit 1; }
done
for id in $(cli --list-extensions 2>/dev/null); do
  if skipped "$id"; then cli --uninstall-extension "$id" >/dev/null 2>&1 && echo "removed $id" >&2 || true; fi
done
printf '%s' "\${want%%;*}" > "$E/.version"
printf '%s' "$want" > "$E/.fnkc-ctl"
chown -R 1000:1000 "$E"`;

export async function prepareExtensions(
  docker: Docker, image: string, arch: Arch, volume: string,
  version: string, commit: string, skip: string[], log: Logger,
): Promise<void> {
  if (!skip.length) return; // keep everything: Positron's own bootstrap does it
  const list = skip.map((s) => s.toLowerCase()).sort();
  const want = `${version};${list.join(',')}`;
  const args = ['run', '--rm', '--user', '0', '--network', 'none', '--memory', '1g', '--cpus', '1', '--pids-limit', '128', '--platform', arch === 'x64' ? 'linux/amd64' : 'linux/arm64',
    '-v', `${serverVolume(arch)}:/srv:ro`, '-v', `${volume}:/ext`,
    '--entrypoint', 'sh', image, '-c', EXTENSIONS_SCRIPT, 'sh', commit, want, list.join(' ')];
  const check = await docker.run(['run', '--rm', '--network', 'none', '--memory', '1g', '--cpus', '1', '--pids-limit', '128', '-v', `${volume}:/ext:ro`, '--entrypoint', 'cat', image, '/ext/.fnkc-ctl']);
  if (check.code === 0 && check.stdout === want) return;
  log.info('Preparing Positron extensions for your containers (once per Positron version)');
  const r = await docker.run(args, { onStderr: (l) => log.info(`  ${l}`) });
  if (r.code !== 0) throw new Error(`could not prepare extensions: ${r.stderr.trim()}`);
}
