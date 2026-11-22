// The server's request journal (journal.ts): line format, key fingerprints, one line per request with its outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entry, formatLine, formatSupportExport, keyFingerprint, parseLine, readJournal, sshClient, startFields, supportExport } from '../src/journal.ts';
import { QuotaExceeded } from '../src/errors.ts';
import { CTL_VERSION } from '../src/protocol.ts';
import { answer } from '../src/serve.ts';

test('a line is key=value pairs; values that could split or fake a field are quoted', () => {
  assert.equal(formatLine({ user: 'anna', command: 'stop', project: 'study', missing: undefined, empty: '' }), 'user=anna command=stop project=study');
  assert.equal(formatLine({ error: 'project is not running' }), 'error="project is not running"');
  assert.equal(formatLine({ error: 'a\nuser=root', q: 'say "hi"', eq: 'a=b' }), 'error="a\\nuser=root" q="say \\"hi\\"" eq="a=b"');
  assert.equal(formatLine({ esc: '\x1b[31mred' }), 'esc="\\u001b[31mred"');
  assert.equal(formatLine({ created: true, ms: 12 }), 'created=true ms=12');
  assert.match(formatLine({ long: 'x'.repeat(5000) }), /^long="x{1000}…"$/);
});

test('the key fingerprint is the one sshd logs (ssh-keygen -lf)', { skip: !hasSshKeygen() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'anna', '-f', join(dir, 'k')]);
  const expected = execFileSync('ssh-keygen', ['-lf', join(dir, 'k.pub')], { encoding: 'utf8' }).split(' ')[1];
  assert.equal(keyFingerprint(readFileSync(join(dir, 'k.pub'), 'utf8')), expected);
  assert.equal(keyFingerprint(''), undefined);
});

test('client address from SSH_CONNECTION; start fields from whatever the client sent', () => {
  assert.equal(sshClient({ SSH_CONNECTION: '10.0.0.7 51234 10.0.0.1 22' }), '10.0.0.7');
  assert.equal(sshClient({}), undefined);
  assert.deepEqual(startFields(JSON.stringify({ project: 'study', revision: 'abc', image: 'ghcr.io/x/r-env@sha256:00', positron: { version: '2026.11.1-4', commit: 'c' }, client: '0.4.41', sshPublicKey: 'ssh-ed25519 AAAA' })),
    { project: 'study', revision: 'abc', image: 'ghcr.io/x/r-env@sha256:00', positron: '2026.11.1-4', client: '0.4.41' });
  assert.deepEqual(startFields('not json'), {});
  assert.deepEqual(startFields('{"project": 5, "positron": "x"}'), { project: undefined, revision: undefined, image: undefined, positron: undefined, client: undefined });
});

test('one line per request, with result, error, warnings and duration', async () => {
  const lines: [string, boolean][] = [];
  const write = (l: string, failed: boolean) => { lines.push([l, failed]); };
  const shown: string[] = [];
  const entry = new Entry({ user: 'anna', command: 'start' }, write);
  const log = entry.tee({ info: (m) => shown.push(m), warn: (m) => shown.push(`W ${m}`) });
  log.info('Starting');
  log.warn('setup changed');
  entry.set({ project: 'study' });
  entry.end();
  entry.end(new Error('second call writes nothing'));
  assert.deepEqual(shown, ['Starting', 'W setup changed'], 'the user still sees every message');
  assert.equal(lines.length, 1);
  assert.match(lines[0][0], new RegExp(`^user=anna command=start project=study ms=\\d+ result=ok warnings="setup changed" ctl=${CTL_VERSION.replace(/\./g, '\\.')}$`));
  assert.equal(lines[0][1], false);

  const failed = new Entry({ user: 'anna', command: 'stop' }, write);
  failed.end(new Error('project is not running'));
  assert.match(lines[1][0], /^user=anna command=stop ms=\d+ result=error error="project is not running" ctl=\S+$/);
  assert.equal(lines[1][1], true);

  const coded = new Entry({ user: 'anna', command: 'start' }, write);
  coded.end(new QuotaExceeded('project quota reached'));
  assert.match(lines[2][0], /^user=anna command=start ms=\d+ result=error code=quota error="project quota reached" ctl=\S+$/);
});

test('a written line parses back to its fields; anything else does not parse', () => {
  const fields = { user: 'anna', error: 'a\nuser=root "x"', eq: 'a=b', ms: '12', esc: '\x1b[31m' };
  assert.deepEqual(parseLine(formatLine(fields)), fields);
  assert.equal(parseLine('Started session 5 of user fnkc.'), undefined);
  assert.equal(parseLine('error="cut'), undefined);
  assert.equal(parseLine(''), undefined);
});

// Audit 2026-11-22 ops #6: an excerpt pasted into a ticket must not carry paths, users, addresses or projects
test('the support export keeps how requests went and leaves out who, where, which project and message text', () => {
  const secret = 'fatal: /srv/volumes/anna-secret-study/.git: permission denied';
  const records = [
    { time: '2026-11-22T10:00:00Z', line: formatLine({ user: 'anna', from: '10.0.0.7', command: 'checkout', project: 'secret-study', ms: 812, result: 'error', error: secret, warnings: 'one /home/anna | two', ctl: '0.4.150' }) },
    { time: '2026-11-22T10:01:00Z', line: formatLine({ user: 'anna', from: '10.0.0.7', command: 'start', project: 'secret-study', revision: 'abc', image: 'ghcr.io/x/r-env@sha256:00', positron: '2026.11.1-4', client: '0.4.149', ms: 3000, result: 'error', code: 'quota', error: 'project quota reached' }) },
    { line: formatLine({ user: 'bob', command: 'stop', result: 'error', error: 'timed out waiting for the lock' }) },
    { line: formatLine({ user: 'eve', command: 'Evil/Path name', client: '1.0 /etc/passwd', result: 'ok', newField: 'anything' }) },
    { line: formatLine({ user: 'root', command: 'admin-remove-user', by: 'admin', key: 'SHA256:abc', stopped: 'secret-study', result: 'ok', ms: 5 }) },
    { line: 'not a line fnkc-ctl wrote' },
  ];
  const x = supportExport(records, '-1d');
  assert.equal(x.skipped, 1);
  assert.equal(x.ctl, CTL_VERSION);
  assert.deepEqual(x.requests, [
    { time: '2026-11-22T10:00:00Z', command: 'checkout', result: 'error', ms: '812', ctl: '0.4.150', category: 'other', warnings: 2 },
    { time: '2026-11-22T10:01:00Z', command: 'start', result: 'error', ms: '3000', client: '0.4.149', positron: '2026.11.1-4', category: 'quota' },
    { time: undefined, command: 'stop', result: 'error', category: 'busy' },
    { time: undefined, command: 'other', result: 'ok', category: undefined },
    { time: undefined, command: 'admin-remove-user', result: 'ok', ms: '5', category: undefined },
  ]);
  const text = formatSupportExport(x);
  for (const s of ['anna', 'bob', 'eve', '10.0.0.7', 'secret', '/srv', '/home', 'sha256', 'SHA256', 'passwd', 'quota reached', 'anything', 'admin ']) {
    assert.ok(!text.includes(s), `${s} leaked into:\n${text}`);
  }
  assert.match(text, /^# fnkc-ctl support export: .*omitted\n/);
  assert.match(text, /\ntime=2026-11-22T10:01:00Z command=start result=error ms=3000 client=0\.4\.149 positron=2026\.11\.1-4 category=quota\n/);

  const full = supportExport(records, '-1d', true);
  assert.equal(full.requests[0].project, 'secret-study');
  assert.equal(full.requests[0].error, secret);
  assert.match(formatSupportExport(full), /review before sharing/);
});

test('the journal is read as journalctl JSON, also messages it writes as bytes', () => {
  let args: string[] = [];
  const stdout = [
    JSON.stringify({ __REALTIME_TIMESTAMP: '1795341600123456', MESSAGE: 'command=ping result=ok' }),
    JSON.stringify({ __REALTIME_TIMESTAMP: '1795341601000000', MESSAGE: [...Buffer.from('command=stop result=ok')] }),
    'garbage', '',
  ].join('\n');
  const r = readJournal('today', (_c, a) => { args = a; return { status: 0, stdout, stderr: '' }; });
  assert.deepEqual(args.slice(-2), ['--since', 'today']);
  assert.deepEqual(r, [
    { time: new Date(1795341600000).toISOString().replace(/\.\d+Z$/, 'Z'), line: 'command=ping result=ok' },
    { time: new Date(1795341601000).toISOString().replace(/\.\d+Z$/, 'Z'), line: 'command=stop result=ok' },
  ]);
  assert.throws(() => readJournal('bad', () => ({ status: 1, stdout: '', stderr: 'Failed to parse timestamp: bad' })), /journalctl failed: Failed to parse timestamp/);
});

test('answer() reports the outcome it replies with', async () => {
  const seen: unknown[] = [];
  const out = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    assert.equal(await answer(async () => ({ stopped: true }), (e, r) => seen.push(e, r)), 0);
    assert.equal(await answer(async () => { throw new Error('no'); }, (e, r) => seen.push((e as Error).message, r)), 1);
  } finally { process.stdout.write = out; }
  assert.deepEqual(seen, [undefined, { stopped: true }, 'no', undefined]);
});

function hasSshKeygen(): boolean {
  try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); return true; } catch (e) { return (e as { code?: string }).code !== 'ENOENT'; }
}
