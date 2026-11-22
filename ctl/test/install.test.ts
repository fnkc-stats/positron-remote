// The server installer's helpers that run without root: the trust-root refresh (also from a file, for servers without
// GitHub access) and the agent.json check. install.sh itself (whole releases, --rollback, keeping the trust root
// when GitHub is unreachable) runs as root in test/e2e.sh.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
