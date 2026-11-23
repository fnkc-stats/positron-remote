import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offboardingReport, unverifiedProjects } from '../src/offboard.ts';
import type { RemovalCheck } from '../src/protocol.ts';

const git = (over: Partial<NonNullable<RemovalCheck['git']>> = {}): RemovalCheck['git'] => ({
  branch: 'main', unpushedCount: 0, unpushed: [], stashes: [], changed: [], untracked: [], ignored: [], regenerable: [], auxiliary: [], ...over,
});
const check = (project: string, g = git(), outside: string[] = []): RemovalCheck =>
  ({ project, volumes: [], git: g, outside, fingerprint: 'f' });

test('Q4: remove-user inspects every project; unpushed work and failed inspections block, clean ones do not', async () => {
  const seen: string[] = [];
  const found = await unverifiedProjects(['clean', 'dirty', 'running', 'home', 'unreadable'], async (p) => {
    seen.push(p);
    if (p === 'running') throw new Error('running is running: stop it first');
    if (p === 'dirty') return check(p, git({ unpushedCount: 2, untracked: ['notes.R'] }));
    if (p === 'home') return check(p, git(), ['.mywork/']);
    if (p === 'unreadable') return check(p, git({ error: 'git failed' }));
    return check(p);
  });
  assert.deepEqual(seen, ['clean', 'dirty', 'running', 'home', 'unreadable']);
  assert.deepEqual(found.map((f) => f.project), ['dirty', 'running', 'home', 'unreadable']);
  assert.match(found[0].lost.join(';'), /2 commits not pushed to Gitea.*1 untracked file/);
  assert.deepEqual(found[1].lost, ['not checked: running is running: stop it first']);
});

test('Q4: remove-user refuses, names each project and how to go on; nothing to report when all is on Gitea', () => {
  const found = [{ project: 'study', lost: ['1 commit not pushed to Gitea'] }, { project: 'live', lost: ['not checked: live is running: stop it first'] }];
  const r = offboardingReport('anna', found);
  const text = [...r.lines, r.refusal].join('\n');
  assert.match(text, /study: 1 commit not pushed to Gitea/);
  assert.match(text, /live: not checked/);
  assert.match(text, /not revoked/);
  assert.match(text, /admin stop-all anna/);
  assert.match(text, /--lose-work/);
  assert.doesNotMatch(offboardingReport('anna', found.slice(0, 1)).refusal ?? '', /stop-all/);
  assert.deepEqual(offboardingReport('anna', []), { lines: [] });
});
