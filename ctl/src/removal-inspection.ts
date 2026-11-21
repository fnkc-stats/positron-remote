import { createHash } from 'node:crypto';
import type { Docker } from './docker.ts';
import type { RemovalCheck } from './protocol.ts';
import { CONTAINER_HOME } from './layout.ts';

/**
 * Reads what removalCheck needs from the volumes (mounted read-only: the project volume at /work, the others at
 * /v/<name>). git runs without the user's configuration, hooks or fsmonitor and never writes (GIT_OPTIONAL_LOCKS).
 * Markers start with @@fnkc: so that no file name can look like one.
 */
export const REMOVAL_SCRIPT = `
set -euo pipefail
# Include every byte and metadata of all durable volumes, including Git refs, ignored files and symlinks.
# Fixed tar timestamps avoid changes caused only by reading; ownership/mode/path/content remain significant.
paths=()
[ ! -d /work ] || paths+=(/work)
[ ! -d /v ] || paths+=(/v)
echo @@fnkc:content
if [ "\${#paths[@]}" -gt 0 ]; then
  tar --sort=name --mtime=@0 --format=gnu -cf - "\${paths[@]}" | sha256sum
else printf '' | sha256sum; fi
if [ "$SIZES" = 1 ]; then echo @@fnkc:sizes; du -sk /work /v/* 2>/dev/null || true; fi
cd /work 2>/dev/null || exit 0
if [ ! -d .git ]; then echo @@fnkc:nogit; ls -Ap; exit 0; fi
if ( set -e
  export GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 HOME=/tmp
  g() { git -c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null -c safe.directory='*' "$@"; }
  echo @@fnkc:branch; g symbolic-ref -q --short HEAD || true
  echo @@fnkc:remotes; g for-each-ref --count=1 --format=x refs/remotes
  echo @@fnkc:unpushed; g rev-list --count HEAD --branches --not --remotes
  g log --format='%h %s' --max-count=50 HEAD --branches --not --remotes
  echo @@fnkc:stash; g stash list --format='%gd: %s'
  echo @@fnkc:status; g status --porcelain=v1 --ignored=matching --untracked-files=normal
) > /tmp/git.out 2> /tmp/git.err; then cat /tmp/git.out; else echo @@fnkc:error; tail -n 3 /tmp/git.err; echo @@fnkc:top; ls -Ap; fi
`;

/**
 * Ignored paths that the next Open of the project rebuilds by itself: not lost work. Includes our own restore marker
 * and environment lock in renv/ (Rprofile.R, fnkc-projects.sh).
 */
const REGENERABLE = /^(renv\/(library|staging|sandbox|python)\/|renv\/\.fnkc-(restored|environment\.lock)|\.Rproj\.user\/|\.quarto\/)$/;

/**
 * Editor, IDE and OS files that need not be on Gitea (Positron/VS Code settings, R history, notebook checkpoints,
 * Finder files), at any depth: not counted as lost work when untracked or ignored. Changes to tracked ones still count.
 */
const AUXILIARY = /(^|\/)((\.vscode|\.positron|\.idea|\.ipynb_checkpoints|__pycache__)(\/|$)|(\.DS_Store|\._[^/]*|Thumbs\.db|desktop\.ini|\.Rhistory|\.Rapp\.history|[^/]*\.code-workspace)\/?$)/;
export const isAuxiliary = (path: string) => AUXILIARY.test(path);

export function parseRemovalOutput(out: string): { sizes: Map<string, number>; git?: RemovalCheck['git'] } {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of out.split('\n')) {
    const m = /^@@fnkc:(\w+)$/.exec(line);
    if (m) sections.set(m[1], current = []);
    else if (line !== '' && current) current.push(line);
  }
  const sizes = new Map<string, number>();
  for (const l of sections.get('sizes') ?? []) {
    const m = /^(\d+)\s+(.+)$/.exec(l);
    if (m) sizes.set(m[2], Number(m[1]));
  }
  const empty = { unpushedCount: 0, unpushed: [], stashes: [], changed: [], untracked: [], ignored: [], regenerable: [], auxiliary: [] };
  if (sections.has('nogit')) return { sizes, git: { ...empty, missing: true, topLevel: sections.get('nogit') } };
  if (sections.has('error')) {
    return { sizes, git: { ...empty, error: (sections.get('error') ?? []).join(' ').trim() || 'git failed', topLevel: sections.get('top') ?? [] } };
  }
  if (!sections.has('status')) return { sizes };
  const [count, ...unpushed] = sections.get('unpushed') ?? ['0'];
  const git: NonNullable<RemovalCheck['git']> = {
    ...empty, branch: sections.get('branch')?.[0], noRemoteRefs: !sections.get('remotes')?.length,
    unpushedCount: Number(count) || 0, unpushed, stashes: sections.get('stash') ?? [],
    changed: [], untracked: [], ignored: [], regenerable: [], auxiliary: [],
  };
  for (const l of sections.get('status') ?? []) {
    const code = l.slice(0, 2), path = l.slice(3);
    // Only files git does not track: an edit to a tracked one would be lost
    if ((code === '??' || code === '!!') && isAuxiliary(path)) git.auxiliary.push(path);
    else if (code === '??') git.untracked.push(path);
    else if (code === '!!') (REGENERABLE.test(path) ? git.regenerable : git.ignored).push(path);
    else git.changed.push({ code, path });
  }
  return { sizes, git };
}

/**
 * The entries of the container's home that `docker diff` shows as added or changed, outside the project folder (a
 * volume, which docker diff leaves out anyway). Hidden entries are left out: caches, Positron's server files and
 * SSH keys of the container, never the user's work. So are logs that tools write into the home by themselves.
 */
const TOOL_FILES = new Set(['snowflake.log']);

export function outsideProject(diff: string, project: string): string[] {
  const home = `${CONTAINER_HOME}/`;
  const top = new Map<string, boolean>();
  for (const line of diff.split('\n')) {
    const m = /^([AC]) (.+)$/.exec(line.trim());
    if (!m || !m[2].startsWith(home)) continue;
    const [first, ...rest] = m[2].slice(home.length).split('/');
    if (!first || first.startsWith('.') || first === project || (!rest.length && TOOL_FILES.has(first))) continue;
    if (rest.length) top.set(first, true);
    else if (m[1] === 'A' && !top.has(first)) top.set(first, false);
  }
  return [...top].map(([name, folder]) => (folder ? `${name}/` : name)).sort();
}


/** The immutable image identifies unchanged files; hash the writable changes without exporting the base image. */
export async function writableContent(docker: Docker, container: string): Promise<{ root: string; diff: string }> {
  const diff = await docker.ok(['diff', container]);
  const entries = diff.split('\n').filter(Boolean).sort();
  const paths = entries.filter((line) => /^[AC] \//.test(line)).map((line) => line.slice(2));
  // Docker lists changed ancestor directories as well as their descendants. Read only leaves, so a changed
  // /usr does not copy every installed R package. Empty/new directories and symlinks are leaves too.
  const leaves = paths.filter((path) => !paths.some((other) => other !== path && other.startsWith(path + '/')));
  const hash = createHash('sha256').update(JSON.stringify(entries));
  for (const path of leaves) {
    const digest = await docker.ok(['cp', `${container}:${path}`, '-'], { hashStdout: true, timeoutMs: 10 * 60_000 });
    hash.update(JSON.stringify([path, digest]));
  }
  return { root: hash.digest('hex'), diff };
}
