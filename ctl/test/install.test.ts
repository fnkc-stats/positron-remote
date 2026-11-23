// The server installer's helpers that run without root: the trust-root refresh (also from a file, for servers without
// GitHub access), the agent.json check, and install.sh's release switch (releases, --rollback, an interrupted
// switch) in a temp prefix. install.sh as a whole (as root, keeping the trust root when GitHub is unreachable) runs
// in test/e2e.sh.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentConfig, CONFIG_KEYS, unknownConfigKeys } from '../src/agent-config.ts';

const ctl = join(__dirname, '..', '..');
const script = join(ctl, 'server', 'refresh-trust-root.sh');
const root = mkdtempSync(join(tmpdir(), 'fnkc-install-'));
after(() => rmSync(root, { recursive: true, force: true }));
const skip = process.platform === 'win32' ? 'bash scripts of the Linux server' : undefined;

const ROOT = '{"mediaType":"application/vnd.dev.sigstore.trustedroot+json;version=0.1","certificateAuthorities":[{"subject":"test"}]}\n';
let n = 0;
/** A directory with a gh that prints `out` (or fails) and the installed trust root holding "old". */
function server(gh: string | undefined) {
  const dir = join(root, String(n++));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), gh === undefined ? '#!/bin/sh\necho "no network" >&2\nexit 1\n' : `#!/bin/sh\nprintf '%s' '${gh}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const file = join(dir, 'trusted-root.jsonl');
  writeFileSync(file, 'old\n');
  const run = (...args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { dir, file, run };
}

test('the trust root is downloaded with gh and replaces the installed one', { skip }, () => {
  const s = server(ROOT);
  const r = s.run(s.file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.file, 'utf8'), ROOT);
});

test('a failed or wrong download keeps the installed trust root', { skip }, () => {
  for (const gh of [undefined, '<html>proxy login</html>', '{"other":1}']) {
    const s = server(gh);
    assert.notEqual(s.run(s.file).status, 0);
    assert.equal(readFileSync(s.file, 'utf8'), 'old\n');
  }
});

test('--from installs a trust root made on another computer, without gh, and checks it like a download', { skip }, () => {
  const s = server(undefined);
  const made = join(s.dir, 'from-laptop.jsonl');
  writeFileSync(made, ROOT);
  let r = s.run('--from', made, s.file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.file, 'utf8'), ROOT);

  writeFileSync(s.file, 'old\n');
  writeFileSync(made, 'not json\n');
  r = s.run('--from', made, s.file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not look like a trust root/);
  assert.equal(readFileSync(s.file, 'utf8'), 'old\n');
  assert.notEqual(s.run('--from', join(s.dir, 'missing'), s.file).status, 0);
  assert.equal(s.run('--from').status, 2);
});

test('install.sh and refresh-trust-root.sh are valid bash', { skip }, () => {
  for (const f of ['install.sh', 'refresh-trust-root.sh']) execFileSync('bash', ['-n', join(ctl, 'server', f)]);
});

test('the server bundle has every file install.sh installs as a release', () => {
  const files = /^FILES=\(([^)]*)\)$/m.exec(readFileSync(join(ctl, 'server', 'install.sh'), 'utf8'))![1].split(' ');
  assert.ok(files.includes('ext-owner-seccomp.json'));
  const bundle = (JSON.parse(readFileSync(join(ctl, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['server-bundle'];
  for (const f of files) assert.ok(bundle.includes(f === 'fnkc-ctl.cjs' ? 'cp dist/fnkc-ctl.cjs ' : ` server/${f} `), f);
});

test('every setting agentConfig reads is a known key, and only those', () => {
  const { user: _, ...fields } = agentConfig('alice', {});
  assert.deepEqual([...CONFIG_KEYS].sort(), Object.keys(fields).sort());
  const example = JSON.parse(readFileSync(join(ctl, 'examples', 'agent.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(unknownConfigKeys(example), []);
});

test('unknown agent.json keys are reported with the setting they are probably a typo of', () => {
  assert.deepEqual(unknownConfigKeys({ idleMinute: 60, maxProjectPerUser: 0, limits: { memroy: '8g', cpus: '2' }, comment: 'x' }), [
    { key: 'idleMinute', suggestion: 'idleMinutes' },
    { key: 'maxProjectPerUser', suggestion: 'maxProjectsPerUser' },
    { key: 'comment' },
    { key: 'limits.memroy', suggestion: 'limits.memory' },
  ]);
  assert.deepEqual(unknownConfigKeys({ IdleMinutes: 5 }), [{ key: 'IdleMinutes', suggestion: 'idleMinutes' }]);
});

test('fnkc-ctl admin check-config prints the settings in force and warns about ignored keys, without root', { skip }, () => {
  // Built from the sources (dist/ may be older: the tests run before the build)
  const cli = join(root, 'fnkc-ctl.cjs');
  execFileSync(join(ctl, 'node_modules', '.bin', 'esbuild'), [join(ctl, 'src', 'cli.ts'), '--bundle', '--platform=node', '--target=node22',
    '--format=cjs', '--loader:.sh=text', '--loader:.R=text', `--outfile=${cli}`, '--log-level=error'], { cwd: ctl });
  const file = join(root, 'agent.json');
  writeFileSync(file, JSON.stringify({ idleMinute: 60, maxProjectsPerUser: 0, keysDir: '/etc/fnkc-ctl/keys' }));
  const r = spawnSync(process.execPath, [cli, 'admin', 'check-config', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const shown = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(shown.maxProjectsPerUser, 0);
  assert.equal(shown.idleMinutes, 0);
  assert.equal(shown.requireProvenance, true);
  assert.equal(shown.user, undefined);
  assert.match(r.stderr, /"idleMinute" is not a setting and is ignored \(did you mean "idleMinutes"\?\)/);

  writeFileSync(file, '{"idleMinutes": "60"}');
  const bad = spawnSync(process.execPath, [cli, 'admin', 'check-config', file], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /idleMinutes/);
});

// install.sh's release switch in a temp prefix instead of /opt/fnkc-ctl: the script up to its release pruning (what
// follows needs root and the real system), with root, Docker and gh stubbed. Needs Linux (flock, GNU mv -T).
const linuxOnly = process.platform === 'linux' ? undefined : 'install.sh needs Linux (flock, GNU coreutils)';
test('a release switch interrupted between its two links is completed by the next run, and nothing is pruned', { skip: linuxOnly }, () => {
  const dir = join(root, String(n++));
  const prefix = join(dir, 'opt');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [['id', '[ "$1" = -u ] && echo 0 || exec /usr/bin/id "$@"'], ['docker', 'exit 0'], ['gh', 'exit 0'], ['getent', 'exit 0']]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const source = readFileSync(join(ctl, 'server', 'install.sh'), 'utf8');
  assert.match(source, /^PREFIX=\/opt\/fnkc-ctl$/m);
  assert.match(source, /^# For admins: /m);
  const installer = source.replace(/^PREFIX=\/opt\/fnkc-ctl$/m, `PREFIX='${prefix}'`).replace(/^# For admins: [^]*$/m, 'exit 0\n');
  // A copy killed right after the first of the two link updates, as a power cut or a lost SSH session stops it
  const lines = installer.split('\n');
  const first = lines.findIndex((l) => /^\s+relink "\$PREFIX\//.test(l));
  assert.ok(first > 0);
  lines.splice(first + 1, 0, 'kill -KILL $$');
  const interrupting = lines.join('\n');
  // A release from before ext-owner-seccomp.json (its installer does not know the file) stays a complete rollback target
  assert.match(installer, /^FILES=\(.* ext-owner-seccomp\.json .*\)$/m);
  const beforeProfile = (script: string) => script.replace(/^(FILES=\(.*) ext-owner-seccomp\.json/m, '$1');
  const bundle = (version: string, old = false) => {
    const b = join(dir, version);
    mkdirSync(b);
    writeFileSync(join(b, 'install.sh'), old ? beforeProfile(installer) : installer, { mode: 0o755 });
    writeFileSync(join(b, 'interrupting.sh'), old ? beforeProfile(interrupting) : interrupting, { mode: 0o755 });
    writeFileSync(join(b, 'fnkc-ctl.cjs'), `console.log('${version}');\n`);
    for (const f of ['volume-backup.sh', 'render-reviewed.py', 'refresh-trust-root.sh', ...old ? [] : ['ext-owner-seccomp.json']]) {
      writeFileSync(join(b, f), `# ${version}\n`);
    }
    return b;
  };
  const run = (script: string, ...args: string[]) =>
    spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const ok = (r: ReturnType<typeof run>) => assert.equal(r.status, 0, r.stderr + r.stdout);
  const links = () => [readlinkSync(join(prefix, 'current')), readlinkSync(join(prefix, 'previous-release'))];
  const active = () => readFileSync(join(prefix, 'fnkc-ctl.cjs'), 'utf8');
  const rollback = () => run(join(prefix, 'install.sh'), '--rollback', '--yes');

  const a = bundle('0.9.0', true), b = bundle('0.9.1');
  ok(run(join(a, 'install.sh')));
  ok(run(join(b, 'install.sh')));
  const [relB, relA] = links();
  assert.match(active(), /0\.9\.1/);
  assert.ok(existsSync(join(prefix, 'current', 'ext-owner-seccomp.json')), 'the profile is in the release, next to fnkc-ctl.cjs');
  assert.ok(!existsSync(join(prefix, relA, 'ext-owner-seccomp.json')));

  // An interrupted rollback: the next --rollback completes it and says so, instead of refusing
  assert.equal(run(join(b, 'interrupting.sh'), '--rollback', '--yes').signal, 'SIGKILL');
  assert.deepEqual(links(), [relB, relB], 'stopped between the two links');
  let r = rollback();
  ok(r);
  assert.match(r.stdout, /interrupted/);
  assert.deepEqual(links(), [relA, relB]);
  assert.match(active(), /0\.9\.0/);
  // Then rollback works as before, both ways
  ok(rollback());
  assert.deepEqual(links(), [relB, relA]);
  assert.match(active(), /0\.9\.1/);

  // An interrupted rollback followed by an install of the active version: the former release is not pruned
  assert.equal(run(join(b, 'interrupting.sh'), '--rollback', '--yes').signal, 'SIGKILL');
  ok(run(join(b, 'install.sh')));
  assert.deepEqual(links(), [relB, relA]);
  assert.deepEqual(readdirSync(join(prefix, 'releases')).sort(), [relA, relB].map((l) => l.replace('releases/', '')).sort());

  // An interrupted upgrade: the next run completes it, and rollback has the release it replaced
  const c = bundle('0.9.2');
  assert.equal(run(join(c, 'interrupting.sh')).signal, 'SIGKILL');
  r = run(join(c, 'install.sh'));
  ok(r);
  assert.match(r.stdout, /interrupted/);
  const [relC, prev] = links();
  assert.equal(prev, relB);
  assert.match(active(), /0\.9\.2/);
  ok(rollback());
  assert.deepEqual(links(), [relB, relC]);

  // An interrupted rollback whose release is damaged meanwhile: undone, the active release stays
  assert.equal(run(join(c, 'interrupting.sh'), '--rollback', '--yes').signal, 'SIGKILL');
  rmSync(join(prefix, relC, 'volume-backup.sh'));
  r = rollback();
  ok(r);
  assert.match(r.stdout, /Undid an interrupted switch/);
  assert.deepEqual(links(), [relB, relC]);
  assert.match(active(), /0\.9\.1/);
});
