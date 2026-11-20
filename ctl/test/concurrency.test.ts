import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Docker, onlyMissing } from '../src/docker.ts';
import type { RunOptions } from '../src/exec.ts';
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
  await withLock(path, async () => {
    await withLock(path, async () => 0, 1500, () => waits++).catch(() => 0);
  });
  assert.equal(waits, 1);
});
