// admin status / admin projects (admin-status.ts): what root sees of every user's projects on a server
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adminStatus, formatAdminStatus, formatRelease, readInstalledRelease, volumeOwner, type VolumeInfo } from '../src/admin-status.ts';
import type { ContainerJson, ImageJson } from '../src/docker.ts';

const container = (user: string, project: string, o: { running?: boolean; startedAt?: string; memory?: number; image?: string } = {}): ContainerJson => ({
  Name: `/fnkc-${user}-${project}`, Image: o.image ?? 'sha256:img',
  Config: { Image: 'ghcr.io/fnkc-stats/r-env:4.6-positron', Env: [], Labels: { 'fnkc.managed': '1', 'fnkc.user': user, 'fnkc.project': project } },
  State: { Running: !!o.running, Status: o.running ? 'running' : 'exited', StartedAt: o.startedAt ?? '0001-01-01T00:00:00Z' },
  HostConfig: { Memory: o.memory ?? 4 * 1024 ** 3 }, NetworkSettings: { Ports: null },
});
const image: ImageJson = { Id: 'sha256:img', Architecture: 'amd64', Config: { Labels: { 'positron.version': '2026.11.1-1' } } } as ImageJson;
const host = { cpus: 16, memory: 64 * 1024 ** 3, reserveMemory: '4g', maxProjectsPerUser: 2, maxMemoryPerUser: '16g' };

test('volumes belong to their user and project by label, or by name for volumes from before labels', () => {
  assert.deepEqual(volumeOwner({ name: 'anything', labels: { 'fnkc.user': 'anna', 'fnkc.project': 'thesis' } }), { user: 'anna', project: 'thesis' });
  assert.deepEqual(volumeOwner({ name: 'fnkc-anna-my-study-project' }), { user: 'anna', project: 'my-study' });
  assert.deepEqual(volumeOwner({ name: 'fnkc-anna-my-study-library' }), { user: 'anna', project: 'my-study' });
  assert.deepEqual(volumeOwner({ name: `fnkc-ext-anna-my-study-x64-${'a'.repeat(12)}` }), { user: 'anna', project: 'my-study' });
  assert.deepEqual(volumeOwner({ name: 'fnkc-anna-old-ext' }), { user: 'anna', project: 'old' });
  assert.equal(volumeOwner({ name: 'postgres-data' }), undefined);
  assert.equal(volumeOwner({ name: 'fnkc-anna-x-backup' }), undefined);
});

test("status: every user's projects, also of removed users and with only volumes left; the host against its limits", () => {
  const volumes: VolumeInfo[] = [
    { name: 'fnkc-anna-thesis-project', labels: { 'fnkc.user': 'anna', 'fnkc.project': 'thesis' }, size: 2 * 1024 ** 3 },
    { name: 'fnkc-anna-thesis-data', size: 50 * 1024 ** 2 },
    { name: 'fnkc-boris-old-project' },
    { name: 'unrelated' },
  ];
  const s = adminStatus({
    containers: [container('anna', 'thesis', { running: true, startedAt: '2026-11-20T09:15:00.123Z', image: 'sha256:img' }),
      container('ivan', 'draft'), { ...container('ivan', 'draft'), Name: '/fnkc.recovery.ivan.draft' }],
    volumes, images: [image], users: ['ivan', 'anna'], memory: new Map([['fnkc-anna-thesis', '1.2GiB / 4GiB']]), host,
  });
  assert.deepEqual(s.users, ['anna', 'ivan']);
  assert.deepEqual(s.projects.map((p) => [p.user, p.project, p.state, p.removedUser]),
    [['anna', 'thesis', 'running', false], ['boris', 'old', 'no container', true], ['ivan', 'draft', 'exited', false]]);
  const thesis = s.projects[0];
  assert.equal(thesis.lastStart, '2026-11-20T09:15:00.123Z');
  assert.equal(thesis.positron, '2026.11.1-1');
  assert.equal(thesis.memory, '1.2GiB / 4GiB');
  assert.deepEqual(thesis.volumes.map((v) => v.name), ['fnkc-anna-thesis-data', 'fnkc-anna-thesis-project']);
  assert.equal(s.projects[2].lastStart, undefined, 'never started: no last start');
  assert.equal(s.host.running, 1);
  assert.equal(s.host.reserved, 4 * 1024 ** 3);

  const text = formatAdminStatus(s, new Date('2026-11-21T09:15:00Z'));
  assert.match(text, /running projects: 1, their memory limits 4\.0 GiB/);
  assert.match(text, /thesis: running, last start 2026-11-20 09:15 \(24 h ago\), memory 1\.2GiB \/ 4GiB, Positron 2026\.11\.1-1/);
  assert.match(text, /fnkc-anna-thesis-project \(2\.0 GiB\); 2\.0 GiB in all/);
  assert.match(text, /boris \(removed: no key; .*admin remove-project\)\n  old: no container\n    volumes: fnkc-boris-old-project\n/);
  assert.match(formatAdminStatus({ ...s, projects: [] }), /No projects on this host/);
});

/** An install.sh layout in a temp dir: releases with MANIFESTs, current and previous-release, and the file links. */
function installedLayout() {
  const prefix = mkdtempSync(join(tmpdir(), 'fnkc-release-'));
  const files = ['fnkc-ctl.cjs', 'volume-backup.sh', 'render-reviewed.py', 'refresh-trust-root.sh', 'install.sh'];
  for (const id of ['0.9.0-aaaaaaaaaaaa', '0.9.1-bbbbbbbbbbbb']) {
    const dir = join(prefix, 'releases', id);
    mkdirSync(dir, { recursive: true });
    const lines = files.map((f) => {
      writeFileSync(join(dir, f), `${id} ${f}\n`);
      return `${createHash('sha256').update(`${id} ${f}\n`).digest('hex')}  ${f}`;
    });
    writeFileSync(join(dir, 'MANIFEST'), lines.join('\n') + '\n');
  }
  symlinkSync('releases/0.9.1-bbbbbbbbbbbb', join(prefix, 'current'));
  symlinkSync('releases/0.9.0-aaaaaaaaaaaa', join(prefix, 'previous-release'));
  for (const f of files.slice(0, 4)) symlinkSync(`current/${f}`, join(prefix, f));
  return prefix;
}

test('the installed release: active and previous ids, every file checked against its manifest', { skip: process.platform === 'win32' ? 'symlinks' : undefined }, () => {
  const prefix = installedLayout();
  try {
    let r = readInstalledRelease(prefix);
    assert.deepEqual(r, {
      problems: [],
      active: { id: '0.9.1-bbbbbbbbbbbb', files: 5, problems: [] },
      previous: { id: '0.9.0-aaaaaaaaaaaa', files: 5, problems: [] },
    });
    assert.deepEqual(formatRelease(r), ['Installed release: 0.9.1-bbbbbbbbbbbb (5 files, all match its manifest); previous: 0.9.0-aaaaaaaaaaaa (5 files, all match its manifest)']);

    // An interrupted or hand-made change: a helper changed in the previous release, a file gone from the active one
    writeFileSync(join(prefix, 'releases', '0.9.0-aaaaaaaaaaaa', 'volume-backup.sh'), 'other\n');
    rmSync(join(prefix, 'releases', '0.9.1-bbbbbbbbbbbb', 'render-reviewed.py'));
    r = readInstalledRelease(prefix);
    assert.deepEqual(r.active?.problems, ['render-reviewed.py: missing']);
    assert.deepEqual(r.previous?.problems, ['volume-backup.sh: changed']);
    const text = formatRelease(r).join('\n');
    assert.match(text, /0\.9\.1-bbbbbbbbbbbb \(5 files, 1 not matching its manifest\)/);
    assert.match(text, /! previous release: volume-backup\.sh: changed \(install\.sh --rollback refuses it\)/);

    // A file replaced by a plain file (an older installer run since)
    rmSync(join(prefix, 'fnkc-ctl.cjs'));
    writeFileSync(join(prefix, 'fnkc-ctl.cjs'), 'plain\n');
    assert.deepEqual(readInstalledRelease(prefix).problems, [`not linked through ${prefix}/current: fnkc-ctl.cjs (run install.sh from the server bundle again)`]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('an unfinished release switch: shown with both pairs of links; none without the record', { skip: process.platform === 'win32' ? 'symlinks' : undefined }, () => {
  const prefix = installedLayout();
  try {
    assert.equal(readInstalledRelease(prefix).pendingSwitch, undefined);
    assert.ok(!formatRelease(readInstalledRelease(prefix)).join('\n').includes('release switch'));

    // install.sh stopped after relinking previous-release, before current (switch_to)
    writeFileSync(join(prefix, '.release-switch'),
      'releases/0.9.2-cccccccccccc\nreleases/0.9.1-bbbbbbbbbbbb\nreleases/0.9.1-bbbbbbbbbbbb\nreleases/0.9.0-aaaaaaaaaaaa\n');
    const r = readInstalledRelease(prefix);
    assert.deepEqual(r.pendingSwitch, { current: '0.9.2-cccccccccccc', previous: '0.9.1-bbbbbbbbbbbb', fromCurrent: '0.9.1-bbbbbbbbbbbb', fromPrevious: '0.9.0-aaaaaaaaaaaa' });
    assert.deepEqual(r.problems, []);
    assert.match(formatRelease(r).join('\n'),
      /\n {2}! unfinished release switch \(\.release-switch\): to 0\.9\.2-cccccccccccc \(previous 0\.9\.1-bbbbbbbbbbbb\), from 0\.9\.1-bbbbbbbbbbbb \(previous 0\.9\.0-aaaaaaaaaaaa\); .*next sudo \/opt\/fnkc-ctl\/install\.sh completes or undoes it/);

    // A first install (no previous release before it, previous-release not to change)
    writeFileSync(join(prefix, '.release-switch'), 'releases/0.9.2-cccccccccccc\n\n\n\n');
    assert.match(formatRelease(readInstalledRelease(prefix)).join('\n'), /to 0\.9\.2-cccccccccccc, from none;/);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('no release layout (installed before releases): said so, nothing else', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'fnkc-release-'));
  try {
    writeFileSync(join(prefix, 'fnkc-ctl.cjs'), 'plain\n');
    const r = readInstalledRelease(prefix);
    assert.equal(r.active, undefined);
    assert.equal(r.previous, undefined);
    assert.match(r.problems.join('\n'), /^no release installed in .* run install\.sh from the server bundle$/);
    assert.match(formatAdminStatus({ host: { cpus: 1, memory: 1024 ** 3, reserved: 0, reserveMemory: '1g', maxProjectsPerUser: 1, maxMemoryPerUser: '1g', running: 0 }, users: [], projects: [], release: r }),
      /Installed release: none; previous: none\n {2}! no release installed/);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
