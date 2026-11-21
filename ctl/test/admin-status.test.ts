// admin status / admin projects (admin-status.ts): what root sees of every user's projects on a server
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminStatus, formatAdminStatus, volumeOwner, type VolumeInfo } from '../src/admin-status.ts';
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
