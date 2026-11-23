// volume-backup.sh restore targets: only the staging namespace fnkc.restore.<name>, which no project volume name can
// match (those are fnkc-<user>-..., and a user name is letters and digits only), so an Open never mounts a restore.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(__dirname, '..', '..', 'server', 'volume-backup.sh');
const image = `ghcr.io/fnkc-stats/r-env@sha256:${'a'.repeat(64)}`;

/** Runs a restore into `target` with fake restic, docker and fnkc-ctl; returns its exit code and the docker calls. */
function restore(t: { after(fn: () => void): void }, target: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-volume-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'docker.log');
  const tool = (name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  tool('restic', 'echo archive');
  // volume inspect: no such volume; everything else succeeds (run reads the archive from stdin)
  tool('docker', `echo "$*" >> ${JSON.stringify(log)}\n[ "$1 $2" = "volume inspect" ] && exit 1\ncat >/dev/null 2>&1 || true\nexit 0`);
  writeFileSync(join(dir, 'ctl.cjs'), `console.log('sha256:${'b'.repeat(64)}')`);
  const r = spawnSync('bash', [script, 'restore', 'abcd1234', '/fnkc-anna-thesis-project.tar', target, image], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RESTIC_REPOSITORY: '/repo', FNKC_BACKUP_LOCK_DIR: join(dir, 'locks'),
      FNKC_CTL: join(dir, 'ctl.cjs') },
  });
  let calls = '';
  try { calls = readFileSync(log, 'utf8'); } catch { /* docker never ran */ }
  return { code: r.status, stderr: r.stderr, calls };
}

for (const [target, why] of [
  ['fnkc-anna-thesis-project', "a project's own volume name"],
  ['fnkc-restore-thesis-project', 'the project volume of a user named restore'],
  ['fnkc-restore-anna-thesis-2026-11-23', 'the former fnkc-restore- prefix (a user named restore)'],
  ['fnkc-ext-anna-thesis-x64-0123456789ab', 'an extensions volume'],
  ['fnkc.restore.', 'an empty staging name'],
  ['fnkc.restore.-x', 'a staging name Docker would refuse'],
] as const) {
  test(`restore refuses ${why} as its target`, (t) => {
    const r = restore(t, target);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /fnkc\.restore\./);
    assert.equal(r.calls, '', 'no docker call');
  });
}

test('restore creates a labelled staging volume fnkc.restore.<name>', (t) => {
  const r = restore(t, 'fnkc.restore.anna-thesis-2026-11-23');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.calls, /^volume create --label fnkc\.restore=abcd1234:\/fnkc-anna-thesis-project\.tar fnkc\.restore\.anna-thesis-2026-11-23$/m);
});
