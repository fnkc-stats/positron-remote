// The Environment Images panel: the images published in the registry by R series (with the image each Gitea
// template pins, and where each one is used), and the images each host has. It only reads; it is loaded when the
// panel is first shown and on Refresh, never on a timer, because it asks the registry, Gitea and every host.
import * as vscode from 'vscode';
import {
  buildLinks, contentsText, dayOf, type HostGroup, type HostImageRow, type ImageRow, type LayerRow, type Overview, type SeriesGroup,
  shortCommit, sizeText, TEMPLATE_STATE,
} from './client/images.ts';
import { localProblem } from './sidebar.ts';

export type ImageItem =
  | { kind: 'registry'; overview: Overview }
  | { kind: 'series'; group: SeriesGroup }
  | { kind: 'image'; row: ImageRow; group: SeriesGroup }
  | { kind: 'layer'; row: LayerRow; env?: ImageRow; group: SeriesGroup }
  | { kind: 'host'; group: HostGroup }
  | { kind: 'hostImage'; row: HostImageRow; group: HostGroup }
  | { kind: 'note'; text: string; tooltip?: string; icon?: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const grey = new vscode.ThemeColor('disabledForeground');
const warn = new vscode.ThemeColor('problemsWarningIcon.foreground');
const good = new vscode.ThemeColor('testing.iconPassed');

export class ImagesTree implements vscode.TreeDataProvider<ImageItem> {
  private readonly changed = new vscode.EventEmitter<ImageItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private loading?: Promise<Overview>;
  private readonly load: () => Promise<Overview>;
  private readonly context: () => { envRepository: string; positron?: string };
  /** Called with each finished overview (the panel's badge). */
  onLoaded?: (o: Overview) => void;

  constructor(load: () => Promise<Overview>, context: () => { envRepository: string; positron?: string }) {
    this.load = load;
    this.context = context;
  }

  refresh() {
    this.loading = undefined;
    this.changed.fire(undefined);
  }

  /** The overview shown now (loads it the first time). */
  current(): Promise<Overview> {
    this.loading ??= this.load().then((o) => { this.onLoaded?.(o); return o; });
    return this.loading;
  }

  async getChildren(item?: ImageItem): Promise<ImageItem[]> {
    if (!item) {
      let o: Overview;
      try {
        o = await this.current();
      } catch (e) { // loadOverview reports failures inside the overview; this is only a last resort
        return [{ kind: 'note', text: 'Could not read the images', tooltip: (e as Error).message, icon: 'error' }];
      }
      return [{ kind: 'registry', overview: o }, ...o.hosts.map((group): ImageItem => ({ kind: 'host', group }))];
    }
    if (item.kind === 'registry') {
      const o = item.overview;
      const notes: ImageItem[] = [];
      if (o.templatesError) notes.push({ kind: 'note', text: 'Templates could not be read', tooltip: o.templatesError, icon: 'warning' });
      if (o.registry.problems.length) {
        notes.push({ kind: 'note', text: `${plural(o.registry.problems.length, 'tag')} could not be read`, tooltip: o.registry.problems.join('\n'), icon: 'warning' });
      }
      return [...o.series.map((group): ImageItem => ({ kind: 'series', group })), ...notes];
    }
    if (item.kind === 'series') {
      const g = item.group;
      if (!g.rows.length && !g.orphans.length) return [{ kind: 'note', text: 'No published images of this series', icon: 'info' }];
      return [...g.rows.map((row): ImageItem => ({ kind: 'image', row, group: g })),
        ...g.orphans.map((row): ImageItem => ({ kind: 'layer', row, group: g }))];
    }
    if (item.kind === 'image') return item.row.layers.map((row): ImageItem => ({ kind: 'layer', row, env: item.row, group: item.group }));
    if (item.kind === 'host') return item.group.rows.map((row): ImageItem => ({ kind: 'hostImage', row, group: item.group }));
    return [];
  }

  getTreeItem(item: ImageItem): vscode.TreeItem {
    switch (item.kind) {
      case 'registry': return this.registryItem(item.overview);
      case 'series': return this.seriesItem(item.group);
      case 'image': return this.imageItem(item.row, item.group);
      case 'layer': return this.layerItem(item.row, item.env);
      case 'host': return this.hostItem(item.group);
      case 'hostImage': return this.hostImageItem(item.row, item.group);
      case 'note': {
        const t = new vscode.TreeItem(item.text, vscode.TreeItemCollapsibleState.None);
        t.iconPath = new vscode.ThemeIcon(item.icon ?? 'info', item.icon === 'warning' ? warn : undefined);
        t.tooltip = item.tooltip;
        return t;
      }
    }
  }

  private registryItem(o: Overview): vscode.TreeItem {
    const t = new vscode.TreeItem('Published', o.registry.error ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    t.iconPath = new vscode.ThemeIcon(o.registry.error ? 'cloud-offline' : 'cloud');
    t.contextValue = 'registry';
    if (o.registry.error) {
      t.description = 'registry unreachable';
      t.tooltip = `${o.registry.error}\n\nThe images on the hosts are still listed below. Refresh to try again.`;
    } else {
      t.description = o.registry.repository;
      t.tooltip = `${plural(o.registry.images.length, 'image')} in ${o.registry.repository}, by R series, newest first`;
    }
    return t;
  }

  private seriesItem(g: SeriesGroup): vscode.TreeItem {
    const t = new vscode.TreeItem(g.series === 'other' ? 'Other tags' : `R ${g.series}`, vscode.TreeItemCollapsibleState.Expanded);
    t.contextValue = g.rows.some((r) => r.newest && (r.kind === 'environment' || r.variant === g.series)) ? 'series-published' : 'series';
    const tpl = g.template;
    const lines = [`**${t.label as string}**: ${plural(g.rows.length, 'image')}`];
    if (!tpl) {
      t.iconPath = new vscode.ThemeIcon('versions');
    } else if (tpl.error) {
      t.iconPath = new vscode.ThemeIcon('versions');
      t.description = 'template unknown';
      lines.push(`Template \`${tpl.repository}\`: ${tpl.error}`);
    } else {
      const ok = g.templateState === 'newest';
      t.iconPath = new vscode.ThemeIcon(ok ? 'versions' : 'warning', ok ? undefined : warn);
      t.description = ok ? 'template is up to date' : g.templateState === 'older' ? 'template pins an older environment'
        : g.templateState === 'not-published' ? 'template pins an unpublished image' : 'template pin unknown';
      lines.push(`Template \`${tpl.repository}\` ${TEMPLATE_STATE[g.templateState]}:`, `\`${tpl.image}\``);
      if (tpl.stale) lines.push('_Gitea is unreachable: this is the pin read last time._');
      if (!ok && g.templateState !== 'unknown') {
        lines.push('New projects get the template\'s environment. To move it to the newest, copy the newest pin (the copy button on this line) into the template\'s `container.json`, together with `env/versions/' +
          `${g.series}/renv.lock\` of that build, in one commit (docs/admin-setup.md).`);
      }
    }
    t.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    return t;
  }

  private imageItem(r: ImageRow, g: SeriesGroup): vscode.TreeItem {
    const { envRepository, positron } = this.context();
    const t = new vscode.TreeItem(`${dayOf(r.created)} · ${r.commit ? shortCommit(r.commit) : r.tag}`,
      r.layers.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const otherPositron = r.kind === 'legacy' && r.variant !== g.series;
    const servers = r.layers.map((l) => l.positron).filter(Boolean);
    const inUse = r.hosts.reduce((n, h) => n + h.containers, 0);
    const badges = [
      otherPositron && r.labels['positron.version'] && `Positron ${r.labels['positron.version']}`,
      r.kind === 'legacy' && !otherPositron && 'server built in',
      r.newest && 'newest',
      r.kind === 'environment' && (servers.length ? `Positron ${servers.join(', ')}` : 'no Positron server yet'),
      r.templates.length && 'template',
      inUse && plural(inUse, 'container'),
      !inUse && r.projects.length && plural(r.projects.length, 'project'),
      r.hosts.length && `on ${r.hosts.map((h) => h.host).join(', ')}`,
      r.incomplete && `${r.architectures.join(', ')} only`,
      r.unused && 'unused',
    ].filter(Boolean);
    t.iconPath = r.templates.length ? new vscode.ThemeIcon('star-full', good)
      : r.incomplete ? new vscode.ThemeIcon('warning', warn)
        : new vscode.ThemeIcon(r.unused ? 'circle-outline' : 'package', r.unused ? grey : undefined);
    const newest = g.rows.find((x) => x.newest && x.variant === r.variant);
    if (r.kind === 'environment' && positron && !servers.includes(positron)) badges.push(`none for your ${positron}`);
    t.description = badges.join(' · ');
    t.contextValue = ['image', r.runId ? 'run' : '', r.commit ? 'commit' : '', newest && newest !== r && newest.commit && r.commit ? 'older' : ''].filter(Boolean).join('-');

    const links = buildLinks(envRepository, r);
    const l = r.labels;
    const lines = [
      `**${contentsText(l) || r.variant}**${r.newest ? ` — the newest ${r.kind === 'environment' ? 'environment' : 'build'} of R ${g.series}${otherPositron && l['positron.version'] ? ` for Positron ${l['positron.version']}` : ''}` : ''}`,
      [l['r-env.cran-snapshot'] && `CRAN snapshot ${l['r-env.cran-snapshot']}`, l['r-env.quarto-version'] && `Quarto ${l['r-env.quarto-version']}`,
        r.architectures.length && r.architectures.join(' + '), r.size && `${sizeText(r.size)} to download`].filter(Boolean).join(' · '),
      `Built ${r.created ? r.created.replace('T', ' ').slice(0, 16) + ' UTC' : '(date unknown)'}${r.commit ? ` from [${shortCommit(r.commit)}](${links.commit})` : ''}${links.run ? ` in [CI run ${r.runId}](${links.run})` : ''}`,
      `Pin: \`${r.reference}\``,
    ];
    if (r.alsoTags?.length) lines.push(`Also published as ${r.alsoTags.map((x) => `\`${x}\``).join(', ')} (a rebuild that gave the same image)`);
    if (r.incomplete) lines.push(`⚠ Only ${r.architectures.join(', ')}: this build did not publish a joined image for all architectures. Pin it only for hosts of that architecture.`);
    const used: string[] = [];
    for (const x of r.templates) used.push(`pinned by the template \`${x}\``);
    for (const h of r.hosts) used.push(`on **${h.host}**: ${h.containers ? `${plural(h.containers, 'project container')} (${h.running} running)` : 'stored, no containers'}`);
    if (r.projects.length) used.push(`your projects: ${r.projects.map((p) => `${p.project} (${p.host})`).join(', ')}`);
    lines.push(used.length ? `Used: ${used.join('; ')}` : 'Not used by a template or by containers on the reachable hosts.');
    if (r.kind === 'legacy' && positron && l['positron.version'] && l['positron.version'] !== positron) lines.push(`Projects on this image open only from Positron ${l['positron.version']} (this Positron is ${positron}).`);
    if (r.kind === 'environment') {
      lines.push(servers.length ? `Positron servers on it (expand the line): ${servers.join(', ')}.` : 'No Positron server on it yet.');
      if (positron && !servers.includes(positron)) lines.push(`Projects on it open from your Positron ${positron} after **Build Environment** adds its server (a few minutes).`);
    }
    t.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    return t;
  }

  private layerItem(r: LayerRow, env?: ImageRow): vscode.TreeItem {
    const t = new vscode.TreeItem(`Positron ${r.positron ?? '?'}`, vscode.TreeItemCollapsibleState.None);
    const inUse = r.hosts.reduce((n, h) => n + h.containers, 0);
    t.description = [dayOf(r.created), !env && 'environment not in the registry', inUse && plural(inUse, 'container'),
      !inUse && r.projects.length && plural(r.projects.length, 'project'), r.hosts.length && `on ${r.hosts.map((h) => h.host).join(', ')}`,
      r.incomplete && `${r.architectures.join(', ')} only`, r.unused && 'unused'].filter(Boolean).join(' · ');
    t.iconPath = new vscode.ThemeIcon(r.unused ? 'circle-outline' : 'server-process', r.unused ? grey : undefined);
    t.contextValue = 'layer';
    const lines = [
      `**Positron ${r.positron}** server${env ? ` on the R ${env.labels['r-env.r-version'] ?? env.series} environment of ${dayOf(env.created)}` : ''}: what project containers run`,
      `Published ${r.created ? r.created.replace('T', ' ').slice(0, 16) + ' UTC' : '(date unknown)'} as \`${r.tag}\` · ${r.size ? `${sizeText(r.size)} to download` : ''}`,
      `Image: \`${r.reference}\``,
    ];
    const used: string[] = r.hosts.map((h) => `on **${h.host}**: ${h.containers ? `${plural(h.containers, 'project container')} (${h.running} running)` : 'stored, no containers'}`);
    if (r.projects.length) used.push(`your projects: ${r.projects.map((p) => `${p.project} (${p.host})`).join(', ')}`);
    lines.push(used.length ? `Used: ${used.join('; ')}` : 'No container on the reachable hosts runs it.');
    if (r.unused) lines.push('Unused: fnkc-ctl images --cleanup lists it for removal; Build Environment makes it again if needed.');
    t.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    return t;
  }

  private hostItem(h: HostGroup): vscode.TreeItem {
    const t = new vscode.TreeItem(h.host, h.rows.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    t.iconPath = new vscode.ThemeIcon(h.ssh ? 'server' : 'device-desktop');
    t.contextValue = 'host-images';
    if (h.older) {
      t.description = 'update fnkc-ctl on the server to list its images';
      t.tooltip = h.error;
    } else if (h.error) {
      const p = h.ssh ? { description: 'unreachable' } : localProblem(h.error, 'images');
      t.description = p.description;
      t.tooltip = `${h.error}${p.hint ? `\n\n${p.hint}` : ''}`;
    } else {
      const unused = h.rows.filter((r) => !r.containers);
      t.description = h.rows.length ? `${plural(h.rows.length, 'image')} · ${sizeText(h.size)}${unused.length ? ` · ${unused.length} unused` : ''}` : 'no environment images yet';
      t.tooltip = `${h.ssh ?? 'this computer'}: environment images Docker keeps there, and the project containers made from them (of all users).` +
        (unused.length ? `\n\n${plural(unused.length, 'image')} (${sizeText(unused.reduce((n, r) => n + r.size, 0))}) no container uses: they can be removed; a project that needs one again gets it on its next Open.` : '');
    }
    return t;
  }

  private hostImageItem(r: HostImageRow, h: HostGroup): vscode.TreeItem {
    const p = r.published;
    const what = p?.kind === 'positron' ? `Positron ${p.positron} server` : p?.commit ? shortCommit(p.commit) : p ? p.tag : 'not in the registry';
    const t = new vscode.TreeItem(`${dayOf(r.created)} · ${what}`, vscode.TreeItemCollapsibleState.None);
    const use = r.containers ? `${plural(r.containers, 'container')}${r.running ? ` (${r.running} running)` : ''}` : 'unused';
    t.description = [contentsText(r.labels), sizeText(r.size), r.templates.length && 'template', use].filter(Boolean).join(' · ');
    t.iconPath = new vscode.ThemeIcon(r.containers ? 'vm' : 'circle-outline', r.containers ? undefined : grey);
    t.contextValue = ['hostImage', r.containers ? '' : h.ssh ? 'unused-server' : 'unused-local', p?.runId ? 'run' : '', p?.commit ? 'commit' : ''].filter(Boolean).join('-');
    const lines = [
      `**${contentsText(r.labels) || 'Environment image'}** on ${h.host}, ${sizeText(r.size)} on disk`,
      `Pin${r.references.length > 1 ? 's' : ''}: ${r.references.map((x) => `\`${x}\``).join(', ')}`,
      p ? `Published as \`${p.tag}\`` : 'Not (or no longer) in the registry: built locally, or its tag was deleted.',
      r.containers ? `${plural(r.containers, 'project container')} of all users made from it, ${r.running} running${r.projects.length ? `; yours: ${r.projects.join(', ')}` : ''}.`
        : h.ssh ? 'No container uses it. To free the space, an administrator removes it on the server: the terminal button on this line copies the command.'
          : 'No container uses it: remove it with the trash button on this line.',
    ];
    t.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
    return t;
  }
}
