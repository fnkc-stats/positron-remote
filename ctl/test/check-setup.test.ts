// "FNKC Projects: Check Setup" as the user sees it (extension.ts, against fake-vscode.ts): the list of problems,
// the steps before a fix runs, the fix run in Positron's terminal (or an elevated PowerShell window), and afterwards
// either "ready now" or, in plain words, why not and what to do instead. The tools are stubs on PATH, and the
// terminal's result is whatever the test says the command did.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import * as vscode from './fake-vscode.ts';
import { COPY, COPY_ADMIN, RUN, RUN_ADMIN } from '../src/client/fix.ts';

const skip = process.platform === 'win32' ? 'stub tools are shell scripts' : undefined;
const work = mkdtempSync(join(tmpdir(), 'fnkc-check-setup-'));
const UBUNTU = 'ID=ubuntu\nID_LIKE=debian\n';
const subscriptions: { dispose(): unknown }[] = [];
let ext: typeof import('../src/extension.ts');
let bin = '';
let n = 0;

type Item = { label: string; description?: string; detail?: string };
type Asked = { kind: 'info' | 'warning'; message: string; buttons: string[]; detail?: string; modal?: boolean };
let asked: Asked[] = [];
let items: Item[] = [];
let title = '';

before(async () => {
  if (skip) return;
  process.env.HOME = work;
  ext = await import('../src/extension.ts');
  const stored = new Map<string, unknown>([['setupChecked', true]]);
  ext.activate({
    subscriptions, extensionUri: vscode.Uri.file(join(__dirname, '..')),
    extension: { packageJSON: { version: '0.3.5' } }, globalStorageUri: vscode.Uri.file(join(work, 'storage')),
    globalState: { get: (k: string) => stored.get(k), update: async (k: string, v: unknown) => { stored.set(k, v); } },
  } as never);
});
after(() => { for (const d of subscriptions) d.dispose(); ext?.setFixPlatformForTests(process.platform); });

/** A fresh computer: its own home folder, and only these tools on PATH. */
beforeEach(() => {
  if (skip) return;
  vscode.ui.reset();
  asked = [];
  items = [];
  const dir = join(work, String(n++));
  bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  process.env.PATH = bin;
  process.env.HOME = join(dir, 'home');
  ext.setFixPlatformForTests('linux', UBUNTU);
  vscode.ui.settings = { gitRemotes: ['ssh://git@gitea.test:2221/stats'], mode: 'none' };
});

function tool(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** The user picks the check whose label contains `name` in the list, and answers each message with `answer`. */
function user(name: string | undefined, answer: (a: Asked) => string | undefined = () => undefined) {
  vscode.ui.quickPick = (list, opts) => {
    items = list as Item[];
    title = opts.title ?? '';
    return name === undefined ? undefined : list.find((i) => i.label.endsWith(` ${name}`));
  };
  const reply = (kind: Asked['kind']) => (message: string, buttons: string[], o?: { modal?: boolean; detail?: string }) => {
    const a = { kind, message, buttons, detail: o?.detail, modal: o?.modal };
    asked.push(a);
    return answer(a);
  };
  vscode.ui.info = reply('info');
  vscode.ui.warning = reply('warning');
}

const checkSetup = () => vscode.commands.executeCommand('fnkcProjects.checkSetup');
const noErrors = () => assert.deepEqual(vscode.ui.shown.filter((s) => s.kind === 'error'), [], 'no error message pops up');

test('nothing installed: the list shows every problem with its fix, and says which need administrator rights', { skip }, async () => {
  user(undefined);
  await checkSetup();
  noErrors();
  assert.match(title, /^\d+ problems found: select one to fix it$/);
  const failed = items.filter((i) => i.label.startsWith('$(error)'));
  assert.ok(failed.length >= 6, items.map((i) => i.label).join(', '));
  for (const i of failed) assert.ok(i.detail && i.detail.length > 10, `${i.label} has no fix`);
  const git = items.find((i) => i.label === '$(error) git')!;
  assert.match(git.detail!, /^Install git, then restart Positron — Select for the steps \(needs administrator rights\)$/);
  assert.match(items.find((i) => i.label === '$(error) SSH key')!.detail!, /Select for the steps$/);
});

test('a fix that works: the steps first, the command in the terminal, then "ready now"', { skip }, async () => {
  user('SSH key', (a) => a.buttons.includes(RUN) ? RUN : undefined);
  vscode.ui.terminal = (command) => {
    // What ssh-keygen does
    mkdirSync(join(process.env.HOME!, '.ssh'), { recursive: true });
    writeFileSync(join(process.env.HOME!, '.ssh', 'id_ed25519'), 'private');
    writeFileSync(join(process.env.HOME!, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA');
    return { exitCode: 0, output: `${command}\r\nYour identification has been saved in id_ed25519\r\n` };
  };
  await checkSetup();
  noErrors();
  const steps = asked[0];
  assert.equal(steps.modal, true);
  assert.match(steps.message, /^SSH key: Create one \(press Enter at the questions\)/);
  assert.match(steps.detail!, /^The command:\nssh-keygen -t ed25519\n\n1\. "Run It for Me" runs the command in the terminal at the bottom of Positron\./);
  assert.match(steps.detail!, /Rather do it by hand\? Ask a team member/);
  assert.doesNotMatch(steps.detail!, /password/, 'ssh-keygen needs no administrator password');
  assert.deepEqual(steps.buttons, [RUN, COPY, COPY_ADMIN]);
  assert.deepEqual(vscode.ui.terminals.map((t) => t.command), ['ssh-keygen -t ed25519']);
  assert.match(asked.at(-1)!.message, /^SSH key is ready now\. \d+ other problems are left\.$/);
});

test('an account that may not install: said plainly, and the admin gets the command and the error', { skip }, async () => {
  user('git', (a) => a.buttons.includes(RUN) ? RUN : a.kind === 'warning' ? COPY_ADMIN : undefined);
  vscode.ui.terminal = () => ({ exitCode: 1, output: '[sudo] password for alice: \r\nalice is not in the sudoers file.  This incident will be reported.\r\n' });
  await checkSetup();
  noErrors();
  assert.match(asked[0].detail!, /asks for your password: type the one you log in to this computer with \(nothing shows while you type\)/);
  assert.match(asked[0].detail!, /not in the sudoers file[\s\S]*ask your IT admin/);
  const why = asked.find((a) => a.kind === 'warning')!;
  assert.equal(why.message, 'git is still not ready. Your account is not allowed to install software or change system settings on this computer.');
  assert.match(why.detail!, /Ask your IT admin to do it for you \("Copy for the Administrator" gives them the command and this message\)\. Or do it by hand: Install git/);
  assert.deepEqual(why.buttons, ['Try Again', COPY_ADMIN]);
  assert.match(vscode.ui.clipboard, /"git" is not ready/);
  assert.match(vscode.ui.clipboard, /Command \(needs administrator rights\): sudo apt-get update && sudo apt-get install -y git/);
  assert.match(vscode.ui.clipboard, /alice is not in the sudoers file/);
  assert.match(asked.at(-1)!.message, /Copied what your IT admin needs/);
});

test('a wrong password, then Try Again: the second run fixes it', { skip }, async () => {
  let runs = 0;
  user('git', (a) => a.buttons.includes(RUN) ? RUN : a.buttons.includes('Try Again') ? 'Try Again' : undefined);
  vscode.ui.terminal = () => {
    if (runs++ === 0) return { exitCode: 1, output: 'Sorry, try again.\r\nsudo: 3 incorrect password attempts\r\n' };
    tool('git', 'echo "git version 2.47.0"');
    return { exitCode: 0, output: 'Setting up git (1:2.43.0-1ubuntu7) ...\r\n' };
  };
  await checkSetup();
  noErrors();
  assert.equal(runs, 2);
  assert.equal(asked.find((a) => a.kind === 'warning')!.message, 'git is still not ready. The password was not accepted.');
  assert.match(asked.at(-1)!.message, /^git is ready now\./);
});

test('a command that finishes but changes nothing: what to do next, not a false "ready"', { skip }, async () => {
  ext.setFixPlatformForTests('darwin');
  user('git', (a) => a.buttons.includes(RUN) ? RUN : undefined);
  vscode.ui.terminal = () => ({ exitCode: 0, output: 'xcode-select: note: install requested for command line developer tools\r\n' });
  await checkSetup();
  const why = asked.find((a) => a.kind === 'warning')!;
  assert.match(why.message, /^git is still not ready\. The command finished, but git is still not ready \(the git command was not found\)\.$/);
  assert.match(why.detail!, /If an installer window opened, finish it first/);
  assert.ok(!asked.some((a) => /ready now/.test(a.message)));
});

test('Copy Command: where to paste it, and that it asks for the password', { skip }, async () => {
  user('git', (a) => a.buttons.includes(COPY) ? COPY : undefined);
  await checkSetup();
  assert.equal(vscode.ui.clipboard, 'sudo apt-get update && sudo apt-get install -y git');
  assert.equal(vscode.ui.terminals.length, 0);
  assert.match(asked.at(-1)!.message, /^Copied the command\. Open a terminal, paste with Ctrl\+Shift\+V and press Enter\. When it asks for your password, type your login password \(nothing shows\) and press Enter\. Then run Check Setup again\.$/);
});

test('a terminal without shell integration: the command is typed in, and the user is told to check again', { skip }, async () => {
  vscode.ui.shellIntegration = false;
  user('SSH key', (a) => a.buttons.includes(RUN) ? RUN : undefined);
  await checkSetup();
  assert.deepEqual(vscode.ui.terminals.map((t) => t.command), ['ssh-keygen -t ed25519']);
  assert.match(asked.at(-1)!.message, /runs in the terminal below\. When it has finished, run Check Setup again\./);
});

test('Windows: an administrator fix opens an elevated PowerShell window; choosing No there is explained', { skip }, async () => {
  ext.setFixPlatformForTests('win32');
  // powershell.exe: the lock check passes; Start-Process -Verb RunAs is where Windows asks, and the user says No
  tool('powershell.exe', `case "$*" in *Start-Process*) echo "Start-Process : This command cannot be run due to the error: The operation was canceled by the user." >&2; exit 1;; esac; exit 0`);
  user('ssh-agent', (a) => a.buttons.includes(RUN_ADMIN) ? RUN_ADMIN : undefined);
  await checkSetup();
  noErrors();
  const steps = asked[0];
  assert.deepEqual(steps.buttons, [RUN_ADMIN, COPY, COPY_ADMIN]);
  assert.match(steps.detail!, /Add-WindowsCapability -Online -Name OpenSSH\.Client/);
  assert.match(steps.detail!, /Windows asks whether to allow it to make changes: choose Yes/);
  assert.equal(vscode.ui.terminals.length, 0, 'not in the unelevated terminal');
  const why = asked.find((a) => a.kind === 'warning')!;
  assert.equal(why.message, 'ssh-agent is still not ready. You chose No when Windows asked for permission, so nothing was changed.');
  assert.match(why.detail!, /choose Yes, or ask your IT admin/);
});

test('Windows: the elevated window fixes it', { skip }, async () => {
  ext.setFixPlatformForTests('win32');
  // As if the elevated window ran Add-WindowsCapability: ssh-add exists afterwards
  tool('powershell.exe', `case "$*" in *Start-Process*) printf '#!/bin/sh\\necho "256 SHA256:abc key (ED25519)"\\n' > ${JSON.stringify(join(bin, 'ssh-add'))}; /bin/chmod +x ${JSON.stringify(join(bin, 'ssh-add'))};; esac; exit 0`);
  user('ssh-agent', (a) => a.buttons.includes(RUN_ADMIN) ? RUN_ADMIN : undefined);
  await checkSetup();
  noErrors();
  assert.match(asked.at(-1)!.message, /^ssh-agent is ready now\./);
});

test('Windows: a fix without administrator rights runs in a PowerShell terminal', { skip }, async () => {
  ext.setFixPlatformForTests('win32');
  user('git', (a) => a.buttons.includes(RUN) ? RUN : undefined);
  vscode.ui.terminal = () => ({ exitCode: 1, output: "winget : The term 'winget' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n" });
  await checkSetup();
  assert.deepEqual(vscode.ui.terminals, [{ command: 'winget install --id Git.Git -e', options: { name: 'FNKC: git', shellPath: 'powershell.exe' } }]);
  assert.match(asked[0].detail!, /An installer may ask to make changes: choose Yes/);
  const why = asked.find((a) => a.kind === 'warning')!;
  assert.match(why.message, /A program the command needs is not installed: winget\./);
  assert.match(why.detail!, /Or do it by hand: Download Git for Windows from git-scm\.com/);
});

test('a problem without a command: the fix and what was found, nothing to run', { skip }, async () => {
  vscode.ui.settings = { hosts: [{ name: 'local' }], mode: 'none' };
  user('Gitea');
  await checkSetup();
  assert.equal(asked[0].message, 'Gitea: Set FNKC Projects -> Git Remotes, e.g. ssh://git@gitea.example.lan:2221/stats');
  assert.deepEqual(asked[0].buttons, []);
  assert.equal(vscode.ui.terminals.length, 0);
});

test('a broken setting is one of the problems, not an error that hides the others', { skip }, async () => {
  vscode.ui.settings = { hosts: [{ name: 'not valid!' }], mode: 'none' };
  user(undefined);
  await checkSetup();
  noErrors();
  const s = items.find((i) => i.label === '$(error) Configuration')!;
  assert.match(s.description!, /invalid host name "not valid!"/);
  assert.match(s.detail!, /Correct it in Settings \(search for FNKC Projects\)/);
  // The Projects panel: nothing listed, the error said above its welcome text
  assert.equal(vscode.ui.context['fnkcProjects.setup'], 'error');
  assert.match(vscode.trees.get('fnkcProjects.list')!.view.message!, /^The configuration has an error: invalid host name/);
});

const panel = () => vscode.trees.get('fnkcProjects.list')!.provider as { getChildren(): Promise<unknown[]> };
const SERVER_CONFIG = { hosts: [{ name: 'stats', ssh: 'fnkc@stats.test' }], gitRemotes: ['ssh://git@gitea.test:2221/stats'] };

/** The config file where the extension looks for it (in this test's home folder), and the file the user picks in Import Configuration. */
async function withConfigFile(fn: (to: string, pick: (content: string) => string) => Promise<void>) {
  const dir = join(work, `config-${n++}`);
  mkdirSync(dir, { recursive: true });
  assert.ok(process.env.HOME!.startsWith(work), 'never the real home folder');
  const to = join(process.env.HOME!, '.config', 'fnkc-ctl', 'config.json');
  let picks = 0;
  try {
    await fn(to, (content) => {
      const from = join(dir, `picked-${picks++}.json`);
      writeFileSync(from, content);
      vscode.ui.openDialog = () => from;
      return from;
    });
  } finally {
    rmSync(join(to, '..'), { recursive: true, force: true });
  }
}

test('no configuration: the panel lists nothing (its welcome says to import one), and Check Setup offers the import', { skip }, async () => {
  vscode.ui.settings = { mode: 'none' };
  assert.deepEqual(await panel().getChildren(), [], 'no phantom "local" host');
  await withConfigFile(async (to, pick) => {
    pick(JSON.stringify(SERVER_CONFIG));
    user('Configuration');
    await checkSetup();
    const c = items.find((i) => i.label === '$(error) Configuration')!;
    assert.equal(c.description, 'no configuration yet: no server is configured');
    assert.ok(!items.some((i) => /Docker on this computer|Gitea$/.test(i.label)), items.map((i) => i.label).join(', '));
    // Selecting the row is the import itself
    assert.deepEqual(JSON.parse(readFileSync(to, 'utf8')), SERVER_CONFIG);
    assert.equal(vscode.ui.context['fnkcProjects.setup'], 'ok');
    assert.match(asked.at(-1)!.message, /^The configuration is in .*config\.json\. Check the setup now\?$/);
    assert.equal((await panel().getChildren()).length, 1);
  });
});

test('Import Configuration: a broken file is refused with the reason; a different one replaces the old, kept as .bak', { skip }, async () => {
  vscode.ui.settings = { mode: 'none' };
  user(undefined, (a) => a.buttons.includes('Replace') ? 'Replace' : undefined);
  await withConfigFile(async (to, pick) => {
    pick('{ "hosts": [ }');
    await vscode.commands.executeCommand('fnkcProjects.importConfig');
    assert.match(vscode.ui.shown.at(-1)!.message, /^picked-0\.json was not imported: it is not valid JSON .*Ask your administrator for a corrected file\.$/);
    pick(JSON.stringify({ hosts: [{ name: 'bad name' }] }));
    await vscode.commands.executeCommand('fnkcProjects.importConfig');
    assert.match(vscode.ui.shown.at(-1)!.message, /^picked-1\.json was not imported: invalid host name "bad name"/);
    assert.equal(existsSync(to), false, 'nothing written');

    mkdirSync(join(to, '..'), { recursive: true });
    writeFileSync(to, '{"hosts":[{"name":"old","ssh":"fnkc@old.test"}]}');
    pick(JSON.stringify(SERVER_CONFIG));
    await vscode.commands.executeCommand('fnkcProjects.importConfig');
    assert.deepEqual(JSON.parse(readFileSync(to, 'utf8')), SERVER_CONFIG);
    assert.equal(readFileSync(`${to}.bak`, 'utf8'), '{"hosts":[{"name":"old","ssh":"fnkc@old.test"}]}');
    assert.match(asked.at(-1)!.message, /The previous one is in config\.json\.bak\./);

    // A file without a server is imported only when the user says so
    pick(JSON.stringify({ hosts: [{ name: 'local' }] }));
    await vscode.commands.executeCommand('fnkcProjects.importConfig');
    assert.match(asked.at(-1)!.message, /names no server/);
    assert.deepEqual(JSON.parse(readFileSync(to, 'utf8')), SERVER_CONFIG, 'not imported without Import Anyway');
  });
});

test('first-run check: repeats until a run passes, reminds at most once a day, and stops on Don\'t Remind Me', { skip }, async () => {
  const stored = new Map<string, unknown>();
  const ctx = { globalState: { get: (k: string) => stored.get(k), update: async (k: string, v: unknown) => { stored.set(k, v); } } } as never;
  vscode.ui.settings = { mode: 'none' };
  user(undefined);
  await ext.firstRunCheckForTests(ctx);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, 'FNKC Projects is not set up yet: get config.json from your administrator, then import it.');
  assert.deepEqual(asked[0].buttons, ['Import Configuration…', 'Check Setup', "Don't Remind Me"]);
  assert.equal(stored.get('setupChecked'), undefined, 'a failed run is not the end of it');

  await ext.firstRunCheckForTests(ctx);
  assert.equal(asked.length, 1, 'not again the same day');

  stored.set('setupRemindedAt', Date.now() - 25 * 3600_000);
  user(undefined, (a) => a.buttons.includes("Don't Remind Me") ? "Don't Remind Me" : undefined);
  await ext.firstRunCheckForTests(ctx);
  assert.equal(asked.length, 2, 'a day later it reminds again');
  assert.equal(stored.get('setupChecked'), true);
  await ext.firstRunCheckForTests(ctx);
  assert.equal(asked.length, 2, 'and after Don\'t Remind Me never again');
});

test('Positron updates: selecting the problem turns them off', { skip }, async () => {
  vscode.ui.settings = { gitRemotes: [], mode: 'default' };
  user('Positron updates');
  await checkSetup();
  assert.equal(vscode.ui.settings.mode, 'none');
});
