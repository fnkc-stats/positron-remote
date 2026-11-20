// Positron extension: the same open / stop as fnkc-ctl, with a progress notification and the project
// window opened at the end. Runs on the user's computer (extensionKind "ui"), never inside a container.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { type ClientConfig, clientConfig, readClientConfigFile } from './client/config.ts';
import { buildOptions, finishBuild, positronReleases, startBuild } from './client/build.ts';
import { listProjects, openProject, stopProject } from './client/open.ts';
import { NoPositronImage } from './client/variant.ts';
import { localPositron } from './client/positron.ts';
import { type Check, runChecks } from './client/doctor.ts';
import { connectionOfAlias } from './client/ssh.ts';
import { type Item, ProjectsTree } from './sidebar.ts';
import { extendPath } from './exec.ts';
import type { Logger } from './log.ts';

let output: vscode.LogOutputChannel;
let tree: ProjectsTree;
let state: vscode.Memento;

export function activate(ctx: vscode.ExtensionContext) {
  extendPath();
  output = vscode.window.createOutputChannel('FNKC Projects', { log: true });
  state = ctx.globalState;
  ctx.subscriptions.push(
    output,
    command('fnkcProjects.open', () => open()),
    command('fnkcProjects.stop', stop),
    command('fnkcProjects.buildEnvironment', buildEnvironment),
    vscode.commands.registerCommand('fnkcProjects.showLog', () => output.show()),
    vscode.commands.registerCommand('fnkcProjects.setupWindows', () => setupWindows(ctx)),
    command('fnkcProjects.stopCurrent', () => stopCurrent(ctx)),
  );
  showStopButton(ctx);
  showProjectsPanel(ctx);
  ctx.subscriptions.push(command('fnkcProjects.checkSetup', checkSetup));
  firstRunCheck(ctx);
}

/** The Projects panel in the activity bar, with Open / Stop buttons on its items. */
function showProjectsPanel(ctx: vscode.ExtensionContext) {
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  tree = new ProjectsTree(config, log);
  const view = vscode.window.createTreeView('fnkcProjects.list', { treeDataProvider: tree });
  // Containers stop themselves when idle, so the panel refreshes while it is visible
  const timer = setInterval(() => { if (view.visible) tree.refresh(); }, 60_000);
  ctx.subscriptions.push(
    view,
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('fnkcProjects')) tree.refresh(); }),
    vscode.commands.registerCommand('fnkcProjects.refresh', () => tree.refresh()),
    command('fnkcProjects.openItem', async (item?: Item) => {
      if (item?.kind === 'project') await open({ project: item.container.repository ?? item.container.project, host: item.host });
    }),
    command('fnkcProjects.openHere', async (item?: Item) => {
      if (item?.kind === 'host') await open({ host: item.host });
    }),
    command('fnkcProjects.stopItem', async (item?: Item) => {
      if (item?.kind !== 'project') return;
      const p = item.container.project;
      if (currentProject() === p && currentConnection()?.host === item.host) return vscode.commands.executeCommand('fnkcProjects.stopCurrent');
      await Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Stopping ${p}` },
        () => stopProject(config(), p, item.host, log))).finally(() => tree.refresh());
    }),
  );
}

export function deactivate() {}

/** A command whose errors end up in the log and in a message with a "Show Log" button. */
function command<A extends unknown[]>(id: string, fn: (...args: A) => Promise<unknown>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      const msg = (e as Error).message;
      output.error(msg);
      const choice = await vscode.window.showErrorMessage(msg, 'Check Setup', 'Show Log');
      if (choice === 'Show Log') output.show();
      if (choice === 'Check Setup') await vscode.commands.executeCommand('fnkcProjects.checkSetup');
    }
  });
}

function config(): ClientConfig {
  return clientConfig(rawConfig());
}

/** The config file shared with the command line, overridden by whatever is set in Positron's settings. */
function rawConfig(): Record<string, unknown> {
  const s = vscode.workspace.getConfiguration('fnkcProjects');
  const raw: Record<string, unknown> = { ...readClientConfigFile() };
  // Connection and secret policy is personal machine configuration, never repository settings.
  for (const k of ['hosts', 'gitRemotes', 'decryptionHosts', 'sshKey', 'gitCryptKey', 'localEngine', 'wslDistro', 'envRepository']) {
    const v = s.inspect<unknown>(k)?.globalValue;
    if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) raw[k] = v;
  }
  const idle = s.inspect<number>('idleMinutes')?.globalValue;
  if (idle !== undefined) raw.local = { ...(raw.local as object | undefined), idleMinutes: idle };
  return raw;
}

function progressLogger(progress: vscode.Progress<{ message?: string }>): Logger {
  return {
    info: (m) => { output.info(m); progress.report({ message: m }); },
    warn: (m) => { output.warn(m); },
  };
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
async function open(preset: { project?: string; host?: string } = {}) {
  const cfg = config();
  const project = preset.project ?? (await vscode.window.showInputBox({
    title: 'Open project',
    prompt: 'Repository name in Gitea, or a full git URL',
    value: state.get<string>('lastProject', ''),
    ignoreFocusOut: true,
  }))?.trim();
  if (!project) return;
  const host = preset.host ?? await pickHost(cfg);
  if (!host) return;
  await state.update('lastProject', project);

  output.info(`--- open ${project} (host: ${host})`);
  let r;
  try {
    r = await Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Opening ${project}` },
      (progress) => openProject(cfg, project, { host, unlock: askToDecrypt(project), positron: localPositron(vscode.env.appRoot) }, progressLogger(progress)),
    )).finally(() => tree.refresh());
  } catch (e) {
    if (!(e instanceof NoPositronImage)) throw e;
    // The project's environment has no image for this Positron yet: add the server once, then open as usual
    output.warn(e.message);
    const build = 'Build Environment';
    if (await vscode.window.showWarningMessage(`${project}: ${e.message}`, build) !== build) return;
    return buildEnvironment({ environment: e.environment, positron: e.positron, then: { project, host } });
  }
  if (r.decryptError) vscode.window.showWarningMessage(`${project}: the data stays encrypted. ${r.decryptError}`);
  output.info(`Opening ${r.folder} on ${r.alias}`);
  const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${r.alias}`, path: r.folder });
  // An empty window is reused; one with a folder open stays as it is
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !!vscode.workspace.workspaceFolders?.length });
}

/**
 * Build Environment: the Positron server of a chosen version on an R environment (the open project's, or the newest
 * of a series), in GitHub CI. Projects on that environment then open from that Positron by themselves.
 */
async function buildEnvironment(preset?: { environment: string; positron: string; then: { project: string; host: string } }) {
  const cfg = config();
  if (preset) return build(cfg, { environment: preset.environment, positron: preset.positron }, preset.then);
  const own = await projectEnvironment();
  const [{ environments, teamPositron }, releases] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reading the environments and Positron releases' },
    () => Promise.all([buildOptions(cfg), positronReleases()]));
  const items = [
    ...(own ? [{ label: "This project's environment", description: own, environment: own }] : []),
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

/** The environment container.json of the open project pins, if a project is open. */
async function projectEnvironment(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'container.json')));
    const image = (JSON.parse(text) as { image?: unknown }).image;
    return typeof image === 'string' ? image : undefined;
  } catch {
    return undefined;
  }
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
  const image = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building for Positron ${req.positron}`, cancellable: true },
    (progress, token) => {
      const stop = new AbortController();
      token.onCancellationRequested(() => stop.abort());
      return finishBuild(cfg, req, started.id, progressLogger(progress), stop.signal);
    });
  output.info(`Built: ${image}`);
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

async function stop() {
  const cfg = config();
  const listings = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Looking for running projects' },
    () => listProjects(cfg, { info: (m) => output.info(m), warn: (m) => output.warn(m) }),
  );
  const items = listings.flatMap((l) =>
    l.containers.filter((c) => c.running).map((c) => ({ label: c.project, description: `on ${l.host}`, host: l.host })));
  if (!items.length) {
    vscode.window.showInformationMessage('No running projects.');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { title: 'Stop which project? (its files are kept)' });
  if (!pick) return;
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  await stopProject(cfg, pick.label, pick.host, log).finally(() => tree.refresh());
  vscode.window.showInformationMessage(`${pick.label} stopped on ${pick.host}. Its files are kept.`);
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

/** The project of this window, if it is connected to a project container (Remote SSH host fnkc-<project>). */
function currentConnection(): { project: string; host: string } | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder?.scheme !== 'vscode-remote') return undefined;
  const alias = /^ssh-remote\+(.+)$/.exec(decodeURIComponent(folder.authority))?.[1];
  return alias ? connectionOfAlias(config().sshDir, alias) : undefined;
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
  const choice = await vscode.window.showWarningMessage(
    `Stop ${project}${host ? ` on '${host}'` : ''} and close this window?`,
    { modal: true, detail: 'Open files are saved first. The project files stay in the container; uncommitted work is kept.' },
    'Stop',
  );
  if (choice !== 'Stop') return;
  if (!(await vscode.workspace.saveAll())) throw new Error('some files could not be saved; project was not stopped');

  const dir = ctx.globalStorageUri.fsPath;
  mkdirSync(dir, { recursive: true });
  const cfgFile = join(dir, `stop-${process.pid}-${Date.now()}.json`);
  writeFileSync(cfgFile, JSON.stringify(raw));
  const logFd = openSync(join(dir, 'stop.log'), 'a');
  const cli = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'fnkc-ctl.cjs').fsPath;
  const args = [cli, 'stop', project, '--config', cfgFile, ...(host ? ['--host', host] : [])];
  output.info(`Stopping ${project} in the background (log: ${join(dir, 'stop.log')})`);
  spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  }).unref();
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}

async function checks() {
  const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
  return [...await runChecks(config(), log, vscode.env.appRoot), updatesCheck()];
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

/** Every check with its result; picking a failed one copies its fix command (or runs the Windows setup). */
async function checkSetup() {
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking the setup of this computer' }, checks);
  for (const c of results) output.info(`${c.ok ? 'ok' : 'FAIL'} ${c.name}: ${c.detail}${c.fix ? ` -> ${c.fix}` : ''}`);
  const failed = results.filter((c) => !c.ok).length;
  const items = results.map((c) => ({
    label: `$(${c.ok ? 'pass-filled' : 'error'}) ${c.name}`,
    description: c.detail,
    detail: c.ok ? undefined : [c.fix, c.command && `Select to copy: ${c.command}`].filter(Boolean).join(' — '),
    check: c,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: failed ? `${failed} problem${failed > 1 ? 's' : ''} found` : 'Everything is set up',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  const c = pick?.check;
  if (!c || c.ok) return;
  if (c.name === UPDATES_CHECK) {
    await vscode.workspace.getConfiguration('update').update('mode', 'none', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Automatic Positron updates are off (update.mode: none). Restart Positron to apply.');
  } else if (/Set Up Docker on This Computer/.test(c.fix ?? '')) {
    await vscode.commands.executeCommand('fnkcProjects.setupWindows');
  } else if (c.command) {
    await vscode.env.clipboard.writeText(c.command);
    vscode.window.showInformationMessage(`Copied to the clipboard: ${c.command} (paste it into a terminal)`);
  }
}

/** Once, the first time the extension runs: say so if something is missing. */
async function firstRunCheck(ctx: vscode.ExtensionContext) {
  if (ctx.globalState.get('setupChecked')) return;
  await ctx.globalState.update('setupChecked', true);
  try {
    const failed = (await checks()).filter((c) => !c.ok);
    if (!failed.length) return;
    const choice = await vscode.window.showWarningMessage(
      `FNKC Projects: ${failed.map((c) => c.name).join(', ')} need${failed.length > 1 ? '' : 's'} attention.`, 'Check Setup');
    if (choice) await vscode.commands.executeCommand('fnkcProjects.checkSetup');
  } catch (e) {
    output.warn(`first-run check: ${(e as Error).message}`);
  }
}
