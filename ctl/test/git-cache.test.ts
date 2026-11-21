import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureBareCache } from '../src/client/project.ts';

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
