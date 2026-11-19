// The Positron server that Remote SSH runs inside a container. It is part of the environment image (env/Dockerfile
// installs it into ~/.positron-server/bin/<commit>), so neither hosts nor this computer ever download it: an image
// serves exactly one Positron build, named in its labels, and a client of another build is refused before a
// container is created (Remote SSH would otherwise try to download a server, which a host without access to Posit
// cannot). A new Positron release means new images (env/positron.args) and new digests in container.json.
import type { Docker, ImageJson } from './docker.ts';
import { type Arch, IMAGE_LABEL, serverDir } from './layout.ts';
import type { Logger } from './log.ts';

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
const EXTENSIONS_SCRIPT = `set -e
B="$1"; E=/ext; want="$2"; skip="$3"
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
  const limits = ['--network', 'none', '--memory', '1g', '--cpus', '1', '--pids-limit', '128', '--platform', arch === 'x64' ? 'linux/amd64' : 'linux/arm64'];
  const check = await docker.run(['run', '--rm', ...limits, '-v', `${volume}:/ext:ro`, '--entrypoint', 'cat', image, '/ext/.fnkc-ctl']);
  if (check.code === 0 && check.stdout === want) return;
  log.info('Preparing Positron extensions for your containers (once per Positron version)');
  const r = await docker.run(['run', '--rm', '--user', '0', ...limits, '-v', `${volume}:/ext`,
    '--entrypoint', 'sh', image, '-c', EXTENSIONS_SCRIPT, 'sh', serverDir(commit), want, list.join(' ')], { onStderr: (l) => log.info(`  ${l}`) });
  if (r.code !== 0) throw new Error(`could not prepare extensions: ${r.stderr.trim()}`);
}
