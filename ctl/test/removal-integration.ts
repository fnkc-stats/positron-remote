// Real Docker content fingerprinting, and the read helpers' bounds on a hostile project volume. No existing project or
// user data is mounted.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, CHECKOUT_READ_MS } from '../src/agent.ts';
import { agentConfig } from '../src/agent-config.ts';
import { Docker } from '../src/docker.ts';
import { LABEL, projectNames } from '../src/layout.ts';

async function main() {
  const image = process.argv[2];
  if (!image) throw Error('image required');
  const project = 'content-' + randomBytes(5).toString('hex');
  const n = projectNames('fixture', project);
  const lockDir = mkdtempSync(join(tmpdir(), 'fnkc-content-'));
  const docker = new Docker();
  const agent = new Agent(agentConfig('fixture', { lockDir }), { info() {}, warn() {} }, docker);
  const fill = (text: string) => docker.ok(['run', '--rm', '--network', 'none', '--memory', '256m',
    '-v', `${n.projectVolume}:/work`, '--entrypoint', 'sh', image, '-c',
    'mkdir -p /work/results; printf "%s" "$1" > /work/results/data; chown -R 1000:1000 /work', 'sh', text]);
  try {
    await docker.ok(['volume', 'create', n.projectVolume]);
    await fill('first');
    await docker.ok(['create', '--name', n.container, '--label', `${LABEL.managed}=1`,
      '--label', `${LABEL.user}=fixture`, '--label', `${LABEL.project}=${project}`,
      '-v', `${n.projectVolume}:/home/analyst/${project}`, '--entrypoint', 'sh', image]);
    // The user controls the project volume: reads of it end, and their helper containers do not stay behind
    const prepare = (script: string) => docker.ok(['run', '--rm', '--network', 'none', '--memory', '256m', '-v', `${n.projectVolume}:/work`,
      '--entrypoint', 'sh', image, '-c', `cd /work && ${script}; chown -R 1000:1000 /work`]);
    const helpers = async () => (await docker.ok(['ps', '-aq', '--filter', `name=fnkc.read.fixture.${project}.`])).trim();
    await prepare('git init -q && git remote add origin git@example.test:org/x.git && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x' +
      ' && ln -s /dev/zero container.json');
    let started = Date.now();
    let found = await agent.checkout(project);
    assert.equal(found.checkout, 'unknown'); assert.match(found.reason ?? '', /not a regular file/);
    assert.ok(Date.now() - started < CHECKOUT_READ_MS, 'a symlink to /dev/zero is not read');
    await prepare('rm container.json && mkfifo container.json');
    found = await agent.checkout(project);
    assert.equal(found.checkout, 'unknown'); assert.match(found.reason ?? '', /not a regular file/);
    // A read that never ends (git opens a FIFO): the helper is stopped at the deadline and removed
    await prepare('rm container.json && mv .git/config .git/config.x && mkfifo .git/config');
    started = Date.now();
    found = await agent.checkout(project);
    assert.equal(found.checkout, 'unknown'); assert.match(found.reason ?? '', /timed out/);
    assert.ok(Date.now() - started < CHECKOUT_READ_MS + 40_000, 'the deadline holds');
    assert.equal(await helpers(), '', 'no helper container remains after a read that did not end');
    await prepare('rm -rf .git container.json');
    console.log('PASS: checkout reads refuse FIFOs and symlinks, stop at their deadline, and leave no helper container');

    const before = await agent.removalCheck(project);
    assert.equal((await agent.removalCheck(project)).fingerprint, before.fingerprint, 'reading alone must not change the fingerprint');
    await fill('second'); // same file name, same top-level report, different content
    await assert.rejects(agent.remove(project, before.fingerprint), /changed since/);
    assert.ok(await docker.container(n.container));
    const current = await agent.removalCheck(project);
    await agent.remove(project, current.fingerprint);
    assert.equal(await docker.container(n.container), null);
    console.log('PASS: real volume content changes invalidate deletion; unchanged previews are stable; removal succeeds after re-review');
  } finally {
    await docker.run(['rm', '-f', n.container]);
    await docker.run(['volume', 'rm', n.projectVolume]);
    rmSync(lockDir, { recursive: true, force: true });
  }
}
main().catch((e: Error) => { console.error(e); process.exitCode = 1; });
