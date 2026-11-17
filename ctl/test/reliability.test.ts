import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.ts';
import { withLock } from '../src/lock.ts';
import { repositoryId, checkRepository } from '../src/repository.ts';
import { connectionOfAlias, writeSshConfig } from '../src/client/ssh.ts';
import { sshAlias } from '../src/layout.ts';

test('repository IDs distinguish equal basenames and reject shell/helper URLs', () => {
  assert.notEqual(repositoryId('git@host:one/study.git'), repositoryId('git@host:two/study.git'));
  for (const url of ['ext::sh -c bad', 'file:///tmp/study', 'ssh://host/org/$(id)/study', 'https://name:password@host/study']) assert.throws(() => checkRepository(url));
});

test('opening the same project on another host leaves the first window identity intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-alias-'));
  try {
    for (const host of ['server', 'local']) {
      const alias = sshAlias('study', host);
      writeSshConfig(dir, 'study', host, { alias, project: 'study', port: 4000,
        knownHosts: join(dir, 'positron', `${alias}.hosts`), hostKey: 'ssh-ed25519 AAAA' });
    }
    assert.deepEqual(connectionOfAlias(dir, sshAlias('study', 'server')), { project: 'study', host: 'server' });
    assert.deepEqual(connectionOfAlias(dir, sshAlias('study', 'local')), { project: 'study', host: 'local' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed mutation releases the lock; a live owner is not evicted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-lock-')); const path = join(dir, 'lock');
  try {
    await assert.rejects(withLock(path, async () => { throw Error('failure'); }), /failure/);
    assert.equal(await withLock(path, async () => 42), 42);
    await withLock(path, async () => { await assert.rejects(withLock(path, async () => 0, 10), /timed out/); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('subprocess deadlines reject stalled commands and excessive output is bounded', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }), /timed out/);
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(9*1024*1024))']), /exceeded/);
});
