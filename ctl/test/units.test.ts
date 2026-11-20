import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentConfig } from '../src/agent-config.ts';
import { clientConfig } from '../src/client/config.ts';
import { imageRepository, latestEnvironments, releaseVersions } from '../src/client/build.ts';
import { positronTag } from '../src/client/variant.ts';
import { newer } from '../src/client/update.ts';
import { graphicalPinentry, pinentryProgram } from '../src/client/doctor.ts';
import { decryptionApproved, keyFileFor, secretFingerprints } from '../src/client/decrypt.ts';
import { imageFromFile, projectSource } from '../src/client/project.ts';
import { parseSshTarget, sshConfigEntry, writeSshConfig } from '../src/client/ssh.ts';
import { projectNames } from '../src/layout.ts';
import { parseCommand } from '../src/serve.ts';
import { tarOf } from '../src/tar.ts';
import { checkImage, checkSshKey, checkUser, sanitizeUser } from '../src/validate.ts';

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
  assert.deepEqual(c.allowedImages, ['ghcr.io/fnkc-stats/r-env']);
  assert.throws(() => agentConfig('alice', { limits: { memory: '1g; rm -rf /' } }));
});

test('the forced command only accepts agent commands', () => {
  assert.deepEqual(parseCommand('fnkc-ctl agent stop thesis'), ['stop', 'thesis']);
  assert.deepEqual(parseCommand('agent list'), ['list']);
  assert.throws(() => parseCommand('bash -i'));
  assert.throws(() => parseCommand(''));
});

test('project source and image', () => {
  assert.deepEqual(projectSource('thesis', ['git@gitea.lan:stats', 'ssh://git@gitea2:2221/stats/']), {
    name: 'thesis',
    urls: ['git@gitea.lan:stats/thesis.git'],
  });
  assert.equal(projectSource('git@gitea.lan:stats/thesis.git', []).name, 'thesis');
  // owner/name and links from Gitea's web pages: cloned over SSH from the server of the git remote
  const remotes = ['ssh://git@Gitea.lan:2221/stats/'];
  const ssh = { name: 'thesis', urls: ['ssh://git@Gitea.lan:2221/a.ivanova/thesis.git'] };
  assert.deepEqual(projectSource('a.ivanova/thesis', remotes), ssh);
  assert.deepEqual(projectSource(' a.ivanova/thesis.git ', remotes), ssh);
  assert.deepEqual(projectSource('https://gitea.lan/a.ivanova/thesis', remotes), ssh);
  assert.deepEqual(projectSource('https://gitea.lan:3000/a.ivanova/thesis.git', remotes), ssh);
  assert.deepEqual(projectSource('http://gitea.lan/a.ivanova/thesis/src/branch/main/R/analysis.R?display=source', remotes), ssh);
  assert.deepEqual(projectSource('a.ivanova/thesis', ['git@gitea.lan:stats']), { name: 'thesis', urls: ['git@gitea.lan:a.ivanova/thesis.git'] });
  assert.deepEqual(projectSource('stats/thesis', remotes).urls, ['ssh://git@Gitea.lan:2221/stats/thesis.git']);
  // a link to another server stays as given
  assert.deepEqual(projectSource('https://github.com/org/thesis.git', remotes).urls, ['https://github.com/org/thesis.git']);
  assert.throws(() => projectSource('a.ivanova/..', remotes));
  assert.throws(() => projectSource('../thesis', remotes));
  assert.throws(() => projectSource('a.ivanova/thesis', []), /gitRemotes is not set/);
  assert.equal(imageFromFile('{"image": "r:1"}'), 'r:1');
  assert.throws(() => imageFromFile(undefined), /requires container.json/);
  assert.throws(() => imageFromFile('{"build": {}}'), /image/);
});

test('ssh targets and config', () => {
  assert.deepEqual(parseSshTarget('ssh://fnkc@srv.lan:2222'), { dest: 'fnkc@srv.lan', port: '2222' });
  assert.deepEqual(parseSshTarget('fnkc@srv.lan'), { dest: 'fnkc@srv.lan', port: undefined });
  assert.throws(() => parseSshTarget('fnkc@srv lan'));
  const dir = mkdtempSync(join(tmpdir(), 'pctl-'));
  const connection = { port: 4022, project: 'thesis', alias: 'local-thesis', knownHosts: join(dir, 'hosts'), hostKey: 'ssh-ed25519 AAAA' };
  const e = sshConfigEntry('thesis', 'server', { ...connection, alias: 'thesis', jump: { dest: 'fnkc@srv', port: '2222' } });
  assert.match(e, /^Host thesis$/m);
  assert.match(e, /ProxyCommand/);
  assert.match(e, /agent.*connect.*thesis/);
  assert.match(e, /ForwardAgent no/);

  writeFileSync(join(dir, 'config'), 'Host a\n  User b\n');
  assert.ok(writeSshConfig(dir, 'thesis', 'local', connection));
  assert.equal(writeSshConfig(dir, 'thesis', 'local', { ...connection, port: 4023 }), undefined);
  assert.match(readFileSync(join(dir, 'config'), 'utf8'), /^# Added by FNKC Projects.*\nInclude fnkc\/\*\.conf\n\nHost a/);
  assert.match(readFileSync(join(dir, 'fnkc', 'local-thesis.conf'), 'utf8'), /Port 4023/);
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
  const line = authorizedKeysLine('anna', 'ssh-ed25519 AAAAC3Nz anna@laptop', { node: '/usr/bin/node', cli: '/opt/fnkc-ctl/fnkc-ctl.cjs' });
  assert.equal(line, 'command="/usr/bin/node /opt/fnkc-ctl/fnkc-ctl.cjs serve --user anna",restrict ssh-ed25519 AAAAC3Nz fnkc-ctl:anna');
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

test('image settings', () => {
  assert.equal(agentConfig('anna').pullImages, false);
  assert.equal(agentConfig('anna', { pullImages: true }).pullImages, true);
  assert.throws(() => agentConfig('anna', { pullImages: 'yes' }));
  assert.equal(agentConfig('anna', { imageStagingDir: '/var/lib/fnkc-ctl/images' }).imageStagingDir, '/var/lib/fnkc-ctl/images');
});

test('image references, uploaded tags and manifest checks', async () => {
  const { imageManifest, parseReference, platformManifest, uploadedTag } = await import('../src/oci.ts');
  const d = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(parseReference(`ghcr.io/fnkc-stats/r-env@${d}`), { registry: 'ghcr.io', repository: 'fnkc-stats/r-env', digest: d });
  assert.deepEqual(parseReference(`ghcr.io/fnkc-stats/r-env:v1@${d}`), { registry: 'ghcr.io', repository: 'fnkc-stats/r-env', digest: d });
  assert.deepEqual(parseReference(`rocker/r-ver@${d}`), { registry: 'registry-1.docker.io', repository: 'rocker/r-ver', digest: d });
  assert.deepEqual(parseReference(`ubuntu@${d}`), { registry: 'registry-1.docker.io', repository: 'library/ubuntu', digest: d });
  assert.deepEqual(parseReference(`localhost:5000/r-env@${d}`), { registry: 'localhost:5000', repository: 'r-env', digest: d });
  assert.throws(() => parseReference('ghcr.io/fnkc-stats/r-env:latest'));
  assert.equal(uploadedTag(`ghcr.io/fnkc-stats/r-env:v1@${d}`), `ghcr.io/fnkc-stats/r-env:sha256-${'a'.repeat(64)}`);
  assert.equal(uploadedTag(`localhost:5000/r-env@${d}`), `localhost:5000/r-env:sha256-${'a'.repeat(64)}`);
  const layer = (mediaType: string) => ({ mediaType, digest: d, size: 1 });
  const manifest = (layers: unknown[]) => Buffer.from(JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', config: layer('application/vnd.oci.image.config.v1+json'), layers }));
  assert.equal(imageManifest(manifest([layer('application/vnd.docker.image.rootfs.diff.tar.gzip')])).layers.length, 1);
  assert.throws(() => imageManifest(manifest([layer('application/vnd.oci.image.layer.v1.tar+zstd')])), /unsupported layer/);
  assert.throws(() => imageManifest(manifest([{ ...layer('application/vnd.oci.image.layer.v1.tar'), digest: 'sha256:x' }])), /invalid layer/);
  assert.throws(() => imageManifest(manifest([{ ...layer('application/vnd.oci.image.layer.v1.tar'), size: 64 * 1024 ** 3 }])), /too large/);
  const index = Buffer.from(JSON.stringify({ manifests: [{ ...layer('application/vnd.oci.image.manifest.v1+json'), platform: { os: 'linux', architecture: 'amd64' } }] }));
  assert.equal(platformManifest(index, 'x64').digest, d);
  assert.throws(() => platformManifest(index, 'arm64'), /no linux\/arm64/);
});

test('the user\'s GPG key finds its copy of the project key', () => {
  const A = 'A'.repeat(40), B = 'b'.repeat(40), S = 'C'.repeat(40), P = 'D'.repeat(40);
  const colons = [`sec:u:255:22:1:1::::::scESC:`, `fpr:::::::::${A}:`, `ssb:u:255:18:2:1::::::e:`, `fpr:::::::::${S}:`,
    `pub:u:255:22:3:1::::::scESC:`, `fpr:::::::::${P}:`, `sec:u:255:22:4:1::::::scESC:`, `fpr:::::::::${B}:`].join('\n');
  assert.deepEqual(secretFingerprints(colons), [A, S, B.toUpperCase()]);
  assert.equal(keyFileFor([`${P}.gpg`, `${B.toUpperCase()}.gpg`], secretFingerprints(colons)), `${B.toUpperCase()}.gpg`);
  assert.equal(keyFileFor([`${P}.gpg`, 'README', ''], [A]), undefined);
  const cfg = clientConfig({ hosts: [{ name: 'local' }, { name: 'server', ssh: 'fnkc@server' }] });
  assert.equal(decryptionApproved(cfg, cfg.hosts[0]), true);
  assert.equal(decryptionApproved(cfg, cfg.hosts[1]), false);
  const approved = clientConfig({ hosts: cfg.hosts, decryptionHosts: ['server'] });
  assert.equal(decryptionApproved(approved, approved.hosts[1]), true);
});

test('Check Setup finds the pinentry gpg-agent uses', () => {
  const components = 'gpg:OpenPGP:/opt/homebrew/bin/gpg\npinentry:Passphrase Entry:/opt/homebrew/opt/pinentry/bin/pinentry\n';
  assert.equal(pinentryProgram(undefined, components), '/opt/homebrew/opt/pinentry/bin/pinentry');
  assert.equal(pinentryProgram('# x\npinentry-program /opt/homebrew/bin/pinentry-mac\n', components), '/opt/homebrew/bin/pinentry-mac');
  for (const p of ['/opt/homebrew/Cellar/pinentry-mac/1.3/pinentry-mac.app/Contents/MacOS/pinentry-mac', '/usr/bin/pinentry-gnome3',
    '/usr/bin/pinentry-qt', 'C:\\Program Files (x86)\\GnuPG\\bin\\pinentry-basic.exe']) assert.ok(graphicalPinentry(p), p);
  for (const p of ['/opt/homebrew/Cellar/pinentry/1.3/bin/pinentry-curses', '/usr/bin/pinentry-tty']) assert.ok(!graphicalPinentry(p), p);
});

test('builds: the newest environment of each series, the image repository, Positron releases', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(latestEnvironments([`4.6-env-${sha}-10-1`, `4.6-env-${sha}-12-1`, `4.6-env-${sha}-12-2-amd64`, `4.5-env-${sha}-11-1`,
    `4.6-${sha}-99-1`, `positron-2026.07.1-5-${'b'.repeat(64)}`, `4.10-env-${sha}-1-1`]),
  [{ series: '4.10', tag: `4.10-env-${sha}-1-1` }, { series: '4.6', tag: `4.6-env-${sha}-12-1` }, { series: '4.5', tag: `4.5-env-${sha}-11-1` }]);
  assert.equal(positronTag(DIGEST, '2026.07.1-5'), `positron-2026.07.1-5-${'a'.repeat(64)}`);
  assert.deepEqual(imageRepository(clientConfig({ envRepository: 'FNKC-Stats/positron-remote' })), { registry: 'ghcr.io', repository: 'fnkc-stats/r-env' });
  assert.throws(() => imageRepository(clientConfig({ envRepository: 'no-slash' })));
  assert.deepEqual(releaseVersions('2026.09.1-2\n2026.10.0-297\nnightly\n2026.10.10-1\n2026.09.1-2\n'), ['2026.10.10-1', '2026.10.0-297', '2026.09.1-2']);
});

test('extension versions compare by number', () => {
  assert.ok(newer('0.3.10', '0.3.9'));
  assert.ok(newer('1.0.0', '0.9.99'));
  assert.ok(!newer('0.3.5', '0.3.5'));
  assert.ok(!newer('0.3.4', '0.3.10'));
});

test('a cancelled command is killed and reported as Cancelled', async () => {
  const { run, Cancelled } = await import('../src/exec.ts');
  const stop = new AbortController();
  const started = Date.now();
  const pending = run('sleep', ['10'], { signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(pending, (e) => e instanceof Cancelled);
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(run('true', [], { signal: stop.signal }), (e) => e instanceof Cancelled);
});

test('the image cache keeps the image just sent and drops the least recently used beyond its limit', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pruneImageCache, clearImageCache, imageCacheSize } = await import('../src/client/image-download.ts');
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-cache-'));
  try {
    const blobs = join(dir, 'images', 'blobs');
    mkdirSync(blobs, { recursive: true });
    const hex = (c: string) => c.repeat(64);
    const put = (c: string, ageDays: number) => {
      writeFileSync(join(blobs, hex(c)), Buffer.alloc(1000));
      const t = new Date(Date.now() - ageDays * 86_400_000); utimesSync(join(blobs, hex(c)), t, t);
    };
    put('a', 30); put('b', 20); put('c', 10);
    const keep = { manifests: [], blobs: [{ digest: `sha256:${hex('a')}`, size: 1000, mediaType: 'x' }], size: 1000 };
    assert.equal(pruneImageCache(dir, 2000, keep), 1000);
    assert.ok(existsSync(join(blobs, hex('a'))), 'the image just sent stays, although it is the oldest');
    assert.ok(!existsSync(join(blobs, hex('b'))), 'the least recently used other blob goes');
    assert.equal(imageCacheSize(dir), 2000);
    assert.equal(clearImageCache(dir), 2000);
    assert.equal(imageCacheSize(dir), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
