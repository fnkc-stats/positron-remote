// Positron extension: the same open / stop as positron-ctl, with a progress notification and the project
// window opened at the end. Runs on the user's computer (extensionKind "ui"), never inside a container.
import * as vscode from 'vscode';
import { type ClientConfig, clientConfig, readClientConfigFile } from './client/config.ts';
import { listProjects, openProject, stopProject } from './client/open.ts';
import { localPositron } from './client/positron.ts';
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
  );
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

/** The config file shared with the command line, overridden by whatever is set in Positron's settings. */
function config(): ClientConfig {
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
  return clientConfig(raw);
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
