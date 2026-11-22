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
import { EXTENSIONS_CHECK_MS, EXTENSIONS_OWNER_MS, EXTENSIONS_PREPARE_MS, prepareExtensions } from '../src/positron-server.ts';

async function main() {
  const image = process.argv[2];
  if (!image) throw Error('image required');
  const project = 'content-' + randomBytes(5).toString('hex');
  const n = projectNames('fixture', project);
  const lockDir = mkdtempSync(join(tmpdir(), 'fnkc-content-'));
  const docker = new Docker();
  const agent = new Agent(agentConfig('fixture', { lockDir }), { info() {}, warn() {} }, docker);
  const extVolume = `fnkc-ext-fixture-${project}-x64-${'0'.repeat(12)}`;
  // A helper of this project left by an agent that died, and one of project <project>.b, which is not this project's
  const leftovers = [`fnkc.ext.fixture.${project}.${randomBytes(6).toString('hex')}`, `fnkc.ext.fixture.${project}.b.${randomBytes(6).toString('hex')}`];
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
    // As the analyst, who owns the volume (fill above): git refuses a repository of another owner
    const prepare = (script: string) => docker.ok(['run', '--rm', '--network', 'none', '--memory', '256m', '--user', '1000:1000',
      '-v', `${n.projectVolume}:/work`, '-e', 'HOME=/tmp', '--entrypoint', 'sh', image, '-c', `set -e; cd /work; ${script}`]);
    const helpers = async () => (await docker.ok(['ps', '-aq', '--filter', `name=fnkc.read.fixture.${project}.`])).trim();
    const origin = 'git@example.test:org/x.git';
    await prepare(`git init -q; git remote add origin ${origin}; git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m x; ` +
      `echo '{"image": "${image}"}' > container.json`);
    let found = await agent.checkout(project);
    assert.equal(found.checkout, 'present', `a regular checkout is read: ${found.reason ?? ''}`);
    await prepare('rm container.json; ln -s /dev/zero container.json');
    let started = Date.now();
    found = await agent.checkout(project);
    assert.equal(found.checkout, 'unknown'); assert.match(found.reason ?? '', /not a regular file/);
    assert.ok(Date.now() - started < CHECKOUT_READ_MS, 'a symlink to /dev/zero is not read');
    await prepare('rm container.json; mkfifo container.json');
    found = await agent.checkout(project);
    assert.equal(found.checkout, 'unknown'); assert.match(found.reason ?? '', /not a regular file/);
    // A read that never ends (git opens a FIFO as HEAD): the helper is stopped at the deadline and removed
    await prepare('rm container.json; mv .git/HEAD .git/HEAD.x; mkfifo .git/HEAD');
    started = Date.now();
    found = await agent.checkout(project);
    assert.equal(found.checkout, 'unknown'); assert.equal(found.reason, `cannot read existing checkout: timed out after ${CHECKOUT_READ_MS / 1000} s`);
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

    // The extensions volume is the user's too: its .fnkc-ctl is never read unless regular, the helpers that prepare it
    // end and do not stay, root's files of earlier versions go to the analyst, and helpers a dead agent left are removed
    const img = (await docker.image(image))!;
    const arch = img.Architecture === 'arm64' ? 'arm64' : 'x64';
    const commit = img.Config?.Labels?.['positron.commit'] || 'd'.repeat(40);
    const version = img.Config?.Labels?.['positron.version'] || '2026.11.1-1';
    const want = `${version};ms-toolsai.`;
    const onExt = (script: string) => docker.ok(['run', '--rm', '--user', '0', '--network', 'none', '--memory', '64m', '-v', `${extVolume}:/ext`,
      '--entrypoint', 'sh', image, '-c', script]);
    const extHelpers = async () => (await docker.ok(['ps', '-a', '--format', '{{.Names}}'])).split('\n')
      .filter((name) => new RegExp(`^fnkc\\.ext\\.fixture\\.${project.replaceAll('.', '\\.')}\\.[0-9a-f]{12}$`).test(name));
    await docker.ok(['volume', 'create', extVolume]);
    await docker.ok(['create', '--name', leftovers[1], '--entrypoint', 'sh', image]);
    for (const [kind, plant] of [['a symlink to /dev/zero', 'ln -s /dev/zero /ext/.fnkc-ctl'], ['a FIFO', 'mkfifo /ext/.fnkc-ctl']]) {
      await onExt(`rm -rf /ext/.fnkc-ctl; ${plant}; touch /ext/root-file; chown -h 0:0 /ext /ext/.fnkc-ctl /ext/root-file`);
      await docker.ok(['create', '--name', leftovers[0], '--entrypoint', 'sh', image]);
      started = Date.now();
      await prepareExtensions(docker, image, arch, extVolume, version, commit, ['ms-toolsai.'], { info() {}, warn() {} }, { user: 'fixture', project });
      assert.ok(Date.now() - started < EXTENSIONS_CHECK_MS + EXTENSIONS_OWNER_MS + EXTENSIONS_PREPARE_MS, `${kind}: the deadlines hold`);
      assert.equal(await onExt('f=/ext/.fnkc-ctl; [ -f "$f" ] && [ ! -L "$f" ] && cat "$f"'), want, `${kind}: replaced by a regular file`);
      assert.equal((await onExt('stat -c %u:%g /ext /ext/.fnkc-ctl /ext/root-file')).trim(), '1000:1000\n1000:1000\n1000:1000', `${kind}: the analyst owns the volume`);
      assert.deepEqual(await extHelpers(), [], `${kind}: no helper container remains, nor the leftover one`);
      assert.ok(await docker.container(leftovers[1]), "another project's helper is not touched");
    }
    console.log('PASS: the extensions volume is prepared without reading a FIFO or /dev/zero, as the analyst, leaving no helper container');
  } finally {
    for (const name of [n.container, ...leftovers]) await docker.run(['rm', '-f', name]);
    await docker.run(['volume', 'rm', n.projectVolume]);
    await docker.run(['volume', 'rm', extVolume]);
    rmSync(lockDir, { recursive: true, force: true });
  }
}
main().catch((e: Error) => { console.error(e); process.exitCode = 1; });
