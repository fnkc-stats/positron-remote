// The Positron server that Remote SSH runs inside a container. It is part of the environment image (env/Dockerfile
// installs it into ~/.positron-server/bin/<commit>), so neither hosts nor this computer ever download it: an image
// serves exactly one Positron build, named in its labels, and a client of another build is refused before a
// container is created (Remote SSH would otherwise try to download a server, which a host without access to Posit
// cannot). A new Positron release means new images (env/positron.args) and new digests in container.json.
import type { Docker, ImageJson } from './docker.ts';
import { type Arch, IMAGE_LABEL, serverDir } from './layout.ts';
import type { Logger } from './log.ts';
import { runHelper } from './helper.ts';

/** The Positron build whose server the image contains (labels written by env/Dockerfile). */
export function imagePositron(img: ImageJson | null): { version: string; commit: string } | undefined {
  const labels = img?.Config?.Labels ?? {};
  const version = labels[IMAGE_LABEL.positronVersion];
  const commit = labels[IMAGE_LABEL.positronCommit];
  return version && commit ? { version, commit } : undefined;
}

/** Refuses a client whose Positron is not the build the image serves. */
export function checkPositron(img: ImageJson | null, image: string, client: { version: string; commit: string }): void {
  const built = imagePositron(img);
  if (!built) throw new Error(`${image} has no Positron server (no ${IMAGE_LABEL.positronCommit} label): pin an image built with one`);
  if (built.commit === client.commit) return;
  const name = (p: { version: string; commit: string }) => built.version === client.version ? `${p.version} (${p.commit.slice(0, 12)})` : p.version;
  throw new Error(`this project's image is built for Positron ${name(built)}, but this computer has Positron ${name(client)}. ` +
    `Install Positron ${built.version} (and turn off its automatic updates), or pin an image built for ${client.version} in container.json`);
}


// Positron installs its bundled ("bootstrap") extensions into the extensions folder once per Positron version,
// recording the version in extensions/.version. For R projects about half of them (Jupyter, Python tools)
// only take memory, so fnkc-ctl prepares the folder itself before the first connection: it installs the
// bundled extensions except the skipped ones, removes skipped ones a previous bootstrap installed, and writes
// .version so Positron does not install them again. Done once per extensions volume, Positron version and
// skip list (remembered in extensions/.fnkc-ctl).
//
// The volume is the user's (mounted read-write in their container), so its files are read only if they are regular
// (not symlinks, FIFOs or devices), at most 4 KiB of them, and the helpers that touch it are bounded (helper.ts).

/** Prints the volume's .fnkc-ctl if it is a regular file (else nothing: the volume is prepared again). */
export const EXTENSIONS_CHECK = 'f=/ext/.fnkc-ctl; if [ -f "$f" ] && [ ! -L "$f" ]; then head -c 4096 "$f"; fi';

/**
 * Gives the volume to the analyst, as root with no capability but CHOWN: a new volume belongs to root, and earlier
 * fnkc-ctl versions prepared volumes as root (one that failed midway left root's files). Symlinks are changed
 * themselves (-h), never followed, and the helper's own files are read-only, so a path the user swaps meanwhile
 * reaches nothing but their volume.
 */
export const EXTENSIONS_OWNER = 'chown 1000:1000 /ext && { find /ext -xdev \\( ! -user 1000 -o ! -group 1000 \\) -exec chown -h 1000:1000 {} + || true; }';

/** Prepares the volume as the analyst (who owns it after EXTENSIONS_OWNER), with no capabilities. */
export const EXTENSIONS_SCRIPT = `set -e
B="$1"; E=/ext; want="$2"; skip="$3"
cur=; if [ -f "$E/.fnkc-ctl" ] && [ ! -L "$E/.fnkc-ctl" ]; then cur="$(head -c 4096 "$E/.fnkc-ctl")"; fi
[ "$cur" = "$want" ] && exit 0
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
rm -f "$E/.version" "$E/.fnkc-ctl"
printf '%s' "\${want%%;*}" > "$E/.version"
printf '%s' "$want" > "$E/.fnkc-ctl"`;

/** How long reading the volume's .fnkc-ctl may take (a few bytes). */
export const EXTENSIONS_CHECK_MS = 20_000;
/** How long giving the volume to the analyst may take. */
export const EXTENSIONS_OWNER_MS = 60_000;
/** How long the preparation may take: Positron's command line installs the bundled extensions one by one. */
export const EXTENSIONS_PREPARE_MS = 5 * 60_000;

export async function prepareExtensions(
  docker: Docker, image: string, arch: Arch, volume: string,
  version: string, commit: string, skip: string[], log: Logger, owner: { user: string; project: string },
): Promise<void> {
  if (!skip.length) return; // keep everything: Positron's own bootstrap does it
  const list = skip.map((s) => s.toLowerCase()).sort();
  const want = `${version};${list.join(',')}`;
  const platform = ['--platform', arch === 'x64' ? 'linux/amd64' : 'linux/arm64'];
  const helper = (what: string, args: string[], timeoutMs: number, exited: number[], onStderr?: (l: string) => void) =>
    runHelper(docker, log, { kind: 'ext', ...owner, args: [...platform, ...args], timeoutMs, exited, onStderr }).catch((e: Error) => {
      if (/operation timed out/.test(e.message)) throw new Error(`could not ${what}: timed out after ${timeoutMs / 1000} s`);
      throw e;
    });
  const check = await helper("read the extensions volume's state", ['--user', '1000:1000', '--memory', '64m', '--pids-limit', '16',
    '-v', `${volume}:/ext:ro`, '--entrypoint', 'sh', image, '-c', EXTENSIONS_CHECK], EXTENSIONS_CHECK_MS, [0]);
  if (check.code === 0 && check.stdout === want) return;
  log.info('Preparing Positron extensions for your containers (once per Positron version)');
  const own = await helper('prepare extensions', ['--user', '0:0', '--cap-add', 'CHOWN', '--memory', '128m', '--pids-limit', '16',
    '-v', `${volume}:/ext`, '--entrypoint', 'sh', image, '-c', EXTENSIONS_OWNER], EXTENSIONS_OWNER_MS, [0, 1]);
  if (own.code !== 0) throw new Error(`could not prepare extensions: ${own.stderr.trim()}`);
  const r = await helper('prepare extensions', ['--user', '1000:1000', '--memory', '1g', '--pids-limit', '128',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '-v', `${volume}:/ext`,
    '--entrypoint', 'sh', image, '-c', EXTENSIONS_SCRIPT, 'sh', serverDir(commit), want, list.join(' ')],
  EXTENSIONS_PREPARE_MS, [0, 1], (l) => log.info(`  ${l}`));
  if (r.code !== 0) throw new Error(`could not prepare extensions: ${r.stderr.trim()}`);
}
