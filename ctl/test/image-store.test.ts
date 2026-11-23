// What the host records after loading a checked upload: only the image ID of that upload, on either image store.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { ContainerJson, Docker, ImageJson } from '../src/docker.ts';
import type { RunOptions, RunResult } from '../src/exec.ts';
import { imageOnHost, loadedImageId, loadedRecord, receiveImage, recordExistingImage } from '../src/image-store.ts';
import { uploadedTag } from '../src/oci.ts';

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const layer = Buffer.from('uncompressed layer bytes (docker load is faked)');
// The run settings as an image builder writes them, and as `docker image inspect` shows them after the load: other
// key order, empty fields as null or "" (both mean unset)
const runConfig = {
  User: 'analyst', Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=en_US.UTF-8'], Cmd: ['R'], WorkingDir: '/work',
  Labels: { 'org.opencontainers.image.source': 'https://github.com/fnkc-stats/r-env', 'fnkc.positron': '1' },
  ExposedPorts: { '8787/tcp': {} },
};
const shownConfig = {
  Cmd: ['R'], Entrypoint: null, Env: runConfig.Env, ExposedPorts: { '8787/tcp': {} }, OnBuild: null, StopSignal: '',
  Labels: { 'fnkc.positron': '1', 'org.opencontainers.image.source': 'https://github.com/fnkc-stats/r-env' },
  User: 'analyst', Volumes: null, WorkingDir: '/work',
};
const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: runConfig, rootfs: { type: 'layers', diff_ids: [sha(layer)] } }));
const manifest = Buffer.from(JSON.stringify({
  schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha(config), size: config.length },
  layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: sha(layer), size: layer.length }],
}));
const image = `ghcr.io/fnkc-stats/r-env@${sha(manifest)}`;
const tag = uploadedTag(image);
const upload = () => Readable.from([manifest, config, layer].flatMap((b) => [Buffer.from(`${b.length}\n`), b]));
const quiet = { info() {}, warn() {} };
const locked = (work: () => Promise<void>) => work();
const policy = { reserveBytes: 0, maxUnpackedBytes: 1024 ** 3, maxStoredBytes: 1024 ** 3 };

/** Docker after a load: `loadedAs` is what the tag then names. */
function docker(store: 'classic' | 'containerd', loadedAs: Partial<ImageJson>) {
  let tagged: ImageJson | null = null;
  const calls: string[][] = [];
  const fake = {
    calls,
    async image(ref: string) { return ref === tag ? tagged : null; },
    async images() { return []; },
    async run(args: string[], _opts?: RunOptions): Promise<RunResult> {
      calls.push(args);
      if (args[0] === 'info') {
        return { code: 0, stdout: store === 'containerd' ? '[["driver-type","io.containerd.snapshotter.v1"]]\n' : '[["Backing Filesystem","extfs"]]\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async ok(args: string[], opts?: RunOptions) {
      calls.push(args);
      if (args[0] === 'load') {
        for await (const _ of opts!.input as AsyncIterable<Buffer>) { /* consumed, as Docker does */ }
        tagged = { Id: sha(config), Architecture: 'amd64', RepoTags: [tag], RootFS: { Layers: [sha(layer)] }, Config: shownConfig, ...loadedAs };
      }
      return '';
    },
  };
  return fake as typeof fake & Docker;
}

function staging(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'pctl-image-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('classic store: the loaded image is recorded only when its ID is the checked config digest', async (t) => {
  const dir = staging(t);
  await receiveImage(docker('classic', {}), image, 'x64', upload(), dir, quiet, locked, policy);
  assert.equal(loadedImageId(dir, image), sha(config));

  // The tag names another image right after the load (moved meanwhile): rejected, nothing recorded
  const other = staging(t);
  const moved = docker('classic', { Id: `sha256:${'9'.repeat(64)}` });
  await assert.rejects(receiveImage(moved, image, 'x64', upload(), other, quiet, locked, policy), /names sha256:9{64} after the load, not the checked upload/);
  assert.ok(!existsSync(loadedRecord(other, image)), 'no loaded/<digest>');
  // On the classic store the same layers under another ID are not enough: the config may differ
  const sameLayers = staging(t);
  await assert.rejects(receiveImage(docker('classic', { Id: `sha256:${'8'.repeat(64)}` }), image, 'x64', upload(), sameLayers, quiet, locked, policy),
    /not the checked upload/);
  assert.ok(!existsSync(loadedRecord(sameLayers, image)));
});

test("containerd store: Docker's own manifest ID is recorded when its layers are the checked config's diff IDs", async (t) => {
  // On containerd the image ID is the digest of a manifest Docker writes during the load, never the config digest
  const id = `sha256:${'7'.repeat(64)}`;
  const dir = staging(t);
  await receiveImage(docker('containerd', { Id: id }), image, 'x64', upload(), dir, quiet, locked, policy);
  assert.equal(loadedImageId(dir, image), id);

  for (const layers of [[`sha256:${'6'.repeat(64)}`], [], [sha(layer), sha(layer)]]) {
    const other = staging(t);
    await assert.rejects(receiveImage(docker('containerd', { Id: id, RootFS: { Layers: layers } }), image, 'x64', upload(), other, quiet, locked, policy),
      /not the checked upload/, `layers ${JSON.stringify(layers)}`);
    assert.ok(!existsSync(loadedRecord(other, image)));
  }
});

test('containerd store: the same layers under another config (user, command, environment, ...) are not the checked upload', async (t) => {
  const id = `sha256:${'7'.repeat(64)}`;
  const changes: Record<string, unknown>[] = [
    { User: 'root' }, { User: null }, { Entrypoint: ['/bin/sh', '-c'] }, { Cmd: ['bash'] }, { WorkingDir: '/' },
    { Env: [...runConfig.Env, 'LD_PRELOAD=/tmp/x.so'] }, { Env: [...runConfig.Env].reverse() },
    { Labels: { ...shownConfig.Labels, 'fnkc.positron': '2' } }, { ExposedPorts: { '22/tcp': {} } },
    { Volumes: { '/work': {} } }, { Healthcheck: { Test: ['CMD', 'true'] } },
  ];
  for (const change of changes) {
    const other = staging(t);
    const moved = docker('containerd', { Id: id, Config: { ...shownConfig, ...change } as ImageJson['Config'] });
    await assert.rejects(receiveImage(moved, image, 'x64', upload(), other, quiet, locked, policy), /not the checked upload/, JSON.stringify(change));
    assert.ok(!existsSync(loadedRecord(other, image)), `no loaded/<digest> for ${JSON.stringify(change)}`);
  }
  // Docker shows no config at all: the checked one sets a user, so it is not that image either
  const none = staging(t);
  await assert.rejects(receiveImage(docker('containerd', { Id: id, Config: undefined }), image, 'x64', upload(), none, quiet, locked, policy),
    /not the checked upload/);
  assert.ok(!existsSync(loadedRecord(none, image)));
});

// fnkc-ctl admin record-image: an image uploaded before the host recorded uploads gets its record only when a project
// container fnkc-ctl created with that pin runs exactly the image the tag names now.
const loadedId = `sha256:${'5'.repeat(64)}`;
function project(over: { name?: string; pin?: string | null; id?: string; from?: string; labels?: Record<string, string>; running?: boolean } = {}): ContainerJson {
  return {
    Name: `/${over.name ?? 'fnkc-alice-thesis'}`,
    Image: over.id ?? loadedId,
    Config: {
      Image: over.from ?? tag,
      Env: over.pin === null ? ['FNKC_PROJECT=thesis'] : ['FNKC_PROJECT=thesis', `FNKC_IMAGE_DIGEST=${over.pin ?? image}`],
      Labels: over.labels ?? { 'fnkc.managed': '1', 'fnkc.user': 'alice', 'fnkc.project': 'thesis' },
    },
    State: { Running: over.running ?? true, Status: over.running === false ? 'exited' : 'running' },
    NetworkSettings: { Ports: null },
  };
}
function host(tagged: string | null, containers: ContainerJson[]) {
  const filters: string[][] = [];
  const fake = {
    filters,
    async image(ref: string): Promise<ImageJson | null> { return ref === tag && tagged ? { Id: tagged, Architecture: 'amd64', RepoTags: [tag] } : null; },
    async containers(labels: string[]) { filters.push(labels); return containers; },
  };
  return fake as typeof fake & Docker;
}

test('record-image records a pre-record upload that a project container with that pin runs', async (t) => {
  for (const c of [project(), project({ running: false }), project({ from: loadedId })]) {
    const dir = staging(t);
    const d = host(loadedId, [project({ name: 'fnkc-bob-other', pin: `ghcr.io/fnkc-stats/r-env@sha256:${'1'.repeat(64)}`, id: `sha256:${'2'.repeat(64)}`, labels: { 'fnkc.managed': '1', 'fnkc.user': 'bob', 'fnkc.project': 'other' } }), c]);
    assert.equal((await imageOnHost(d, dir, image)).state, 'unrecorded');
    const r = await recordExistingImage(d, dir, image);
    assert.deepEqual(r, { state: 'recorded', id: loadedId, containers: ['fnkc-alice-thesis'] });
    assert.equal(loadedImageId(dir, image), loadedId);
    assert.deepEqual(await imageOnHost(d, dir, image), { state: 'ready', id: loadedId });
    assert.deepEqual(d.filters, [['fnkc.managed=1']]);
    // Run again: nothing to do
    assert.deepEqual(await recordExistingImage(d, dir, image), { state: 'ready', id: loadedId, containers: [] });
  }
});

test('record-image refuses without a project container that proves the tag', async (t) => {
  const cases: [string, ContainerJson[], RegExp][] = [
    ['no container', [], /no project container on this host pins/],
    ['another digest', [project({ pin: `ghcr.io/fnkc-stats/r-env@sha256:${'1'.repeat(64)}` })], /no project container on this host pins/],
    ['another repository', [project({ pin: `ghcr.io/fnkc-stats/other@${sha(manifest)}` })], /no project container on this host pins/],
    ['no pin', [project({ pin: null })], /no project container on this host pins/],
    ['not a project container (helper)', [project({ name: 'fnkc.read.alice.thesis.0123456789ab' })], /no project container on this host pins/],
    ['not managed by fnkc-ctl', [project({ labels: { 'fnkc.user': 'alice', 'fnkc.project': 'thesis' } })], /no project container on this host pins/],
    ['another image ID', [project({ id: `sha256:${'4'.repeat(64)}` })], /fnkc-alice-thesis runs sha256:4{64}, not sha256:5{64}/],
    ['conflicting containers', [project(), project({ name: 'fnkc-bob-thesis', id: `sha256:${'4'.repeat(64)}`, labels: { 'fnkc.managed': '1', 'fnkc.user': 'bob', 'fnkc.project': 'thesis' } })],
      /fnkc-bob-thesis runs sha256:4{64}/],
    ['created from another name', [project({ from: `ghcr.io/fnkc-stats/r-env:latest` })], /was not created from/],
  ];
  for (const [what, containers, error] of cases) {
    const dir = staging(t);
    await assert.rejects(recordExistingImage(host(loadedId, containers), dir, image), error, what);
    assert.ok(!existsSync(loadedRecord(dir, image)), `${what}: no record`);
  }
});

test('record-image never overwrites a record and needs the uploaded tag', async (t) => {
  // Damaged record: refused, left as it is (untag and upload again)
  const dir = staging(t);
  mkdirSync(join(dir, 'loaded'));
  writeFileSync(loadedRecord(dir, image), 'garbage\n');
  await assert.rejects(recordExistingImage(host(loadedId, [project()]), dir, image), /names no image ID/);
  assert.equal(readFileSync(loadedRecord(dir, image), 'utf8'), 'garbage\n');
  // A tag moved away from the recorded image: refused, record unchanged
  const moved = staging(t);
  mkdirSync(join(moved, 'loaded'));
  writeFileSync(loadedRecord(moved, image), `sha256:${'3'.repeat(64)}\n`);
  await assert.rejects(recordExistingImage(host(loadedId, [project()]), moved, image), /now names sha256:5{64}, not the image sha256:3{64}/);
  assert.equal(loadedImageId(moved, image), `sha256:${'3'.repeat(64)}`);
  // Not on the host at all
  await assert.rejects(recordExistingImage(host(null, [project()]), staging(t), image), /not on this host/);
});
