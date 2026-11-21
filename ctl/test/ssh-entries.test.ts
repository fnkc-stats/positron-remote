import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containerSshArgs, sshConfigEntry, type ContainerSsh } from '../src/client/ssh.ts';

const local: ContainerSsh = { port: 2222, project: 'thesis', alias: 'local-thesis', knownHosts: '/k', hostKey: 'ssh-ed25519 AAAA' };

test("fnkc-ctl's own ssh overrides a ProxyJump/ProxyCommand for all hosts; the local entry has no 'none' Positron would misread", () => {
  const entry = sshConfigEntry('thesis', 'local', local);
  assert.doesNotMatch(entry, /Proxy(Command|Jump)/);
  const args = containerSshArgs(local);
  assert.ok(args.includes('ProxyCommand=none') && args.includes('ProxyJump=none'));
});

test('a server project keeps its broker ProxyCommand and no override', () => {
  const entry = sshConfigEntry('thesis', 'server', { ...local, alias: 'thesis', jump: { dest: 'fnkc@server' } });
  assert.match(entry, /ProxyCommand '?ssh/);
  assert.doesNotMatch(entry, /ProxyJump none/);
});
