// Positron extension: the same open / stop as fnkc-ctl, with a progress notification and the project
// window opened at the end. Runs on the user's computer (extensionKind "ui"), never inside a container.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { type ClientConfig, clientConfig, clientConfigPath, readClientConfigFile } from './client/config.ts';
import { type BuildRun, buildOptions, buildRequest, CannotBuild, checkBuildRights, finishBuild, positronReleases, startBuild, WatchStopped } from './client/build.ts';
import { busyProcesses, type HostListing, type HostStop, keepProject, listProjects, openProject, SshIncludeDeclined, stopProject } from './client/open.ts';
import { checkRemoval, deletedObjects, deleteProject, lostWork, nothingLost, removalReport, tagNote } from './client/remove.ts';
import { NoPositronImage, teamPositron, teamPositronNote } from './client/variant.ts';
import { pinImage, ProjectUnreachable } from './client/project.ts';
import { downloadRelease, latestRelease, newer, serverReadiness, type ServerState } from './client/update.ts';
import { localPositron } from './client/positron.ts';
import { TransferCancelled } from './client/start.ts';
import { type Check, CONFIGURATION_CHECK, GET_CONFIG, runChecks } from './client/doctor.ts';
import { adminReport, COPY, COPY_ADMIN, elevatedPowerShell, explainFailure, fixSteps, pasteHelp, RUN, RUN_ADMIN } from './client/fix.ts';
import { connectionOfAlias, INCLUDE_MARKER, removeSshSetup } from './client/ssh.ts';
import { PendingUpdates } from './pending-updates.ts';
import { type Item, ProjectsTree } from './sidebar.ts';
import { buildLinks, compareLink, loadOverview, type PublishedImage, removalCommand } from './client/images.ts';
import { type ImageItem, ImagesTree } from './images-view.ts';
import { LocalTransport, SshTransport } from './client/transport.ts';
import { Cancelled, extendPath, run } from './exec.ts';
import { HostCapacity, Incompatible, LockBusy, QuotaExceeded } from './errors.ts';
import { setLockLossHandler } from './lock.ts';
import { clearImageCache, imageCacheSize } from './client/image-download.ts';
import type { Logger } from './log.ts';

let output: vscode.LogOutputChannel;
let tree: ProjectsTree;
let images: ImagesTree;
let state: vscode.Memento;
let pendingUpdates: PendingUpdates;

export function activate(ctx: vscode.ExtensionContext) {
  extendPath();
  output = vscode.window.createOutputChannel('FNKC Projects', { log: true });
  state = ctx.globalState;
  pendingUpdates = new PendingUpdates(ctx.globalState);
  // A lost lock must not end the extension host (and every other extension with it): say so instead
  setLockLossHandler((path) => {
    output.error(`lost the lock ${path} while an operation held it`);
    void vscode.window.showErrorMessage('FNKC Projects lost a lock while it was working. Let the operation finish, then reload the window before the next one.', 'Reload Window')
      .then((c) => { if (c) void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
  });
  void reportBackgroundStops(ctx);
  ctx.subscriptions.push(
    output,
    command('fnkcProjects.open', () => open()),
    command('fnkcProjects.stop', stop),
    // Not passed directly: a view's title button hands the command its own argument, which is no preset
    command('fnkcProjects.buildEnvironment', () => buildEnvironment()),
    vscode.commands.registerCommand('fnkcProjects.showLog', () => output.show()),
    vscode.commands.registerCommand('fnkcProjects.setupWindows', () => setupWindows(ctx)),
    command('fnkcProjects.stopCurrent', () => stopCurrent(ctx)),
  );
  showStopButton(ctx);
  showProjectsPanel(ctx);
  showImagesPanel(ctx);
  ctx.subscriptions.push(command('fnkcProjects.checkSetup', checkSetup));
  ctx.subscriptions.push(command('fnkcProjects.removeSshConfig', removeSshConfiguration));
  ctx.subscriptions.push(reportChanged, vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME,
    { onDidChange: reportChanged.event, provideTextDocumentContent: (u) => reports.get(u.path) ?? '' }));
  ctx.subscriptions.push(command('fnkcProjects.checkForUpdates', () => checkForUpdates(ctx, true)));
  ctx.subscriptions.push(command('fnkcProjects.clearImageCache', clearDownloadCache));
  ctx.subscriptions.push(command('fnkcProjects.importConfig', importConfiguration));
  watchConfiguration(ctx);
  void firstRunCheck(ctx);
  watchLongRunning(ctx);
  if (vscode.workspace.getConfiguration('fnkcProjects').get<boolean>('checkForUpdates', true)) void checkForUpdates(ctx, false);
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A newer release of the extension (client/update.ts): asked once a day on start, or now on request. Offers to
 * install it; "Skip This Version" keeps it quiet until the next one. The vsix is checked against its checksum.
 */
async function checkForUpdates(ctx: vscode.ExtensionContext, manual: boolean) {
  const mine = String((ctx.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0');
  if (!manual) {
    const last = ctx.globalState.get<number>('updateCheckedAt') ?? 0;
    if (Date.now() - last < DAY) return;
    await ctx.globalState.update('updateCheckedAt', Date.now());
  }
  let release;
  try {
    release = await latestRelease(config().envRepository);
  } catch (e) {
    output.warn(`update check: ${(e as Error).message}`);
    if (manual) throw e;
    return;
  }
  if (!release || !newer(release.version, mine)) {
    if (manual) vscode.window.showInformationMessage(`FNKC Projects ${mine} is the newest version.`);
    return;
  }
  if (!manual && ctx.globalState.get<string>('updateSkipped') === release.version) return;
  // Server first: a client the servers cannot serve yet is not offered (client/update.ts, serverReadiness)
  const { behind, unknown } = serverReadiness(release.requires, await serverStates(config()));
  if (behind.length) {
    output.info(`update ${release.version} waits for the server update of ${behind.join(', ')}`);
    if (manual) {
      const notes = await vscode.window.showWarningMessage(`FNKC Projects ${release.version} needs a newer fnkc-ctl on ${behind.join(', ')}. ` +
        'Ask your administrator to install the server bundle of the same release; the update is offered after that.', 'Release Notes');
      if (notes) void vscode.env.openExternal(vscode.Uri.parse(release.url));
    }
    return;
  }
  if (unknown.length && !manual) {
    // Asked again at the next start rather than offered without knowing
    output.info(`update ${release.version}: could not ask ${unknown.join(', ')} whether it is ready; asking again later`);
    await ctx.globalState.update('updateCheckedAt', 0);
    return;
  }
  const caution = unknown.length ? ` Could not check whether ${unknown.join(', ')} is ready for it.` : '';
  const choice = await vscode.window.showInformationMessage(
    `FNKC Projects ${release.version} is available (you have ${mine}).${caution}`, 'Update', 'Release Notes', 'Skip This Version');
  if (choice === 'Release Notes') return void vscode.env.openExternal(vscode.Uri.parse(release.url));
  if (choice === 'Skip This Version') return void ctx.globalState.update('updateSkipped', release.version);
  if (choice !== 'Update') return;
  const file = join(ctx.globalStorageUri.fsPath, `fnkc-projects-${release.version}.vsix`);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating FNKC Projects to ${release.version}` }, async () => {
    await downloadRelease(release, file);
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
  });
  output.info(`Installed FNKC Projects ${release.version} from ${release.vsix}`);
  const reload = await vscode.window.showInformationMessage(`FNKC Projects ${release.version} is installed. Reload the window to use it.`, 'Reload Window');
  if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/** What every configured server runs (ping), for the update check; a server that cannot be asked says why. */
async function serverStates(cfg: ClientConfig): Promise<ServerState[]> {
  const quiet: Logger = { info() {}, warn() {} };
  return Promise.all(cfg.hosts.filter((h) => h.ssh).map(async (h) => {
    try {
      const p = await new SshTransport(h, cfg, quiet).info();
      return { host: h.name, version: p.version, protocol: p.protocol, minProtocol: p.minProtocol, capabilities: p.capabilities };
    } catch (e) {
      return { host: h.name, error: (e as Error).message };
    }
  }));
}

/** The Projects panel in the activity bar, with Open / Stop buttons on its items. */
function showProjectsPanel(ctx: vscode.ExtensionContext) {
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  tree = new ProjectsTree(config, log, pendingUpdates);
  const view = vscode.window.createTreeView('fnkcProjects.list', { treeDataProvider: tree });
  projectsView = view;
  showConfigState();
  // Containers stop themselves when idle, so the panel refreshes while it is visible. This computer's Docker reports
  // its containers' starts and stops at once; a server's are seen at the next refresh, or when the user comes back
  const timer = setInterval(() => { if (view.visible) tree.refresh(); }, 60_000);
  let soon: NodeJS.Timeout | undefined;
  const changed = () => { clearTimeout(soon); soon = setTimeout(() => tree.refresh(), 1_000); };
  let local: { dispose(): void } | undefined;
  const follow = () => {
    local?.dispose();
    local = undefined;
    try {
      const cfg = config();
      const here = cfg.hosts.find((h) => !h.ssh);
      if (here) local = new LocalTransport(here, cfg, log).watch(changed);
    } catch { /* no usable configuration yet: followed once there is one */ }
  };
  follow();
  ctx.subscriptions.push(
    view,
    { dispose: () => { clearInterval(timer); clearTimeout(soon); local?.dispose(); } },
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('fnkcProjects')) follow(); }),
    // Coming back to the panel or the window shows the servers' containers as they are now, not up to a minute ago
    view.onDidChangeVisibility((e) => { if (e.visible) tree.refreshIfOlder(10_000); }),
    vscode.window.onDidChangeWindowState((w) => { if (w.focused && view.visible) tree.refreshIfOlder(10_000); }),
    vscode.commands.registerCommand('fnkcProjects.refresh', () => tree.refresh()),
    command('fnkcProjects.openItem', async (item?: Item) => {
      if (item?.kind === 'project') await open({ project: item.container.repository ?? item.container.project, host: item.host });
    }),
    command('fnkcProjects.openHere', async (item?: Item) => {
      if (item?.kind === 'host') await open({ host: item.host });
    }),
    command('fnkcProjects.deleteItem', async (item?: Item) => {
      if (item?.kind !== 'project') return;
      if (item.container.running) {
        vscode.window.showWarningMessage(`${item.container.project} is running: stop it first, then delete it.`);
        return;
      }
      await deleteFlow(item.container.project, item.host, item.container.repository ?? item.container.project);
    }),
    command('fnkcProjects.stopItem', async (item?: Item) => {
      if (item?.kind !== 'project') return;
      const p = item.container.project;
      if (currentProject() === p && currentConnection()?.host === item.host) return vscode.commands.executeCommand('fnkcProjects.stopCurrent');
      if (!(await confirmStop(p, item.host))) return;
      const results = await Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Stopping ${p}` },
        () => stopProject(config(), p, item.host, log))).finally(() => tree.refresh());
      // The list shows it stopped; said only when there was nothing to stop
      if (results[0]?.outcome !== 'stopped') vscode.window.showInformationMessage(stoppedMessage(p, item.host, results));
    }),
  );
}

/** Read-only documents the extension shows (the Delete Project report), by path. */
const REPORT_SCHEME = 'fnkc-report';
const reports = new Map<string, string>();
/** Tells VS Code a report changed: a report of the same name that is still open shows the new text, not the old one. */
const reportChanged = new vscode.EventEmitter<vscode.Uri>();

/** Shows Markdown as a rendered preview beside the current editor (as plain text if there is no preview). */
async function showReport(name: string, text: string) {
  const uri = vscode.Uri.from({ scheme: REPORT_SCHEME, path: `/${name}.md` });
  const changed = reports.has(uri.path) && reports.get(uri.path) !== text;
  reports.set(uri.path, text);
  if (changed) reportChanged.fire(uri);
  try {
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
  } catch {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
}

export const showReportForTests = showReport;

/**
 * Delete Project: first what it would lose. All work on Gitea: one confirmation that says so and names what is
 * deleted. Otherwise the report lists every file and folder that is lost; the user can open the project to commit
 * and push, or delete anyway after a confirmation that names the lost work and what is deleted again.
 */
async function deleteFlow(project: string, host: string, repository: string) {
  const cfg = config();
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  const check = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking what deleting ${project} would lose` },
    () => checkRemoval(cfg, project, host, log));
  const report = removalReport(check, host);
  output.info(`--- delete ${project} on ${host}: check\n${report}`);
  const lost = lostWork(check);
  const deleted = deletedObjects(check).map((o) => `• ${o}`).join('\n');
  const kept = 'The repository on Gitea is not touched: Open clones the project again.';
  if (!lost.length) {
    const del = 'Delete Project';
    const tags = tagNote(check);
    const answer = await vscode.window.showWarningMessage(`Delete ${project} on '${host}'?`,
      { modal: true, detail: `${nothingLost(check, host)}${tags ? `\n\n${tags}` : ''}\n\nDeleted:\n${deleted}\n\n${kept}` }, del);
    if (answer !== del) return;
  } else {
    await showReport(`Delete ${project} on ${host}`, report);
    const push = 'Open to Commit & Push';
    const anyway = 'Delete Anyway…';
    const answer = await vscode.window.showWarningMessage(
      `${project} has work that is not on Gitea: ${lost.join('; ')}. The report lists every file and folder, and the volumes that are deleted.`,
      push, anyway);
    if (answer === push) return open({ project: repository, host });
    if (answer !== anyway) return;
    const del = 'Delete and Lose This Work';
    const sure = await vscode.window.showWarningMessage(`Delete ${project} on '${host}' and lose the work that is not on Gitea?`, {
      modal: true,
      detail: `Lost (listed file by file in the report):\n${lost.map((l) => `• ${l}`).join('\n')}\n\nDeleted:\n${deleted}\n\n${kept}`,
    }, del);
    if (sure !== del) return;
  }
  const removed = await Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deleting ${project}` },
    () => deleteProject(cfg, check, host, log))).finally(() => tree.refresh());
  output.info(`Deleted ${project} on ${host}: ${removed.join(', ')}`);
  vscode.window.showInformationMessage(`${project} is deleted on '${host}' (${removed.length} Docker objects: container, volumes, network). ${kept}`);
}

/** Asked before the first Open adds its line to ~/.ssh/config. */
async function confirmSshInclude(): Promise<boolean> {
  const add = 'Add the Line';
  const answer = await vscode.window.showInformationMessage('Add one line to your ~/.ssh/config?', {
    modal: true,
    detail: 'Positron connects to project containers through SSH entries that FNKC Projects keeps apart from yours, in ' +
      `~/.ssh/fnkc. One line at the top of ~/.ssh/config includes them:\n\n${INCLUDE_MARKER}\nInclude fnkc/*.conf\n\n` +
      'Your own entries are not changed. To take it out again: FNKC: Remove SSH Configuration.',
  }, add);
  return answer === add;
}

async function removeSshConfiguration() {
  const remove = 'Remove';
  const answer = await vscode.window.showWarningMessage('Remove the SSH configuration of FNKC Projects?', {
    modal: true,
    detail: 'Removes the Include line from ~/.ssh/config and the project connections in ~/.ssh/fnkc. Your own SSH entries, ' +
      'the containers and their files are not touched. Open project windows lose their connection; the next Open sets it up again (and asks first).',
  }, remove);
  if (answer !== remove) return;
  const cfg = config();
  const done = await removeSshSetup(cfg.sshDir, cfg.cacheDir);
  output.info(`Removed: ${done.join('; ') || 'nothing (there was no FNKC Projects SSH configuration)'}`);
  vscode.window.showInformationMessage(done.length ? `Removed ${done.join(' and ')}.` : 'There was no FNKC Projects SSH configuration to remove.');
}

/**
 * The Environment Images panel: published images by R series, the templates' pins, the images on each host.
 * It asks the registry, Gitea and every host, so it starts collapsed and loads only once opened (VS Code asks a
 * collapsed view for nothing) and on Refresh.
 */
function showImagesPanel(ctx: vscode.ExtensionContext) {
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  const quiet: Logger = { info: () => {}, warn: () => {} };
  images = new ImagesTree(async () => {
    const cfg = config();
    return loadOverview(cfg, cfg.templateRepository, log, listProjects(cfg, quiet));
  }, () => {
    let positron: string | undefined;
    try { positron = localPositron(vscode.env.appRoot).version; } catch { /* not Positron */ }
    let envRepository = 'fnkc-stats/positron-remote';
    try { envRepository = config().envRepository; } catch { /* the default */ }
    return { envRepository, positron };
  });
  const view = vscode.window.createTreeView('fnkcProjects.images', { treeDataProvider: images });
  // The badge counts templates that do not pin the newest image of their series
  images.onLoaded = (o) => {
    const behind = o.series.filter((g) => g.templateState === 'older' || g.templateState === 'not-published');
    view.badge = behind.length
      ? { value: behind.length, tooltip: `${behind.map((g) => g.template!.repository).join(', ')}: not on the newest image` }
      : undefined;
  };
  const open = (url?: string) => { if (url) void vscode.env.openExternal(vscode.Uri.parse(url)); };
  const links = (item?: ImageItem) => {
    const p = publishedOf(item);
    return p ? buildLinks(config().envRepository, p) : {};
  };
  ctx.subscriptions.push(
    view,
    vscode.commands.registerCommand('fnkcProjects.images.refresh', () => images.refresh()),
    command('fnkcProjects.images.copyPin', async (item?: ImageItem) => {
      const pin = pinOf(item);
      if (!pin) return;
      await vscode.env.clipboard.writeText(pin);
      vscode.window.showInformationMessage(`Copied: ${pin}`);
    }),
    command('fnkcProjects.images.pinHere', async (item?: ImageItem) => {
      const pin = pinOf(item);
      if (pin) await pinInWorkspace(pin);
    }),
    command('fnkcProjects.images.openRun', async (item?: ImageItem) => open(links(item).run)),
    command('fnkcProjects.images.openCommit', async (item?: ImageItem) => open(links(item).commit)),
    command('fnkcProjects.images.openPackages', async (item?: ImageItem) => open(links(item).packages)),
    command('fnkcProjects.images.compare', async (item?: ImageItem) => {
      if (item?.kind !== 'image') return;
      const newest = item.group.rows.find((r) => r.newest && r.variant === item.row.variant);
      if (newest?.commit && item.row.commit) open(compareLink(config().envRepository, item.row.commit, newest.commit));
    }),
    command('fnkcProjects.images.openRegistry', async () => {
      const [owner] = config().envRepository.split('/');
      open(`https://github.com/orgs/${owner}/packages/container/package/r-env`);
    }),
    command('fnkcProjects.images.copyRemoval', async (item?: ImageItem) => {
      if (item?.kind !== 'hostImage') return;
      const cmd = removalCommand(item.group, item.row);
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage(`Copied. Run it on ${item.group.ssh ?? item.group.host} as an administrator: ${cmd}`);
    }),
    command('fnkcProjects.images.remove', async (item?: ImageItem) => {
      if (item?.kind !== 'hostImage' || item.group.ssh) return;
      const r = item.row;
      const choice = await vscode.window.showWarningMessage(`Remove this environment image from this computer?`, {
        modal: true,
        detail: `${r.published ? `${r.published.tag}\n` : ''}${r.size ? `Frees about ${(r.size / 1e9).toFixed(1)} GB. ` : ''}No container uses it; a project that pins it downloads it again on its next Open.`,
      }, 'Remove');
      if (choice !== 'Remove') return;
      const host = config().hosts.find((h) => h.name === item.group.host && !h.ssh);
      if (!host) throw new Error(`'${item.group.host}' is not Docker on this computer`);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Removing the image' },
        () => new LocalTransport(host, config(), log).removeImage(r.id));
      images.refresh();
    }),
  );
}

/** The published image an item stands for: an image, the newest of a series, a host's image if it is published. */
function publishedOf(item?: ImageItem): PublishedImage | undefined {
  if (item?.kind === 'image') return item.row;
  if (item?.kind === 'hostImage') return item.row.published;
  if (item?.kind === 'series') return item.group.rows.find((r) => r.newest && r.variant === item.group.series);
  return undefined;
}

function pinOf(item?: ImageItem): string | undefined {
  if (item?.kind === 'hostImage') return item.row.published?.reference ?? item.row.references[0];
  return publishedOf(item)?.reference;
}

/** The workspace folders that have container.json (several in a multi-root window), in the window's order. */
async function containerJsonFolders(): Promise<{ folder: vscode.WorkspaceFolder; file: vscode.Uri }[]> {
  const exists = (u: vscode.Uri) => Promise.resolve(vscode.workspace.fs.stat(u)).then(() => true, () => false);
  const eligible: { folder: vscode.WorkspaceFolder; file: vscode.Uri }[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const file = vscode.Uri.joinPath(folder.uri, 'container.json');
    if (await exists(file)) eligible.push({ folder, file });
  }
  return eligible;
}

/**
 * Writes the image into container.json of a workspace folder that has one: the only such folder, or the one the user
 * picks when several have it (a multi-root window). With none, the pin is copied instead.
 */
async function pinInWorkspace(image: string): Promise<boolean> {
  const eligible = await containerJsonFolders();
  if (!eligible.length) {
    await vscode.env.clipboard.writeText(image);
    vscode.window.showInformationMessage(`No open folder has container.json; the pin is copied instead: ${image}`);
    return false;
  }
  const target = eligible.length === 1 ? eligible[0] : (await vscode.window.showQuickPick(
    eligible.map((e) => ({ label: e.folder.name, description: e.file.fsPath, e })),
    { title: 'Pin the environment in which folder\'s container.json?' }))?.e;
  if (!target) return false;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(target.file));
  await vscode.workspace.fs.writeFile(target.file, new TextEncoder().encode(pinImage(text, image)));
  vscode.window.showInformationMessage(`Pinned in ${target.file.fsPath}. Commit container.json, then stop the project and open it again: it then runs in the new environment.`);
  return true;
}

export function deactivate() {}

/**
 * A command whose errors end up in the log and in a message with buttons that help with that error (errorActions),
 * and always "Show Log". A cancelled operation is no error.
 */
function command<A extends unknown[]>(id: string, fn: (...args: A) => Promise<unknown>): vscode.Disposable {
  const runIt = async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof Cancelled) { output.info(`${id}: cancelled`); return; }
      const msg = (e as Error).message;
      output.error(msg);
      const actions = errorActions(e, () => runIt(...args));
      const choice = await vscode.window.showErrorMessage(msg, ...actions.map((a) => a.label), 'Show Log');
      if (choice === 'Show Log') output.show();
      await actions.find((a) => a.label === choice)?.run();
    }
  };
  return vscode.commands.registerCommand(id, runIt);
}

/** Buttons for an error message, by the kind of error (errors.ts); Check Setup when nothing more specific fits. */
export function errorActions(e: unknown, retry: () => Promise<void>): { label: string; run: () => Promise<unknown> }[] {
  const message = (e as Error).message;
  if (e instanceof QuotaExceeded) {
    return [{ label: 'Stop a Project', run: () => Promise.resolve(vscode.commands.executeCommand('fnkcProjects.stop')) }];
  }
  if (e instanceof LockBusy) return [{ label: 'Retry', run: retry }];
  if (e instanceof ProjectUnreachable && /^Gitea has no repository/.test(message)) {
    return [{ label: 'Open Project…', run: () => Promise.resolve(vscode.commands.executeCommand('fnkcProjects.open')) }, checkSetupAction];
  }
  // Failures on the server, which Check Setup on this computer cannot find: by their code, or by their wording for those
  // that have no code yet
  if (e instanceof Incompatible || e instanceof HostCapacity ||
    /admits no project starts|container failed to start|host key was not initialized|log in to the (project )?container|operator inspection|previous recovery container/.test(message)) {
    return [{ label: 'Copy for the Administrator', run: async () => {
      await vscode.env.clipboard.writeText(message);
      vscode.window.showInformationMessage('Copied: send it to your administrator.');
    } }];
  }
  return [checkSetupAction];
}
const checkSetupAction = { label: 'Check Setup', run: () => Promise.resolve(vscode.commands.executeCommand('fnkcProjects.checkSetup')) };

function config(): ClientConfig {
  return clientConfig(rawConfig());
}

let projectsView: vscode.TreeView<Item> | undefined;

/**
 * The Projects panel's welcome when it has nothing to list (package.json, viewsWelcome): no configuration yet, or
 * one with an error (said above the welcome text, which cannot hold it).
 */
function showConfigState() {
  let setup: 'none' | 'error' | 'ok';
  let error: string | undefined;
  try {
    setup = config().hosts.length ? 'ok' : 'none';
  } catch (e) {
    setup = 'error';
    error = (e as Error).message.replace(/^config: /, '');
  }
  void vscode.commands.executeCommand('setContext', 'fnkcProjects.setup', setup);
  if (projectsView) projectsView.message = error && `The configuration has an error: ${error}`;
}

/** Settings or the config file changed: the panels and the first-run check follow (several saves count as one). */
function watchConfiguration(ctx: vscode.ExtensionContext) {
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      showConfigState();
      tree?.refresh();
      images?.refresh();
      void firstRunCheck(ctx);
    }, 1000);
  };
  const file = clientConfigPath();
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(file)), basename(file)));
  ctx.subscriptions.push(
    watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('fnkcProjects')) changed(); }),
    { dispose: () => clearTimeout(timer) },
  );
}

/**
 * Puts the config.json from the administrator where the command line and the extension read it, after checking that
 * it is one. A file already there is kept next to it as config.json.bak.
 */
async function importConfiguration() {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import Configuration: the config.json from your administrator', openLabel: 'Import',
    canSelectMany: false, filters: { 'Configuration': ['json'] },
  });
  const from = picked?.[0]?.fsPath;
  if (!from) return;
  let text: string;
  let parsed: ClientConfig;
  try {
    text = readFileSync(from, 'utf8');
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: the file is not a JSON object');
    parsed = clientConfig(raw as Record<string, unknown>);
  } catch (e) {
    const why = e instanceof SyntaxError ? `it is not valid JSON (${e.message})` : (e as Error).message.replace(/^config: /, '');
    vscode.window.showErrorMessage(`${basename(from)} was not imported: ${why}. Ask your administrator for a corrected file.`);
    return;
  }
  if (!parsed.hosts.some((h) => h.ssh)) {
    const go = await vscode.window.showWarningMessage(`${basename(from)} names no server: projects could run only on this computer.`,
      { modal: true, detail: 'The config.json from your administrator names the team\'s servers. Import this file anyway?' }, 'Import Anyway');
    if (go !== 'Import Anyway') return;
  }
  const to = clientConfigPath();
  let kept = '';
  if (existsSync(to)) {
    if (readFileSync(to, 'utf8') === text) {
      vscode.window.showInformationMessage(`${to} already has this configuration.`, 'Check Setup')
        .then((b) => { if (b) void vscode.commands.executeCommand('fnkcProjects.checkSetup'); });
      return;
    }
    const replace = await vscode.window.showWarningMessage(`Replace the configuration in ${to}?`,
      { modal: true, detail: 'The current file is kept as config.json.bak next to it.' }, 'Replace');
    if (replace !== 'Replace') return;
    copyFileSync(to, `${to}.bak`);
    kept = ` The previous one is in ${basename(to)}.bak.`;
  }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text);
  output.info(`Import Configuration: ${from} -> ${to}`);
  // Settings win over the file (rawConfig): say so when they would hide what was just imported
  const s = vscode.workspace.getConfiguration('fnkcProjects');
  const overridden = ['hosts', 'gitRemotes'].filter((k) => {
    const v = s.inspect<unknown>(k)?.globalValue;
    return v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  });
  const note = overridden.length ? ` Your Settings still set ${overridden.map((k) => `FNKC Projects → ${k}`).join(' and ')}, which win over the file.` : '';
  showConfigState();
  tree?.refresh();
  images?.refresh();
  const b = await vscode.window.showInformationMessage(`The configuration is in ${to}.${kept}${note} Check the setup now?`, 'Check Setup');
  if (b) await vscode.commands.executeCommand('fnkcProjects.checkSetup');
}

/** The config file shared with the command line, overridden by whatever is set in Positron's settings. */
function rawConfig(): Record<string, unknown> {
  const s = vscode.workspace.getConfiguration('fnkcProjects');
  const raw: Record<string, unknown> = { ...readClientConfigFile() };
  // Connection and secret policy is personal machine configuration, never repository settings.
  for (const k of ['hosts', 'gitRemotes', 'decryptionHosts', 'sshKey', 'gitCryptKey', 'localEngine', 'wslDistro', 'envRepository', 'templateRepository']) {
    const v = s.inspect<unknown>(k)?.globalValue;
    if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) raw[k] = v;
  }
  const idle = s.inspect<number>('idleMinutes')?.globalValue;
  if (idle !== undefined) raw.local = { ...(raw.local as object | undefined), idleMinutes: idle };
  return raw;
}

/** Logs and shows each step in the notification; warnings also go into `warnings`, for a summary at the end. */
function progressLogger(progress: vscode.Progress<{ message?: string }>, warnings: string[] = []): Logger {
  return {
    info: (m) => { output.info(m); progress.report({ message: m }); },
    warn: (m) => { output.warn(m); progress.report({ message: `⚠ ${m}` }); warnings.push(m); },
  };
}

/** The warnings of an Open that succeeded, in one line: the first in full, the rest counted. */
export function warningSummary(project: string, warnings: string[]): string | undefined {
  const unique = [...new Set(warnings)];
  if (!unique.length) return undefined;
  return `${project} opened with ${unique.length === 1 ? 'a warning' : 'warnings'}: ${unique[0]}` +
    (unique.length > 1 ? ` (+${unique.length - 1} more in the log)` : '');
}

/** Asked before the container starts: with an empty ssh-agent the clone from Gitea would fail minutes later. */
async function confirmEmptyAgent(): Promise<boolean> {
  const check = 'Check Setup', anyway = 'Open Anyway';
  const choice = await vscode.window.showWarningMessage(
    'Your SSH key is not loaded (ssh-agent has no keys), so the project cannot be cloned from Gitea. ' +
    'Run Check Setup → ssh-agent, then open again.', check, anyway);
  if (choice === check) void vscode.commands.executeCommand('fnkcProjects.checkSetup');
  return choice === anyway;
}

/**
 * The project's new environment container (new pin, fnkc-ctl update) started but does not become ready: Discard and
 * Retry removes it and starts the environment afresh; the project's files are kept. `message`: the failure with the
 * tail of its readiness log.
 */
export async function confirmDiscardReplacement(project: string, message: string): Promise<boolean> {
  output.warn(message);
  const retry = 'Discard and Retry';
  const choice = await vscode.window.showWarningMessage(`The new environment of ${project} does not start.`, {
    modal: true,
    detail: 'Discard and Retry removes the environment container that does not start and starts it afresh. ' +
      `The project's files and packages are kept.\n\n${message}`,
  }, retry);
  return choice === retry;
}

async function pickHost(cfg: ClientConfig): Promise<string | undefined> {
  if (cfg.hosts.length === 1) return cfg.hosts[0].name;
  const items = [
    { label: 'Automatic', description: `preferred host: ${cfg.hosts[0].name}; no automatic fallback`, host: 'auto' },
    ...cfg.hosts.map((h) => ({ label: h.name, description: h.ssh ?? 'this computer', host: h.name })),
  ];
  return (await vscode.window.showQuickPick(items, { title: 'Where to run the project?' }))?.host;
}

/** Asks for whatever is not given: the project, then the host. */
/** Without a host nothing can open or stop: says how to set up (the panel's welcome says the same). */
async function notSetUp(cfg: ClientConfig): Promise<boolean> {
  if (cfg.hosts.length) return false;
  const b = await vscode.window.showWarningMessage('FNKC Projects is not set up yet: get config.json from your administrator, then import it.',
    'Import Configuration…', 'Check Setup');
  if (b === 'Import Configuration…') await vscode.commands.executeCommand('fnkcProjects.importConfig');
  else if (b) await vscode.commands.executeCommand('fnkcProjects.checkSetup');
  return true;
}

async function open(preset: { project?: string; host?: string } = {}): Promise<void> {
  const cfg = config();
  if (await notSetUp(cfg)) return;
  const project = preset.project ?? (await vscode.window.showInputBox({
    title: 'Open project',
    prompt: 'Repository in Gitea: its name, owner/name, or a link to it (from the browser or the clone URL)',
    value: state.get<string>('lastProject', ''),
    ignoreFocusOut: true,
  }))?.trim();
  if (!project) return;
  const host = preset.host ?? await pickHost(cfg);
  if (!host) return;
  await state.update('lastProject', project);

  output.info(`--- open ${project} (host: ${host})`);
  const warnings: string[] = [];
  let r;
  try {
    r = await Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Opening ${project}`, cancellable: true },
      (progress, token) => {
        // Cancel kills the commands in progress; the host keeps or rolls back what it began (lifecycle.md)
        const stop = new AbortController();
        token.onCancellationRequested(() => stop.abort());
        return openProject(cfg, project, { host, unlock: askToDecrypt(project), positron: localPositron(vscode.env.appRoot),
          confirmSshInclude, confirmEmptyAgent, discardReplacement: (m) => confirmDiscardReplacement(project, m), signal: stop.signal },
          progressLogger(progress, warnings));
      },
    )).finally(() => tree.refresh());
  } catch (e) {
    if (e instanceof SshIncludeDeclined) return void vscode.window.showInformationMessage(e.message);
    if (e instanceof TransferCancelled && e.host) {
      const there = e.host;
      output.info(`open ${project}: cancelled during the image transfer to '${there}'`);
      await transferCancelled(project, there, () => open({ project, host: there }));
      return;
    }
    if (!(e instanceof NoPositronImage)) throw e;
    // The project's environment has no image for this Positron yet: an administrator adds the server once (or this
    // Positron is updated to the team's), then the project opens as usual
    const note = teamPositronNote(e.positron, await teamPositron(cfg.cacheDir, cfg.envRepository));
    const message = `${project}: ${e.message}${note ? ` ${note}` : ''}`;
    output.warn(message);
    return missingBuild(message, e, { project, host });
  }
  await pendingUpdates.set(r.host, r.container, !!r.updatePending);
  tree.refresh();
  if (r.decryptError) vscode.window.showWarningMessage(`${project}: the data stays encrypted. ${r.decryptError}`);
  // The decryption failure has its own message above
  const summary = warningSummary(project, warnings.filter((w) => !r.decryptError || !w.includes(r.decryptError)));
  const reuse = !vscode.workspace.workspaceFolders?.length;
  if (summary && reuse) {
    // This window becomes the project's, and a notification would go with it: ask before
    const openIt = 'Open Project';
    const detail = [...new Set(warnings)].map((w) => `• ${w}`).join('\n');
    if (await vscode.window.showWarningMessage(summary, { modal: true, detail }, openIt) !== openIt) {
      void vscode.window.showInformationMessage(`${project} is running on '${r.host}'. Open it from the Projects panel when ready.`);
      return;
    }
  } else if (summary) {
    void vscode.window.showWarningMessage(summary, 'Show Log').then((c) => { if (c) output.show(); });
  }
  if (r.updatePending) {
    void vscode.window.showWarningMessage(`${project} keeps running as it was: an update of its environment or setup waits. ` +
      'When your jobs have finished, stop the project (its files are kept) and open it again to apply it.');
  }
  output.info(`Opening ${r.folder} on ${r.alias}`);
  const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${r.alias}`, path: r.folder });
  // An empty window is reused; one with a folder open stays as it is
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !reuse });
}

/**
 * Open was cancelled while the environment image was on its way: what arrived stays in this computer's download cache,
 * and Retry Open continues with the same repository and host, without asking for them again.
 */
export async function transferCancelled(project: string, host: string, retry: () => Promise<unknown>) {
  const again = 'Retry Open';
  const choice = await vscode.window.showInformationMessage(
    `Opening ${project} on '${host}' was cancelled during the environment image transfer. ` +
    'What was downloaded stays in this computer\'s cache: Retry Open continues from there.', again);
  if (choice === again) await retry();
}

/**
 * The project's environment has no image for this Positron: Build Environment (it checks the access first), or Copy
 * Request at once for those who already know an administrator builds.
 */
export async function missingBuild(message: string, e: NoPositronImage, then: { project: string; host: string }) {
  const build = 'Build Environment', copy = 'Copy Request';
  const choice = await vscode.window.showWarningMessage(message, build, copy);
  if (choice === copy) return copyRequest(buildRequest({ environment: e.environment, positron: e.positron }));
  if (choice === build) return buildEnvironment({ environment: e.environment, positron: e.positron, then });
}

async function copyRequest(request: string) {
  await vscode.env.clipboard.writeText(request);
  void vscode.window.showInformationMessage('The request is copied: send it to an administrator.');
}

/**
 * Build Environment: the Positron server of a chosen version on an R environment (the open project's, or the newest
 * of a series), in GitHub CI. Projects on that environment then open from that Positron by themselves.
 */
async function buildEnvironment(preset?: { environment: string; positron: string; then: { project: string; host: string } }) {
  const cfg = config();
  const owns = await projectEnvironments();
  const distinct = [...new Set(owns.map((o) => o.image))];
  // One environment when the open folders agree on it; the request for an administrator then names it
  const own = distinct.length === 1 ? distinct[0] : undefined;
  // Before any question: most team members cannot build, and then the message says why and what to send an administrator
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking your access on GitHub' },
      () => checkBuildRights(cfg, preset ?? { environment: own, positron: localPositron(vscode.env.appRoot).version }));
  } catch (e) {
    if (!(e instanceof CannotBuild)) throw e;
    output.warn(e.message);
    const copy = 'Copy Request';
    if (await vscode.window.showWarningMessage(e.message, copy) === copy) await copyRequest(e.request);
    return;
  }
  if (preset) return build(cfg, { environment: preset.environment, positron: preset.positron }, preset.then);
  const [{ environments, teamPositron }, releases] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reading the environments and Positron releases' },
    () => Promise.all([buildOptions(cfg), positronReleases()]));
  const items = [
    // Folders that pin different environments (a multi-root window): each one, by its folder
    ...(own ? [{ label: "This project's environment", description: own, environment: own }]
      : owns.map((o) => ({ label: `${o.folder.name}'s environment`, description: o.image, environment: o.image }))),
    ...environments.map((e) => ({ label: `R ${e.series}`, description: `newest: ${e.image}`, environment: e.image })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Build an environment (1/2): R environment', ignoreFocusOut: true });
  if (!pick) return;
  const mine = localPositron(vscode.env.appRoot).version;
  const version = await vscode.window.showQuickPick(releases.map((v) => ({
    label: v,
    description: [v === mine ? 'this Positron' : '', v === teamPositron ? "the team's" : ''].filter(Boolean).join(', '),
    picked: v === mine,
  })).sort((a, b) => Number(b.label === mine) - Number(a.label === mine)), {
    title: 'Build an environment (2/2): Positron version',
    placeHolder: `Positron releases${releases.includes(mine) ? '' : ` (yours, ${mine}, is not a release)`}`,
    ignoreFocusOut: true,
  });
  if (!version) return;
  return build(cfg, { environment: pick.environment, positron: version.label });
}

/**
 * The environments the open folders' container.json files pin: one per folder that has container.json with an image
 * (several in a multi-root window), in the window's order.
 */
async function projectEnvironments(): Promise<{ folder: vscode.WorkspaceFolder; image: string }[]> {
  const found: { folder: vscode.WorkspaceFolder; image: string }[] = [];
  for (const { folder, file } of await containerJsonFolders()) {
    try {
      const image = (JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))) as { image?: unknown }).image;
      if (typeof image === 'string') found.push({ folder, image });
    } catch {
      // unreadable or not JSON: that folder has no environment to offer
    }
  }
  return found;
}

/** Builds the image and waits for it; after an Open that found none (`then`), offers to open that project. */
async function build(cfg: ClientConfig, req: { environment: string; positron: string }, then?: { project: string; host: string }) {
  output.info(`--- build Positron ${req.positron} for ${req.environment}`);
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  const started = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Starting the build on GitHub' }, () => startBuild(cfg, req, log));
  output.info(`Run ${started.id}: ${started.url}`);
  void vscode.window.showInformationMessage(`Adding the server of Positron ${req.positron} to the environment on GitHub (a few minutes).`, 'Open Run')
    .then((c) => { if (c) void vscode.env.openExternal(vscode.Uri.parse(started.url)); });
  return watchBuild(cfg, req, started, then);
}

/**
 * Follows a started build to its image. Cancelling the progress only stops watching: the run goes on, and the
 * message offers to watch the same run again (nothing is dispatched twice) or to open it on GitHub.
 */
async function watchBuild(cfg: ClientConfig, req: { environment: string; positron: string }, started: BuildRun,
  then?: { project: string; host: string }): Promise<void> {
  let image: string;
  try {
    image = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Building for Positron ${req.positron}`, cancellable: true },
      (progress, token) => {
        const stop = new AbortController();
        token.onCancellationRequested(() => stop.abort());
        return finishBuild(cfg, req, started.id, progressLogger(progress), stop.signal);
      });
  } catch (e) {
    if (!(e instanceof WatchStopped)) throw e;
    output.info(`Stopped watching run ${started.id}; the build goes on: ${started.url}`);
    const resume = 'Resume Watching', openRun = 'Open Run';
    const choice = await vscode.window.showInformationMessage(
      `The build for Positron ${req.positron} continues on GitHub.`, resume, openRun);
    if (choice === resume) return watchBuild(cfg, req, started, then);
    if (choice === openRun) await vscode.env.openExternal(vscode.Uri.parse(started.url));
    return;
  }
  output.info(`Built: ${image}`);
  images?.refresh();
  const done = `Built: projects on this environment now open from Positron ${req.positron}.`;
  if (!then) {
    vscode.window.showInformationMessage(done);
    return;
  }
  const openIt = `Open ${then.project}`;
  if (await vscode.window.showInformationMessage(done, openIt) === openIt) await open(then);
}

/** Asked when an opened project has encrypted data that is not decrypted yet (once per checkout). */
function askToDecrypt(project: string) {
  return async (host: string): Promise<boolean> => {
    const decrypt = 'Decrypt';
    const answer = await vscode.window.showInformationMessage(`${project}: the project's data is encrypted. Decrypt it?`, {
      modal: true,
      detail: `Your GPG key on this computer opens the project key (GnuPG may ask for your passphrase); the data is ` +
        `decrypted in the container on '${host}'. It stays decrypted until you run fnkc-projects lock in the project's terminal.`,
    }, decrypt);
    return answer === decrypt;
  };
}

/** A row of the Stop picker: a running project, or (retry) a host that could not be checked. */
export interface StopChoice { label: string; description: string; detail?: string; host: string; retry?: boolean }

/**
 * The Stop picker's rows: the running projects on the hosts that answered, then a Retry row for each host that did
 * not, so a host that could not be checked is not mistaken for one without running projects.
 */
export function stopChoices(listings: HostListing[]): StopChoice[] {
  const running = listings.flatMap((l) =>
    l.containers.filter((c) => c.running).map((c) => ({ label: c.project, description: `on ${l.host}`, host: l.host })));
  const failed = listings.filter((l) => l.error).map((l) =>
    ({ label: `$(refresh) Retry ${l.host}`, description: 'could not be checked', detail: l.error, host: l.host, retry: true }));
  return [...running, ...failed];
}

/**
 * What a Stop on one host did (the picker, the list, Stop Now): it stopped the project, the project had already
 * stopped (since the list was read), or its container is gone. A host that could not be asked throws instead.
 */
export function stoppedMessage(project: string, host: string, results: HostStop[]): string {
  switch (results.find((r) => r.host === host)?.outcome) {
    case 'stopped': return `${project} stopped on ${host}. Its files are kept.`;
    case 'already-stopped': return `${project} had already stopped on ${host}. Its files are kept.`;
    case 'other-repository': return `${project} on ${host} belongs to another repository: left running.`;
    default: return `${project} has no container on ${host}: nothing to stop.`;
  }
}

/** "Could not check lab-server and laptop. Reconnect and retry." */
export function uncheckedHosts(hosts: string[]): string {
  const names = hosts.map((h) => `'${h}'`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `Could not check ${list}. Reconnect and retry.`;
}

async function stop() {
  const cfg = config();
  if (await notSetUp(cfg)) return;
  let pick: StopChoice | undefined;
  for (;;) {
    const listings = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Looking for running projects' },
      () => listProjects(cfg, { info: (m) => output.info(m), warn: (m) => output.warn(m) }),
    );
    const choices = stopChoices(listings);
    const failed = choices.filter((c) => c.retry);
    if (choices.length === failed.length) {
      if (!failed.length) {
        vscode.window.showInformationMessage('No running projects.');
        return;
      }
      for (const f of failed) output.warn(`${f.host}: ${f.detail}`);
      const others = listings.length > failed.length ? ' The other hosts have no running projects.' : '';
      const answer = await vscode.window.showWarningMessage(`${uncheckedHosts(failed.map((f) => f.host))}${others}`,
        { detail: failed.map((f) => `${f.host}: ${f.detail}`).join('\n') }, 'Retry');
      if (answer !== 'Retry') return;
      continue;
    }
    pick = await vscode.window.showQuickPick(choices, {
      title: 'Stop which project? (its files are kept)',
      placeHolder: failed.length ? uncheckedHosts(failed.map((f) => f.host)) : undefined,
    });
    if (!pick?.retry) break;
  }
  if (!pick) return;
  // This window's own project: its files are saved first, and the window closes
  if (currentProject() === pick.label && currentConnection()?.host === pick.host) return void vscode.commands.executeCommand('fnkcProjects.stopCurrent');
  if (!(await confirmStop(pick.label, pick.host))) return;
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  const results = await Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Stopping ${pick.label}` },
    () => stopProject(cfg, pick.label, pick.host, log))).finally(() => tree.refresh());
  vscode.window.showInformationMessage(stoppedMessage(pick.label, pick.host, results));
}

/** Runs the one-time WSL + Docker setup (windows/setup-wsl.ps1, shipped with the extension) in a terminal. */
function setupWindows(ctx: vscode.ExtensionContext) {
  const script = vscode.Uri.joinPath(ctx.extensionUri, 'windows', 'setup-wsl.ps1').fsPath;
  const t = vscode.window.createTerminal({
    name: 'FNKC Projects setup',
    shellPath: 'powershell.exe',
    shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', script],
  });
  t.show();
}

/**
 * The project of this window, if it is connected to a project container (its Remote SSH host, see sshAlias): the
 * first workspace folder on such a host, so a multi-root window whose first folder is elsewhere still finds it.
 */
export function currentConnection(): { project: string; host: string } | undefined {
  for (const { uri } of vscode.workspace.workspaceFolders ?? []) {
    if (uri.scheme !== 'vscode-remote') continue;
    const alias = /^ssh-remote\+(.+)$/.exec(decodeURIComponent(uri.authority))?.[1];
    const found = alias ? connectionOfAlias(config().sshDir, alias) : undefined;
    if (found) return found;
  }
  return undefined;
}
function currentProject(): string | undefined { return currentConnection()?.project; }

/** In a project window: "■ <project> (<host>)" in the status bar; clicking it stops the project. */
function showStopButton(ctx: vscode.ExtensionContext) {
  const project = currentProject();
  if (!project) return;
  const host = currentConnection()?.host ?? 'unknown host';
  const item = vscode.window.createStatusBarItem('fnkcProjects.stop', vscode.StatusBarAlignment.Left, 100);
  item.name = 'FNKC Projects: stop this project';
  item.text = `$(debug-stop) ${project} (${host})`;
  item.tooltip = `Stop the container of ${project} on '${host}' and close this window. Files are kept.`;
  item.command = 'fnkcProjects.stopCurrent';
  item.show();
  ctx.subscriptions.push(item);
}

/**
 * Stops this window's project. The container is the other end of this window's connection, so the stop runs
 * in a separate process (fnkc-ctl, with Positron's own Node) that outlives the window, and the window closes.
 */
async function stopCurrent(ctx: vscode.ExtensionContext) {
  const project = currentProject();
  if (!project) {
    await vscode.commands.executeCommand('fnkcProjects.stop');
    return;
  }
  const raw = rawConfig();
  const host = currentConnection()?.host;
  const busy = host ? await busyDetail(project, host) : undefined;
  const choice = await vscode.window.showWarningMessage(
    `Stop ${project}${host ? ` on '${host}'` : ''} and close this window?`,
    { modal: true, detail: `${busy ? `${busy}\n\n` : ''}Open files are saved first. The project files stay in the container; uncommitted work is kept.` },
    busy ? 'Stop Anyway' : 'Stop',
  );
  if (choice !== 'Stop' && choice !== 'Stop Anyway') return;
  if (!(await vscode.workspace.saveAll())) throw new Error('some files could not be saved; project was not stopped');

  const dir = ctx.globalStorageUri.fsPath;
  mkdirSync(dir, { recursive: true });
  const id = `${process.pid}-${Date.now()}`;
  const cfgFile = join(dir, `stop-${id}.json`);
  writeFileSync(cfgFile, JSON.stringify(raw), { mode: 0o600 });
  const logFile = join(dir, 'stop.log');
  // The log of background stops is kept small: the previous megabyte moves to stop.log.1
  try { if (statSync(logFile).size > 1024 * 1024) renameSync(logFile, `${logFile}.1`); } catch { /* no log yet */ }
  const logFd = openSync(logFile, 'a');
  const cli = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'fnkc-ctl.cjs').fsPath;
  // The outcome is reported by the next window that starts (reportBackgroundStops): this one closes now
  const args = [cli, 'stop', project, '--config', cfgFile, '--status-file', join(dir, `stop-status-${id}.json`), ...(host ? ['--host', host] : [])];
  output.info(`Stopping ${project} in the background (log: ${join(dir, 'stop.log')})`);
  spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  }).unref();
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}

/**
 * The outcomes of stops that ran in the background after their window closed (stopCurrent): a failure is shown
 * with what to do, a success only in the log. Their config copies are removed, as are ones older than a day.
 */
async function reportBackgroundStops(ctx: vscode.ExtensionContext) {
  const dir = ctx.globalStorageUri.fsPath;
  let files: string[];
  try { files = readdirSync(dir); } catch { return; }
  for (const f of files) {
    const status = /^stop-status-(.+)\.json$/.exec(f);
    if (status) {
      let s: { ok?: boolean; project?: string; host?: string; message?: string } = {};
      try { s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as typeof s; } catch { /* unreadable: reported below */ }
      rmSync(join(dir, f), { force: true });
      rmSync(join(dir, `stop-${status[1]}.json`), { force: true });
      if (s.ok) { output.info(`background stop: ${s.message ?? ''}`); continue; }
      output.error(`background stop of ${s.project ?? 'a project'} failed: ${s.message ?? 'no details'}`);
      const again = 'Stop Again';
      const choice = await vscode.window.showErrorMessage(
        `Stopping ${s.project ?? 'a project'}${s.host ? ` on '${s.host}'` : ''} after its window closed did not succeed: ${s.message ?? 'no details'}. It may still be running.`,
        again, 'Show Log');
      if (choice === 'Show Log') output.show();
      if (choice === again) await vscode.commands.executeCommand('fnkcProjects.stop');
    } else if (/^stop-\d+-\d+\.json$/.test(f)) {
      try { if (Date.now() - statSync(join(dir, f)).mtimeMs > DAY) rmSync(join(dir, f), { force: true }); } catch { /* gone */ }
    }
  }
}

/** Clear Image Download Cache: the environment images this computer downloaded to send to hosts. */
async function clearDownloadCache() {
  const cfg = config();
  const size = imageCacheSize(cfg.cacheDir);
  if (!size) return void vscode.window.showInformationMessage('The image download cache is empty.');
  const clear = 'Clear';
  const answer = await vscode.window.showWarningMessage(`Clear the image download cache (${(size / 1e9).toFixed(1)} GB)?`, {
    modal: true,
    detail: 'These are environment images this computer downloaded to send to hosts that lack them. Hosts and projects are not affected; an Open that needs an image again downloads it again.',
  }, clear);
  if (answer !== clear) return;
  const freed = clearImageCache(cfg.cacheDir);
  output.info(`Cleared the image download cache: ${Math.round(freed / 1e6)} MB`);
  vscode.window.showInformationMessage(`Cleared ${(freed / 1e9).toFixed(1)} GB.`);
}

/** The platform Check Setup writes its commands for: this computer, or another one in tests. */
let fixPlatform: NodeJS.Platform = process.platform;
let fixOsRelease: string | undefined;
export function setFixPlatformForTests(p: NodeJS.Platform, osRelease?: string) { fixPlatform = p; fixOsRelease = osRelease; }

async function checks(): Promise<Check[]> {
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  showConfigState();
  let cfg: ClientConfig;
  try {
    cfg = config();
  } catch (e) {
    // A broken setting is a problem to show like the others, not an error that hides them all
    return [{ name: CONFIGURATION_CHECK, ok: false, detail: (e as Error).message.replace(/^config: /, ''),
      fix: `Correct it in Settings (search for FNKC Projects) or in ${clientConfigPath()}, then run Check Setup again; ` +
        'if the file came from your administrator, ask them for a corrected one' }, updatesCheck()];
  }
  return [...await runChecks(cfg, log, { appRoot: vscode.env.appRoot, platform: fixPlatform, osRelease: fixOsRelease,
    teamPositron: () => teamPositron(cfg.cacheDir, cfg.envRepository) }), updatesCheck()];
}

const UPDATES_CHECK = 'Positron updates';

/**
 * Project images contain the server of one Positron build, so Positron must not update itself: the team moves to a
 * new release together, with new images (env/positron.args).
 */
function updatesCheck(): Check {
  const mode = vscode.workspace.getConfiguration('update').get<string>('mode', 'default');
  if (mode === 'none' || mode === 'manual') return { name: UPDATES_CHECK, ok: true, detail: `automatic updates are off (update.mode: ${mode})` };
  return {
    name: UPDATES_CHECK, ok: false, detail: `Positron updates itself (update.mode: ${mode})`,
    fix: 'Select to turn automatic updates off: project images work with one Positron version, the team updates together',
  };
}

const runChecksWithProgress = (title: string) =>
  Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, checks));

/** Every check with its result; picking a failed one explains its fix and can run it. */
async function checkSetup() {
  const results = await runChecksWithProgress('Checking the setup of this computer');
  for (const c of results) output.info(`${c.ok ? 'ok' : 'FAIL'} ${c.name}: ${c.detail}${c.fix ? ` -> ${c.fix}` : ''}`);
  const failed = results.filter((c) => !c.ok).length;
  const items = results.map((c) => ({
    label: `$(${c.ok ? 'pass-filled' : 'error'}) ${c.name}`,
    description: c.detail,
    detail: c.ok ? undefined : [c.fix, c.command && `Select for the steps${c.admin ? ' (needs administrator rights)' : ''}`].filter(Boolean).join(' — '),
    check: c,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: failed ? `${failed} problem${failed > 1 ? 's' : ''} found: select one to fix it` : 'Everything is set up',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  const c = pick?.check;
  if (c && !c.ok) await fixCheck(c);
}

/** Explains the fix of a failed check, then runs it (or copies it) and checks again; a failure is explained in plain words. */
async function fixCheck(c: Check): Promise<void> {
  if (c.name === UPDATES_CHECK) {
    await vscode.workspace.getConfiguration('update').update('mode', 'none', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Automatic Positron updates are off (update.mode: none). Restart Positron to apply.');
    return;
  }
  if (c.name === CONFIGURATION_CHECK && c.fix === GET_CONFIG) {
    await vscode.commands.executeCommand('fnkcProjects.importConfig');
    return;
  }
  if (/Set Up Docker on This Computer/.test(c.fix ?? '')) {
    await vscode.commands.executeCommand('fnkcProjects.setupWindows');
    return;
  }
  if (!c.command) {
    await vscode.window.showInformationMessage(`${c.name}: ${c.fix ?? c.detail}`, { modal: true, detail: c.manual ?? `Found: ${c.detail}` });
    return;
  }
  const elevated = fixPlatform === 'win32' && !!c.admin;
  const runLabel = elevated ? RUN_ADMIN : RUN;
  const choice = await vscode.window.showInformationMessage(`${c.name}: ${c.fix ?? c.detail}`,
    { modal: true, detail: `The command:\n${c.command}\n\n${fixSteps(c, fixPlatform)}` }, runLabel, COPY, COPY_ADMIN);
  if (choice === COPY) {
    await vscode.env.clipboard.writeText(c.command);
    vscode.window.showInformationMessage(`Copied the command. ${pasteHelp(c, fixPlatform)} Then run Check Setup again.`);
    return;
  }
  if (choice === COPY_ADMIN) {
    await vscode.env.clipboard.writeText(adminReport(c, fixPlatform));
    vscode.window.showInformationMessage('Copied what your IT admin needs: paste it into an email or chat to them.');
    return;
  }
  if (choice !== runLabel) return;
  output.info(`Check Setup: running the fix of ${c.name}: ${c.command}`);
  const result = elevated ? await runElevated(c.command) : await runInTerminal(c);
  if (!result) {
    vscode.window.showInformationMessage('The command runs in the terminal below. When it has finished, run Check Setup again.', 'Check Setup')
      .then((b) => { if (b) void vscode.commands.executeCommand('fnkcProjects.checkSetup'); });
    return;
  }
  output.info(`Check Setup: the fix of ${c.name} ended (exit code ${result.exitCode ?? 'unknown'})`);
  const after = await runChecksWithProgress(`Checking ${c.name} again`);
  const now = after.find((x) => x.name === c.name);
  const left = after.filter((x) => !x.ok && x.name !== c.name).length;
  if (!now || now.ok) {
    const more = left ? ` ${left} other problem${left > 1 ? 's are' : ' is'} left.` : '';
    const b = await vscode.window.showInformationMessage(`${c.name} is ready now.${more}`, ...(left ? ['Check Setup'] : []));
    if (b) await vscode.commands.executeCommand('fnkcProjects.checkSetup');
    return;
  }
  const o = explainFailure(c, result.exitCode, result.output, now);
  output.warn(`Check Setup: ${c.name} is still not ready: ${o.problem}`);
  const b = await vscode.window.showWarningMessage(`${c.name} is still not ready. ${o.problem}`, { modal: true, detail: o.next }, 'Try Again', COPY_ADMIN);
  if (b === 'Try Again') await fixCheck(now);
  else if (b === COPY_ADMIN) {
    await vscode.env.clipboard.writeText(adminReport(now, fixPlatform, result.output));
    vscode.window.showInformationMessage('Copied what your IT admin needs: paste it into an email or chat to them.');
  }
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');

/**
 * Runs a fix in Positron's terminal, where the user sees it and answers its questions (a password, Enter for
 * ssh-keygen). Its exit code and output come from shell integration; without it (some shells), the command is
 * typed in and undefined returned.
 */
async function runInTerminal(c: Check): Promise<{ exitCode: number | undefined; output: string } | undefined> {
  const t = vscode.window.createTerminal({ name: `FNKC: ${c.name}`, ...(fixPlatform === 'win32' ? { shellPath: 'powershell.exe' } : {}) });
  t.show();
  const integration = t.shellIntegration ?? await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
    const timer = setTimeout(() => { sub.dispose(); resolve(undefined); }, 5000);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal !== t) return;
      clearTimeout(timer); sub.dispose(); resolve(e.shellIntegration);
    });
  });
  if (!integration) { t.sendText(c.command!, true); return undefined; }
  let exec: vscode.TerminalShellExecution | undefined;
  const subs: vscode.Disposable[] = [];
  const ended = new Promise<number | undefined>((resolve) => {
    subs.push(vscode.window.onDidEndTerminalShellExecution((e) => { if (e.execution === exec) resolve(e.exitCode); }),
      vscode.window.onDidCloseTerminal((closed) => { if (closed === t) resolve(undefined); }));
  });
  exec = integration.executeCommand(c.command!);
  let text = '';
  const reading = (async () => { for await (const d of exec.read()) text += d; })().catch(() => {});
  const exitCode = await ended;
  await Promise.race([reading, new Promise((r) => setTimeout(r, 1000))]);
  subs.forEach((s) => s.dispose());
  return { exitCode, output: stripAnsi(text) };
}

/** Runs a fix that needs administrator rights in an elevated PowerShell window (Windows asks for permission). */
async function runElevated(command: string): Promise<{ exitCode: number | undefined; output: string }> {
  const errorFile = join(tmpdir(), `fnkc-fix-${process.pid}-${Date.now()}.txt`);
  try {
    const r = await run('powershell.exe', elevatedPowerShell(command, errorFile), { timeoutMs: 60 * 60_000 });
    let err = '';
    try { err = readFileSync(errorFile, 'utf8'); } catch { /* no error written */ }
    return { exitCode: r.code, output: `${r.stdout}${r.stderr}${err}` };
  } catch (e) {
    return { exitCode: undefined, output: (e as Error).message };
  } finally {
    rmSync(errorFile, { force: true });
  }
}

let firstRunRunning = false;

/**
 * Until the setup passes once: on start and when the configuration changes, the checks run in the background and a
 * problem is said at most once a day. A pass (or Don't Remind Me) ends it; Check Setup stays in the panel's title.
 */
async function firstRunCheck(ctx: vscode.ExtensionContext) {
  if (ctx.globalState.get('setupChecked') || firstRunRunning) return;
  firstRunRunning = true;
  try {
    const failed = (await checks()).filter((c) => !c.ok);
    if (!failed.length) {
      await ctx.globalState.update('setupChecked', true);
      output.info('first-run check: everything is set up');
      return;
    }
    output.info(`first-run check: ${failed.map((c) => c.name).join(', ')} not ready`);
    if (Date.now() - (ctx.globalState.get<number>('setupRemindedAt') ?? 0) < DAY) return;
    await ctx.globalState.update('setupRemindedAt', Date.now());
    const unconfigured = failed.find((c) => c.name === CONFIGURATION_CHECK && c.fix === GET_CONFIG);
    const choice = unconfigured
      ? await vscode.window.showWarningMessage('FNKC Projects is not set up yet: get config.json from your administrator, then import it.',
        'Import Configuration…', 'Check Setup', DONT_REMIND)
      : await vscode.window.showWarningMessage(
        `FNKC Projects: ${failed.map((c) => c.name).join(', ')} need${failed.length > 1 ? '' : 's'} attention.`, 'Check Setup', DONT_REMIND);
    if (choice === DONT_REMIND) await ctx.globalState.update('setupChecked', true);
    else if (choice === 'Import Configuration…') await vscode.commands.executeCommand('fnkcProjects.importConfig');
    else if (choice) await vscode.commands.executeCommand('fnkcProjects.checkSetup');
  } catch (e) {
    output.warn(`first-run check: ${(e as Error).message}`);
  } finally {
    firstRunRunning = false;
  }
}

const DONT_REMIND = "Don't Remind Me";
export const firstRunCheckForTests = firstRunCheck;

/**
 * What still computes in the project, as the text of Stop's confirmation; undefined if nothing does (or the host
 * cannot tell: Stop then asks as before).
 */
async function busyDetail(project: string, host: string): Promise<string | undefined> {
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  let list;
  try {
    list = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking what runs in ${project}` },
      () => busyProcesses(config(), project, host, log));
  } catch (e) {
    output.warn(`could not tell what runs in ${project}: ${(e as Error).message}`);
    return undefined;
  }
  if (!list.length) return undefined;
  const shown = list.slice(0, 8).map((p) => `• ${p.what} (${p.cpu}% CPU)`);
  if (list.length > shown.length) shown.push(`• and ${list.length - shown.length} more`);
  return `Still running in ${project}:\n${shown.join('\n')}\nStopping ends them: what they hold in memory and have not written to files is lost.`;
}

/** Before Stop of a project that is not this window's: true unless it computes and the user does not confirm. */
async function confirmStop(project: string, host: string): Promise<boolean> {
  const detail = await busyDetail(project, host);
  if (!detail) return true;
  return (await vscode.window.showWarningMessage(`Stop ${project} on '${host}'?`, { modal: true, detail }, 'Stop Anyway')) === 'Stop Anyway';
}

/**
 * A project that has computed without a window for a day (its host stops it 3 days after the last window closed):
 * Keep gives it 3 more days, Stop Now stops it. Asked in one window, once a day per project.
 */
function watchLongRunning(ctx: vscode.ExtensionContext) {
  const quiet: Logger = { info: () => {}, warn: () => {} };
  const check = async () => {
    let listings;
    try { listings = await listProjects(config(), quiet); } catch { return; }
    const today = new Date().toISOString().slice(0, 10);
    for (const l of listings) {
      for (const c of l.containers) {
        if (!c.running || !c.notice || !c.stopsAt) continue;
        if (currentProject() === c.project && currentConnection()?.host === l.host) continue;
        const key = `longRunningAsked:${l.host}/${c.project}`;
        if (ctx.globalState.get<string>(key) === today) continue;
        await ctx.globalState.update(key, today);
        void askKeep(c.project, l.host, c.noWindowSince, c.stopsAt);
      }
    }
  };
  const first = setTimeout(() => void check(), 20_000);
  const every = setInterval(() => void check(), 30 * 60_000);
  ctx.subscriptions.push({ dispose: () => { clearTimeout(first); clearInterval(every); } });
}

async function askKeep(project: string, host: string, noWindowSince: string | undefined, stopsAt: string) {
  const hours = noWindowSince ? Math.round((Date.now() - Date.parse(noWindowSince)) / 3.6e6) : undefined;
  const choice = await vscode.window.showWarningMessage(
    `${project} on '${host}' has been computing without a window${hours ? ` for ${hours} h` : ''}. It stops on ` +
      `${new Date(stopsAt).toLocaleString()} unless you keep it; what its sessions hold in memory is then lost.`,
    'Keep 3 More Days', 'Stop Now');
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  try {
    if (choice === 'Keep 3 More Days') {
      const { until } = await keepProject(config(), project, host, log);
      vscode.window.showInformationMessage(`${project} keeps running until ${new Date(until).toLocaleString()}, or until you stop it.`);
    } else if (choice === 'Stop Now' && (await confirmStop(project, host))) {
      const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Stopping ${project}` },
        () => stopProject(config(), project, host, log));
      vscode.window.showInformationMessage(stoppedMessage(project, host, results));
    }
  } catch (e) {
    vscode.window.showErrorMessage(`${project}: ${(e as Error).message}`);
  } finally {
    tree.refresh();
  }
}
