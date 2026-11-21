// The server's request journal (journal.ts): line format, key fingerprints, one line per request with its outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entry, formatLine, keyFingerprint, sshClient, startFields } from '../src/journal.ts';
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
  assert.match(lines[0][0], /^user=anna command=start project=study ms=\d+ result=ok warnings="setup changed"$/);
  assert.equal(lines[0][1], false);

  const failed = new Entry({ user: 'anna', command: 'stop' }, write);
  failed.end(new Error('project is not running'));
  assert.match(lines[1][0], /^user=anna command=stop ms=\d+ result=error error="project is not running"$/);
  assert.equal(lines[1][1], true);
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
