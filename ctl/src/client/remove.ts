// Delete Project: what a stopped project would lose (agent remove-check), the report the user reads before deciding,
// and the deletion itself with this computer's SSH entries for the project. The extension and the CLI share it.
import { sshAlias } from '../layout.ts';
import type { Logger } from '../log.ts';
import type { RemovalCheck } from '../protocol.ts';
import { checkProject } from '../validate.ts';
import type { ClientConfig } from './config.ts';
import { removeSshConfig } from './ssh.ts';
import { transportFor } from './transport.ts';

function transport(cfg: ClientConfig, host: string, log: Logger) {
  const h = cfg.hosts.find((x) => x.name === host);
  if (!h) throw new Error(`unknown host '${host}' (known: ${cfg.hosts.map((x) => x.name).join(', ')})`);
  return transportFor(h, cfg, log);
}

export function checkRemoval(cfg: ClientConfig, project: string, host: string, log: Logger): Promise<RemovalCheck> {
  return transport(cfg, host, log).removalCheck(checkProject(project));
}

/** Deletes what `check` listed (the host refuses if the project changed since) and the project's SSH entries here. */
export async function deleteProject(cfg: ClientConfig, check: RemovalCheck, host: string, log: Logger): Promise<string[]> {
  const { removed } = await transport(cfg, host, log).remove(check.project, check.fingerprint);
  removeSshConfig(cfg.sshDir, sshAlias(check.project, host));
  return removed;
}

/** The work that would be lost, as short lines ("2 unpushed commits"); none: everything is on Gitea. */
export function lostWork(c: RemovalCheck): string[] {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const g = c.git;
  const lost: string[] = [];
  if (g?.error) lost.push(`the checkout could not be read (${g.error}): everything in the project folder`);
  else if (g?.missing) lost.push(`the project folder is not a git checkout: ${n(g.topLevel?.length ?? 0, 'entry', 'entries')} in it`);
  if (g?.unpushedCount) lost.push(`${n(g.unpushedCount, 'commit')} not pushed to Gitea${g.noRemoteRefs ? ' (the checkout has never seen Gitea’s branches)' : ''}`);
  if (g?.stashes.length) lost.push(n(g.stashes.length, 'stash', 'stashes'));
  if (g?.changed.length) lost.push(`${n(g.changed.length, 'file')} with uncommitted changes`);
  if (g?.untracked.length) lost.push(`${n(g.untracked.length, 'untracked file or folder', 'untracked files and folders')}`);
  if (g?.ignored.length) lost.push(`${n(g.ignored.length, 'file or folder', 'files and folders')} ignored by .gitignore (never pushed)`);
  if (c.outside.length) lost.push(`${n(c.outside.length, 'file or folder', 'files and folders')} in the container’s home, outside the project folder`);
  return lost;
}

export function size(kib?: number): string {
  if (kib === undefined) return '';
  return kib >= 1024 ** 2 ? `${(kib / 1024 ** 2).toFixed(1)} GB` : kib >= 1024 ? `${Math.round(kib / 1024)} MB` : `${kib} KB`;
}

/** What gets deleted: the container, each volume with what it holds and its size, the network. */
export function deletedObjects(c: RemovalCheck): string[] {
  return [
    ...(c.container ? [`container ${c.container}`] : []),
    ...c.volumes.map((v) => `volume ${v.name}${v.kib !== undefined ? ` (${size(v.kib)})` : ''}: ${v.holds}`),
    ...(c.network ? [`network ${c.network}`] : []),
  ];
}

/** The whole report as Markdown: what is lost, file by file, and what gets deleted. */
export function removalReport(c: RemovalCheck, host: string): string {
  const g = c.git;
  const lost = lostWork(c);
  const folder = `~/${c.project}`;
  const out = [`# Delete ${c.project} on ${host}?`, ''];
  if (!lost.length) {
    out.push(g
      ? `All of the local work in ${c.project} is synced with Gitea${g.branch ? ` (branch ${g.branch})` : ''}: nothing is uncommitted, ` +
        'unpushed, stashed or ignored, as of the last push or pull of this checkout.'
      : `${c.project} has no project folder on this host: there is no work in it to lose.`, '');
  } else {
    out.push('**This work is not on Gitea and is lost when the project is deleted:**', '', ...lost.map((l) => `- ${l}`), '');
    const list = (title: string, items: string[], more = 0) => {
      if (!items.length) return;
      out.push(`## ${title}`, '', ...items.map((i) => `- \`${i}\``), ...(more > 0 ? [`- … and ${more} more`] : []), '');
    };
    if (g?.error || g?.missing) list(`Everything in ${folder}`, (g.topLevel ?? []).map((p) => `${folder}/${p}`));
    if (g) {
      list('Commits not pushed to Gitea', g.unpushed, g.unpushedCount - g.unpushed.length);
      list('Stashes', g.stashes);
      list('Uncommitted changes', g.changed.map((f) => `${folder}/${f.path}  (${describe(f.code)})`));
      list('Untracked files and folders', g.untracked.map((p) => `${folder}/${p}`));
      list('Ignored by .gitignore (never pushed)', g.ignored.map((p) => `${folder}/${p}`));
    }
    list('In the container’s home, outside the project folder', c.outside.map((p) => `~/${p}`));
    out.push(`To keep it: open ${c.project}, commit and push (or copy the files elsewhere), stop it, then delete it again.`, '');
  }
  out.push('## Deleted in both cases', '', ...deletedObjects(c).map((o) => `- ${o}`), '');
  if (g?.regenerable.length) {
    out.push(`Rebuilt by itself on the next Open, so not counted as work: ${g.regenerable.map((p) => `\`${p}\``).join(', ')}.`, '');
  }
  if (g?.auxiliary.length) {
    out.push(`Editor and system files, not synced with Gitea and not counted as work: ${g.auxiliary.map((p) => `\`${p}\``).join(', ')}.`, '');
  }
  out.push(`The repository on Gitea is not touched: Open clones ${c.project} again, as on a new computer.`);
  return out.join('\n') + '\n';
}

function describe(code: string): string {
  const words: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type changed' };
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'merge conflict';
  const [staged, unstaged] = [...code];
  const w = (x: string) => words[x];
  return [staged !== ' ' ? `${w(staged) ?? staged}, staged` : '', unstaged !== ' ' ? w(unstaged) ?? unstaged : ''].filter(Boolean).join('; ');
}
