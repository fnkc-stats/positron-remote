import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { Docker, onlyMissing } from '../src/docker.ts';
import { imageUpload } from '../src/client/image-download.ts';
import { Cancelled, type RunOptions } from '../src/exec.ts';
import { withLock } from '../src/lock.ts';

/** docker inspect of several objects, one of which is gone: Docker prints the others and exits with 1. */
class VanishingDocker extends Docker {
  stderr = 'Error: No such object: gone\n';
  override async run(args: string[], _opts?: RunOptions) {
    if (args[1] === 'inspect') return { code: 1, stdout: JSON.stringify([{ Name: '/kept' }]), stderr: this.stderr };
    return { code: 0, stdout: '', stderr: '' };
  }
  override async ok(args: string[]) {
    if (args[0] === 'ps' || args[0] === 'image') return 'kept\ngone\n';
    return '';
  }
}

test('objects removed between listing and inspecting are skipped', async () => {
  const d = new VanishingDocker();
  assert.deepEqual((await d.containers([])).map((c) => c.Name), ['/kept']);
  assert.equal((await d.images()).length, 1);
});

test('other inspect failures are still errors', async () => {
  const d = new VanishingDocker();
  d.stderr = 'Error: No such object: gone\nCannot connect to the Docker daemon\n';
  await assert.rejects(d.containers([]), /cannot inspect containers/);
});

test('onlyMissing accepts the daemon and CLI wordings and nothing else', () => {
  assert.ok(onlyMissing('Error response from daemon: No such container: x\nError: No such image: y'));
  assert.ok(onlyMissing('Error response from daemon: get fnkc.restore.x: no such volume'), 'a staging volume removed between ls and inspect');
  assert.ok(!onlyMissing(''));
  assert.ok(!onlyMissing('permission denied'));
});

test('a waiting lock says so once, an immediately free one does not', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-wait-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'l');
  let waits = 0;
  await withLock(path, async () => 1, 5000, () => waits++);
  assert.equal(waits, 0);
  // The holder lets go only once the waiter has said it waits: no race between the notice and the release
  let inner: Promise<number> | undefined;
  await withLock(path, async () => {
    let said!: () => void;
    const notice = new Promise<void>((resolveNotice) => { said = resolveNotice; });
    inner = withLock(path, async () => 0, 10_000, () => { waits++; said(); });
    await notice;
  });
  assert.equal(await inner, 0);
  assert.equal(waits, 1);
});

test('a slow lock helper start is not reported as waiting for a free lock', { skip: process.platform === 'win32' }, async (t) => {
  // A loaded machine can take over a second to start python3; only real contention may trigger the notice
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-slow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = execFileSync('sh', ['-c', 'command -v python3']).toString().trim();
  writeFileSync(join(dir, 'python3'), `#!/bin/sh\nsleep 1.5\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  let waits = 0;
  assert.equal(await withLock(join(dir, 'l'), async () => 1, 10_000, () => waits++), 1);
  assert.equal(waits, 0);
});

test('Cancel stops a lock wait at once, before or during it; the holder keeps its lock (N12)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-cancel-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'l');
  let ran = false;
  await assert.rejects(withLock(path, async () => { ran = true; }, 10_000, undefined, AbortSignal.abort()), Cancelled);
  assert.equal(ran, false);
  await withLock(path, async () => {
    const cancel = new AbortController();
    let said!: () => void;
    const waiting = new Promise<void>((r) => { said = r; });
    const started = Date.now();
    const waiter = withLock(path, async () => { ran = true; }, 3600_000, said, cancel.signal);
    await waiting;
    cancel.abort();
    await assert.rejects(waiter, Cancelled);
    assert.ok(Date.now() - started < 5000, 'returns promptly, not after the lock timeout');
    assert.equal(ran, false);
  });
  assert.equal(await withLock(path, async () => 42, 5000), 42);
});

test('Cancel while another Open downloads the same image returns at once, not after the queue timeout (N12)', async (t) => {
  const cache = mkdtempSync(join(tmpdir(), 'fnkc-cancel-download-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const missing = { image: `localhost:1/fnkc-stats/r-env@sha256:${'a'.repeat(64)}`, arch: 'x64' as const };
  const quiet = { info() {}, warn() {} };
  // Cancelled before: no wait, no request
  await assert.rejects(imageUpload(cache, missing, quiet, AbortSignal.abort()), Cancelled);
  // Cancelled while another Open holds the download lock of this image
  await withLock(join(cache, 'locks', `image-${'a'.repeat(64)}`), async () => {
    const cancel = new AbortController();
    let said!: () => void;
    const waiting = new Promise<void>((r) => { said = r; });
    const upload = imageUpload(cache, missing, { info: (m: string) => { if (/Waiting for another download/.test(m)) said(); }, warn() {} }, cancel.signal);
    await waiting;
    const started = Date.now();
    cancel.abort();
    await assert.rejects(upload, Cancelled);
    assert.ok(Date.now() - started < 5000, 'returns promptly');
  });
});
