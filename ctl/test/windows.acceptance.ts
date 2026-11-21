import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withLock } from '../src/lock.ts';
import { Engine } from '../src/client/engine.ts';
import { proxyCommand, sshConfigEntry, type ContainerSsh } from '../src/client/ssh.ts';

test('Windows PowerShell mutex serializes mutations and releases on errors', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-windows-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(withLock(join(dir, 'project'), async () => {
    await assert.rejects(withLock(join(dir, 'project'), async () => 0, 50), /timed out/);
    throw new Error('exercise release');
  }), /exercise release/);
  assert.equal(await withLock(join(dir, 'project'), async () => 42), 42);
});

test('WSL engine uses the configured distribution and SSH config quotes Windows paths', () => {
  const engine = new Engine('wsl', { engine: 'wsl', wslDistro: 'fnkc-test' }, 'C:\\cache');
  assert.deepEqual(engine.docker.command, ['wsl', '-d', 'fnkc-test', '--exec', 'docker']);
  const c: ContainerSsh = {
    port: 2201, jump: { dest: 'fnkc@example.test', port: '2222' }, identity: 'C:\\Users\\analyst\\.ssh\\id_ed25519',
    project: 'study', alias: 'study', knownHosts: 'C:\\Users\\analyst\\.ssh\\fnkc\\study.known_hosts', hostKey: 'ssh-ed25519 AAAA',
  };
  // The Windows quoting, whatever system the test runs on (so the pre-commit hook covers it too)
  assert.match(proxyCommand(c, 'win32')!, /"C:\\Users\\analyst\\.ssh\\id_ed25519"/);
  assert.throws(() => proxyCommand({ ...c, identity: 'C:\\a&b' }, 'win32'), /unsupported Windows proxy argument/);
  assert.match(sshConfigEntry('study', 'server', c), /IdentityFile "C:\/Users\/analyst\/\.ssh\/id_ed25519"/);
  assert.match(sshConfigEntry('study', 'server', c), /ProxyCommand/);
});
