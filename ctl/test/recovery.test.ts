import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { withLock } from '../src/lock.ts';
import { PartReader, unpackedSize } from '../src/image-store.ts';
import { checkProject } from '../src/validate.ts';
import { projectNames, recoveryName, isProjectContainer, LABEL } from '../src/layout.ts';
import { CAPABILITIES, PROTOCOL_VERSION, requireCompatible } from '../src/protocol.ts';
import { LockBusy } from '../src/errors.ts';

test('kernel lock releases after SIGKILL of its owner; unrelated locks stay available', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-crash-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'project');
  // Run the real lock implementation in an independently killed Node process.
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `import {withLock} from ${JSON.stringify(new URL('../src/lock.ts', 'file://' + resolve('test/recovery.test.ts')).href)};
     await withLock(${JSON.stringify(path)}, async () => { console.log('ready'); await new Promise(() => {}); });`]);
  t.after(() => child.kill('SIGKILL'));
  let err = '';
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error(err); })]);
  // A busy lock is a LockBusy with one clean line (no Python traceback), so the extension offers Retry
  await assert.rejects(withLock(path, async () => 1, 20), (e: Error) => e instanceof LockBusy && /^operation is busy; timed out waiting for/.test(e.message) && !e.message.includes('\n'));
  assert.equal(await withLock(join(dir, 'other'), async () => 42), 42);
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(await withLock(path, async () => 43, 5000), 43);
});

test('real projects ending in previous remain visible and never share recovery names', () => {
  const project = checkProject('study-previous');
  const name = projectNames('alice', project).container;
  assert.notEqual(name, recoveryName('alice', 'study'));
  assert.ok(isProjectContainer({ Name: '/' + name, Config: { Labels: { [LABEL.user]: 'alice', [LABEL.project]: project } } }));
  assert.ok(!isProjectContainer({ Name: '/fnkc-alice-study-previous', Config: { Labels: { [LABEL.user]: 'alice', [LABEL.project]: 'study' } } }));
});

test('stalled upload data and missing EOF have server-side deadlines', async () => {
  for (const eof of [false, true]) {
    const source = new PassThrough();
    const reader = new PartReader(source, 20, 100);
    await assert.rejects(eof ? reader.end() : reader.part(100), /timed out/);
    assert.ok(source.destroyed);
  }
});

test('compressed uploads cannot exceed their unpacked budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-gzip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'layer');
  writeFileSync(file, gzipSync(Buffer.alloc(1024 * 1024)));
  await assert.rejects(unpackedSize(file, true, 1000), /unpacked storage/);
  assert.equal(await unpackedSize(file, true, 2 * 1024 * 1024), 1024 * 1024);
});

test('protocol compatibility uses capabilities rather than release number equality', () => {
  requireCompatible({ version: '0.3.999', user: 'alice', protocol: PROTOCOL_VERSION, capabilities: CAPABILITIES });
  assert.throws(() => requireCompatible({ version: '0.3.0', user: 'alice' }), /incompatible/);
  assert.throws(() => requireCompatible({ version: '0.3.999', user: 'alice', protocol: PROTOCOL_VERSION, capabilities: [] }), /incompatible/);
});
