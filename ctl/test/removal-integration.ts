// Real Docker content fingerprinting. No existing project or user data is mounted.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.ts';
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
