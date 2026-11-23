// The Projects panel: each host with its project containers. Listing never starts anything: a computer whose
// Docker is not running just says so. Buttons on the items run the same open / stop as the commands.
import * as vscode from 'vscode';
import type { ClientConfig } from './client/config.ts';
import { listProjects } from './client/open.ts';
import type { Logger } from './log.ts';
import type { PendingUpdates } from './pending-updates.ts';
import { type ContainerInfo, shortMemory } from './protocol.ts';

export type Item =
  | { kind: 'host'; host: string; ssh?: string; error?: string; count: number }
  | { kind: 'project'; host: string; container: ContainerInfo };

/**
 * Why this computer's Docker could not list the projects (or `what` else). Only a daemon that does not answer is
 * started by an Open; no access to the socket, a missing docker command or a broken Docker setup are not, so they
 * say what to check. Also used by the Environment Images panel.
 */
export function localProblem(error: string, what = 'projects'): { description: string; hint?: string } {
  if (/permission denied|operation not permitted|EACCES|access is denied/i.test(error)) {
    return { description: 'no access to Docker', hint: 'Your account may not use Docker on this computer (on Linux: '
      + 'be in the docker group, then log out and in again). Check Setup shows how to fix it.' };
  }
  // Colima creates its context at the first start, which an Open does
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|Docker is not running|daemon is not running|error during connect|docker_engine.*cannot find the file|context "colima-[^"]*": context not found/i.test(error)) {
    return { description: 'Docker is not running', hint: 'It starts by itself when you open a project here.' };
  }
  if (/ENOENT|command not found|is not recognized|context not found|context ".*" does not exist|error loading config|unable to resolve docker endpoint|non-local endpoint|is not installed/i.test(error)) {
    return { description: 'Docker is not set up', hint: 'Docker or its settings on this computer need fixing. Check Setup shows how.' };
  }
  return { description: `cannot list ${what}`, hint: 'Refresh to try again; Check Setup may show why.' };
}

export class ProjectsTree implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private listing?: Promise<Map<string, { error?: string; containers: ContainerInfo[] }>>;
  private readonly config: () => ClientConfig;
  private readonly log: Logger;
  private readonly pending?: PendingUpdates;
  private readonly list: typeof listProjects;

  constructor(config: () => ClientConfig, log: Logger, pending?: PendingUpdates, list = listProjects) {
    this.config = config;
    this.log = log;
    this.pending = pending;
    this.list = list;
  }

  refresh() {
    this.listing = undefined;
    this.changed.fire(undefined);
  }

  /** Refreshes unless the hosts were asked less than ms ago (focus changes come often; a server is one SSH call). */
  refreshIfOlder(ms: number) {
    if (Date.now() - this.listedAt >= ms) this.refresh();
  }

  private listedAt = 0;

  private load() {
    this.listing ??= (async () => {
      this.listedAt = Date.now();
      const result = new Map<string, { error?: string; containers: ContainerInfo[] }>();
      try {
        for (const l of await this.list(this.config(), this.log)) {
          result.set(l.host, l);
          // A host that answered: what it no longer runs has no pending update
          if (!l.error) await this.pending?.prune(l.host, l.containers);
        }
      } catch (e) {
        this.log.warn(`listing projects: ${(e as Error).message}`);
      }
      return result;
    })();
    return this.listing;
  }

  async getChildren(item?: Item): Promise<Item[]> {
    if (!item) {
      let cfg: ClientConfig;
      try {
        cfg = this.config();
      } catch {
        return []; // the welcome view says the configuration has an error
      }
      // Not configured: the welcome view says so
      if (!cfg.hosts.length) return [];
      const listing = await this.load();
      return cfg.hosts.map((h) => {
        const l = listing.get(h.name);
        return { kind: 'host', host: h.name, ssh: h.ssh, error: l?.error, count: l?.containers.length ?? 0 };
      });
    }
    if (item.kind === 'host') {
      const listing = await this.load();
      const cs = [...(listing.get(item.host)?.containers ?? [])];
      cs.sort((a, b) => Number(b.running) - Number(a.running) || a.project.localeCompare(b.project));
      return cs.map((c) => ({ kind: 'project', host: item.host, container: c }));
    }
    return [];
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === 'host') {
      const t = new vscode.TreeItem(item.host, vscode.TreeItemCollapsibleState.Expanded);
      t.contextValue = 'host';
      t.iconPath = new vscode.ThemeIcon(item.ssh ? 'server' : 'device-desktop');
      if (item.error) {
        const p = item.ssh ? { description: 'unreachable' } : localProblem(item.error);
        t.description = p.description;
        t.tooltip = `${item.error}${p.hint ? `\n\n${p.hint}` : ''}`;
        t.collapsibleState = vscode.TreeItemCollapsibleState.None;
      } else {
        t.description = item.ssh ?? 'this computer';
        if (!item.count) t.collapsibleState = vscode.TreeItemCollapsibleState.None;
      }
      return t;
    }
    const c = item.container;
    const t = new vscode.TreeItem(c.project, vscode.TreeItemCollapsibleState.None);
    t.contextValue = c.running ? 'project-running' : 'project-stopped';
    const pending = c.running && !!this.pending?.has(item.host, c.container);
    t.description = c.running
      ? `running${pending ? ' · update pending' : ''}${c.memory ? ` · ${shortMemory(c.memory)}` : ''}`
      : 'stopped';
    t.iconPath = new vscode.ThemeIcon(c.running ? 'vm-running' : 'vm-outline',
      c.running ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    t.tooltip = new vscode.MarkdownString(
      `**${c.project}** on ${item.host} — ${c.running ? 'running' : 'stopped (files are kept)'}` +
      `${c.memory ? `\n\nMemory: ${c.memory} (used / limit)` : ''}\n\n\`${c.image}\`` +
      (pending ? '\n\nAn update of its environment or setup waits. When your jobs have finished, stop the project ' +
        '(its files are kept) and open it again to apply it.' : ''));
    t.command = { command: 'fnkcProjects.openItem', title: 'Open', arguments: [item] };
    return t;
  }
}
