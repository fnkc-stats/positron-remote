// The Projects panel (sidebar.ts) with a stub listing: a running checkout that Open connected to while an update of
// its environment or setup waits says "update pending" until the host shows it stopped or gone, or an Open without
// a pending update.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingUpdates, type Store } from '../src/pending-updates.ts';
import type { ContainerInfo } from '../src/protocol.ts';
import { type Item, ProjectsTree } from '../src/sidebar.ts';

function memory(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: <T>(k: string) => data.get(k) as T | undefined, update: async (k, v) => { data.set(k, v); } };
}

const box = (project: string, running: boolean): ContainerInfo =>
  ({ project, container: `fnkc-anna-${project}`, running, state: running ? 'running' : 'exited', image: 'img', memory: '1.4GiB / 8GiB' });

test('a pending update shows on the running project row until the host shows that container stopped', async () => {
  const store = memory();
  const pending = new PendingUpdates(store);
  let listing: { host: string; error?: string; containers: ContainerInfo[] }[] = [];
  const cfg = { hosts: [{ name: 'stats', ssh: 'stats.example' }, { name: 'other', ssh: 'other.example' }] };
  const tree = new ProjectsTree(() => cfg as never, { info() {}, warn() {} }, pending, async () => listing as never);
  const rows = async () => {
    tree.refresh();
    const out: Record<string, { description?: string; tooltip?: string }> = {};
    for (const h of await tree.getChildren()) {
      for (const p of await tree.getChildren(h)) {
        const t = tree.getTreeItem(p) as unknown as { description?: string; tooltip?: { value: string } };
        out[`${(p as Extract<Item, { kind: 'project' }>).host}/${(p as Extract<Item, { kind: 'project' }>).container.project}`] =
          { description: t.description, tooltip: t.tooltip?.value };
      }
    }
    return out;
  };

  listing = [{ host: 'stats', containers: [box('survey', true), box('trial', true)] }, { host: 'other', containers: [box('survey', true)] }];
  await pending.set('stats', 'fnkc-anna-survey', true);
  let r = await rows();
  assert.equal(r['stats/survey'].description, 'running · update pending · 1.4 of 8.0 GB');
  assert.match(r['stats/survey'].tooltip!, /stop the project \(its files are kept\) and open it again/);
  assert.equal(r['stats/trial'].description, 'running · 1.4 of 8.0 GB');
  assert.equal(r['other/survey'].description, 'running · 1.4 of 8.0 GB', 'the same project on another host');

  // An unreachable host keeps what it had
  listing = [{ host: 'stats', error: 'ssh: timeout', containers: [] }];
  await rows();
  assert.ok(pending.has('stats', 'fnkc-anna-survey'));

  // Reload: the state is kept in the store
  assert.ok(new PendingUpdates(store).has('stats', 'fnkc-anna-survey'));

  // Stopped (by the user, or idle): the next Open creates it anew
  listing = [{ host: 'stats', containers: [box('survey', false)] }];
  r = await rows();
  assert.equal(r['stats/survey'].description, 'stopped');
  assert.ok(!pending.has('stats', 'fnkc-anna-survey'));
  listing = [{ host: 'stats', containers: [box('survey', true)] }];
  assert.equal((await rows())['stats/survey'].description, 'running · 1.4 of 8.0 GB');
});

test('an Open without a pending update clears it', async () => {
  const pending = new PendingUpdates(memory());
  await pending.set('stats', 'fnkc-anna-survey', true);
  await pending.set('stats', 'fnkc-anna-survey', true);
  await pending.set('stats', 'fnkc-anna-trial', true);
  await pending.set('stats', 'fnkc-anna-survey', false);
  assert.ok(!pending.has('stats', 'fnkc-anna-survey'));
  assert.ok(pending.has('stats', 'fnkc-anna-trial'));
});

test('a local listing error says what is wrong and promises a Docker start only when the daemon is offline', async () => {
  let listing: { host: string; error?: string; containers: ContainerInfo[] }[] = [];
  const cfg = { hosts: [{ name: 'local' }, { name: 'stats', ssh: 'stats.example' }] };
  const tree = new ProjectsTree(() => cfg as never, { info() {}, warn() {} }, undefined, async () => listing as never);
  const hostRow = async (error: string, host = 'local') => {
    listing = [{ host, error, containers: [] }];
    tree.refresh();
    const h = (await tree.getChildren()).find((i) => i.kind === 'host' && i.host === host)!;
    const t = tree.getTreeItem(h) as unknown as { description?: string; tooltip?: string };
    return { description: t.description, tooltip: String(t.tooltip) };
  };
  const starts = /starts by itself|will start/i;

  const denied = await hostRow('docker ps -aq: permission denied while trying to connect to the Docker daemon socket at '
    + 'unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied');
  assert.equal(denied.description, 'no access to Docker');
  assert.doesNotMatch(denied.tooltip, starts);
  assert.match(denied.tooltip, /permission denied/);
  assert.match(denied.tooltip, /docker group/);
  const eacces = await hostRow('connect EACCES /var/run/docker.sock');
  assert.equal(eacces.description, 'no access to Docker');
  assert.doesNotMatch(eacces.tooltip, starts);

  const offline = await hostRow('docker ps -aq: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
  assert.equal(offline.description, 'Docker is not running');
  assert.match(offline.tooltip, starts);
  // Colima's context appears at its first start, which an Open does
  assert.equal((await hostRow('docker ps -aq: context "colima-fnkc": context not found: open …: no such file or directory')).description,
    'Docker is not running');

  const config = await hostRow('docker ps -aq: context "desktop-linux": context not found: open /home/a/.docker/contexts/meta/x/meta.json: no such file or directory');
  assert.equal(config.description, 'Docker is not set up');
  assert.doesNotMatch(config.tooltip, starts);
  assert.match(config.tooltip, /context not found/);
  const missing = await hostRow('spawn docker ENOENT');
  assert.equal(missing.description, 'Docker is not set up');
  assert.doesNotMatch(missing.tooltip, starts);

  const other = await hostRow('docker container inspect: unexpected end of JSON input');
  assert.equal(other.description, 'cannot list projects');
  assert.match(other.tooltip, /unexpected end of JSON input/);
  assert.doesNotMatch(other.tooltip, starts);

  const remote = await hostRow('ssh: connect to host stats.example port 22: Connection timed out', 'stats');
  assert.equal(remote.description, 'unreachable');
  assert.doesNotMatch(remote.tooltip, starts);
});
