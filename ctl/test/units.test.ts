import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentConfig } from '../src/agent-config.ts';
import { clientConfig } from '../src/client/config.ts';
import { imageFromFiles, projectSource } from '../src/client/project.ts';
import { parseSshTarget, sshConfigEntry, writeSshConfig } from '../src/client/ssh.ts';
import { projectNames } from '../src/layout.ts';
import { serverUrl } from '../src/positron-server.ts';
import { parseCommand } from '../src/serve.ts';
import { tarOf } from '../src/tar.ts';
import { checkImage, checkSshKey, checkUser, sanitizeUser } from '../src/validate.ts';

test('images need a specific tag and an allowed prefix', () => {
  const allowed = ['ghcr.io/fnkc-stats/'];
  assert.equal(checkImage('ghcr.io/fnkc-stats/r-env:2026.11.16-aaf87d7', allowed), 'ghcr.io/fnkc-stats/r-env:2026.11.16-aaf87d7');
  assert.throws(() => checkImage('ghcr.io/fnkc-stats/r-env', allowed), /no tag/);
  assert.throws(() => checkImage('ghcr.io/fnkc-stats/r-env:latest', allowed), /latest/);
  assert.throws(() => checkImage('ghcr.io/fnkc-stats/r-env@sha256:abc', allowed), /digest/);
  assert.throws(() => checkImage('docker.io/library/ubuntu:24.04', allowed), /not allowed/);
  assert.throws(() => checkImage('ghcr.io/fnkc-stats/r-env:1 --privileged', allowed), /invalid image/);
  assert.equal(checkImage('localhost:5000/x:1', []), 'localhost:5000/x:1');
});

test('user names cannot make container names collide', () => {
  assert.equal(sanitizeUser('Anna.Ivanova'), 'annaivanova');
  assert.equal(sanitizeUser('1st'), 'u1st');
  assert.throws(() => checkUser('a-b'));
  assert.notEqual(projectNames('a', 'b-c').container, projectNames(sanitizeUser('a-b'), 'c').container);
});

test('ssh keys are one line of a known type', () => {
  assert.ok(checkSshKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL alice@laptop\n'));
  assert.throws(() => checkSshKey('ssh-ed25519 AAAA\nssh-ed25519 BBBB'));
  assert.throws(() => checkSshKey('command="sh" ssh-ed25519 AAAA'));
});

test('agent config checks limits', () => {
  const c = agentConfig('alice', { limits: { memory: '64g', cpus: 16 } });
  assert.deepEqual(c.limits, { memory: '64g', cpus: '16' });
  assert.deepEqual(c.allowedImages, ['ghcr.io/fnkc-stats/']);
  assert.throws(() => agentConfig('alice', { limits: { memory: '1g; rm -rf /' } }));
});

test('the forced command only accepts agent commands', () => {
  assert.deepEqual(parseCommand('positron-ctl agent stop thesis'), ['stop', 'thesis']);
  assert.deepEqual(parseCommand('agent list'), ['list']);
  assert.throws(() => parseCommand('bash -i'));
  assert.throws(() => parseCommand(''));
});

test('project source and image', () => {
  assert.deepEqual(projectSource('thesis', ['git@gitea.lan:stats', 'ssh://git@gitea2:2221/stats/']), {
    name: 'thesis',
    urls: ['git@gitea.lan:stats/thesis.git', 'ssh://git@gitea2:2221/stats/thesis.git'],
  });
  assert.equal(projectSource('git@gitea.lan:stats/thesis.git', []).name, 'thesis');
  assert.equal(imageFromFiles('{"image": "r:1"}', undefined), 'r:1');
  assert.equal(imageFromFiles(undefined, '{\n // c\n "image": "r:2"\n}'), 'r:2');
  assert.equal(imageFromFiles(undefined, undefined), undefined);
  assert.throws(() => imageFromFiles('{"build": {}}', undefined), /no "image"/);
});

test('server download url', () => {
  const t = 'https://cdn.posit.co/positron/${quality}/reh/${arch-long}/positron-reh-${os}-${arch}-${version}.tar.gz';
  assert.equal(serverUrl(t, 'releases', '2026.07.1-5', 'x64'),
    'https://cdn.posit.co/positron/releases/reh/x86_64/positron-reh-linux-x64-2026.07.1-5.tar.gz');
});

test('ssh targets and config', () => {
  assert.deepEqual(parseSshTarget('ssh://positron@srv.lan:2222'), { dest: 'positron@srv.lan', port: '2222' });
  assert.deepEqual(parseSshTarget('positron@srv.lan'), { dest: 'positron@srv.lan', port: undefined });
  assert.throws(() => parseSshTarget('positron@srv lan'));
  const e = sshConfigEntry('thesis', 'server', { port: 4022, jump: { dest: 'positron@srv', port: '2222' } });
  assert.match(e, /^Host positron-thesis$/m);
  assert.match(e, /ProxyJump positron@srv:2222/);

  const dir = mkdtempSync(join(tmpdir(), 'pctl-'));
  writeFileSync(join(dir, 'config'), 'Host a\n  User b\n');
  assert.ok(writeSshConfig(dir, 'thesis', 'local', { port: 4022 }));
  assert.equal(writeSshConfig(dir, 'thesis', 'local', { port: 4023 }), undefined);
  assert.match(readFileSync(join(dir, 'config'), 'utf8'), /^# .*\nInclude positron\/\*\.conf\n\nHost a/);
  assert.match(readFileSync(join(dir, 'positron', 'thesis.conf'), 'utf8'), /Port 4023/);
});

test('client config defaults to this computer only', () => {
  const c = clientConfig();
  assert.deepEqual(c.hosts, [{ name: 'local', ssh: undefined }]);
  assert.throws(() => clientConfig({ hosts: [{ name: 'a' }, { name: 'a' }] }), /unique/);
});

test('tar archives unpack with system tar, modes kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-tar-'));
  const big = 'x'.repeat(1000);
  writeFileSync(join(dir, 'a.tar'), tarOf([
    { name: 'usr/bin/run', mode: 0o755, data: '#!/bin/sh\necho hi\n' },
    { name: 'data.txt', mode: 0o644, data: big },
  ]));
  execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir });
  assert.equal(readFileSync(join(dir, 'usr/bin/run'), 'utf8'), '#!/bin/sh\necho hi\n');
  assert.equal(statSync(join(dir, 'usr/bin/run')).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(dir, 'data.txt'), 'utf8'), big);
});

test('local engine setting', () => {
  assert.deepEqual(clientConfig({ localEngine: 'wsl', wslDistro: 'pos2' }).engine, { engine: 'wsl', wslDistro: 'pos2' });
  assert.equal(clientConfig().engine.engine, 'auto');
  assert.throws(() => clientConfig({ localEngine: 'podman' }), /localEngine/);
});

test('authorized_keys lines for server users', async () => {
  const { authorizedKeysLine, usersIn, withoutUser } = await import('../src/admin.ts');
  const line = authorizedKeysLine('anna', 'ssh-ed25519 AAAAC3Nz anna@laptop', { node: '/usr/bin/node', cli: '/opt/positron-ctl/positron-ctl.cjs' });
  assert.equal(line, 'command="/usr/bin/node /opt/positron-ctl/positron-ctl.cjs serve --user anna",restrict,port-forwarding,permitopen="127.0.0.1:*" ssh-ed25519 AAAAC3Nz positron-ctl:anna');
  const text = `ssh-ed25519 ADMIN admin@pc\n${line}\n`;
  assert.deepEqual(usersIn(text), ['anna']);
  assert.deepEqual(withoutUser(text, 'anna'), ['ssh-ed25519 ADMIN admin@pc']);
  assert.throws(() => authorizedKeysLine('Anna', 'ssh-ed25519 AAAA', { node: 'n', cli: 'c' }));
});

test('Gitea ssh target from gitRemotes', async () => {
  const { gitSshTarget } = await import('../src/client/ssh.ts');
  assert.deepEqual(gitSshTarget('ssh://git@gitea.lan:2221/stats'), { dest: 'git@gitea.lan', port: '2221' });
  assert.deepEqual(gitSshTarget('git@gitea.lan:stats'), { dest: 'git@gitea.lan' });
  assert.equal(gitSshTarget('https://gitea.lan/stats'), undefined);
});

test('memory display and extension skip list', async () => {
  const { shortMemory } = await import('../src/protocol.ts');
  assert.equal(shortMemory('1.43GiB / 8GiB'), '1.4 of 8.0 GB');
  assert.equal(shortMemory('512MiB / 7.654GiB'), '0.5 of 7.7 GB');
  assert.equal(shortMemory('odd'), 'odd');
  assert.ok(agentConfig('anna').skipExtensions.includes('ms-toolsai.'));
  assert.deepEqual(agentConfig('anna', { skipExtensions: [] }).skipExtensions, []);
  assert.throws(() => agentConfig('anna', { skipExtensions: ['x; rm -rf /'] }));
  assert.equal(agentConfig('anna').idleMinutes, 60);
});
