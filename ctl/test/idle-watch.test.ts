// container/idle-watch.sh with fakes (ps, the CPU counter, the stop), one check a second; and how agent list reads it
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import IDLE_WATCH from '../container/idle-watch.sh';
import { idleState, parseBusy } from '../src/agent.ts';

/** stopped: the state the watch wrote just before it stopped the container. */
interface Run { stopped?: string; states: string[] }
/**
 * Runs the watch until it stops the container or has made `checks` checks (counted by its writes of the state, not
 * by the clock: on a loaded test machine its one-second sleeps drift). `window(check)`: a window is connected at that
 * check; `busy`: the CPU counter rises; `keepAt`: Keep is pressed before that check; `unreadAt`: the CPU counter
 * cannot be read at that check (empty).
 */
async function watch(t: { after: (f: () => void) => void }, o: { minutes: number; notice: number; limit: number; checks: number;
  busy?: boolean; window?: (check: number) => boolean; keepAt?: number; unreadAt?: number }): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-idle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'ps'), `#!/bin/sh\n[ -f '${dir}/window' ] && echo sshd-session\necho bash\n`);
  chmodSync(join(dir, 'bin', 'ps'), 0o755);
  writeFileSync(join(dir, 'watch.sh'), IDLE_WATCH);
  let usage = 0;
  // Written aside and renamed, as the kernel's counter is never seen half-written
  const stat = () => {
    writeFileSync(join(dir, 'cpu.stat.tmp'), `usage_usec ${usage}\nuser_usec 0\n`);
    renameSync(join(dir, 'cpu.stat.tmp'), join(dir, 'cpu.stat'));
  };
  stat();
  const states: string[] = [];
  const child = spawn('sh', [join(dir, 'watch.sh')], { env: {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FNKC_IDLE_MINUTES: String(o.minutes), FNKC_BUSY_NOTICE_MINUTES: String(o.notice),
    FNKC_BUSY_STOP_MINUTES: String(o.limit), FNKC_IDLE_INTERVAL: '1', FNKC_IDLE_STAT: join(dir, 'cpu.stat'),
    FNKC_IDLE_STATE: join(dir, 'state'), FNKC_IDLE_KEEP: join(dir, 'keep'), FNKC_IDLE_JOBS: join(dir, 'jobs'),
    FNKC_IDLE_STOP: `cp ${join(dir, 'state')} ${join(dir, 'stopped')}`,
  } });
  let check = 0;
  let kept = false;
  let written = 0;
  let lastIno = 0;
  // Every 100 ms: what the watch wrote, and what it will see. Keep is pressed after the watch wrote no_window=keepAt-1,
  // so its check keepAt sees it whatever the timing on a busy test machine
  const tick = () => {
    const state = existsSync(join(dir, 'state')) ? readFileSync(join(dir, 'state'), 'utf8') : '';
    if (state && state !== states.at(-1)) { states.push(state); check++; }
    // Each check rewrites the state (rename): a new inode even when the text is the same
    const ino = existsSync(join(dir, 'state')) ? statSync(join(dir, 'state')).ino : 0;
    if (ino && ino !== lastIno) { lastIno = ino; written++; if (written >= o.checks) child.kill(); }
    if (o.window?.(check + 1)) writeFileSync(join(dir, 'window'), ''); else rmSync(join(dir, 'window'), { force: true });
    if (o.keepAt && !kept && new RegExp(`no_window=${o.keepAt - 1}\n`).test(state)) { writeFileSync(join(dir, 'keep'), ''); kept = true; }
    // 90% of a core
    if (o.busy) usage += 90_000;
    if (o.unreadAt === check + 1) {
      writeFileSync(join(dir, 'cpu.stat.tmp'), '');
      renameSync(join(dir, 'cpu.stat.tmp'), join(dir, 'cpu.stat'));
    } else if (o.busy || o.unreadAt) stat();
  };
  const timer = setInterval(tick, 100);
  // Only a guard: the watch stops by itself, or after `checks` checks
  const end = setTimeout(() => child.kill(), 90_000);
  await new Promise((r) => child.on('exit', r));
  clearInterval(timer); clearTimeout(end);
  const run: Run = { states };
  if (existsSync(join(dir, 'stopped'))) run.stopped = readFileSync(join(dir, 'stopped'), 'utf8');
  return run;
}

test('the idle watch: quiet without a window stops; busy without a window stops later; a window or Keep postpones it', { timeout: 120_000 }, async (t) => {
  const [quiet, busy, kept, attended, unread] = await Promise.all([
    watch(t, { minutes: 2, notice: 1, limit: 4, checks: 12 }),
    watch(t, { minutes: 2, notice: 2, limit: 4, checks: 12, busy: true }),
    watch(t, { minutes: 2, notice: 2, limit: 3, checks: 12, busy: true, keepAt: 3 }),
    watch(t, { minutes: 1, notice: 1, limit: 2, checks: 4, window: () => true }),
    watch(t, { minutes: 2, notice: 1, limit: 4, checks: 12, unreadAt: 1 }),
  ]);
  const at = (r: Run) => /no_window=(\d+)/.exec(r.stopped ?? '')?.[1];
  assert.equal(at(quiet), '2', `quiet: ${quiet.stopped}`);
  assert.match(quiet.stopped!, /^idle=2\nidle_limit=2\nsessions=0\njobs=0\ncpu=0\nbusy=0\nno_window=2\nstop_in=2\n$/);

  assert.equal(at(busy), '4', `busy: ${busy.stopped}`);
  assert.ok(busy.states.every((s) => /busy=1/.test(s) && /idle=0/.test(s)), 'computing is never idle');
  assert.ok(busy.states.some((s) => /no_window=2\n.*stop_in=2\nnotice=1/s.test(s)), 'from the notice time on, Positron asks');
  assert.ok(!busy.states.some((s) => /no_window=1\n.*notice/s.test(s)), 'not before');

  // Keep before the third check: the full limit (3) again from there
  assert.equal(at(kept), '6', `kept: ${kept.stopped}`);
  assert.ok(kept.states.some((s) => /no_window=3\n.*stop_in=3/s.test(s)));

  // A check that could not read the CPU counter is not a quiet one: the idle count starts after it
  assert.match(unread.states[0], /idle=0\n.*busy=1\nno_window=1\n/s, `unread: ${unread.states[0]}`);
  assert.equal(at(unread), '3', `unread: ${unread.stopped}`);
  assert.match(unread.stopped!, /cpu=0\n/, 'and the next check measures from the last value read');

  assert.equal(attended.stopped, undefined, 'a window keeps it running');
  assert.ok(attended.states.length >= 1 && attended.states.every((s) => /sessions=1/.test(s) && !/stop_in/.test(s)));
});

test('agent list: the watch state as times', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const busy = idleState('idle=0\nidle_limit=120\nsessions=0\njobs=0\ncpu=97\nbusy=1\nno_window=1500\nstop_in=2820\nnotice=1\n', 60, now);
  assert.deepEqual(busy, { busy: true, noWindowSince: '2026-11-20T11:00:00.000Z', stopsAt: '2026-11-23T11:00:00.000Z', notice: true });
  // Quiet: the idle rule stops it first
  const quiet = idleState('idle=100\nidle_limit=120\nsessions=0\njobs=0\ncpu=0\nbusy=0\nno_window=100\nstop_in=4220\n', 60, now);
  assert.equal(quiet.stopsAt, '2026-11-21T12:20:00.000Z');
  assert.equal(quiet.notice, undefined);
  assert.deepEqual(idleState('idle=0\nidle_limit=120\nsessions=1\njobs=0\ncpu=3\nbusy=0\nno_window=0\n', 60, now), { busy: false });
  // A container from before (one line of text), or no watch
  assert.deepEqual(idleState('idle 3/120 min; ssh sessions: 0; cpu: 0% of a core', 60, now), {});
  assert.deepEqual(idleState('off=no /sys/fs/cgroup/cpu.stat', 60, now), {});
});

test('fnkc-projects busy output', () => {
  assert.deepEqual(parseBusy('812 98 R console\n9001 12 Rscript analysis.R --long\n\nnoise\n'),
    [{ pid: 812, cpu: 98, what: 'R console' }, { pid: 9001, cpu: 12, what: 'Rscript analysis.R --long' }]);
});
