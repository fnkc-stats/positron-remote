// The Positron server that Remote SSH runs inside a container. Instead of a separate image per Positron
// version, every host keeps unpacked servers in a shared volume (bin/<commit>), mounted read-only into all
// project containers. A new Positron version only means one more download on each host.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { AgentConfig } from './agent-config.ts';
import type { Docker } from './docker.ts';
import { type Arch, serverVolume } from './layout.ts';
import type { Logger } from './log.ts';

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
c="$1"; t="/srv/.tmp-$c-$$"
rm -rf "$t"; mkdir -p "$t"
tar -xzf - -C "$t" --strip-components=1 --no-same-owner
got="$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\\([0-9a-f]\\{40\\}\\)".*/\\1/p' "$t/product.json" | head -n 1)"
if [ "$got" != "$c" ]; then rm -rf "$t"; echo "the archive is for commit \${got:-unknown}, expected $c" >&2; exit 3; fi
if [ ! -x "$t/bin/positron-server" ]; then rm -rf "$t"; echo "no bin/positron-server in the archive" >&2; exit 3; fi
rm -rf "/srv/$c"; mv "$t" "/srv/$c"`;

function helperArgs(arch: Arch, image: string, script: string, args: string[]): string[] {
  return ['run', '--rm', '-i', '--user', '0', '--network', 'none', '-v', `${serverVolume(arch)}:/srv`,
    '--platform', arch === 'x64' ? 'linux/amd64' : 'linux/arm64',
    '--entrypoint', 'sh', image, '-c', script, 'sh', ...args];
}

/** Makes sure bin/<commit> is in the host's server volume; `image` is used for the helper container. */
export async function ensureServer(
  docker: Docker, cfg: AgentConfig, image: string, arch: Arch,
  version: string, commit: string, log: Logger,
): Promise<void> {
  const check = await docker.run(helperArgs(arch, image, 'test -x "/srv/$1/bin/positron-server"', [commit]));
  if (check.code === 0) return;

  let source: Readable;
  let total = 0;
  const local = cfg.serverArchiveDir && join(cfg.serverArchiveDir, archiveName(version, arch));
  if (local && existsSync(local)) {
    log.info(`Installing Positron server ${version} (${arch}) from ${local}`);
    source = createReadStream(local);
    total = statSync(local).size;
  } else {
    const url = serverUrl(cfg.serverUrlTemplate, cfg.quality, version, arch);
    log.info(`Downloading Positron server ${version} (${arch}): ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} (is ${version} a Positron release?)`);
    total = Number(res.headers.get('content-length') ?? 0);
    source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  }

  let done = 0;
  let shown = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
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
  log.info(`Positron server ${version} is ready on this host`);
}
