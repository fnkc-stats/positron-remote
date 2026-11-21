// The extension's commands, run against the stand-in vscode module (fake-vscode.ts): what is registered matches
// package.json, and Build Environment works from the menus to container.json, with a fake gh command and registry.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, test } from 'node:test';
import * as vscode from './fake-vscode.ts';

const ROOT = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'fnkc-ext-'));
const ghLog = join(work, 'gh.log');
const pathWithGh = `${join(work, 'bin')}${delimiter}${process.env.PATH}`;
const INDEX = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }));
const DIGEST = `sha256:${createHash('sha256').update(INDEX).digest('hex')}`;
const fetched: string[] = [];
/** The extension's newest GitHub release (extension.yml), served by the fetch stub; undefined: none. */
let release: { version: string; vsix: Buffer; sum?: string } | undefined;
const RELEASES = 'https://api.github.com/repos/fnkc-stats/positron-remote/releases/latest';

// gh as the build needs it: the repository's series and team Positron, Positron releases, a dispatched run
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), j = a.join(' '), state = ${JSON.stringify(join(work, 'request'))};
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(a) + '\\n');
const out = (s) => process.stdout.write(s);
if (a[0] === 'api' && j.includes('contents/env/versions')) out('4.2\\n4.5\\n4.6\\n');
else if (a[0] === 'api' && j.includes('contents/env/positron.args')) out('POSITRON_VERSION=2026.11.1-4\\nPOSITRON_COMMIT=e915\\n');
else if (a[0] === 'api' && j.includes('posit-dev/positron/releases')) out('2026.11.1-4\\n2026.07.1-5\\n2026.06.1-6\\n');
else if (a[0] === 'workflow' && a[1] === 'run') fs.writeFileSync(state, a.find((x) => x.startsWith('request=')).slice(8));
else if (a[0] === 'run' && a[1] === 'list') out(JSON.stringify([{ databaseId: 99, url: 'https://github.test/runs/99',
  displayTitle: 'positron image 2026.07.1-5 [' + fs.readFileSync(state, 'utf8') + ']' }]));
else if (a[0] === 'run' && a[1] === 'view') out(JSON.stringify({ status: 'completed', conclusion: 'success', url: 'https://github.test/runs/99', jobs: [] }));
else { process.stderr.write('unexpected gh call: ' + j); process.exit(1); }
`;

let ext: typeof import('../src/extension.ts');
const subscriptions: { dispose(): unknown }[] = [];

before(async () => {
  // HOME first: the client config path is fixed when the module loads
  process.env.HOME = work;
  process.env.USERPROFILE = work;
  mkdirSync(join(work, 'bin'));
  writeFileSync(join(work, 'bin', 'gh'), FAKE_GH);
  chmodSync(join(work, 'bin', 'gh'), 0o755);
  const app = join(work, 'positron');
  mkdirSync(app);
  writeFileSync(join(app, 'product.json'), JSON.stringify({ positronVersion: '2026.07.1', positronBuildNumber: 5, commit: 'd3cd' }));
  vscode.env.appRoot = app;
  globalThis.fetch = (async (url: string | URL) => {
    fetched.push(String(url));
    if (/\/v2\/fnkc-stats\/r-env\/tags\/list/.test(String(url))) {
      return new Response(JSON.stringify({ tags: [`4.6-env-${'a'.repeat(40)}-20-1`, `4.6-env-${'a'.repeat(40)}-10-1`, `4.5-env-${'a'.repeat(40)}-20-1`] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/v2\/fnkc-stats\/r-env\/manifests\//.test(String(url))) {
      return new Response(INDEX, { status: 200, headers: { 'content-type': 'application/vnd.oci.image.index.v1+json' } });
    }
    if (String(url) === RELEASES && release) {
      return Response.json({ tag_name: `fnkc-projects-v${release.version}`, html_url: 'https://github.test/release', assets: [
        { name: 'fnkc-projects.vsix', browser_download_url: 'https://github.test/dl/fnkc-projects.vsix' },
        { name: 'fnkc-projects.vsix.sha256', browser_download_url: 'https://github.test/dl/fnkc-projects.vsix.sha256' }] });
    }
    if (String(url) === 'https://github.test/dl/fnkc-projects.vsix' && release) return new Response(release.vsix);
    if (String(url) === 'https://github.test/dl/fnkc-projects.vsix.sha256' && release) {
      return new Response(`${release.sum ?? createHash('sha256').update(release.vsix).digest('hex')}  fnkc-projects.vsix\n`);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  ext = await import('../src/extension.ts');
  const stored = new Map<string, unknown>([['setupChecked', true]]);
  ext.activate({
    subscriptions, extensionUri: vscode.Uri.file(join(ROOT)),
    extension: { packageJSON: { version: '0.3.5' } }, globalStorageUri: vscode.Uri.file(join(work, 'storage')),
    globalState: { get: (k: string) => stored.get(k), update: async (k: string, v: unknown) => { stored.set(k, v); } },
  } as never);
});

// As when Positron unloads the extension: the projects panel's refresh timer would keep the test running
after(() => { for (const d of subscriptions) d.dispose(); });

test('the extension registers exactly the commands package.json contributes', () => {
  const contributed = (manifest.contributes.commands as { command: string }[]).map((c) => c.command).sort();
  assert.deepEqual(vscode.commands.registered().sort(), contributed);
  const menus = Object.values(manifest.contributes.menus as Record<string, { command?: string }[]>).flat();
  for (const m of menus) if (m.command) assert.ok(contributed.includes(m.command), `menu refers to unknown command ${m.command}`);
});

test('every setting the extension reads is declared in package.json', () => {
  const src = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
  const keys = /for \(const k of \[([^\]]+)\]\)/.exec(src)![1].match(/'([^']+)'/g)!.map((k) => k.slice(1, -1));
  const declared = Object.keys(manifest.contributes.configuration.properties ?? manifest.contributes.configuration[0].properties);
  for (const k of [...keys, 'idleMinutes']) assert.ok(declared.includes(`fnkcProjects.${k}`), `setting fnkcProjects.${k} is not declared`);
});

test('Build Environment: an environment and a Positron release, a dispatched run, the published image found by its tag', async () => {
  vscode.ui.reset();
  process.env.PATH = pathWithGh;
  writeFileSync(ghLog, '');
  const own = `ghcr.io/fnkc-stats/r-env@sha256:${'c'.repeat(64)}`;
  const project = join(work, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'container.json'), JSON.stringify({ image: own }));
  vscode.ui.workspaceFolders = [{ uri: vscode.Uri.file(project), name: 'project', index: 0 }];
  const asked: { title?: string; labels: string[]; descriptions: (string | undefined)[] }[] = [];
  vscode.ui.quickPick = (items, opts) => {
    asked.push({ title: opts.title, labels: items.map((i) => i.label), descriptions: items.map((i) => i.description) });
    return items.find((i) => i.label === (asked.length === 1 ? 'R 4.6' : '2026.07.1-5'));
  };

  await vscode.commands.executeCommand('fnkcProjects.buildEnvironment');

  assert.deepEqual(vscode.ui.shown.filter((s) => s.kind === 'error'), []);
  assert.deepEqual(asked[0].labels, ["This project's environment", 'R 4.6', 'R 4.5'], "the open project's, then the newest of each series");
  assert.equal(asked[0].descriptions[0], own);
  assert.equal(asked[1].labels[0], '2026.07.1-5', 'this Positron first');
  assert.equal(asked[1].descriptions[0], 'this Positron');
  assert.equal(asked[1].descriptions[asked[1].labels.indexOf('2026.11.1-4')], "the team's");
  const calls = readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  const dispatch = calls.find((c) => c[0] === 'workflow')!;
  assert.deepEqual(dispatch.slice(0, 7), ['workflow', 'run', 'positron.yml', '-R', 'fnkc-stats/positron-remote', '--ref', 'main']);
  assert.ok(dispatch.includes(`base=ghcr.io/fnkc-stats/r-env@${DIGEST}`) && dispatch.includes('positron=2026.07.1-5'), dispatch.join(' '));
  assert.ok(fetched.some((u) => u.endsWith(`/manifests/4.6-env-${'a'.repeat(40)}-20-1`)), 'the newest 4.6 environment');
  assert.ok(fetched.some((u) => u.endsWith(`/manifests/positron-2026.07.1-5-${DIGEST.slice(7)}`)), `registry asked for: ${fetched.join(', ')}`);
  assert.ok(vscode.ui.shown.some((s) => s.message === 'Built: projects on this environment now open from Positron 2026.07.1-5.'));
  assert.equal(readFileSync(join(project, 'container.json'), 'utf8'), JSON.stringify({ image: own }), 'nothing is pinned');
});

test("Build Environment for the open project's environment", async () => {
  vscode.ui.reset();
  process.env.PATH = pathWithGh;
  writeFileSync(ghLog, '');
  const own = `ghcr.io/fnkc-stats/r-env@sha256:${'c'.repeat(64)}`;
  vscode.ui.workspaceFolders = [{ uri: vscode.Uri.file(join(work, 'project')), name: 'project', index: 0 }];
  let n = 0;
  vscode.ui.quickPick = (items) => items[n++ === 0 ? 0 : items.findIndex((i) => i.label === '2026.07.1-5')];
  await vscode.commands.executeCommand('fnkcProjects.buildEnvironment');
  const dispatch = readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).find((c) => c[0] === 'workflow')!;
  assert.ok(dispatch.includes(`base=${own}`), dispatch.join(' '));
});

test('Build Environment: cancelling the series question starts nothing', async () => {
  vscode.ui.reset();
  process.env.PATH = pathWithGh;
  writeFileSync(ghLog, '');
  vscode.ui.quickPick = () => undefined;
  await vscode.commands.executeCommand('fnkcProjects.buildEnvironment');
  assert.ok(!readFileSync(ghLog, 'utf8').includes('"workflow"'));
});

test('Build Environment without gh says what to install', async () => {
  vscode.ui.reset();
  const empty = join(work, 'empty');
  mkdirSync(empty, { recursive: true });
  process.env.PATH = empty;
  await vscode.commands.executeCommand('fnkcProjects.buildEnvironment');
  process.env.PATH = pathWithGh;
  const error = vscode.ui.shown.find((s) => s.kind === 'error');
  assert.ok(error && /gh command is needed/.test(error.message), JSON.stringify(vscode.ui.shown));
});

test('Environment Images with no registry, Gitea or host: every line says what is missing, nothing pops up', async () => {
  vscode.ui.reset();
  // Nothing listens on port 9 of this computer: the server is unreachable at once
  vscode.ui.settings.hosts = [{ name: 'server', ssh: 'fnkc@127.0.0.1:9' }];
  // A registry that has nothing (the other tests' stub serves tags)
  const served = globalThis.fetch;
  globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  await vscode.commands.executeCommand('fnkcProjects.images.refresh');
  const { provider, view } = vscode.trees.get('fnkcProjects.images')!;
  const tree = provider as import('../src/images-view.ts').ImagesTree;
  const lines = await Promise.all((await tree.getChildren()).map(async (i) => {
    const t = tree.getTreeItem(i) as unknown as { label: string; description?: string; tooltip?: string };
    return { label: t.label, description: t.description, tooltip: String(t.tooltip), children: (await tree.getChildren(i)).length };
  }));
  assert.deepEqual(lines.map((l) => [l.label, l.description, l.children]), [['Published', 'registry unreachable', 0], ['server', 'unreachable', 0]]);
  assert.match(lines[0].tooltip, /^cannot read ghcr\.io\/fnkc-stats\/r-env: registry: HTTP 404/);
  assert.match(lines[1].tooltip, /^host 'server' \(fnkc@127\.0\.0\.1:9\): /);
  assert.equal(view.badge, undefined);
  assert.deepEqual(vscode.ui.shown, []);
  globalThis.fetch = served;
});

test('Copy Pin and Pin Here from the Environment Images panel', async () => {
  vscode.ui.reset();
  const image = `ghcr.io/fnkc-stats/r-env@sha256:${'c'.repeat(64)}`;
  const row = { tag: 't', reference: image, digest: `sha256:${'c'.repeat(64)}`, variant: '4.6', architectures: [], labels: {} };
  await vscode.commands.executeCommand('fnkcProjects.images.copyPin', { kind: 'image', row, group: { rows: [row] } });
  assert.equal(vscode.ui.clipboard, image);
  const project = join(work, 'pin-here');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'container.json'), JSON.stringify({ image: 'old' }));
  vscode.ui.workspaceFolders = [{ uri: vscode.Uri.file(project), name: 'p', index: 0 }];
  await vscode.commands.executeCommand('fnkcProjects.images.pinHere', { kind: 'image', row, group: { rows: [row] } });
  assert.equal(JSON.parse(readFileSync(join(project, 'container.json'), 'utf8')).image, image);
  assert.deepEqual(vscode.ui.shown.filter((s) => s.kind === 'error'), []);
});

test('Check for Updates: a newer release is downloaded, checked against its checksum and installed', async () => {
  vscode.ui.reset();
  release = { version: '0.3.12', vsix: Buffer.from('a vsix') };
  vscode.ui.info = (m, buttons) => (/0\.3\.12 is available \(you have 0\.3\.5\)/.test(m) ? 'Update' : buttons.includes('Reload Window') ? 'Reload Window' : undefined);
  await vscode.commands.executeCommand('fnkcProjects.checkForUpdates');
  const install = vscode.ui.ran.find((r) => r.id === 'workbench.extensions.installExtension');
  assert.ok(install, JSON.stringify(vscode.ui.shown));
  const file = (install.args[0] as vscode.Uri).fsPath;
  assert.equal(readFileSync(file, 'utf8'), 'a vsix');
  assert.ok(vscode.ui.ran.some((r) => r.id === 'workbench.action.reloadWindow'));
});

test('Check for Updates: a download that does not match its checksum is not installed', async () => {
  vscode.ui.reset();
  release = { version: '0.3.13', vsix: Buffer.from('tampered'), sum: 'f'.repeat(64) };
  vscode.ui.info = () => 'Update';
  await vscode.commands.executeCommand('fnkcProjects.checkForUpdates');
  assert.equal(vscode.ui.ran.length, 0);
  assert.ok(vscode.ui.shown.some((s) => s.kind === 'error' && /does not match its checksum/.test(s.message)), JSON.stringify(vscode.ui.shown));
});

test('Check for Updates: the installed version is the newest, or there is no release', async () => {
  for (const r of [{ version: '0.3.5', vsix: Buffer.from('') }, undefined]) {
    vscode.ui.reset();
    release = r;
    await vscode.commands.executeCommand('fnkcProjects.checkForUpdates');
    assert.equal(vscode.ui.ran.length, 0);
    assert.ok(vscode.ui.shown.some((s) => /0\.3\.5 is the newest version/.test(s.message)), JSON.stringify(vscode.ui.shown));
  }
});

test('error messages offer the action that helps with them', async () => {
  const { errorActions } = await import('../src/extension.ts');
  const { hostError, LockBusy } = await import('../src/errors.ts');
  const { ProjectUnreachable } = await import('../src/client/project.ts');
  const labels = (e: Error) => errorActions(e, async () => {}).map((a) => a.label);
  // By the code the host sends, whatever the wording
  assert.deepEqual(labels(hostError("host 'srv': reworded", 'quota')), ['Stop a Project']);
  assert.deepEqual(labels(hostError("host 'srv': reworded", 'capacity')), ['Copy for the Administrator']);
  assert.deepEqual(labels(new LockBusy('operation is busy; timed out waiting for lock')), ['Retry']);
  // A host from before codes: by its wording
  assert.deepEqual(labels(hostError("host 'srv': concurrent project quota reached (2): stop another project (running: a, b)")), ['Stop a Project']);
  assert.deepEqual(labels(hostError("host 'srv': operation is busy; timed out waiting for /x")), ['Retry']);
  // A code this client does not know, and a plain error
  assert.deepEqual(labels(hostError("host 'srv': concurrent project quota reached", 'future-code')), ['Check Setup']);
  assert.deepEqual(labels(new Error('no SSH key found: create one with ssh-keygen')), ['Check Setup']);
  assert.deepEqual(labels(new ProjectUnreachable('Gitea has no repository stats/thesiss that you can read. Check the name', [])), ['Open Project…', 'Check Setup']);
  // Failures on the server without a code yet: Check Setup on this computer would find nothing
  for (const m of ['container failed to start: exited 1; inspect its logs', 'container host key was not initialized',
    'could not log in to the project container: it started but does not accept SSH connections',
    'multiple recovery containers; operator inspection required']) {
    assert.deepEqual(labels(new Error(m)), ['Copy for the Administrator'], m);
  }
  assert.deepEqual(labels(new Error('a recovery container fnkc-x exists; reopen the project to recover it before removal')), ['Check Setup']);
});

test('an Open with warnings sums them up in one line', () => {
  assert.equal(ext.warningSummary('thesis', []), undefined);
  assert.equal(ext.warningSummary('thesis', ['a', 'a']), 'thesis opened with a warning: a');
  assert.equal(ext.warningSummary('thesis', ['a', 'b', 'c']), 'thesis opened with warnings: a (+2 more in the log)');
});
