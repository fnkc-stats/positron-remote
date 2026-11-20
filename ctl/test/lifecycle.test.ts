import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent.ts';
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
  checkout?: string;
  positronCommit = 'd'.repeat(40);
  /** Labels of particular images; all others serve the Positron build positronCommit. */
  labels = new Map<string, Record<string, string>>();
  override async image(value: string): Promise<ImageJson | null> {
    const labels = this.labels.get(value) ?? { 'positron.version': '2026.11.1-1', 'positron.commit': this.positronCommit };
    return { Id: value, Architecture: 'amd64', Config: { Labels: labels } };
  }
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
  const { stopped, failed } = await agent.stopAllForRevocation();
  assert.deepEqual(stopped, [project]); assert.deepEqual(failed, []);
  assert.equal(docker.cs.get(name)!.State.Running, false);
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
