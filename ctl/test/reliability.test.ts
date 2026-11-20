import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.ts';
import { withLock } from '../src/lock.ts';
import { repositoryName, checkRepository } from '../src/repository.ts';
import { connectionOfAlias, writeSshConfig } from '../src/client/ssh.ts';
import { sshAlias } from '../src/layout.ts';

test('projects are named after their repository; shell/helper URLs are rejected', () => {
  assert.equal(repositoryName('git@host:one/study.git'), 'study');
  assert.equal(repositoryName('ssh://git@host:2221/stats/muhina-PI-2026-1.git'), 'muhina-PI-2026-1');
  for (const url of ['ext::sh -c bad', 'file:///tmp/study', 'ssh://host/org/$(id)/study', 'https://name:password@host/study']) assert.throws(() => checkRepository(url));
});

test('opening the same project on another host leaves the first window identity intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-alias-'));
  const hosts = [{ name: 'local' }, { name: 'server', ssh: 'fnkc@srv' }, { name: 'srv2', ssh: 'fnkc@srv2' }];
  const write = (project: string, host: string) => {
    const alias = sshAlias(project, host, hosts);
    writeSshConfig(dir, project, host, { alias, project, port: 4000, knownHosts: join(dir, 'fnkc', `${alias}.hosts`), hostKey: 'ssh-ed25519 AAAA' });
  };
  try {
    // The team server's windows carry the repository's name; this computer and other servers get theirs in front
    assert.equal(sshAlias('study', 'server', hosts), 'study');
    assert.equal(sshAlias('study', 'local', hosts), 'local-study');
    assert.equal(sshAlias('study', 'srv2', hosts), 'srv2-study');
    assert.equal(sshAlias('study', 'local', [{ name: 'local' }]), 'local-study');
    for (const host of ['server', 'local']) write('study', host);
    assert.deepEqual(connectionOfAlias(dir, 'study'), { project: 'study', host: 'server' });
    assert.deepEqual(connectionOfAlias(dir, 'local-study'), { project: 'study', host: 'local' });
    assert.match(readFileSync(join(dir, 'fnkc', 'local-study.conf'), 'utf8'), /^Host local-study$/m);
    // A project whose name is another one's window name is refused, not written over it
    assert.throws(() => write('local-study', 'server'), /already used by project study on 'local'/);
    assert.deepEqual(connectionOfAlias(dir, 'local-study'), { project: 'study', host: 'local' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('windows opened under the old name are still recognized; reopening replaces the old entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-alias-'));
  try {
    mkdirSync(join(dir, 'fnkc'));
    writeFileSync(join(dir, 'fnkc', 'fnkc-local--study.json'), JSON.stringify({ project: 'study', host: 'local' }));
    writeFileSync(join(dir, 'fnkc', 'fnkc-local--study.conf'), 'Host fnkc-local--study\n');
    assert.deepEqual(connectionOfAlias(dir, 'fnkc-local--study'), { project: 'study', host: 'local' });
    assert.equal(connectionOfAlias(dir, 'local-study'), undefined);
    writeSshConfig(dir, 'study', 'local', { alias: 'local-study', project: 'study', port: 4000, knownHosts: join(dir, 'fnkc', 'k'), hostKey: 'ssh-ed25519 AAAA' });
    assert.deepEqual(connectionOfAlias(dir, 'local-study'), { project: 'study', host: 'local' });
    assert.ok(!existsSync(join(dir, 'fnkc', 'fnkc-local--study.conf')));
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
