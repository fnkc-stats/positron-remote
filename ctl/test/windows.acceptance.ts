// Runs on windows-2025 in CI (extension.yml, which gates the release) and in `npm run check` everywhere else.
// Cases that only mean something on Windows (its paths, PATH, Positron install folders) are skipped elsewhere.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { withLock } from '../src/lock.ts';
import { Engine } from '../src/client/engine.ts';
import { expandHome } from '../src/client/config.ts';
import { localPositron, positronCli } from '../src/client/positron.ts';
import { extendPath, run } from '../src/exec.ts';
import {
  INCLUDE_MARKER, addSshInclude, proxyCommand, pruneSshConfig, removeSshSetup, sshConfigEntry, sshIncludePresent,
  writeSshConfig, type ContainerSsh,
} from '../src/client/ssh.ts';

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only' };
/** A ~/.ssh in a temporary folder whose path has a space, like C:\Users\Ivan Petrov\.ssh */
function sshHome(t: { after: (f: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-windows-ssh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ssh = join(dir, 'Ivan Petrov', '.ssh');
  mkdirSync(ssh, { recursive: true });
  return ssh;
}
const entry = (ssh: string, project: string, alias: string): ContainerSsh => ({
  port: 2201, jump: { dest: 'fnkc@example.test', port: '2222' }, identity: join(ssh, 'id_ed25519'),
  project, alias, knownHosts: join(ssh, 'fnkc', `${alias}.known_hosts`), hostKey: 'ssh-ed25519 AAAA',
});

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

test('SSH setup on this computer: Include, entries, pruning and removal leave the user\'s config as it was', async (t) => {
  const ssh = sshHome(t);
  const own = 'Host mine\n  User me\n';
  writeFileSync(join(ssh, 'config'), own);
  assert.ok(writeSshConfig(ssh, 'study', 'server', entry(ssh, 'study', 'fnkc-server--study')));
  assert.ok(sshIncludePresent(ssh));
  assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), `${INCLUDE_MARKER}\nInclude fnkc/*.conf\n\n${own}`);
  // Written again (the next Open): the files are replaced in place, the Include is not added twice
  assert.equal(writeSshConfig(ssh, 'study', 'server', entry(ssh, 'study', 'fnkc-server--study')), undefined);
  assert.equal(addSshInclude(ssh), undefined);
  assert.match(readFileSync(join(ssh, 'fnkc', 'fnkc-server--study.known_hosts'), 'utf8'), /^fnkc-server--study ssh-ed25519 AAAA\n$/);

  writeSshConfig(ssh, 'gone', 'server', entry(ssh, 'gone', 'fnkc-server--gone'), false);
  const old = new Date(Date.now() - 3600_000);
  for (const e of ['conf', 'json', 'known_hosts']) utimesSync(join(ssh, 'fnkc', `fnkc-server--gone.${e}`), old, old);
  assert.deepEqual(await pruneSshConfig(ssh, join(ssh, 'cache'), 'server', new Set(['study']), Date.now()), ['gone']);
  assert.ok(!existsSync(join(ssh, 'fnkc', 'fnkc-server--gone.conf')));
  assert.ok(existsSync(join(ssh, 'fnkc', 'fnkc-server--study.conf')));

  assert.equal((await removeSshSetup(ssh, join(ssh, 'cache'))).length, 2);
  assert.equal(readFileSync(join(ssh, 'config'), 'utf8'), own);
  assert.ok(!existsSync(join(ssh, 'fnkc')));
});

test('the system OpenSSH reads an entry whose paths have a space and backslashes', (t) => {
  const found = spawnSync('ssh', ['-V'], { windowsHide: true });
  if (found.error) return t.skip('no ssh on this computer');
  const ssh = sshHome(t);
  const c = entry(ssh, 'study', 'fnkc-server--study');
  writeSshConfig(ssh, 'study', 'server', c, false);
  const r = spawnSync('ssh', ['-F', join(ssh, 'fnkc', `${c.alias}.conf`), '-G', c.alias], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  // ssh -G prints lower-case keys; on Windows it may print the drive letter in either case
  const value = (k: string) => r.stdout.split(/\r?\n/).find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
  const same = (a: string | undefined, b: string) => a?.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  assert.equal(value('hostname'), '127.0.0.1');
  assert.equal(value('port'), '2201');
  assert.equal(value('hostkeyalias'), c.alias);
  assert.ok(same(value('identityfile'), c.identity!), `identityfile: ${value('identityfile')}`);
  assert.ok(same(value('userknownhostsfile'), c.knownHosts), `userknownhostsfile: ${value('userknownhostsfile')}`);
  // The words of the proxy command come through whole: the identity with its space is one quoted word
  const unquoted = (x: string | undefined) => x?.replace(/['"]/g, '');
  assert.ok(same(unquoted(value('proxycommand')), unquoted(proxyCommand(c))!), `proxycommand: ${value('proxycommand')}`);
  assert.ok(value('proxycommand')?.includes(process.platform === 'win32' ? `"${c.identity}"` : `'${c.identity}'`));
});

test('~\\ paths are under the Windows home folder', windowsOnly, () => {
  assert.equal(expandHome('~\\.ssh\\id_ed25519'), join(homedir(), '.ssh', 'id_ed25519'));
  assert.equal(expandHome('~/.ssh/id_ed25519'), join(homedir(), '.ssh', 'id_ed25519'));
  assert.equal(expandHome('C:\\keys\\id'), 'C:\\keys\\id');
});

test('Positron installed for the user is found under LOCALAPPDATA, with Positron.exe', windowsOnly, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-windows-positron-'));
  const saved = { app: process.env.POSITRON_APP, local: process.env.LOCALAPPDATA };
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['POSITRON_APP', saved.app], ['LOCALAPPDATA', saved.local]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const install = join(dir, 'Programs', 'Positron');
  const app = join(install, 'resources', 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'product.json'), JSON.stringify({ positronVersion: '2026.11.0', positronBuildNumber: 12, commit: 'abc' }));
  writeFileSync(join(install, 'Positron.exe'), '');
  delete process.env.POSITRON_APP;
  process.env.LOCALAPPDATA = dir;
  const p = localPositron();
  assert.deepEqual(p, { version: '2026.11.0-12', commit: 'abc', appRoot: app });
  assert.equal(positronCli(p), join(install, 'Positron.exe'));
});

test('apps started from the Start menu find Docker, Git, GnuPG and gh', windowsOnly, (t) => {
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = 'C:\\Windows\\system32';
  extendPath();
  extendPath();
  const parts = process.env.PATH.split(delimiter);
  assert.equal(parts[0], 'C:\\Windows\\system32');
  for (const want of [/\\Docker\\Docker\\resources\\bin$/, /\\Git\\cmd$/, /\\GnuPG\\bin$/, /\\GitHub CLI$/]) {
    assert.equal(parts.filter((p) => want.test(p)).length, 1, `${want} once in ${process.env.PATH}`);
  }
});

test('a command that hangs is killed at its timeout and on Cancel', async () => {
  const hang = ['-e', 'setTimeout(() => {}, 60_000)'];
  const started = Date.now();
  await assert.rejects(run(process.execPath, hang, { timeoutMs: 300 }), /timed out/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(run(process.execPath, hang, { signal: controller.signal }), { name: 'Cancelled' });
  assert.ok(Date.now() - started < 15_000, 'the children did not keep run waiting');
});
