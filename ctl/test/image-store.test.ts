// What the host records after loading a checked upload: only the image ID of that upload, on either image store.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { Docker, ImageJson } from '../src/docker.ts';
import type { RunOptions, RunResult } from '../src/exec.ts';
import { loadedImageId, loadedRecord, receiveImage } from '../src/image-store.ts';
import { uploadedTag } from '../src/oci.ts';

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const layer = Buffer.from('uncompressed layer bytes (docker load is faked)');
const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [sha(layer)] } }));
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
        tagged = { Id: sha(config), Architecture: 'amd64', RepoTags: [tag], RootFS: { Layers: [sha(layer)] }, ...loadedAs };
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
