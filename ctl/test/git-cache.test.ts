import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureBareCache, ProjectUnreachable, readProjectRevision } from '../src/client/project.ts';
import { Cancelled } from '../src/exec.ts';

const log = { info() {}, warn() {} };
const bare = (dir: string) => execFileSync('git', ['--git-dir', dir, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim();

function dir(t: { after(fn: () => void): void }) {
  const d = mkdtempSync(join(tmpdir(), 'pctl-cache-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('git cache: a first Open interrupted after mkdir leaves a cache the next Open repairs', async (t) => {
  const cache = join(dir(t), 'study-abc.git');
  mkdirSync(cache); // what an older client left when it stopped before git init
  await ensureBareCache(cache, log);
  assert.equal(bare(cache), 'true');
  await ensureBareCache(cache, log); // an initialized cache is kept as it is
  assert.equal(bare(cache), 'true');
});

test('git cache: unexpected contents are kept aside, never deleted', async (t) => {
  const d = dir(t), cache = join(d, 'study-abc.git');
  mkdirSync(cache); writeFileSync(join(cache, 'note.txt'), 'x');
  await ensureBareCache(cache, log);
  assert.equal(bare(cache), 'true');
  const aside = readdirSync(d).find((n) => n.startsWith('study-abc.git.broken-'));
  assert.ok(aside && existsSync(join(d, aside, 'note.txt')));
});

test('git cache: a fresh cache appears only initialized, without a leftover temporary directory', async (t) => {
  const d = dir(t), cache = join(d, 'study-abc.git');
  await ensureBareCache(cache, log);
  assert.equal(bare(cache), 'true');
  assert.deepEqual(readdirSync(d), ['study-abc.git']);
});

// readProjectRevision against a local upstream whose upload-pack (every connection: the fetch, then each blob read)
// goes through a wrapper: `budget` holds how many more connections succeed, or "hang"; no file: all succeed
const pin = (c: string) => `ghcr.io/fnkc-stats/r-env@sha256:${c.repeat(64)}`;
const CONFIG_ENV = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
function upstream(t: { after(fn: () => void): void }) {
  const d = dir(t), repo = join(d, 'study'), budget = join(d, 'budget'), wrapper = join(d, 'upload-pack.sh');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.test'], ['uploadpack.allowFilter', 'true'],
    ['uploadpack.allowAnySHA1InWant', 'true']]) git('config', k, v);
  writeFileSync(wrapper, `#!/bin/sh
b=$(cat '${budget}' 2>/dev/null) || exec git-upload-pack "$@"
if [ "$b" = hang ]; then sleep 30; exit 1; fi
if [ "$b" -le 0 ]; then echo 'fatal: the connection was reset' >&2; exit 1; fi
echo $((b - 1)) > '${budget}'
exec git-upload-pack "$@"
`, { mode: 0o755 });
  const saved = CONFIG_ENV.map((k) => process.env[k]);
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.uploadpack', GIT_CONFIG_VALUE_0: wrapper });
  t.after(() => CONFIG_ENV.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }));
  const commit = (manifest: string | undefined) => {
    if (manifest === undefined) git('rm', '-q', 'container.json');
    else { writeFileSync(join(repo, 'container.json'), manifest); git('add', 'container.json'); }
    git('commit', '-q', '--allow-empty', '-m', 'c');
    return git('rev-parse', 'HEAD');
  };
  const set = (b: number | 'hang' | undefined) => (b === undefined ? rmSync(budget, { force: true }) : writeFileSync(budget, `${b}\n`));
  return { src: { name: 'study', urls: [`file://${repo}`] }, cacheDir: join(d, 'cache'), commit, set };
}

test('git cache: a blob read lost after the fetch keeps the last usable pin and commit', async (t) => {
  const u = upstream(t);
  const first = u.commit(JSON.stringify({ image: pin('a') }));
  assert.deepEqual(await readProjectRevision(u.src, u.cacheDir, log), { image: pin('a'), revision: first, stale: false });
  const second = u.commit(JSON.stringify({ image: pin('b') }));
  u.set(1); // the fetch succeeds, reading container.json does not
  assert.deepEqual(await readProjectRevision(u.src, u.cacheDir, log), { image: pin('a'), revision: first, stale: true });
  u.set(0); // Gitea down afterwards: still the last usable pair
  assert.deepEqual(await readProjectRevision(u.src, u.cacheDir, log), { image: pin('a'), revision: first, stale: true });
  u.set(undefined);
  assert.deepEqual(await readProjectRevision(u.src, u.cacheDir, log), { image: pin('b'), revision: second, stale: false });
});

test('git cache: a fetch that times out falls back to the last usable pair', async (t) => {
  const u = upstream(t);
  const first = u.commit(JSON.stringify({ image: pin('a') }));
  await readProjectRevision(u.src, u.cacheDir, log);
  u.commit(JSON.stringify({ image: pin('b') }));
  u.set('hang');
  assert.deepEqual(await readProjectRevision(u.src, u.cacheDir, log, 10, 1000), { image: pin('a'), revision: first, stale: true });
});

test('git cache: a HEAD without container.json is an error, not an outage, and does not replace the last pair', async (t) => {
  const u = upstream(t);
  const first = u.commit(JSON.stringify({ image: pin('a') }));
  await readProjectRevision(u.src, u.cacheDir, log);
  u.commit(undefined);
  await assert.rejects(readProjectRevision(u.src, u.cacheDir, log), /has no container.json/);
  u.set(0);
  assert.deepEqual(await readProjectRevision(u.src, u.cacheDir, log), { image: pin('a'), revision: first, stale: true });
});

test('git cache: a stopped read of remote HEAD ends at once, without warnings about an unreachable Gitea', async (t) => {
  // Open stops it once the host's checkout is adopted, or on Cancel: no git left running for its timeout
  const u = upstream(t);
  u.commit(JSON.stringify({ image: pin('a') }));
  const warnings: string[] = [];
  const watched = { info() {}, warn: (m: string) => warnings.push(m) };
  await assert.rejects(readProjectRevision(u.src, u.cacheDir, watched, 10, 60_000, AbortSignal.abort()), Cancelled);
  u.set('hang');
  const stop = new AbortController();
  const started = Date.now();
  const read = readProjectRevision(u.src, u.cacheDir, watched, 10, 60_000, stop.signal);
  setTimeout(() => stop.abort(), 500);
  await assert.rejects(read, Cancelled);
  assert.ok(Date.now() - started < 10_000, 'ends promptly, not after the git timeout');
  assert.deepEqual(warnings, []);
});

test('git cache: nothing fetched ever and Gitea down: ProjectUnreachable', async (t) => {
  const u = upstream(t);
  u.commit(JSON.stringify({ image: pin('a') }));
  u.set(0);
  await assert.rejects(readProjectRevision(u.src, u.cacheDir, log), ProjectUnreachable);
});
