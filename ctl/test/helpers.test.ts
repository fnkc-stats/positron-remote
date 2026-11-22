// Helper containers on a user's volumes (helper.ts): the extensions volume's preparation, deadlines, and the removal of
// helpers a previous agent left behind.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Docker } from '../src/docker.ts';
import type { RunOptions, RunResult } from '../src/exec.ts';
import type { Logger } from '../src/log.ts';
import { removeHelpers } from '../src/helper.ts';
import { helperPattern } from '../src/layout.ts';
import { EXTENSIONS_CHECK, EXTENSIONS_CHECK_MS, EXTENSIONS_OWNER, EXTENSIONS_SCRIPT, prepareExtensions } from '../src/positron-server.ts';

const version = '2026.11.1-1';
const commit = 'd'.repeat(40);
const want = `${version};ms-python,ms-toolsai`;
const hex = (c: string) => c.repeat(12);

class FakeDocker extends Docker {
  calls: string[][] = [];
  opts: (RunOptions | undefined)[] = [];
  /** The volume's .fnkc-ctl as the check prints it. */
  state = '';
  /** Names `docker ps -a` lists. */
  names: string[] = [];
  /** The docker CLI of a helper fails like this (timeout, output limit): the container may still run. */
  runThrows?: (args: string[]) => string | undefined;
  /** The helper's container exits like this (default: 0). */
  runExits?: (args: string[]) => Partial<RunResult> | undefined;
  removed: string[] = [];
  override async run(args: string[], opts?: RunOptions): Promise<RunResult> {
    this.calls.push(args); this.opts.push(opts);
    if (args[0] === 'run') {
      const error = this.runThrows?.(args);
      if (error) throw new Error(error);
      return { code: 0, stdout: args.includes(EXTENSIONS_CHECK) ? this.state : '', stderr: '', ...this.runExits?.(args) };
    }
    if (args[0] === 'rm') { this.removed.push(args.at(-1)!); return { code: 1, stdout: '', stderr: 'Error response from daemon: No such container: x' }; }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  }
  override async ok(args: string[], opts?: RunOptions): Promise<string> {
    this.calls.push(args); this.opts.push(opts);
    if (args[0] === 'ps') return this.names.join('\n') + '\n';
    return '';
  }
  get runs() { return this.calls.filter((a) => a[0] === 'run'); }
}

const quiet: Logger = { info() {}, warn() {} };
const prepare = (docker: FakeDocker, project = 'study', log: Logger = quiet) =>
  prepareExtensions(docker, 'img', 'x64', 'fnkc-ext-vol', version, commit, ['ms-toolsai', 'ms-python'], log, { user: 'alice', project });
const warnings = () => { const list: string[] = []; return { list, log: { info() {}, warn: (m: string) => { list.push(m); } } }; };
const value = (args: string[], flag: string) => args.flatMap((a, i) => a === flag ? [args[i + 1]] : []);

test('extensions: every helper is named, bounded and unprivileged; only the ownership step is root, with CHOWN and DAC_READ_SEARCH', async () => {
  const docker = new FakeDocker();
  await prepare(docker);
  const [check, own, script] = docker.runs;
  assert.equal(docker.runs.length, 3);
  for (const args of docker.runs) {
    assert.match(value(args, '--name')[0], /^fnkc\.ext\.alice\.study\.[0-9a-f]{12}$/);
    for (const flag of ['--init', '--rm', '--read-only']) assert.ok(args.includes(flag), `${flag} in ${args.join(' ')}`);
    assert.deepEqual(value(args, '--log-driver'), ['none']);
    assert.deepEqual(value(args, '--network'), ['none']);
    assert.deepEqual(value(args, '--cap-drop'), ['ALL']);
    assert.deepEqual(value(args, '--security-opt'), ['no-new-privileges']);
    assert.ok(value(args, '--label').includes('fnkc.helper=ext') && value(args, '--label').includes('fnkc.helper.project=study'));
    assert.ok(!value(args, '--label').some((l) => /^fnkc\.(user|project|managed)=/.test(l)), 'admission never counts a helper as a project');
    assert.equal(value(args, '--user').length, 1);
    assert.ok(value(args, '--memory').length && value(args, '--pids-limit').length);
  }
  assert.deepEqual(value(check, '--user'), ['1000:1000']); assert.ok(check.includes('fnkc-ext-vol:/ext:ro'));
  assert.deepEqual(value(check, '--cap-add'), []);
  assert.deepEqual(value(own, '--user'), ['0:0']); assert.deepEqual(value(own, '--cap-add'), ['CHOWN', 'DAC_READ_SEARCH']);
  assert.ok(own.includes(EXTENSIONS_OWNER)); assert.match(EXTENSIONS_OWNER, /^chown 1000:1000 \/ext && /, '/ext itself first');
  assert.deepEqual(value(own, '--workdir'), ['/'], 'root without capabilities cannot enter the analyst\'s home');
  assert.deepEqual(value(script, '--user'), ['1000:1000']); assert.deepEqual(value(script, '--cap-add'), []);
  assert.ok(script.includes(EXTENSIONS_SCRIPT) && script.includes(want));
  assert.ok(!EXTENSIONS_SCRIPT.includes('chown'), 'the preparation runs as the analyst');
  // Each has its own deadline; none ran past it, and a helper that ran to its end is not removed again
  const deadlines = docker.calls.flatMap((a, i) => a[0] === 'run' ? [docker.opts[i]?.timeoutMs] : []);
  assert.deepEqual(deadlines, [EXTENSIONS_CHECK_MS, 60_000, 5 * 60_000]);
  assert.deepEqual(docker.removed, []);
});

test('extensions: a prepared volume is only read', async () => {
  const docker = new FakeDocker(); docker.state = want;
  await prepare(docker);
  assert.equal(docker.runs.length, 1);
});

test('extensions: a helper whose docker CLI was killed is removed by its name, and the error names the deadline', async () => {
  const docker = new FakeDocker();
  docker.runThrows = (args) => args.includes(EXTENSIONS_CHECK) ? 'docker: operation timed out' : undefined;
  await assert.rejects(prepare(docker), new RegExp(`could not read the extensions volume's state: timed out after ${EXTENSIONS_CHECK_MS / 1000} s`));
  assert.deepEqual(docker.removed, value(docker.runs[0], '--name'));
  const after = new FakeDocker();
  after.runThrows = (args) => args.includes(EXTENSIONS_SCRIPT) ? 'docker: output exceeded 8 MiB' : undefined;
  const w = warnings();
  await prepare(after, 'study', w.log);
  assert.match(w.list.join('\n'), /output exceeded 8 MiB; starting without preparing the extensions volume/);
  assert.deepEqual(after.removed, value(after.runs[2], '--name'));
});

// The user controls the volume, so they could make these two steps fail on every Open (millions of files for find,
// a FIFO where Positron's command line reads): the start goes on, with a warning, and the next Open after a stop tries again
test('extensions: an ownership step that runs out of time warns and the start goes on, without the preparation', async () => {
  const docker = new FakeDocker();
  docker.runThrows = (args) => args.includes(EXTENSIONS_OWNER) ? 'docker: operation timed out' : undefined;
  const w = warnings();
  await prepare(docker, 'study', w.log);
  assert.equal(docker.runs.length, 2, 'the preparation does not run on a volume that may not be the analyst\'s');
  assert.equal(w.list.length, 1);
  assert.match(w.list[0], /^could not give the extensions volume to the analyst: timed out after 60 s; starting without preparing the extensions volume .*the next Open after a stop tries again/);
  assert.deepEqual(docker.removed, value(docker.runs[1], '--name'));
});

test('extensions: an ownership step that could not change /ext itself fails the start, with its own message', async () => {
  const docker = new FakeDocker();
  docker.runExits = (args) => args.includes(EXTENSIONS_OWNER) ? { code: 1, stderr: 'chown: /ext: Operation not permitted\n' } : undefined;
  await assert.rejects(prepare(docker), /^Error: could not give the extensions volume to the analyst: chown: \/ext: Operation not permitted$/);
  assert.equal(docker.runs.length, 2);
});

test('extensions: a preparation that runs out of time or fails warns, says it continues next time, and the start goes on', async () => {
  const slow = new FakeDocker();
  slow.runThrows = (args) => args.includes(EXTENSIONS_SCRIPT) ? 'docker: operation timed out' : undefined;
  const w = warnings();
  await prepare(slow, 'study', w.log);
  assert.equal(w.list.length, 1);
  assert.match(w.list[0], /^could not prepare extensions: timed out after 300 s; stop the project and open it again to continue \(installed extensions are kept\); starting without preparing the extensions volume/);
  assert.deepEqual(slow.removed, value(slow.runs[2], '--name'));

  const failed = new FakeDocker();
  failed.runExits = (args) => args.includes(EXTENSIONS_SCRIPT) ? { code: 1, stderr: 'could not install posit.air\n' } : undefined;
  const f = warnings();
  await prepare(failed, 'study', f.log);
  assert.deepEqual(f.list.map((m) => m.split(';')[0]), ['could not prepare extensions: could not install posit.air']);
});

test('leftover helpers: only the exact project\'s are removed (a, not a.b or aXb), before a new helper starts', async () => {
  const docker = new FakeDocker();
  const mine = [`fnkc.read.alice.a.${hex('1')}`, `fnkc.ext.alice.a.${hex('f')}`];
  docker.names = [...mine, `fnkc.read.alice.a.b.${hex('2')}`, `fnkc.ext.alice.aXb.${hex('3')}`, `fnkc.read.bob.a.${hex('4')}`,
    `fnkc.read.alice.a.${hex('5')}0`, `fnkc.read.alice.a.${'g'.repeat(12)}`, 'fnkc-alice-a', 'fnkc.recovery.alice.a', `xfnkc.read.alice.a.${hex('6')}`];
  await removeHelpers(docker, quiet, 'alice', 'a');
  assert.deepEqual(docker.removed, mine);
  assert.ok(docker.calls.every((a) => !a.some((x) => x.startsWith('name='))), 'never Docker\'s name filter');
  assert.ok(helperPattern('alice', 'a.b').test(`fnkc.read.alice.a.b.${hex('2')}`));
  assert.ok(!helperPattern('alice', 'a.b').test(`fnkc.read.alice.aXb.${hex('2')}`), 'dots in a project name are literal');

  // A preparation first removes what a previous agent of this project left
  const next = new FakeDocker(); next.names = docker.names; next.state = want;
  await prepare(next, 'a');
  assert.deepEqual(next.removed, mine);
  assert.ok(next.calls.findIndex((a) => a[0] === 'ps') < next.calls.findIndex((a) => a[0] === 'run'));
});

// The scripts themselves, on a directory standing in for the volume (/ext)
function volume(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-ext-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (script: string, ...args: string[]) => spawnSync('sh', ['-c', script.replaceAll('/ext', dir), 'sh', ...args],
    { encoding: 'utf8', timeout: 10_000 });
  return { dir, sh };
}

for (const kind of ['symlink to /dev/zero', 'FIFO', 'large file'] as const) {
  test(`extensions scripts: a ${kind} at .fnkc-ctl is not read, and the preparation replaces it`, (t) => {
    const { dir, sh } = volume(t);
    const f = join(dir, '.fnkc-ctl');
    if (kind === 'symlink to /dev/zero') symlinkSync('/dev/zero', f);
    else if (kind === 'FIFO') assert.equal(spawnSync('mkfifo', [f]).status, 0);
    else writeFileSync(f, 'x'.repeat(1 << 20));
    const check = sh(EXTENSIONS_CHECK);
    assert.equal(check.status, 0, check.stderr);
    assert.ok(check.stdout.length <= 4096, 'at most 4 KiB is read');
    // No server in this stand-in: nothing to install, and the volume is marked prepared
    const r = sh(EXTENSIONS_SCRIPT, join(dir, 'no-server'), want, 'ms-python ms-toolsai');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(lstatSync(f).isFile());
    assert.equal(readFileSync(f, 'utf8'), want);
    assert.equal(readFileSync(join(dir, '.version'), 'utf8'), version);
    assert.equal(sh(EXTENSIONS_CHECK).stdout, want);
  });
}
