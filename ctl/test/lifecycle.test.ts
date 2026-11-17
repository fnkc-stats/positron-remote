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
  serverInstalled = true;
  override async image(value: string): Promise<{ Id: string; Architecture: string } | null> { return { Id: value, Architecture: 'amd64' }; }
  override async container(value: string) { return this.cs.get(value) ?? null; }
  override async containers(_labels: string[]) { return [...this.cs.values()]; }
  override async run(args: string[], _opts?: RunOptions) {
    this.calls.push(args);
    if (args[0] === 'volume') return { code: this.checkout ? 0 : 1, stdout: '', stderr: this.checkout ? '' : 'no such volume' };
    if (args[0] === 'run' && args.some((a) => a.endsWith(':/work:ro'))) return { code: 0, stdout: this.checkout!, stderr: '' };
    if (args[0] === 'exec') return { code: 0, stdout: 'ssh-ed25519 AAAA', stderr: '' };
    if (args.some((a) => a.startsWith('test -x "/srv/'))) return { code: this.serverInstalled ? 0 : 1, stdout: '', stderr: '' };
    if (args.some((a) => a.includes('tar -xzf -'))) this.serverInstalled = true;
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
  const create = docker.calls.find((c) => c[0] === 'create')!;
  assert.equal(create[create.indexOf('--ulimit') + 1], 'core=0', 'containers never write core dumps');
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

test('a missing Positron server is reported, then installed from an archive the client sends', async (t) => {
  const { Readable } = await import('node:stream');
  const { PositronServerMissing } = await import('../src/positron-server.ts');
  const { answer } = await import('../src/serve.ts');
  const { docker, agent } = fixture(t); docker.serverInstalled = false;
  const err = await agent.start(request).catch((e: unknown) => e);
  assert.ok(err instanceof PositronServerMissing);
  assert.equal(err.missing.commit, request.positron.commit);
  assert.equal(err.missing.image, image);
  assert.equal(err.missing.archive, 'positron-reh-linux-x64-2026.11.1-1.tar.gz');
  assert.match(err.missing.url, /^https:\/\/cdn\.posit\.co\/.*positron-reh-linux-x64-2026\.11\.1-1\.tar\.gz$/);
  assert.equal(docker.cs.size, 0, 'nothing is created before the server is there');
  // The reply over SSH carries the details the client needs
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  try { await answer(() => agent.start(request)); } finally { process.stdout.write = write; }
  assert.equal(JSON.parse(out[0]).serverMissing.archive, err.missing.archive);
  await assert.rejects(agent.installServer('x', image, Readable.from([])));
  await assert.rejects(agent.installServer(request.positron.commit, 'evil/image@sha256:' + 'a'.repeat(64), Readable.from([])));
  assert.deepEqual(await agent.installServer(request.positron.commit, image, Readable.from([Buffer.from('tgz')])), { installed: true });
  assert.equal((await agent.start(request)).created, true);
});

test('a missing image is reported, downloaded by digest on the client, checked and loaded on the host', async (t) => {
  const { createHash } = await import('node:crypto');
  const { createServer } = await import('node:http');
  const { Readable } = await import('node:stream');
  const { readdirSync } = await import('node:fs');
  const { EnvironmentImageMissing } = await import('../src/image-store.ts');
  const { imageUpload, uploadStream } = await import('../src/client/image-download.ts');
  const { answer } = await import('../src/serve.ts');
  const digest = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
  const blob = (b: Buffer, mediaType: string) => ({ mediaType, digest: digest(b), size: b.length });
  // A two-architecture image as a registry serves it
  const configs = { amd64: Buffer.from('{"architecture":"amd64","os":"linux"}'), arm64: Buffer.from('{"architecture":"arm64","os":"linux"}') };
  const layer = Buffer.from('layer bytes (any content: docker load is faked)');
  const gz = 'application/vnd.oci.image.layer.v1.tar+gzip';
  const manifests = Object.fromEntries(Object.entries(configs).map(([arch, config]) => [arch, Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: blob(config, 'application/vnd.oci.image.config.v1+json'), layers: [blob(layer, gz), blob(layer, gz)],
  }))]));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    ...Object.entries(manifests).map(([arch, m]) => ({ ...blob(m, 'application/vnd.oci.image.manifest.v1+json'), platform: { os: 'linux', architecture: arch } })),
    { ...blob(Buffer.from('{}'), 'application/vnd.oci.image.manifest.v1+json'), platform: { os: 'unknown', architecture: 'unknown' } },
  ] }));
  const store = new Map([index, ...Object.values(manifests), ...Object.values(configs), layer].map((b) => [digest(b), b]));
  const fetched: string[] = [];
  const registry = createServer((req, res) => {
    if (req.url?.startsWith('/token')) return res.end(JSON.stringify({ token: 'anonymous' }));
    if (req.headers.authorization !== 'Bearer anonymous') {
      res.writeHead(401, { 'www-authenticate': `Bearer realm="http://${req.headers.host}/token",service="test"` });
      return res.end();
    }
    const body = store.get(req.url!.split('/').pop()!);
    fetched.push(req.url!);
    if (!body) { res.writeHead(404); return res.end(); }
    res.end(body);
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  t.after(() => registry.close());
  const port = (registry.address() as { port: number }).port;
  const repo = `localhost:${port}/fnkc-stats/r-env`;
  const pinned = `${repo}@${digest(index)}`;

  const dir = mkdtempSync(join(tmpdir(), 'pctl-image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loaded = new Map<string, { names: string[]; manifest: { RepoTags: string[]; Layers: string[] }[] }>();
  class OfflineDocker extends FakeDocker {
    override async image(value: string) { return loaded.has(value) ? { Id: value, Architecture: 'amd64' } : null; }
    override async ok(args: string[], opts?: RunOptions) {
      if (args[0] !== 'load') return super.ok(args, opts);
      this.calls.push(args);
      const chunks: Buffer[] = [];
      for await (const c of opts!.input as AsyncIterable<Buffer>) chunks.push(c);
      const tar = Buffer.concat(chunks);
      const names: string[] = [];
      let manifest;
      for (let at = 0; tar[at];) {
        const name = tar.toString('utf8', at, at + 100).replace(/\0.*$/s, '');
        const size = parseInt(tar.toString('utf8', at + 124, at + 135), 8);
        names.push(name);
        if (name === 'manifest.json') manifest = JSON.parse(tar.toString('utf8', at + 512, at + 512 + size));
        at += 512 + Math.ceil(size / 512) * 512;
      }
      loaded.set(manifest[0].RepoTags[0], { names, manifest });
      return '';
    }
  }
  const docker = new OfflineDocker();
  const agent = new Agent(agentConfig('alice', { lockDir: dir, skipExtensions: [], allowedImages: [repo], imageStagingDir: join(dir, 'staging') }), { info() {}, warn() {} }, docker);
  const req = { ...request, image: pinned };

  const err = await agent.start(req).catch((e: unknown) => e);
  assert.ok(err instanceof EnvironmentImageMissing);
  assert.deepEqual(err.missing, { image: pinned, arch: 'x64' });
  assert.ok(!docker.calls.some((c) => c[0] === 'pull'), 'hosts do not pull by default');
  assert.equal(docker.cs.size, 0);
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  try { await answer(() => agent.start(req)); } finally { process.stdout.write = write; }
  assert.deepEqual(JSON.parse(out[0]).imageMissing, err.missing);

  // The client downloads only the host's architecture, each layer once, and caches it
  const cache = join(dir, 'client');
  const upload = await imageUpload(cache, err.missing, { info() {}, warn() {} });
  assert.ok(!fetched.some((u) => u.endsWith(digest(configs.arm64).slice(7))), 'other architecture not downloaded');
  assert.equal(fetched.filter((u) => u.endsWith(digest(layer))).length, 1);
  assert.equal(upload.blobs.length, 2);
  await imageUpload(cache, err.missing, { info() {}, warn() {} });
  assert.equal(fetched.filter((u) => u.includes('/blobs/')).length, 2, 'second Open uses the cache');

  // Content that does not match the digest never reaches Docker
  const good = Buffer.concat(await uploadStream(cache, upload).toArray());
  const bad = Buffer.from(good); bad[bad.length - 3] ^= 1;
  await assert.rejects(agent.installImage(pinned, Readable.from([bad])), /does not match/);
  await assert.rejects(agent.installImage(pinned, Readable.from([good.subarray(0, good.length - 5)])), /ended early/);
  await assert.rejects(agent.installImage(pinned, Readable.from([good, Buffer.from('x')])), /after the last layer/);
  await assert.rejects(agent.installImage(`ghcr.io/evil/r-env@${digest(index)}`, Readable.from([good])), /not allowed/);
  assert.equal(loaded.size, 0);
  assert.deepEqual(readdirSync(join(dir, 'staging')), [], 'rejected uploads leave nothing behind');

  assert.deepEqual(await agent.installImage(pinned, uploadStream(cache, upload)), { installed: true });
  const tag = `${repo}:${digest(index).replace(':', '-')}`;
  assert.deepEqual(loaded.get(tag)!.manifest[0].Layers, [`blobs/sha256/${digest(layer).slice(7)}`, `blobs/sha256/${digest(layer).slice(7)}`]);
  assert.deepEqual(readdirSync(join(dir, 'staging')), []);

  // Start now uses the uploaded image by its tag; the container still names the pinned digest
  assert.equal((await agent.start(req)).image, pinned);
  const create = docker.calls.find((c) => c[0] === 'create')!;
  assert.equal(create.at(-1), tag);
  assert.ok(create.includes(`FNKC_IMAGE_DIGEST=${pinned}`));
});
