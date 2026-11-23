// container/idle-watch.sh with fakes (ps, sleep, the CPU counter, the stop), stepped one check at a time by the test;
// and how agent list reads it
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import IDLE_WATCH from '../container/idle-watch.sh';
import { idleState, parseBusy } from '../src/agent.ts';

/** stopped: the state the watch wrote just before it stopped the container; states: what each check wrote. */
interface Run { stopped?: string; states: string[] }

/** Waits for an event of the watch; the time limit is only a guard against a hung watch (each step takes milliseconds). */
async function until(done: () => boolean, what: string): Promise<void> {
  for (const start = Date.now(); !done(); await new Promise((r) => setTimeout(r, 5))) {
    if (Date.now() - start > 60_000) throw new Error(`the idle watch: no ${what} in 60 s`);
  }
}

/**
 * Runs the watch in lockstep, without the clock: its `sleep` is a fake that waits for the test to let it go. So the
 * test sets what check n will see (a window, the CPU counter, Keep) while the watch sleeps, and nothing changes while
 * it looks, however slow the test machine is. Runs until the watch stops the container or has made `checks` checks.
 * `window(check)`: a window is connected at that check; `busy`: the CPU counter rises by 90% of a core per check;
 * `keepAt`: Keep is pressed before that check; `unreadAt`: the CPU counter cannot be read at that check (empty).
 */
async function watch(t: { after: (f: () => void) => void }, o: { minutes: number; notice: number; limit: number; checks: number;
  busy?: boolean; window?: (check: number) => boolean; keepAt?: number; unreadAt?: number }): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-idle-'));
  const at = (f: string) => join(dir, f);
  mkdirSync(at('bin'));
  writeFileSync(at('bin/ps'), `#!/bin/sh\n[ -f '${at('window')}' ] && echo sshd-session\necho bash\n`);
  // The watch's sleep between checks: says it sleeps, then waits for go; end (the run is over) fails it, which ends
  // the watch's loop, so no process is left behind
  writeFileSync(at('bin/sleep'), `#!/bin/sh\n: > '${at('asleep')}'\n`
    + `while [ ! -e '${at('go')}' ]; do [ -e '${at('end')}' ] && exit 1; /bin/sleep 0.005; done\nrm -f '${at('go')}'\n`);
  chmodSync(at('bin/ps'), 0o755);
  chmodSync(at('bin/sleep'), 0o755);
  writeFileSync(at('watch.sh'), IDLE_WATCH);
  let usage = 0;
  // Written aside and renamed, as the kernel's counter is never seen half-written
  const stat = (text = `usage_usec ${usage}\nuser_usec 0\n`) => {
    writeFileSync(at('cpu.stat.tmp'), text);
    renameSync(at('cpu.stat.tmp'), at('cpu.stat'));
  };
  stat();
  const child = spawn('sh', [at('watch.sh')], { env: {
    PATH: `${at('bin')}:${process.env.PATH}`, FNKC_IDLE_MINUTES: String(o.minutes), FNKC_BUSY_NOTICE_MINUTES: String(o.notice),
    FNKC_BUSY_STOP_MINUTES: String(o.limit), FNKC_IDLE_INTERVAL: '1', FNKC_IDLE_STAT: at('cpu.stat'),
    FNKC_IDLE_STATE: at('state'), FNKC_IDLE_KEEP: at('keep'), FNKC_IDLE_JOBS: at('jobs'),
    FNKC_IDLE_STOP: `cp ${at('state')} ${at('stopped')}`,
  } });
  let exited = false;
  const exit = new Promise((r) => child.on('exit', () => { exited = true; r(undefined); }));
  t.after(() => {
    if (!exited) { writeFileSync(at('end'), ''); child.kill(); }
    rmSync(dir, { recursive: true, force: true });
  });
  const states: string[] = [];
  const awake = () => exited || existsSync(at('asleep'));
  for (let check = 1; check <= o.checks; check++) {
    // The watch sleeps before check n, or has exited (stopped the container, or found no counter at start)
    await until(awake, `sleep before check ${check}`);
    if (exited) break;
    if (o.window?.(check)) writeFileSync(at('window'), ''); else rmSync(at('window'), { force: true });
    if (o.keepAt === check) writeFileSync(at('keep'), '');
    if (o.busy) usage += 900_000;
    stat(o.unreadAt === check ? '' : undefined);
    rmSync(at('asleep'));
    writeFileSync(at('go'), '');
    // Check n is done when the watch sleeps again or has exited after a stop
    await until(awake, `check ${check}`);
    states.push(readFileSync(at('state'), 'utf8'));
  }
  writeFileSync(at('end'), '');
  await exit;
  const run: Run = { states };
  if (existsSync(at('stopped'))) run.stopped = readFileSync(at('stopped'), 'utf8');
  return run;
}

test('the idle watch: quiet without a window stops; busy without a window stops later; a window or Keep postpones it', { timeout: 90_000 }, async (t) => {
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
