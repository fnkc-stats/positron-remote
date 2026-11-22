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
