// Positron extension: the same open / stop as positron-ctl, with a progress notification and the project
// window opened at the end. Runs on the user's computer (extensionKind "ui"), never inside a container.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { type ClientConfig, clientConfig, readClientConfigFile } from './client/config.ts';
import { listProjects, openProject, stopProject } from './client/open.ts';
import { localPositron } from './client/positron.ts';
import { hostOfProject } from './client/ssh.ts';
import { LocalTransport } from './client/transport.ts';
import { extendPath } from './exec.ts';
import type { Logger } from './log.ts';

let output: vscode.LogOutputChannel;
let state: vscode.Memento;

export function activate(ctx: vscode.ExtensionContext) {
  extendPath();
  output = vscode.window.createOutputChannel('Positron Projects', { log: true });
  state = ctx.globalState;
  ctx.subscriptions.push(
    output,
    command('positronProjects.open', () => open(false)),
    command('positronProjects.openUnlocked', () => open(true)),
    command('positronProjects.stop', stop),
    vscode.commands.registerCommand('positronProjects.showLog', () => output.show()),
    vscode.commands.registerCommand('positronProjects.setupWindows', () => setupWindows(ctx)),
    command('positronProjects.stopCurrent', () => stopCurrent(ctx)),
  );
  showStopButton(ctx);
  watchLocalDocker(ctx);
}

export function deactivate() {}

/** A command whose errors end up in the log and in a message with a "Show Log" button. */
function command(id: string, fn: () => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async () => {
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error).message;
      output.error(msg);
      const choice = await vscode.window.showErrorMessage(msg, 'Show Log');
      if (choice) output.show();
    }
  });
}

function config(): ClientConfig {
  return clientConfig(rawConfig());
}

/** The config file shared with the command line, overridden by whatever is set in Positron's settings. */
function rawConfig(): Record<string, unknown> {
  const s = vscode.workspace.getConfiguration('positronProjects');
  const raw: Record<string, unknown> = { ...readClientConfigFile() };
  for (const k of ['hosts', 'gitRemotes']) {
    const v = s.get<unknown[]>(k, []);
    if (v.length) raw[k] = v;
  }
  for (const k of ['defaultImage', 'sshKey', 'gitCryptKey']) {
    const v = s.get<string>(k, '');
    if (v) raw[k] = v;
  }
  // These two have real defaults, so only values the user changed override the config file
  for (const k of ['localEngine', 'wslDistro']) {
    const v = s.inspect<string>(k);
    const set = v?.workspaceValue ?? v?.globalValue;
    if (set) raw[k] = set;
  }
  const idle = s.inspect<number>('idleMinutes');
  const idleSet = idle?.workspaceValue ?? idle?.globalValue;
  if (idleSet !== undefined) raw.local = { ...(raw.local as object | undefined), idleMinutes: idleSet };
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
    { label: 'Automatic', description: `first available: ${cfg.hosts.map((h) => h.name).join(', ')}`, host: 'auto' },
    ...cfg.hosts.map((h) => ({ label: h.name, description: h.ssh ?? 'this computer', host: h.name })),
  ];
  return (await vscode.window.showQuickPick(items, { title: 'Where to run the project?' }))?.host;
}

async function open(unlock: boolean) {
  const cfg = config();
  const project = (await vscode.window.showInputBox({
    title: unlock ? 'Open project with decrypted data' : 'Open project',
    prompt: 'Repository name in Gitea, or a full git URL',
    value: state.get<string>('lastProject', ''),
    ignoreFocusOut: true,
  }))?.trim();
  if (!project) return;
  const host = await pickHost(cfg);
  if (!host) return;
  await state.update('lastProject', project);

  output.info(`--- open ${project} (host: ${host})`);
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Opening ${project}` },
    (progress) => openProject(cfg, project, { host, unlock, positron: localPositron(vscode.env.appRoot) }, progressLogger(progress)),
  );
  output.info(`Opening ${r.folder} on ${r.alias}`);
  const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${r.alias}`, path: r.folder });
  // An empty window is reused; one with a folder open stays as it is
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: !!vscode.workspace.workspaceFolders?.length });
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
  await stopProject(cfg, pick.label, pick.host, log);
  vscode.window.showInformationMessage(`${pick.label} stopped on ${pick.host}. Its files are kept.`);
}

/** Runs the one-time WSL + Docker setup (windows/setup-wsl.ps1, shipped with the extension) in a terminal. */
function setupWindows(ctx: vscode.ExtensionContext) {
  const script = vscode.Uri.joinPath(ctx.extensionUri, 'windows', 'setup-wsl.ps1').fsPath;
  const t = vscode.window.createTerminal({
    name: 'Positron Projects setup',
    shellPath: 'powershell.exe',
    shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', script],
  });
  t.show();
}

/** The project of this window, if it is connected to a project container (Remote SSH host positron-<project>). */
function currentProject(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder?.scheme !== 'vscode-remote') return undefined;
  return /^ssh-remote\+positron-(.+)$/.exec(decodeURIComponent(folder.authority))?.[1];
}

/** In a project window: "■ <project> (<host>)" in the status bar; clicking it stops the project. */
function showStopButton(ctx: vscode.ExtensionContext) {
  const project = currentProject();
  if (!project) return;
  const host = hostOfProject(config().sshDir, project) ?? 'unknown host';
  const item = vscode.window.createStatusBarItem('positronProjects.stop', vscode.StatusBarAlignment.Left, 100);
  item.name = 'Positron Projects: stop this project';
  item.text = `$(debug-stop) ${project} (${host})`;
  item.tooltip = `Stop the container of ${project} on '${host}' and close this window. Files are kept.`;
  item.command = 'positronProjects.stopCurrent';
  item.show();
  ctx.subscriptions.push(item);
}

/**
 * Stops this window's project. The container is the other end of this window's connection, so the stop runs
 * in a separate process (positron-ctl, with Positron's own Node) that outlives the window, and the window closes.
 */
async function stopCurrent(ctx: vscode.ExtensionContext) {
  const project = currentProject();
  if (!project) {
    await vscode.commands.executeCommand('positronProjects.stop');
    return;
  }
  const raw = rawConfig();
  const host = hostOfProject(clientConfig(raw).sshDir, project);
  const choice = await vscode.window.showWarningMessage(
    `Stop ${project}${host ? ` on '${host}'` : ''} and close this window?`,
    { modal: true, detail: 'Open files are saved first. The project files stay in the container; uncommitted work is kept.' },
    'Stop',
  );
  if (choice !== 'Stop') return;
  await vscode.commands.executeCommand('workbench.action.files.saveAll');

  const dir = ctx.globalStorageUri.fsPath;
  mkdirSync(dir, { recursive: true });
  const cfgFile = join(dir, 'config.json');
  writeFileSync(cfgFile, JSON.stringify(raw));
  const logFd = openSync(join(dir, 'stop.log'), 'a');
  const cli = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'positron-ctl.cjs').fsPath;
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

/**
 * Containers stop themselves when idle; then Docker on this computer (Colima, WSL) is stopped too if
 * Positron Projects started it. Checked every few minutes; never starts anything.
 */
function watchLocalDocker(ctx: vscode.ExtensionContext) {
  const check = async () => {
    try {
      const cfg = config();
      const log: Logger = { info: (m) => output.info(m), warn: (m) => output.warn(m) };
      for (const h of cfg.hosts.filter((x) => !x.ssh)) await new LocalTransport(h, cfg, log).stopEngineIfIdle();
    } catch (e) {
      output.warn(`checking local Docker: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(check, 5 * 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}
