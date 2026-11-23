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
import { EXTENSIONS_CHECK_MS, EXTENSIONS_OWNER_MS, EXTENSIONS_OWNER_SECCOMP, EXTENSIONS_PREPARE_MS, prepareExtensions } from '../src/positron-server.ts';

// The profile install.sh installs next to fnkc-ctl.cjs (this file is bundled to ctl/.cache)
const profile = join(__dirname, '..', 'server', EXTENSIONS_OWNER_SECCOMP);

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
      // root's file in the analyst's mode-700 directory: the ownership step enters it (DAC_READ_SEARCH)
      await onExt(`rm -rf /ext/.fnkc-ctl /ext/private; ${plant}; touch /ext/root-file; chown -h 0:0 /ext /ext/.fnkc-ctl /ext/root-file; ` +
        'mkdir /ext/private; touch /ext/private/root-file; chown 1000:1000 /ext/private; chmod 700 /ext/private');
      await docker.ok(['create', '--name', leftovers[0], '--entrypoint', 'sh', image]);
      started = Date.now();
      const warnings: string[] = [];
      await prepareExtensions(docker, image, arch, extVolume, version, commit, ['ms-toolsai.'], { info() {}, warn: (m) => warnings.push(m) },
        { user: 'fixture', project }, () => profile);
      assert.deepEqual(warnings, [], `${kind}: prepared, not skipped`);
      assert.ok(Date.now() - started < EXTENSIONS_CHECK_MS + EXTENSIONS_OWNER_MS + EXTENSIONS_PREPARE_MS, `${kind}: the deadlines hold`);
      assert.equal(await onExt('f=/ext/.fnkc-ctl; [ -f "$f" ] && [ ! -L "$f" ] && cat "$f"'), want, `${kind}: replaced by a regular file`);
      assert.equal((await onExt('stat -c %u:%g /ext /ext/.fnkc-ctl /ext/root-file /ext/private/root-file')).trim(),
        '1000:1000\n1000:1000\n1000:1000\n1000:1000', `${kind}: the analyst owns the volume`);
      assert.deepEqual(await extHelpers(), [], `${kind}: no helper container remains, nor the leftover one`);
      assert.ok(await docker.container(leftovers[1]), "another project's helper is not touched");
    }
    console.log('PASS: the extensions volume is prepared without reading a FIFO or /dev/zero, as the analyst, leaving no helper container');

    // The ownership step's profile refuses file handles to root with DAC_READ_SEARCH; Docker's default allows them.
    // Prints the errno of name_to_handle_at (EOVERFLOW for a handle of 0 bytes, if allowed) and open_by_handle_at
    // (EINVAL for that handle, if allowed); EPERM (1) where seccomp refuses them.
    const probe = 'my %n = (x86_64 => [303, 304], aarch64 => [264, 265]); my ($name, $open) = @{$n{(POSIX::uname())[4]}}; ' +
      'my $h = pack("LiC128", 0, 0); my $m = pack("i", 0); syscall($name, -100, "/", $h, $m, 0); print $! + 0, " "; ' +
      'opendir(my $d, "/") or die; syscall($open, dirfd($d), $h, 0); print $! + 0;';
    const handles = (seccomp: string[]) => docker.ok(['run', '--rm', '--network', 'none', '--memory', '64m', '--user', '0:0',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges', ...seccomp,
      '--entrypoint', 'perl', image, '-MPOSIX', '-e', probe]);
    const allowed = (await handles([])).trim();
    assert.ok(/^\d+ \d+$/.test(allowed) && !allowed.split(' ').includes('1'), `Docker's default profile allows file handles (errno ${allowed})`);
    assert.equal((await handles(['--security-opt', `seccomp=${profile}`])).trim(), '1 1', 'the ownership step\'s profile refuses them');
    console.log('PASS: the ownership step\'s seccomp profile refuses name_to_handle_at and open_by_handle_at');
  } finally {
    for (const name of [n.container, ...leftovers]) await docker.run(['rm', '-f', name]);
    await docker.run(['volume', 'rm', n.projectVolume]);
    await docker.run(['volume', 'rm', extVolume]);
    rmSync(lockDir, { recursive: true, force: true });
  }
}
main().catch((e: Error) => { console.error(e); process.exitCode = 1; });
