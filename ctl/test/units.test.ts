import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentConfig } from '../src/agent-config.ts';
import { clientConfig } from '../src/client/config.ts';
import { imageFromFile, projectSource } from '../src/client/project.ts';
import { parseSshTarget, sshConfigEntry, writeSshConfig } from '../src/client/ssh.ts';
import { libraryVolume, projectNames } from '../src/layout.ts';
import { checkLockfile, lockfileHash } from '../src/library.ts';
import { CHECK_FILES } from '../src/checks.ts';
import { serverUrl } from '../src/positron-server.ts';
import { parseCommand } from '../src/serve.ts';
import { tarOf } from '../src/tar.ts';
import { manifestLibrary, repositoryId } from '../src/repository.ts';
import { checkImage, checkLibrary, checkSshKey, checkUser, sanitizeUser } from '../src/validate.ts';

const DIGEST = 'ghcr.io/fnkc-stats/r-env@sha256:' + 'a'.repeat(64);
test('images require immutable digests and exact approved repositories', () => {
  const allowed = ['ghcr.io/fnkc-stats/r-env'];
  assert.equal(checkImage(DIGEST, allowed), DIGEST);
  for (const bad of ['ghcr.io/fnkc-stats/r-env:latest', 'ghcr.io/fnkc-stats/r-env:dated-tag',
    DIGEST.replace('r-env@', 'r-env-evil@'), DIGEST.slice(0, -1)]) assert.throws(() => checkImage(bad, allowed));
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
  assert.deepEqual(c.limits, { memory: '64g', cpus: '16', pids: 512 });
  assert.deepEqual(c.allowedImages, ['ghcr.io/fnkc-stats/r-env', 'ghcr.io/fnkc-stats/r-base']);
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
    name: repositoryId('git@gitea.lan:stats/thesis.git'),
    urls: ['git@gitea.lan:stats/thesis.git'],
  });
  assert.equal(projectSource('git@gitea.lan:stats/thesis.git', []).name, repositoryId('git@gitea.lan:stats/thesis.git'));
  assert.equal(imageFromFile('{"image": "r:1"}'), 'r:1');
  assert.throws(() => imageFromFile(undefined), /requires container.json/);
  assert.throws(() => imageFromFile('{"build": {}}'), /image/);
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
  const dir = mkdtempSync(join(tmpdir(), 'pctl-'));
  const connection = { port: 4022, project: 'thesis', alias: 'positron-local--thesis', knownHosts: join(dir, 'hosts'), hostKey: 'ssh-ed25519 AAAA' };
  const e = sshConfigEntry('thesis', 'server', { ...connection, jump: { dest: 'positron@srv', port: '2222' } });
  assert.match(e, /^Host positron-server--thesis$/m);
  assert.match(e, /ProxyCommand/);
  assert.match(e, /agent.*connect.*thesis/);
  assert.match(e, /ForwardAgent no/);

  writeFileSync(join(dir, 'config'), 'Host a\n  User b\n');
  assert.ok(writeSshConfig(dir, 'thesis', 'local', connection));
  assert.equal(writeSshConfig(dir, 'thesis', 'local', { ...connection, port: 4023 }), undefined);
  assert.match(readFileSync(join(dir, 'config'), 'utf8'), /^Include positron\/\*\.conf\n\nHost a/);
  assert.match(readFileSync(join(dir, 'positron', 'positron-local--thesis.conf'), 'utf8'), /Port 4023/);
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
  assert.equal(line, 'command="/usr/bin/node /opt/positron-ctl/positron-ctl.cjs serve --user anna",restrict ssh-ed25519 AAAAC3Nz positron-ctl:anna');
  const text = `ssh-ed25519 ADMIN admin@pc\n${line}\n`;
  assert.deepEqual(usersIn(text), ['anna']);
  assert.deepEqual(withoutUser(text, 'anna'), ['ssh-ed25519 ADMIN admin@pc']);
  assert.throws(() => authorizedKeysLine('Anna', 'ssh-ed25519 AAAA', { node: 'n', cli: 'c' }));
});

test('Gitea ssh target from gitRemotes', async () => {
  const { gitSshTarget } = await import('../src/client/ssh.ts');
  assert.deepEqual(gitSshTarget('ssh://git@gitea.lan:2221/stats'), { dest: 'git@gitea.lan', port: '2221' });
  assert.deepEqual(gitSshTarget('git@gitea.lan:stats'), { dest: 'git@gitea.lan', port: undefined });
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
  assert.equal(agentConfig('anna').idleMinutes, 0);
});

test('shared renv cache setting', () => {
  assert.equal(agentConfig('anna').sharedRenvCache, true);
  assert.equal(agentConfig('anna', { sharedRenvCache: false }).sharedRenvCache, false);
  assert.throws(() => agentConfig('anna', { sharedRenvCache: 'no' }));
});

test('R package repository setting', () => {
  assert.equal(agentConfig('anna').rRepository, 'https://cloud.r-project.org');
  assert.equal(agentConfig('anna', { rRepository: 'https://cran.example.lan/' }).rRepository, 'https://cran.example.lan');
  assert.throws(() => agentConfig('anna', { rRepository: 'https://x; rm -rf /' }));
  assert.throws(() => agentConfig('anna', { rRepository: 'ftp://x' }));
});

test('container.json may pin an R library by its lockfile hash', () => {
  const lib = `sha256:${'f'.repeat(64)}`;
  assert.equal(manifestLibrary(JSON.stringify({ image: DIGEST, library: lib })), lib);
  assert.equal(manifestLibrary(JSON.stringify({ image: DIGEST })), undefined);
  for (const bad of ['f'.repeat(64), 'sha256:' + 'F'.repeat(64), 'sha256:abc', 42]) {
    assert.throws(() => manifestLibrary(JSON.stringify({ image: DIGEST, library: bad })), /library must be/);
  }
  assert.throws(() => checkLibrary('sha256:' + 'f'.repeat(64) + '\n'));
});

test('library volumes are per image ID and lockfile, and lockfiles are checked', () => {
  const lock = JSON.stringify({ R: { Version: '4.5.1' }, Packages: { cli: { Package: 'cli', Version: '3.6.5' } } });
  const hash = lockfileHash(lock);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, lockfileHash(Buffer.from(lock)), 'the same hash as sha256sum of the file');
  const v = libraryVolume('sha256:' + '1'.repeat(64), hash);
  assert.equal(v, `positron-rlib-${'1'.repeat(16)}-${hash.slice(7, 23)}`);
  assert.notEqual(v, libraryVolume('sha256:' + '2'.repeat(64), hash), 'another image gets another library');
  assert.doesNotThrow(() => checkLockfile(lock));
  for (const bad of ['not json', '{}', JSON.stringify({ R: { Version: '4.5.1' }, Packages: {} })]) assert.throws(() => checkLockfile(bad));
});

test('every file of checks/ is embedded for build-library', () => {
  const root = join(__dirname, '..', '..', '..', 'checks');
  const onDisk = ['check.R', ...['lib', 'tasks'].flatMap((d) => readdirSync(join(root, d)).map((f) => `${d}/${f}`))].sort();
  assert.deepEqual(Object.keys(CHECK_FILES).sort(), onDisk);
  for (const f of onDisk) assert.equal(CHECK_FILES[f], readFileSync(join(root, f), 'utf8'));
});
