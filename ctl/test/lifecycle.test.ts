import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, CHECKOUT_READ_MS, CHECKOUT_SCRIPT } from '../src/agent.ts';
import { agentConfig } from '../src/agent-config.ts';
import { Docker, type ContainerJson, type ImageJson } from '../src/docker.ts';
import { LABEL, projectNames } from '../src/layout.ts';
import { repositoryName } from '../src/repository.ts';
import type { RunOptions } from '../src/exec.ts';

const image = `ghcr.io/fnkc-stats/r-env@sha256:${'a'.repeat(64)}`;
const image2 = image.replace(/a{64}/, 'b'.repeat(64));
const repository = 'git@example.test:org/study.git';
const project = repositoryName(repository);
const name = projectNames('alice', project).container;
const request = { project, repository, revision: 'c'.repeat(40), image, positron: { version: '2026.11.1-1', commit: 'd'.repeat(40) }, sshPublicKey: 'ssh-ed25519 AAAA' };
class FakeDocker extends Docker {
  cs = new Map<string, ContainerJson>();
  calls: string[][] = [];
  copyFails = false;
  /** How removing a replaced container fails: Docker refuses it, or removes it and the answer is lost. */
  predecessorRm?: 'refused' | 'lost-ack';
  checkout?: string;
  /** Exit code of reading the checkout (0: prints `checkout`). */
  checkoutCode = 0;
  /** Reading the checkout fails in the docker CLI (timeout, output limit): the helper may still run. */
  checkoutThrows?: string;
  /** Environment images on the host (docker images). */
  imgs: ImageJson[] = [];
  positronCommit = 'd'.repeat(40);
  /** Labels of particular images; all others serve the Positron build positronCommit. */
  labels = new Map<string, Record<string, string>>();
  override async image(value: string): Promise<ImageJson | null> {
    const labels = this.labels.get(value) ?? { 'positron.version': '2026.11.1-1', 'positron.commit': this.positronCommit };
    return { Id: value, Architecture: 'amd64', Config: { Labels: labels } };
  }
  override async container(value: string) { return this.cs.get(value) ?? null; }
  override async containers(_labels: string[]) { return [...this.cs.values()]; }
  override async images() { return this.imgs; }
  override async run(args: string[], _opts?: RunOptions) {
    this.calls.push(args);
    if (args[0] === 'volume') return { code: this.checkout ? 0 : 1, stdout: '', stderr: this.checkout ? '' : 'no such volume' };
    if (args[0] === 'run' && args.some((a) => a.endsWith(':/work:ro'))) {
      if (this.checkoutThrows) throw new Error(this.checkoutThrows);
      return this.checkoutCode ? { code: this.checkoutCode, stdout: '', stderr: 'git: bad object' } : { code: 0, stdout: this.checkout!, stderr: '' };
    }
    if (args[0] === 'exec') return { code: 0, stdout: 'ssh-ed25519 AAAA', stderr: '' };
    if (args[0] === 'rm' && args.length === 2 && args[1] !== name && this.predecessorRm) {
      if (this.predecessorRm === 'lost-ack') this.cs.delete(args[1]);
      return { code: 1, stdout: '', stderr: 'connection reset' };
    }
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
      this.cs.set(name, { Name: `/${name}`, Image: args.at(-1)!, Config: { Image: args.at(-1)!, Labels: labels, Env: [] },
        State: { Running: false, Status: 'created' }, HostConfig: { Memory: 4 * 1024 ** 3 },
        NetworkSettings: { Ports: { '22/tcp': [{ HostIp: '127.0.0.1', HostPort: '2222' }] } } });
    }
    if (args[0] === 'cp' && this.copyFails) throw new Error('interrupted copy');
    if (args[0] === 'start') this.cs.get(name)!.State = { Running: true, Status: 'running' };
    if (args[0] === 'stop') this.cs.get(args.at(-1)!)!.State = { Running: false, Status: 'exited' };
    if (args[0] === 'rm' && args.length === 2 && args[1] !== name && this.predecessorRm) {
      if (this.predecessorRm === 'lost-ack') this.cs.delete(args[1]);
      throw new Error('connection reset');
    }
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
  assert.ok(create.includes(`${projectNames('alice', project).libraryVolume}:/home/analyst/.fnkc-library`), "renv's cache lives on a volume");
});
test('running jobs survive an environment upgrade request', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  const before = docker.calls.length;
  // The client connects to the running container as it is and learns that the update waits for a stop
  const again = await agent.start({ ...request, image: image2 });
  assert.equal(again.updatePending, true); assert.equal(again.created, false);
  assert.equal(again.image, image, 'the container still runs the old image'); assert.equal(again.pinnedImage, image2);
  assert.ok(!docker.calls.slice(before).some((c) => ['rm', 'stop', 'rename', 'create'].includes(c[0])));
  assert.ok(docker.cs.get(name)!.State.Running);
});
test('stopped replacement rolls back if copying fails', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request); await agent.stop(project); docker.copyFails = true;
  await assert.rejects(agent.start({ ...request, image: image2 }), /interrupted copy/);
  assert.equal(docker.cs.size, 1); assert.equal(docker.cs.get(name)?.Config.Image, image);
});
for (const mode of ['refused', 'lost-ack'] as const) {
  test(`a ready replacement stays when removing its predecessor fails (${mode})`, async (t) => {
    const { docker, agent } = fixture(t); await agent.start(request); await agent.stop(project);
    docker.predecessorRm = mode;
    const result = await agent.start({ ...request, image: image2 });
    assert.equal(result.created, true);
    assert.equal(docker.cs.get(name)?.Config.Image, image2); assert.ok(docker.cs.get(name)?.State.Running);
    assert.equal(docker.cs.size, mode === 'refused' ? 2 : 1, 'the predecessor is left only if Docker kept it');
    docker.predecessorRm = undefined;
    await agent.start({ ...request, image: image2 });
    assert.equal(docker.cs.size, 1, 'the next Open removes a leftover predecessor');
  });
}
test('existing branch manifest overrides remote HEAD environment', async (t) => {
  const { docker, agent } = fixture(t); const oldCommit = 'e'.repeat(40);
  docker.checkout = `${repository}\n${oldCommit}\n${JSON.stringify({ image: image2 })}`;
  const result = await agent.start(request);
  assert.equal(result.image, image2); assert.equal(result.revision, oldCommit);
});
test('the checkout query reads the pin with an image the host has, never pulling the proposed one', async (t) => {
  const { docker, agent } = fixture(t);
  // Nothing on the host: no checkout, and no image was needed to say so
  assert.deepEqual(await agent.checkout(project), { container: undefined, checkout: 'none' });
  assert.ok(!docker.calls.some((c) => c[0] === 'run' || c[0] === 'pull'));

  // A stopped project: read with its container's image
  await agent.start(request); await agent.stop(project);
  const oldCommit = 'e'.repeat(40);
  docker.checkout = `${repository}\n${oldCommit}\n${JSON.stringify({ image: image2 })}`;
  docker.calls = [];
  assert.deepEqual(await agent.checkout(project), { container: { repository, running: false }, checkout: 'present', repository, revision: oldCommit, image: image2 });
  const read = docker.calls.find((c) => c[0] === 'run')!;
  assert.equal(read[read.indexOf('-c') - 1], image, "the container's image, not the checkout's new pin");
  assert.ok(read.includes('--network') && read.includes('none') && read.some((a) => a.endsWith(':/work:ro')));
  assert.ok(!docker.calls.some((c) => c[0] === 'pull' || c[0] === 'create' || c[0] === 'start'));

  // A checkout that cannot be read is "unknown": the start decides
  docker.checkoutCode = 1;
  const broken = await agent.checkout(project);
  assert.equal(broken.checkout, 'unknown'); assert.match(broken.reason!, /cannot read existing checkout/);
});
test('without a container the checkout is read with the newest environment image; with none it is unknown', async (t) => {
  const { docker, agent } = fixture(t);
  docker.checkout = `${repository}\n${'e'.repeat(40)}\n${JSON.stringify({ image: image2 })}`;
  const unknown = await agent.checkout(project);
  assert.equal(unknown.checkout, 'unknown'); assert.match(unknown.reason!, /no environment image/);
  docker.imgs = [
    { Id: 'sha256:old', Architecture: 'amd64', RepoDigests: [image], Created: '2026-01-01T00:00:00Z' },
    { Id: 'sha256:new', Architecture: 'amd64', RepoDigests: [image2], Created: '2026-06-01T00:00:00Z' },
    { Id: 'sha256:other', Architecture: 'amd64', RepoTags: ['busybox:latest'], Created: '2026-09-01T00:00:00Z' },
  ];
  docker.calls = [];
  assert.equal((await agent.checkout(project)).image, image2);
  const read = docker.calls.find((c) => c[0] === 'run')!;
  assert.equal(read[read.indexOf('-c') - 1], 'sha256:new', 'an environment image, never an unrelated one');
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
test('extraHosts become --add-host on project containers', async (t) => {
  const { docker, agent, cfg } = fixture(t); cfg.extraHosts = { 'git.example.test': '10.0.0.5' };
  await agent.start(request);
  const create = docker.calls.find((c) => c[0] === 'create')!;
  assert.equal(create[create.indexOf('--add-host') + 1], 'git.example.test:10.0.0.5');
});
test('broker checks ownership before connecting to any socket', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  docker.cs.get(name)!.Config.Labels![LABEL.user] = 'bob';
  await assert.rejects(agent.connectProject(project), /not owned/);
});

test('the Positron server comes with the image: another Positron build is refused, nothing is downloaded', async (t) => {
  const { docker, agent } = fixture(t);
  assert.equal(project, 'study', 'the project is named after the repository');
  docker.positronCommit = 'e'.repeat(40);
  await assert.rejects(agent.start(request), /built for Positron 2026\.11\.1-1 \(eeeeeeeeeeee\).*this computer has Positron 2026\.11\.1-1 \(dddddddddddd\)/);
  assert.equal(docker.cs.size, 0, 'nothing is created');
  docker.positronCommit = request.positron.commit;
  await agent.start(request);
  const create = docker.calls.find((c) => c[0] === 'create')!;
  assert.ok(!create.some((a) => a.includes('fnkc-server')), 'no shared server volume');
  assert.ok(create.includes('--init'), 'docker-init passes docker stop on to the entrypoint');
  await agent.stop(project);
  const stop = docker.calls.find((c) => c[0] === 'stop')!;
  assert.ok(Number(stop[stop.indexOf('--time') + 1]) >= 60, 'the stop allows a graceful shutdown');
});

test('the pinned environment runs with the server of the client\'s Positron, only an image built on it', async (t) => {
  const { docker, agent } = fixture(t);
  const withServer = image.replace(/a{64}/, 'c'.repeat(64));
  const other = image.replace(/a{64}/, 'd'.repeat(64));
  docker.labels.set(image, { 'r-env.r-series': '4.6' }); // the pin: an environment, no server
  docker.labels.set(withServer, { 'positron.version': '2026.11.1-1', 'positron.commit': request.positron.commit, 'r-env.base': image });
  docker.labels.set(other, { 'positron.version': '2026.11.1-1', 'positron.commit': request.positron.commit, 'r-env.base': image2 });
  await assert.rejects(agent.start({ ...request, positronImage: { image: other } }), /is not built on .*r-env\.base/);
  assert.equal(docker.cs.size, 0, 'nothing is created for another environment');
  await assert.rejects(agent.start(request), /has no Positron server/, 'the environment itself does not run');
  const r = await agent.start({ ...request, positronImage: { image: withServer } });
  assert.equal(r.image, withServer, 'the container runs the image with the server');
  assert.equal(r.pinnedImage, image, 'and reports the pin, which container.json keeps');
  assert.equal(docker.calls.find((c) => c[0] === 'create')!.at(-1), withServer);
});

test('a checkout that pins another environment is reported, so the client chooses for that one', async (t) => {
  const { CheckoutPinsOther } = await import('../src/image-store.ts');
  const { docker, agent } = fixture(t);
  const withServer = image.replace(/a{64}/, 'c'.repeat(64));
  docker.labels.set(withServer, { 'positron.version': '2026.11.1-1', 'positron.commit': request.positron.commit, 'r-env.base': image });
  docker.checkout = `${repository}\n${'c'.repeat(40)}\n{"image": "${image2}"}`;
  await assert.rejects(agent.start({ ...request, positronImage: { image: withServer } }),
    (e: unknown) => e instanceof CheckoutPinsOther && e.pinned === image2);
  assert.equal(docker.cs.size, 0);
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
  const layer = (await import('node:zlib')).gzipSync(Buffer.from('layer bytes (docker load is faked)'));

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
    // The layer arrives in two pieces, so that two downloads of it overlap
    if (body === layer) { res.write(body.subarray(0, 8)); return void setTimeout(() => res.end(body.subarray(8)), 200); }
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
    override async images() { return []; }
    override async image(value: string) { return loaded.has(value) ? super.image(value) : null; }
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
  // Two Opens at once of different images that share the layer: each downloads into its own part file
  const both = join(dir, 'client-both');
  const quiet = { info() {}, warn() {} };
  const [a, b] = await Promise.all([imageUpload(both, err.missing, quiet), imageUpload(both, { image: `${repo}@${digest(manifests.amd64)}`, arch: 'x64' }, quiet)]);
  assert.deepEqual(a.blobs, b.blobs);
  assert.deepEqual(readdirSync(join(both, 'images', 'blobs')).filter((n) => n.endsWith('.part')), [], 'no part file is left');
  assert.deepEqual(Buffer.concat(await uploadStream(both, a).toArray()), Buffer.concat(await uploadStream(cache, upload).toArray()));

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

test('a stalled image pull does not block stopping another project', async (t) => {
  const { docker, cfg, agent } = fixture(t);
  await agent.start(request);
  cfg.pullImages = true;
  let reached!: () => void;
  let release!: () => void;
  const pulling = new Promise<void>((r) => { reached = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const originalImage = docker.image.bind(docker);
  docker.image = async (value) => value.includes('b'.repeat(64)) ? null : originalImage(value);
  const originalRun = docker.run.bind(docker);
  docker.run = async (args, opts) => {
    if (args[0] !== 'pull') return originalRun(args, opts);
    reached(); await gate;
    return { code: 1, stdout: '', stderr: 'fixture offline' };
  };
  const pending = agent.start({ ...request, project: 'other', repository: 'git@example.test:org/other.git', image: image2 });
  const rejected = assert.rejects(pending, /not on this host/);
  await pulling;
  try {
    assert.deepEqual(await Promise.race([agent.stop(project), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('stop was blocked by another project')), 1500); timer.unref();
    })]), { stopped: true });
  } finally { release(); }
  await rejected;
});

test('an interrupted rename is recovered from labels without hiding real previous-suffix projects', async (t) => {
  const { docker, agent } = fixture(t);
  await agent.start(request); await agent.stop(project);
  await docker.ok(['rename', name, 'fnkc.recovery.alice.study']);
  assert.equal((await agent.start(request)).container, name);
  assert.ok(!docker.cs.has('fnkc.recovery.alice.study'));
  const c = structuredClone(docker.cs.get(name)!);
  c.Name = '/fnkc-alice-study-previous';
  c.Config.Labels![LABEL.project] = 'study-previous';
  docker.cs.set('fnkc-alice-study-previous', c);
  assert.ok((await agent.list()).some((p) => p.project === 'study-previous'));
});
test('a start whose user is revoked meanwhile does not start the container', async (t) => {
  const { docker, cfg } = fixture(t);
  const keysDir = mkdtempSync(join(tmpdir(), 'pctl-keys-'));
  t.after(() => rmSync(keysDir, { recursive: true, force: true }));
  writeFileSync(join(keysDir, 'alice.pub'), 'ssh-ed25519 AAAA alice\n');
  const agent = new Agent({ ...cfg, keysDir }, { info() {}, warn() {} }, docker);
  // admin remove-user takes the key away after the start's first check, before it reaches the host lock
  const ok = docker.ok.bind(docker);
  docker.ok = async (args, opts) => {
    if (args[0] === 'cp') rmSync(join(keysDir, 'alice.pub'));
    return ok(args, opts);
  };
  await assert.rejects(agent.start(request), /ENOENT|no such file/i);
  assert.ok(!docker.calls.some((c) => c[0] === 'start'), 'the revoked user gets no running container');
});
test('offboarding stops each running project under its project lock', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  const { stopped, failed } = await agent.stopAll();
  assert.deepEqual(stopped, [project]); assert.deepEqual(failed, []);
  assert.equal(docker.cs.get(name)!.State.Running, false);
});
test("root's admin commands reach a removed user's projects; the user's own requests do not", async (t) => {
  const { docker, cfg, agent } = fixture(t); await agent.start(request);
  const keysDir = mkdtempSync(join(tmpdir(), 'pctl-keys-'));
  t.after(() => rmSync(keysDir, { recursive: true, force: true }));
  // No alice.pub: admin remove-user took it away
  const user = new Agent({ ...cfg, keysDir }, { info() {}, warn() {} }, docker);
  await assert.rejects(user.list(), /ENOENT|no such file/i);
  await assert.rejects(user.stop(project), /ENOENT|no such file/i);
  const admin = new Agent({ ...cfg, keysDir }, { info() {}, warn() {} }, docker, { asAdmin: true });
  assert.equal((await admin.list())[0].project, project);
  assert.deepEqual(await admin.stop(project), { stopped: true });
});
test("a project's new volumes are created with its user and project as labels", async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  const created = docker.calls.filter((c) => c[0] === 'volume' && c[1] === 'create');
  assert.equal(created.length, 4, 'project, data, library and extensions');
  for (const c of created) {
    assert.ok(c.includes('fnkc.user=alice') && c.includes(`fnkc.project=${project}`) && c.includes('fnkc.managed=1'), c.join(' '));
    assert.match(c.at(-1)!, new RegExp(`^fnkc-(ext-)?alice-${project}`));
  }
  // Before docker create mounts them, and before the extensions are prepared in theirs
  const at = (f: (c: string[]) => boolean) => docker.calls.findIndex(f);
  assert.ok(at((c) => c[0] === 'volume' && c[1] === 'create') < at((c) => c[0] === 'create'));
});
test('the project list survives slow docker stats', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  const run = docker.run.bind(docker);
  docker.run = async (args, opts) => {
    if (args[0] === 'stats') throw new Error('docker: operation timed out');
    return run(args, opts);
  };
  const list = await agent.list();
  assert.equal(list.length, 1); assert.equal(list[0].memory, undefined);
});
test('project containers drop every capability they do not need and gain no privileges', async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  const create = docker.calls.find((c) => c[0] === 'create')!;
  assert.equal(create[create.indexOf('--cap-drop') + 1], 'ALL');
  const added = create.flatMap((a, i) => (a === '--cap-add' ? [create[i + 1]] : []));
  assert.ok(!added.includes('NET_RAW') && !added.includes('MKNOD') && added.includes('SYS_CHROOT'));
  assert.equal(create[create.indexOf('--security-opt') + 1], 'no-new-privileges');
});
test('maxProjectsPerUser 0 admits no starts and says why', async (t) => {
  const { agent, cfg } = fixture(t); cfg.maxProjectsPerUser = 0;
  await assert.rejects(agent.start(request), /admits no project starts/);
});
test("containers get the host's CRAN mirror for packages the image lacks", async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  const create = docker.calls.find((c) => c[0] === 'create')!;
  assert.ok(create.includes('FNKC_CRAN_MIRROR=https://mirror.truenetwork.ru/CRAN/'));
  assert.throws(() => agentConfig('alice', { cranMirror: 'http://insecure.example/CRAN/' }), /https URL/);
  assert.throws(() => agentConfig('alice', { cranMirror: 'https://x.example/CRAN"; rm' }), /https URL/);
  assert.equal(agentConfig('alice', { cranMirror: 'https://cloud.r-project.org/' }).cranMirror, 'https://cloud.r-project.org/');
});
test("a running container of another Positron build is not offered to this client", async (t) => {
  const { docker, agent } = fixture(t); await agent.start(request);
  docker.labels.set(image, { 'positron.version': '2026.07.1-5', 'positron.commit': 'f'.repeat(40) });
  docker.labels.set(image2, { 'positron.version': '2026.11.1-1', 'positron.commit': 'd'.repeat(40) });
  await assert.rejects(agent.start({ ...request, image: image2 }), /running with the server of Positron 2026\.07\.1-5/);
});
test('a qualified stop stops only the container of that repository, under the project lock; the gateway passes it on', async (t) => {
  const { handle } = await import('../src/serve.ts');
  const { docker, agent } = fixture(t); await agent.start(request);
  const name = projectNames('alice', project).container;
  const running = () => docker.cs.get(name)!.State.Running;
  // The same repository in another form (ssh://, port, no .git) is the same repository
  assert.deepEqual(await agent.stop(project, 'git@example.test:someone/study.git'), { stopped: false, otherRepository: repository });
  assert.ok(running(), 'another repository of the same name keeps running');
  docker.cs.get(name)!.Config.Labels![LABEL.repository] = undefined as unknown as string;
  assert.deepEqual(await agent.stop(project, repository), { stopped: false, otherRepository: '' });
  assert.ok(running(), 'a container that does not say its repository is not stopped by a qualified stop');
  docker.cs.get(name)!.Config.Labels![LABEL.repository] = repository;
  assert.deepEqual(await handle(agent, ['stop', project, 'ssh://git@example.test:2221/org/study'], async () => ''), { stopped: true });
  assert.ok(!running());
  await assert.rejects(handle(agent, ['stop', project, 'file:///etc'], async () => ''), /SSH or HTTPS URL/);
  await assert.rejects(handle(agent, ['stop', project, repository, 'x'], async () => ''), /too many arguments/);
  assert.deepEqual(await agent.stop('absent', repository), { stopped: false }, 'no container: nothing to compare');
});

/** The helper that read the checkout, and the name it ran under. */
function helperOf(calls: string[][]) {
  const read = calls.find((c) => c[0] === 'run' && c.some((a) => a.endsWith(':/work:ro')))!;
  return { read, name: read[read.indexOf('--name') + 1] };
}
test('the checkout helper cannot outlive its docker CLI: init, no logs, read-only root, a name of its own', async (t) => {
  const { docker, agent } = fixture(t);
  await agent.start(request); await agent.stop(project);
  docker.checkout = `${repository}\n${'c'.repeat(40)}\n${JSON.stringify({ image })}`;
  docker.calls = [];
  assert.equal((await agent.checkout(project)).checkout, 'present');
  const { read, name: helper } = helperOf(docker.calls);
  assert.ok(read.includes('--init'), 'docker-init is PID 1: the shell would ignore SIGTERM');
  assert.equal(read[read.indexOf('--log-driver') + 1], 'none', 'endless output never reaches the daemon\'s disk');
  assert.ok(read.includes('--read-only') && read.includes('--rm'));
  assert.match(helper, new RegExp(`^fnkc\\.read\\.alice\\.${project.replace(/[.]/g, '\\.')}\\.[0-9a-f]{12}$`));
  assert.match(helper, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, 'a valid Docker name');
  assert.ok(!docker.calls.some((c) => c[0] === 'rm'), 'a helper that exited was removed by --rm');

  // The CLI gave up (timeout or output limit): the helper is removed by its name, and the error reaches the caller
  docker.calls = [];
  docker.checkoutThrows = 'docker: operation timed out';
  const unknown = await agent.checkout(project);
  assert.equal(unknown.checkout, 'unknown'); assert.equal(unknown.reason, 'cannot read existing checkout: timed out after 20 s');
  const after = helperOf(docker.calls);
  const rm = docker.calls.findIndex((c) => c[0] === 'rm');
  assert.deepEqual(docker.calls[rm], ['rm', '-f', after.name]);
  assert.ok(rm > docker.calls.indexOf(after.read));
  assert.ok(docker.cs.has(name), 'the project container is never removed');

  // The same in a start, which holds the project lock while it reads
  docker.calls = [];
  await assert.rejects(agent.start(request), /cannot read existing checkout: timed out after 20 s$/);
  assert.deepEqual(docker.calls.find((c) => c[0] === 'rm'), ['rm', '-f', helperOf(docker.calls).name]);
  assert.ok(CHECKOUT_READ_MS <= 30_000, 'the project lock is held only briefly');
});
test('the checkout script reads only small regular files: no FIFO, no symlink to /dev/zero, no endless file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-checkout-script-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, 'work');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args], { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  mkdirSync(work);
  git('init', '-q'); git('remote', 'add', 'origin', repository); git('commit', '-q', '--allow-empty', '-m', 'x');
  const script = CHECKOUT_SCRIPT.replaceAll('/work', work);
  const read = () => spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const manifest = join(work, 'container.json');

  writeFileSync(manifest, JSON.stringify({ image }));
  let r = read();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').slice(0, 1), [repository]); assert.ok(r.stdout.endsWith(JSON.stringify({ image })));

  rmSync(manifest); symlinkSync('/dev/zero', manifest);
  r = read();
  assert.equal(r.error, undefined, 'it finishes'); assert.equal(r.status, 1); assert.match(r.stderr, /not a regular file/);

  rmSync(manifest); execFileSync('mkfifo', [manifest]);
  r = read();
  assert.equal(r.error, undefined, 'it finishes'); assert.equal(r.status, 1); assert.match(r.stderr, /not a regular file/);

  rmSync(manifest); writeFileSync(manifest, 'x'.repeat(65_537));
  r = read();
  assert.equal(r.status, 1, 'a file over 64 KiB is refused, not cut'); assert.match(r.stderr, /too large \(over 64 KiB\)/);
  assert.ok(r.stdout.length < 1000);
  writeFileSync(manifest, `${JSON.stringify({ image })}${' '.repeat(65_536 - JSON.stringify({ image }).length)}`);
  assert.equal(read().status, 0, 'exactly 64 KiB is read');

  // An initialization ready for promotion: its request and manifest, read the same way
  rmSync(manifest); mkdirSync(join(work, '.fnkc-init', 'repo'), { recursive: true });
  writeFileSync(join(work, '.fnkc-init', 'ready'), '');
  writeFileSync(join(work, '.fnkc-init', 'request'), `${repository}\n${'c'.repeat(40)}\nextra\n`);
  writeFileSync(join(work, '.fnkc-init', 'repo', 'container.json'), JSON.stringify({ image }));
  r = read();
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, `${repository}\n${'c'.repeat(40)}\n${JSON.stringify({ image })}`);
  symlinkSync('/dev/zero', manifest);
  r = read();
  assert.equal(r.status, 1, 'a symlinked manifest is refused, not replaced by the clone\'s'); assert.match(r.stderr, /not a regular file/);
  rmSync(manifest);
  const req = join(work, '.fnkc-init', 'request');
  rmSync(req); execFileSync('mkfifo', [req]);
  r = read();
  assert.equal(r.error, undefined, 'it finishes'); assert.equal(r.status, 1, 'a FIFO request fails the read');
  assert.match(r.stderr, /request is not a regular file/); assert.equal(r.stdout, '');
  rmSync(req); symlinkSync('/dev/zero', req);
  r = read();
  assert.equal(r.status, 1, 'a symlinked request fails the read'); assert.match(r.stderr, /request is not a regular file/); assert.equal(r.stdout, '');
  rmSync(join(work, '.fnkc-init', 'ready'));
  assert.equal(read().status, 44, 'an initialization that is not ready is no checkout yet');
});
