import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, outsideProject, parseRemovalOutput } from '../src/agent.ts';
import { REMOVAL_SCRIPT } from '../src/removal-inspection.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { agentConfig } from '../src/agent-config.ts';
import { Docker, type ContainerJson } from '../src/docker.ts';
import { LABEL, legacySshAlias, projectNames, sshAlias } from '../src/layout.ts';
import type { RemovalCheck } from '../src/protocol.ts';
import { deletedObjects, lostWork, removalReport, tagNote } from '../src/client/remove.ts';
import { addSshInclude, INCLUDE_MARKER, pruneSshConfig, removeProjectSshEntries, removeSshConfig, removeSshSetup, sshIncludePresent, withSshEntries, writeSshConfig } from '../src/client/ssh.ts';
import type { RunOptions } from '../src/exec.ts';

const project = 'study';
const names = projectNames('alice', project);
const ext = `fnkc-ext-alice-${project}-arm64-${'d'.repeat(12)}`;

/** Git's answer for a checkout with everything pushed; tests change it. */
const synced = ['@@fnkc:content', 'a'.repeat(64), '@@fnkc:sizes', '536\t/work', '2116\t/v/' + names.dataVolume, '@@fnkc:branch', 'main', '@@fnkc:remotes', 'x',
  '@@fnkc:unpushed', '0', '@@fnkc:stash', '@@fnkc:status', '!! renv/library/', ''].join('\n');

class FakeDocker extends Docker {
  calls: string[][] = [];
  c: ContainerJson | null = {
    Name: `/${names.container}`, Image: 'sha256:' + 'e'.repeat(64),
    Config: { Image: 'img', Env: [], Labels: { [LABEL.managed]: '1', [LABEL.user]: 'alice', [LABEL.project]: project } },
    State: { Running: false, Status: 'exited' }, NetworkSettings: { Ports: null },
  };
  volumes = [names.projectVolume, names.dataVolume, names.libraryVolume, ext,
    // Not this project's: another user, and a project whose name starts the same
    'fnkc-bob-study-project', 'fnkc-alice-study2-project', `fnkc-ext-alice-study-x-arm64-${'d'.repeat(12)}`];
  out = synced;
  /** The docker CLI of the removal check fails (timeout, output limit): the helper may still run. */
  runThrows?: string;
  rmError = 'Error response from daemon: No such container: x';
  diff = 'C /home\nC /home/analyst\nA /home/analyst/.cache/x\n';
  override async container(name: string) { return name === names.container ? this.c : null; }
  override async run(args: string[], _opts?: RunOptions) {
    this.calls.push(args);
    if (args[0] === 'network') return { code: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'run' && this.runThrows) throw new Error(this.runThrows);
    if (args[0] === 'run') return { code: 0, stdout: this.out, stderr: '' };
    if (args[0] === 'rm') return { code: 1, stdout: '', stderr: this.rmError };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  }
  override async ok(args: string[], _opts?: RunOptions) {
    this.calls.push(args);
    if (args[0] === 'volume' && args[1] === 'ls') return this.volumes.join('\n');
    if (args[0] === 'diff') return this.diff;
    if (args[0] === 'cp') return 'b'.repeat(64);
    return '';
  }
}

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-remove-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = new FakeDocker();
  const warnings: string[] = [];
  return { docker, warnings, agent: new Agent(agentConfig('alice', { lockDir: dir, skipExtensions: [] }), { info() {}, warn(m: string) { warnings.push(m); } }, docker) };
}

test('remove-check: only this project\'s volumes, read-only, without network; sizes; nothing lost', async (t) => {
  const { docker, agent } = fixture(t);
  const c = await agent.removalCheck(project);
  assert.deepEqual(c.volumes.map((v) => v.name), [names.dataVolume, names.libraryVolume, names.projectVolume, ext]);
  assert.equal(c.volumes.find((v) => v.name === names.projectVolume)?.kib, 536);
  assert.equal(c.network, `${names.container}-net`);
  const run = docker.calls.find((a) => a[0] === 'run')!;
  assert.ok(run.includes('none') && run.includes(`${names.projectVolume}:/work:ro`) && run.includes(`${ext}:/v/${ext}:ro`));
  assert.ok(!run.some((a) => a.startsWith('fnkc-bob') || a.includes('study2')), 'other projects are never mounted');
  assert.deepEqual(lostWork(c), []);
  assert.deepEqual(c.git?.regenerable, ['renv/library/']);
  assert.deepEqual(c.outside, [], 'caches in the home are not work');
  const report = removalReport(c, 'local');
  assert.match(report, /No work that is not on Gitea was found\.\*\* The checkout in ~\/study \(branch main\) has nothing uncommitted/);
  assert.match(report, /the container’s home holds only files that tools create by themselves/);
  assert.ok(!/all of the local work/i.test(report), 'no claim beyond what was checked');
  for (const v of c.volumes) assert.ok(report.includes(`volume ${v.name}`), `the report names ${v.name}`);
});

test('remove-check: a running project is refused; so is a host without it', async (t) => {
  const { docker, agent } = fixture(t);
  docker.c!.State = { Running: true, Status: 'running' };
  await assert.rejects(agent.removalCheck(project), /running: stop it first/);
  docker.c = null; docker.volumes = [];
  await assert.rejects(agent.removalCheck(project), /no project study/);
});

test('remove-check without a container reads the volumes only with an image whose pin this host trusts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-remove-image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = 'ghcr.io/fnkc-stats/r-env';
  const tag = `${repo}:sha256-${'a'.repeat(64)}`;
  const uploaded = `sha256:${'1'.repeat(64)}`;
  const docker = new FakeDocker();
  docker.c = null;
  // The only environment image is an uploaded tag: Docker does not know it by its digest
  docker.images = async () => [{ Id: uploaded, Architecture: 'amd64', RepoTags: [tag], Created: '2026-06-01T00:00:00Z' }];
  docker.image = async (ref: string) => (ref === tag || ref === uploaded ? { Id: uploaded, Architecture: 'amd64', RepoTags: [tag] } : null);
  const staging = join(dir, 'staging');
  const agent = new Agent(agentConfig('alice', { lockDir: dir, skipExtensions: [], allowedImages: [repo], imageStagingDir: staging }), { info() {}, warn() {} }, docker);
  const record = join(staging, 'loaded', 'a'.repeat(64));
  mkdirSync(join(staging, 'loaded'), { recursive: true });
  // No record of its upload, or a record of another image (the tag was moved): never run over the user's volumes
  for (const recorded of [undefined, `sha256:${'9'.repeat(64)}`]) {
    if (recorded) writeFileSync(record, `${recorded}\n`);
    docker.calls = [];
    await assert.rejects(agent.removalCheck(project), /cannot fingerprint all project volumes/);
    assert.ok(!docker.calls.some((a) => a[0] === 'run'), `no helper runs from the ${recorded ? 'moved' : 'unrecorded'} tag`);
  }
  writeFileSync(record, `${uploaded}\n`);
  docker.calls = [];
  await agent.removalCheck(project);
  const run = docker.calls.find((a) => a[0] === 'run')!;
  assert.equal(run[run.indexOf('-c') - 1], uploaded, 'the recorded image ID');
});

test('remove deletes the container, then the volumes and the network, only as checked', async (t) => {
  const { docker, agent } = fixture(t);
  const c = await agent.removalCheck(project);
  docker.out = synced.replace('@@fnkc:stash', '@@fnkc:stash\nstash@{0}: WIP on main');
  await assert.rejects(agent.remove(project, c.fingerprint), /changed since it was checked/);
  assert.ok(!docker.calls.some((a) => a[0] === 'rm' || (a[0] === 'volume' && a[1] === 'rm')), 'nothing is deleted');
  docker.out = synced;
  const { removed } = await agent.remove(project, c.fingerprint);
  assert.deepEqual(removed, [names.container, ...c.volumes.map((v) => v.name), `${names.container}-net`]);
  const rm = docker.calls.filter((a) => a[0] === 'rm' || a[1] === 'rm');
  assert.deepEqual(rm[0], ['rm', names.container], 'without -f: Docker refuses a running container');
  assert.ok(rm.every((a) => !a.includes('-f') && !a.includes('--force')));
  assert.ok(docker.calls.filter((a) => a[0] === 'run').at(-1)!.includes('SIZES=0'), 'the check under the lock does not measure sizes');
});

test('work that is not on Gitea is listed file by file', () => {
  const out = ['@@fnkc:branch', '', '@@fnkc:remotes', '', '@@fnkc:unpushed', '3', 'abc1234 Fit the model', 'def5678 Draft',
    '@@fnkc:stash', 'stash@{0}: WIP on main: abc1234', '@@fnkc:status', ' M analysis.R', 'MM report.qmd', 'R  old.R -> new.R',
    'UU merge.R', '?? notes/', '?? scratch.R', '!! data/raw.csv', '!! results/', '!! .Rproj.user/', '!! renv/staging/'].join('\n');
  const { git } = parseRemovalOutput(out);
  assert.equal(git?.noRemoteRefs, true);
  assert.equal(git?.unpushedCount, 3);
  assert.deepEqual(git?.untracked, ['notes/', 'scratch.R']);
  assert.deepEqual(git?.ignored, ['data/raw.csv', 'results/']);
  assert.deepEqual(git?.regenerable, ['.Rproj.user/', 'renv/staging/']);
  const c: RemovalCheck = { project, container: names.container, volumes: [{ name: names.projectVolume, kib: 3 * 1024 ** 2, holds: 'the project folder' }],
    git, outside: ['thesis.docx', 'downloads/'], fingerprint: 'f' };
  const report = removalReport(c, 'server');
  for (const s of ['~/study/analysis.R', '~/study/report.qmd  (modified, staged; modified)', 'merge conflict', '~/study/notes/', '~/study/data/raw.csv',
    '~/study/results/', '~/thesis.docx', '~/downloads/', 'abc1234 Fit the model', '… and 1 more', 'stash@{0}', `volume ${names.projectVolume} (3.0 GB)`]) {
    assert.ok(report.includes(s), `report lists ${s}`);
  }
  assert.ok(!report.includes('synced'));
  assert.equal(lostWork(c).length, 6);
  assert.match(lostWork(c)[0], /3 commits not pushed.*never seen Gitea/);
  assert.deepEqual(deletedObjects(c), [`container ${names.container}`, `volume ${names.projectVolume} (3.0 GB): the project folder`]);
});

test('editor, IDE and system files are not counted as work, at any depth, unless git tracks them', () => {
  const out = ['@@fnkc:branch', 'main', '@@fnkc:remotes', 'x', '@@fnkc:unpushed', '0', '@@fnkc:stash', '@@fnkc:status',
    '?? .vscode/', ' M .positron/settings.json', '?? .Rhistory', '?? data/.DS_Store', '!! scripts/__pycache__/', '?? study.code-workspace',
    '?? ._report.qmd', 'R  .vscode/a.json -> notes.json', '?? vscode-notes.R', '?? my.vscode/'].join('\n');
  const { git } = parseRemovalOutput(out);
  assert.deepEqual(git?.auxiliary, ['.vscode/', '.Rhistory', 'data/.DS_Store', 'scripts/__pycache__/',
    'study.code-workspace', '._report.qmd']);
  assert.deepEqual(git?.changed, [{ code: ' M', path: '.positron/settings.json' }, { code: 'R ', path: '.vscode/a.json -> notes.json' }],
    'changes to tracked files are work, editor files too');
  assert.deepEqual(git?.untracked, ['vscode-notes.R', 'my.vscode/']);
  const synced = parseRemovalOutput(out.split('\n').slice(0, 9).join('\n')).git!;
  const c: RemovalCheck = { project, volumes: [], git: synced, outside: [], fingerprint: 'f' };
  assert.deepEqual(lostWork(c), []);
  assert.match(removalReport(c, 'local'), /No work that is not on Gitea was found[\s\S]*not counted as work: `\.vscode\/`/);
});

test('a checkout git cannot read, or no checkout: everything in the folder counts as lost', () => {
  const broken = parseRemovalOutput('@@fnkc:error\nfatal: bad object HEAD\n@@fnkc:top\ndata/\nanalysis.R\n').git!;
  assert.match(broken.error!, /bad object/);
  assert.deepEqual(broken.topLevel, ['data/', 'analysis.R']);
  const c: RemovalCheck = { project, volumes: [], git: broken, outside: [], fingerprint: 'f' };
  assert.match(lostWork(c)[0], /could not be read/);
  assert.match(removalReport(c, 'local'), /~\/study\/analysis\.R/);
  assert.equal(parseRemovalOutput('@@fnkc:nogit\nx.csv\n').git?.missing, true);
});

test('files outside the project folder: entries of the home, folders once; only generated ones left out', () => {
  const diff = ['C /home/analyst', 'A /home/analyst/.cache', 'A /home/analyst/.cache/pip', 'A /home/analyst/study/x', 'A /home/analyst/thesis.docx',
    'A /home/analyst/downloads', 'A /home/analyst/downloads/a.csv', 'C /home/analyst/old', 'D /home/analyst/old/gone', 'A /etc/x', 'A /tmp/y',
    'A /home/analyst/snowflake.log', 'A /home/analyst/.ssh', 'A /home/analyst/.ssh/authorized_keys', 'C /home/analyst/.positron-server',
    'A /home/analyst/.positron-server/.cli.log', 'A /home/analyst/.fnkc-init-study.lock', 'A /home/analyst/.bash_history',
    'A /home/analyst/.local', 'A /home/analyst/.local/share', 'A /home/analyst/.local/share/jupyter',
    'A /home/analyst/.local/share/jupyter/runtime', 'A /home/analyst/.local/share/jupyter/runtime/kernel-1.json'].join('\n');
  assert.deepEqual(outsideProject(diff, 'study'), ['downloads/', 'thesis.docx'], 'what tools write by themselves is not work');
  // Hidden entries are listed like any other: work kept in ~/.mywork, a key made with ssh-keygen, a file next to generated ones
  const more = [diff, 'A /home/analyst/.mywork', 'A /home/analyst/.mywork/x', 'A /home/analyst/.ssh/id_ed25519', 'A /home/analyst/.notes.md',
    'A /home/analyst/.local/share/jupyter/nbsignatures.db'].join('\n');
  assert.deepEqual(outsideProject(more, 'study'), ['.local/', '.mywork/', '.notes.md', '.ssh/', 'downloads/', 'thesis.docx']);
});

test('remove-check (N1): a clean checkout with work in a hidden folder of the home lists it and claims nothing is synced', async (t) => {
  const { docker, agent } = fixture(t);
  docker.diff += 'A /home/analyst/.mywork\nA /home/analyst/.mywork/x\n';
  const c = await agent.removalCheck(project);
  assert.deepEqual(c.outside, ['.mywork/']);
  assert.equal(lostWork(c).length, 1);
  const report = removalReport(c, 'local');
  assert.ok(report.includes('`~/.mywork/`'), report);
  assert.ok(!/No work that is not on Gitea|synced/.test(report), 'no all-synced line');
});

test('Q1: a local tag on a pushed commit is named for information, without a loss warning', () => {
  const g = parseRemovalOutput(synced.replace('@@fnkc:stash', '@@fnkc:tags\nv1\nsubmitted\n@@fnkc:stash')).git!;
  assert.deepEqual(g.tags, ['v1', 'submitted']);
  const c: RemovalCheck = { project, volumes: [], git: g, outside: [], fingerprint: 'f' };
  assert.deepEqual(lostWork(c), []);
  assert.equal(tagNote(c), 'Local tags are removed with the checkout: v1, submitted. Their commits are on Gitea; a tag itself is there only if it was pushed.');
  assert.match(removalReport(c, 'local'), /No work that is not on Gitea was found[\s\S]*Local tags are removed with the checkout: v1, submitted/);
  // An older host sends no tags: no line
  assert.equal(tagNote({ ...c, git: { ...g, tags: undefined } }), undefined);
});

test('our renv marker and lock are regenerable, not lost work', () => {
  const out = '@@fnkc:branch\nmain\n@@fnkc:remotes\nx\n@@fnkc:unpushed\n0\n@@fnkc:stash\n@@fnkc:status\n!! renv/.fnkc-environment.lock\n!! renv/.fnkc-restored\n!! renv/.fnkc-restored-not\n';
  const git = parseRemovalOutput(out).git;
  assert.deepEqual(git?.regenerable, ['renv/.fnkc-environment.lock', 'renv/.fnkc-restored']);
  assert.deepEqual(git?.ignored, ['renv/.fnkc-restored-not']);
});

test('SSH: the Include line comes with its comment, is upgraded, and comes out again with ~/.ssh/fnkc', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ssh-'));
  try {
    writeFileSync(join(dir, 'config'), 'Host mine\n  User me\n');
    assert.equal(sshIncludePresent(dir), false);
    assert.ok(addSshInclude(dir));
    assert.equal(readFileSync(join(dir, 'config'), 'utf8'), `${INCLUDE_MARKER}\nInclude fnkc/*.conf\n\nHost mine\n  User me\n`);
    assert.equal(addSshInclude(dir), undefined);
    // An Include from an earlier version gets the comment
    writeFileSync(join(dir, 'config'), 'Include fnkc/*.conf\n\nHost mine\n  User me\n');
    assert.equal(addSshInclude(dir), undefined);
    assert.ok(readFileSync(join(dir, 'config'), 'utf8').startsWith(`${INCLUDE_MARKER}\nInclude fnkc/*.conf\n`));
    // An Include inside a Host block does not count
    writeFileSync(join(dir, 'config'), 'Host mine\n  User me\nInclude fnkc/*.conf\n');
    assert.equal(sshIncludePresent(dir), false);

    writeFileSync(join(dir, 'config'), 'Host mine\n  User me\n');
    const c = { port: 4022, project, alias: 'fnkc-local--study', knownHosts: join(dir, 'fnkc', 'fnkc-local--study.known_hosts'), hostKey: 'ssh-ed25519 AAAA' };
    assert.equal(writeSshConfig(dir, project, 'local', c, false), undefined, 'the caller decides about the Include');
    assert.equal(sshIncludePresent(dir), false);
    writeSshConfig(dir, project, 'local', c);
    assert.deepEqual((await removeSshSetup(dir, join(dir, 'cache'))).length, 2);
    assert.equal(readFileSync(join(dir, 'config'), 'utf8'), 'Host mine\n  User me\n', "the user's own config is as it was");
    assert.equal(existsSync(join(dir, 'fnkc')), false);
    assert.deepEqual(await removeSshSetup(dir, join(dir, 'cache')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SSH: a symlinked ~/.ssh/config (dotfile managers) stays a link, with its mode', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ssh-'));
  try {
    mkdirSync(join(dir, 'dotfiles'));
    const real = join(dir, 'dotfiles', 'ssh_config');
    writeFileSync(real, 'Host mine\n  User me\n'); chmodSync(real, 0o644);
    mkdirSync(join(dir, 'ssh'));
    symlinkSync(real, join(dir, 'ssh', 'config'));
    assert.ok(addSshInclude(join(dir, 'ssh')));
    assert.ok(lstatSync(join(dir, 'ssh', 'config')).isSymbolicLink());
    assert.ok(readFileSync(real, 'utf8').startsWith(INCLUDE_MARKER));
    assert.equal(statSync(real).mode & 0o777, 0o644);
    await removeSshSetup(join(dir, 'ssh'), join(dir, 'cache'));
    assert.ok(lstatSync(join(dir, 'ssh', 'config')).isSymbolicLink());
    assert.equal(readFileSync(real, 'utf8'), 'Host mine\n  User me\n');
    assert.deepEqual(readdirSync(join(dir, 'dotfiles')), ['ssh_config'], 'no temporary file is left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SSH entries of deleted projects go: with Delete, and when a listing no longer finds the container', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ssh-'));
  try {
    const entry = (p: string, host: string) => {
      const alias = `fnkc-${host}--${p}`;
      writeSshConfig(dir, p, host, { port: 4022, project: p, alias, knownHosts: join(dir, 'fnkc', `${alias}.known_hosts`), hostKey: 'ssh-ed25519 AAAA' }, false);
      const old = new Date(Date.now() - 3600_000);
      for (const e of ['conf', 'json', 'known_hosts']) utimesSync(join(dir, 'fnkc', `${alias}.${e}`), old, old);
      return alias;
    };
    entry('kept', 'local'); entry('gone', 'local'); entry('gone', 'server');
    assert.deepEqual(await pruneSshConfig(dir, join(dir, 'cache'), 'local', new Set(['kept']), Date.now()), ['gone']);
    assert.ok(existsSync(join(dir, 'fnkc', 'fnkc-local--kept.conf')));
    assert.ok(!existsSync(join(dir, 'fnkc', 'fnkc-local--gone.conf')) && !existsSync(join(dir, 'fnkc', 'fnkc-local--gone.known_hosts')));
    assert.ok(existsSync(join(dir, 'fnkc', 'fnkc-server--gone.conf')), 'other hosts are left alone');
    // Written after the listing started: an Open that the listing may have missed
    mkdirSync(join(dir, 'fnkc'), { recursive: true });
    writeSshConfig(dir, 'fresh', 'local', { port: 1, project: 'fresh', alias: 'fnkc-local--fresh', knownHosts: join(dir, 'fnkc', 'k'), hostKey: 'ssh-ed25519 AAAA' }, false);
    assert.deepEqual(await pruneSshConfig(dir, join(dir, 'cache'), 'local', new Set(['kept']), Date.now()), []);
    removeSshConfig(dir, 'fnkc-server--gone');
    assert.ok(!existsSync(join(dir, 'fnkc', 'fnkc-server--gone.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('content changes invalidate deletion even when Git status and paths are identical', async (t) => {
  const { docker, agent } = fixture(t);
  const before = await agent.removalCheck(project);
  docker.out = synced.replace('a'.repeat(64), 'c'.repeat(64));
  await assert.rejects(agent.remove(project, before.fingerprint), /changed since/);
  assert.ok(!docker.calls.some((a) => a[0] === 'rm' || a[1] === 'rm'));
});

test('the removal check helper cannot outlive its docker CLI, and is removed by name when the CLI gives up', async (t) => {
  const { docker, agent, warnings } = fixture(t);
  await agent.removalCheck(project);
  const run = docker.calls.find((a) => a[0] === 'run')!;
  assert.ok(run.includes('--init') && run.includes('--read-only') && run.includes('--rm'));
  assert.equal(run[run.indexOf('--log-driver') + 1], 'none');
  assert.match(run[run.indexOf('--tmpfs') + 1], /^\/tmp:.*size=64m/, "git's output has a bounded place to go");
  const helper = run[run.indexOf('--name') + 1];
  assert.match(helper, /^fnkc\.read\.alice\.study\.[0-9a-f]{12}$/);
  assert.ok(!docker.calls.some((a) => a[0] === 'rm'));

  docker.calls = []; docker.runThrows = 'docker: operation timed out';
  await assert.rejects(agent.removalCheck(project), /timed out/);
  const name = docker.calls.find((a) => a[0] === 'run')!;
  assert.deepEqual(docker.calls.filter((a) => a[0] === 'rm'), [['rm', '-f', name[name.indexOf('--name') + 1]]]);
  // Docker answers that the helper is gone, or going: nothing to warn about; anything else is logged
  docker.rmError = 'Error response from daemon: removal of container x is already in progress';
  await assert.rejects(agent.removalCheck(project), /timed out/);
  assert.deepEqual(warnings, []);
  docker.rmError = 'Cannot connect to the Docker daemon';
  await assert.rejects(agent.removalCheck(project), /timed out/);
  assert.match(warnings.join('\n'), /could not remove the helper container fnkc\.read\.alice\.study\.[0-9a-f]{12}: Cannot connect/);
});

/** Runs the Git part of the real removal script on a checkout in a temporary folder (no Docker). */
function inspect(work: string, tmp: string) {
  const script = REMOVAL_SCRIPT.slice(REMOVAL_SCRIPT.indexOf('cd /work'))
    .replaceAll('/work', work).replaceAll('/tmp/git.', `${tmp}/git.`).replaceAll('HOME=/tmp', `HOME=${tmp}`);
  const r = spawnSync('bash', ['-c', 'set -euo pipefail\n' + script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return parseRemovalOutput(r.stdout).git!;
}

function checkout(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-inspect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const work = join(dir, 'work'), tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  git(dir, 'init', '-q', '--bare', 'gitea.git');
  git(dir, 'init', '-q', '--bare', 'other.git');
  git(dir, 'clone', '-q', join(dir, 'gitea.git'), work);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  return { dir, work, tmp, git };
}

test('inspection on a real checkout: a pushed one is clean', (t) => {
  const { work, tmp } = checkout(t);
  const g = inspect(work, tmp);
  assert.equal(g.error, undefined);
  assert.equal(g.unpushedCount, 0);
});

test('inspection: a commit reachable only from a local tag is unpushed', (t) => {
  const { work, tmp, git } = checkout(t);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'result');
  git(work, 'tag', 'v1');
  git(work, 'reset', '-q', '--hard', 'origin/main');
  const g = inspect(work, tmp);
  assert.equal(g.unpushedCount, 1);
  assert.match(g.unpushed[0], /result/);
});

test('inspection (Q1): an unpushed tag on a pushed commit is listed as a tag; a tag-only commit stays unpushed', (t) => {
  const { work, tmp, git } = checkout(t);
  git(work, 'tag', 'v1');
  git(work, 'tag', '-a', '-m', 'sent', 'submitted');
  let g = inspect(work, tmp);
  assert.equal(g.unpushedCount, 0);
  assert.deepEqual(g.tags, ['submitted', 'v1']);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'result');
  git(work, 'tag', 'local-only');
  git(work, 'reset', '-q', '--hard', 'origin/main');
  g = inspect(work, tmp);
  assert.equal(g.unpushedCount, 1);
  assert.deepEqual(g.tags, ['submitted', 'v1'], 'the tag on the unpushed commit is in the loss warning instead');
});

test('inspection: a commit pushed only to a secondary remote is not on Gitea', (t) => {
  const { dir, work, tmp, git } = checkout(t);
  git(work, 'remote', 'add', 'other', join(dir, 'other.git'));
  git(work, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
  git(work, 'push', '-q', 'other', 'HEAD:main');
  assert.equal(inspect(work, tmp).unpushedCount, 1);
});

test('inspection: a failed rev-list is an error (loss warning), not a clean result', (t) => {
  const { work, tmp } = checkout(t);
  writeFileSync(join(work, '.git', 'refs', 'heads', 'broken'), 'f'.repeat(40) + '\n');
  const g = inspect(work, tmp);
  assert.ok(g.error, 'git error reported');
  const c: RemovalCheck = { project, volumes: [], git: g, outside: [], fingerprint: 'f' };
  assert.match(lostWork(c)[0], /could not be read/);
});

test('a garbled unpushed count is an error, never zero', () => {
  const g = parseRemovalOutput('@@fnkc:branch\nmain\n@@fnkc:remotes\nx\n@@fnkc:unpushed\n@@fnkc:stash\n@@fnkc:status\n').git!;
  assert.match(g.error!, /could not verify that Gitea has all local commits/);
});

test('SSH: an older alias is removed only when its metadata names this project and host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ssh-'));
  try {
    const open = (p: string, alias: string) => writeSshConfig(dir, p, 'team',
      { port: 4022, project: p, alias, knownHosts: join(dir, 'fnkc', `${alias}.known_hosts`), hostKey: 'ssh-ed25519 AAAA' }, false);
    // On the team server the alias is the repository name: "fnkc-team--study" is also study's legacy alias
    open('fnkc-team--study', 'fnkc-team--study');
    open('study', 'study');
    for (const e of ['conf', 'json', 'known_hosts']) assert.ok(existsSync(join(dir, 'fnkc', `fnkc-team--study.${e}`)), `another project's ${e} stays`);
    // A real entry of fnkc-ctl 0.3 for the same project and host goes
    rmSync(join(dir, 'fnkc'), { recursive: true });
    mkdirSync(join(dir, 'fnkc'));
    writeFileSync(join(dir, 'fnkc', 'fnkc-team--study.json'), JSON.stringify({ project: 'study', host: 'team' }));
    writeFileSync(join(dir, 'fnkc', 'fnkc-team--study.conf'), 'Host fnkc-team--study\n');
    open('study', 'study');
    assert.ok(!existsSync(join(dir, 'fnkc', 'fnkc-team--study.conf')) && !existsSync(join(dir, 'fnkc', 'fnkc-team--study.json')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Delete: removes only the SSH entries whose metadata names this project and host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ssh-'));
  try {
    const hosts = [{ name: 'team', ssh: 'team.example' }, { name: 'local' }];
    const open = (p: string, host: string, alias: string) => writeSshConfig(dir, p, host,
      { port: 4022, project: p, alias, knownHosts: join(dir, 'fnkc', `${alias}.known_hosts`), hostKey: 'ssh-ed25519 AAAA' }, false);
    // B's current alias on the team server is A's (study's) legacy alias there
    const b = legacySshAlias('study', 'team');
    assert.equal(sshAlias(b, 'team', hosts), b);
    open('study', 'team', sshAlias('study', 'team', hosts));
    open(b, 'team', b);
    // "local-x" here can be project "local-x" on the team server too: a current alias may also be someone else's
    open('local-x', 'team', 'local-x');
    const del = (p: string, host: string) =>
      removeProjectSshEntries(dir, join(dir, 'cache'), p, host, [sshAlias(p, host, hosts), legacySshAlias(p, host)]);
    await del('study', 'team');
    await del('x', 'local');
    assert.ok(!existsSync(join(dir, 'fnkc', 'study.conf')), "study's own entry goes");
    for (const a of [b, 'local-x']) {
      for (const e of ['conf', 'json', 'known_hosts']) assert.ok(existsSync(join(dir, 'fnkc', `${a}.${e}`)), `another project's ${a}.${e} stays`);
    }
    // A real entry of fnkc-ctl 0.3 for the same project and host goes
    rmSync(join(dir, 'fnkc', `${b}.json`));
    writeFileSync(join(dir, 'fnkc', `${b}.json`), JSON.stringify({ project: 'study', host: 'team' }));
    await del('study', 'team');
    assert.ok(!existsSync(join(dir, 'fnkc', `${b}.conf`)) && !existsSync(join(dir, 'fnkc', `${b}.json`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Delete: the ownership check and the removal wait for an Open writing the same name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ssh-'));
  const cache = join(dir, 'cache');
  try {
    const legacy = legacySshAlias('study', 'team');
    const entry = (p: string) => ({ port: 4022, project: p, alias: legacy, knownHosts: join(dir, 'fnkc', `${legacy}.known_hosts`), hostKey: 'ssh-ed25519 AAAA' });
    // study's own legacy entry, which Delete would remove
    writeSshConfig(dir, 'study', 'team', entry('study'), false);
    let removal: Promise<void> | undefined;
    // An Open holds the lock: it replaces that name with project "fnkc-team--study"'s entry meanwhile
    await withSshEntries(cache, async () => {
      removal = removeProjectSshEntries(dir, cache, 'study', 'team', [legacy]);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(existsSync(join(dir, 'fnkc', `${legacy}.conf`)), 'Delete waits for the lock');
      removeSshConfig(dir, legacy);
      writeSshConfig(dir, legacy, 'team', entry(legacy), false);
    });
    await removal;
    assert.ok(existsSync(join(dir, 'fnkc', `${legacy}.conf`)), "the other project's new entry stays: Delete checked after the Open");
    assert.equal(JSON.parse(readFileSync(join(dir, 'fnkc', `${legacy}.json`), 'utf8')).project, legacy);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a listing prune and Remove SSH Configuration wait for an Open holding the SSH entries lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ssh-'));
  const cache = join(dir, 'cache');
  try {
    const alias = 'fnkc-local--study';
    const entry = { port: 4022, project: 'study', alias, knownHosts: join(dir, 'fnkc', `${alias}.known_hosts`), hostKey: 'ssh-ed25519 AAAA' };
    // An entry from an hour ago, and a listing that started now without study's container
    writeSshConfig(dir, 'study', 'local', entry, false);
    const old = new Date(Date.now() - 3600_000);
    for (const e of ['conf', 'json', 'known_hosts']) utimesSync(join(dir, 'fnkc', `${alias}.${e}`), old, old);
    const listedAt = Date.now();
    let prune: Promise<string[]> | undefined;
    // An Open holds the lock and writes study's entry afresh meanwhile
    await withSshEntries(cache, async () => {
      prune = pruneSshConfig(dir, cache, 'local', new Set(), listedAt);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(existsSync(join(dir, 'fnkc', `${alias}.conf`)), 'the prune waits for the lock');
      writeSshConfig(dir, 'study', 'local', entry, false);
    });
    assert.deepEqual(await prune, [], 'the prune checks after the Open: the fresh entry is not older than the listing');
    assert.ok(existsSync(join(dir, 'fnkc', `${alias}.conf`)), 'the fresh entry stays');

    let removal: Promise<string[]> | undefined;
    await withSshEntries(cache, async () => {
      removal = removeSshSetup(dir, cache);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(existsSync(join(dir, 'fnkc', `${alias}.conf`)), 'Remove SSH Configuration waits for the lock');
    });
    assert.equal((await removal)?.length, 1);
    assert.ok(!existsSync(join(dir, 'fnkc')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
