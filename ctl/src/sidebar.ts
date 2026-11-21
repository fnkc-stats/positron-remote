// The Projects panel: each host with its project containers. Listing never starts anything: a computer whose
// Docker is not running just says so. Buttons on the items run the same open / stop as the commands.
import * as vscode from 'vscode';
import type { ClientConfig } from './client/config.ts';
import { listProjects } from './client/open.ts';
import type { Logger } from './log.ts';
import { type ContainerInfo, shortMemory } from './protocol.ts';

export type Item =
  | { kind: 'host'; host: string; ssh?: string; error?: string; count: number }
  | { kind: 'project'; host: string; container: ContainerInfo };

export class ProjectsTree implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private listing?: Promise<Map<string, { error?: string; containers: ContainerInfo[] }>>;
  private readonly config: () => ClientConfig;
  private readonly log: Logger;

  constructor(config: () => ClientConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  refresh() {
    this.listing = undefined;
    this.changed.fire(undefined);
  }

  private load() {
    this.listing ??= (async () => {
      const result = new Map<string, { error?: string; containers: ContainerInfo[] }>();
      try {
        for (const l of await listProjects(this.config(), this.log)) result.set(l.host, l);
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
      // Not configured: the welcome view says so instead of showing this computer as a host nobody chose
      if (cfg.hostsDefault) return [];
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
        t.description = item.ssh ? 'unreachable' : 'Docker is not running';
        t.tooltip = `${item.error}${item.ssh ? '' : '\n\nIt starts by itself when you open a project here.'}`;
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
    t.description = c.running ? `running${c.memory ? ` · ${shortMemory(c.memory)}` : ''}` : 'stopped';
    t.iconPath = new vscode.ThemeIcon(c.running ? 'vm-running' : 'vm-outline',
      c.running ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    t.tooltip = new vscode.MarkdownString(
      `**${c.project}** on ${item.host} — ${c.running ? 'running' : 'stopped (files are kept)'}` +
      `${c.memory ? `\n\nMemory: ${c.memory} (used / limit)` : ''}\n\n\`${c.image}\``);
    t.command = { command: 'fnkcProjects.openItem', title: 'Open', arguments: [item] };
    return t;
  }
}
