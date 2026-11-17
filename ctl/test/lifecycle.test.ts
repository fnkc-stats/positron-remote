import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent.ts';
import { agentConfig } from '../src/agent-config.ts';
import { Docker, type ContainerJson } from '../src/docker.ts';
import { LABEL, projectNames } from '../src/layout.ts';
import { repositoryId } from '../src/repository.ts';
import type { RunOptions } from '../src/exec.ts';

const image = `ghcr.io/fnkc-stats/r-env@sha256:${'a'.repeat(64)}`;
const image2 = image.replace(/a{64}/, 'b'.repeat(64));
const repository = 'git@example.test:org/study.git';
const project = repositoryId(repository);
const name = projectNames('alice', project).container;
const request = { project, repository, revision: 'c'.repeat(40), image, positron: { version: '2026.11.1-1', commit: 'd'.repeat(40) }, sshPublicKey: 'ssh-ed25519 AAAA' };
class FakeDocker extends Docker {
  cs = new Map<string, ContainerJson>();
  calls: string[][] = [];
  copyFails = false;
  checkout?: string;
  override async image(value: string) { return { Id: value, Architecture: 'amd64' }; }
  override async container(value: string) { return this.cs.get(value) ?? null; }
  override async containers(_labels: string[]) { return [...this.cs.values()]; }
  override async run(args: string[], _opts?: RunOptions) {
    this.calls.push(args);
    if (args[0] === 'volume') return { code: this.checkout ? 0 : 1, stdout: '', stderr: this.checkout ? '' : 'no such volume' };
    if (args[0] === 'run' && args.some((a) => a.endsWith(':/work:ro'))) return { code: 0, stdout: this.checkout!, stderr: '' };
    if (args[0] === 'exec') return { code: 0, stdout: 'ssh-ed25519 AAAA', stderr: '' };
    if (args[0] === 'rm') this.cs.delete(args.at(-1)!);
    return { code: 0, stdout: '', stderr: '' };
  }
  override async ok(args: string[], _opts?: RunOptions) {
    this.calls.push(args);
    if (args[0] === 'info') return 'x86_64 8 34359738368';
    if (args[0] === 'create') {
      const labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) if (args[i] === '--label') {
        const item = args[++i]; const at = item.indexOf('='); labels[item.slice(0, at)] = item.slice(at + 1);
      }
      this.cs.set(name, { Name: `/${name}`, Config: { Image: args.at(-1)!, Labels: labels, Env: [] },
        State: { Running: false, Status: 'created' }, HostConfig: { Memory: 4 * 1024 ** 3 },
        NetworkSettings: { Ports: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: '2222' }] } } });
    }
    if (args[0] === 'cp' && this.copyFails) throw new Error('interrupted copy');
    if (args[0] === 'start') this.cs.get(name)!.State = { Running: true, Status: 'running' };
    if (args[0] === 'stop') this.cs.get(args.at(-1)!)!.State = { Running: false, Status: 'exited' };
    if (args[0] === 'rename') { const c = this.cs.get(args[1])!; this.cs.delete(args[1]); c.Name = `/${args[2]}`; this.cs.set(args[2], c); }
    if (args[0] === 'rm') this.cs.delete(args.at(-1)!);
    return '';
  }
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = new FakeDocker();
  const cfg = agentConfig('alice', { lockDir: dir, skipExtensions: [] });
  return { docker, cfg, agent: new Agent(cfg, { info() {}, warn() {} }, docker) };
}
test('interrupted creation preserves volumes and retries successfully', async (t) => {
  const { docker, agent } = fixture(t); docker.copyFails = true;
  await assert.rejects(agent.start(request), /interrupted copy/);
  assert.equal(docker.cs.size, 0);
  assert.ok(!docker.calls.some((c) => c[0] === 'volume' && c[1] === 'rm'));
  docker.copyFails = false; assert.equal((await agent.start(request)).created, true);
});
test('running jobs survive an environment upgrade request', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  const before = docker.calls.length;
  await assert.rejects(agent.start({ ...request, image: image2 }), /stop this project explicitly/);
  assert.ok(!docker.calls.slice(before).some((c) => ['rm', 'stop', 'rename'].includes(c[0])));
  assert.ok(docker.cs.get(name)!.State.Running);
});
test('stopped replacement rolls back if copying fails', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request); await agent.stop(project); docker.copyFails = true;
  await assert.rejects(agent.start({ ...request, image: image2 }), /interrupted copy/);
  assert.equal(docker.cs.size, 1); assert.equal(docker.cs.get(name)?.Config.Image, image);
});
test('existing branch manifest overrides remote HEAD environment', async (t) => {
  const { docker, agent } = fixture(t); const oldCommit = 'e'.repeat(40);
  docker.checkout = `${repository}\n${oldCommit}\n${JSON.stringify({ image: image2 })}`;
  const result = await agent.start(request);
  assert.equal(result.image, image2); assert.equal(result.revision, oldCommit);
});
test('checkout origin mismatch fails before creating a container', async (t) => {
  const { docker, agent } = fixture(t);
  docker.checkout = `git@example.test:other/study.git\n${request.revision}\n${JSON.stringify({ image })}`;
  await assert.rejects(agent.start(request), /another repository/); assert.equal(docker.cs.size, 0);
});
test('concurrent opens serialize and create only one container', async (t) => {
  const { docker, agent } = fixture(t);
  const results = await Promise.all([agent.start(request), agent.start(request)]);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(docker.calls.filter((c) => c[0] === 'create').length, 1);
});
test('admission reserves host memory and enforces per-user quota', async (t) => {
  const { docker, agent, cfg } = fixture(t); cfg.reserveMemory = '31g';
  await assert.rejects(agent.start(request), /host capacity/);
  cfg.reserveMemory = '2g'; await agent.start(request); cfg.maxProjectsPerUser = 1;
  const c = docker.cs.get(name)!; docker.cs.delete(name); docker.cs.set('another', c);
  await assert.rejects(agent.start(request), /quota/);
});
test('broker checks ownership before connecting to any socket', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  docker.cs.get(name)!.Config.Labels![LABEL.user] = 'bob';
  await assert.rejects(agent.connectProject(project), /not owned/);
});
