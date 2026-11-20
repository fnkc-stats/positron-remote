// Open's choice of the image to run (client/variant.ts): the pinned R environment with the server of this computer's
// Positron, against a registry on this computer that serves images with labels and tags, as ghcr.io does.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { forgetChoice, imageToRun, NoPositronImage, positronTag } from '../src/client/variant.ts';

const digest = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const blobs = new Map<string, Buffer>();
const tags = new Map<string, Buffer>();
const requests: string[] = [];
const MINE = { version: '2026.07.1-5', commit: 'd'.repeat(40) };
let repo = '';
let server: ReturnType<typeof createServer>;
const log = { info() {}, warn() {} };
const cache = () => mkdtempSync(join(tmpdir(), 'fnkc-variant-'));

/** A multi-architecture image with these labels, optionally under a tag; returns it pinned by digest. */
function publish(labels: Record<string, string>, tag?: string): string {
  const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: { Labels: labels } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest(config), size: config.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: digest(Buffer.from('layer')), size: 5 }] }));
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: digest(manifest), size: manifest.length, platform: { os: 'linux', architecture: 'amd64' } },
  ] }));
  for (const b of [config, manifest, index]) blobs.set(digest(b), b);
  if (tag) tags.set(tag, index);
  return `${repo}@${digest(index)}`;
}
const environment = (series = '4.6', extra: Record<string, string> = {}) => publish({ 'r-env.r-series': series, 'r-env.lock-sha256': 'f'.repeat(64), ...extra });
const server_ = (base: string, positron = MINE) =>
  publish({ 'r-env.r-series': '4.6', 'positron.version': positron.version, 'positron.commit': positron.commit, 'r-env.base': base }, positronTag(base, positron.version));

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    const m = /^\/v2\/fnkc-stats\/r-env\/(manifests|blobs)\/(.+)$/.exec(url);
    const body = m && (blobs.get(m[2]) ?? tags.get(m[2]));
    if (!body) { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', m[1] === 'manifests' ? JSON.parse(body.toString()).mediaType : 'application/octet-stream');
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, r));
  repo = `localhost:${(server.address() as AddressInfo).port}/fnkc-stats/r-env`;
});
after(() => server.close());

test('the pinned environment runs with the server of this Positron, found by its tag', async () => {
  const pin = environment();
  const run = server_(pin);
  const dir = cache();
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: run });
  // The choice is kept: the next Open needs no registry, also when it is not reachable
  requests.length = 0;
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: run });
  assert.deepEqual(requests, []);
});

test('an image published under the tag but built on another environment, or for another commit, is refused', async () => {
  const pin = environment('4.6', { note: 'a' });
  const other = environment('4.6', { note: 'b' });
  publish({ 'positron.version': MINE.version, 'positron.commit': MINE.commit, 'r-env.base': other }, positronTag(pin, MINE.version));
  await assert.rejects(imageToRun(cache(), pin, MINE, log), /is not the project's environment for this Positron/);
  const pin2 = environment('4.6', { note: 'c' });
  server_(pin2, { version: MINE.version, commit: 'e'.repeat(40) });
  await assert.rejects(imageToRun(cache(), pin2, MINE, log), /for commit e{40}/);
});

test('without the server for this Positron, Open says how to add it', async () => {
  const pin = environment('4.2', { note: 'none yet' });
  await assert.rejects(imageToRun(cache(), pin, MINE, log), (e: unknown) => {
    assert.ok(e instanceof NoPositronImage);
    assert.equal(e.environment, pin);
    assert.equal(e.positron, MINE.version);
    assert.match(e.message, /R 4\.2.*fnkc-ctl build .* --positron 2026\.07\.1-5/);
    return true;
  });
});

test('a pin with the server built in (from before environments) runs as it is; the host checks it', async () => {
  const old = publish({ 'positron.version': '2026.11.1-4', 'positron.commit': 'e'.repeat(40), 'r-env.r-series': '4.6' });
  assert.equal(await imageToRun(cache(), old, MINE, log), undefined);
});

test('an unreachable registry leaves the decision to the host, with the reason', async () => {
  const warned: string[] = [];
  const v = await imageToRun(cache(), `localhost:1/fnkc-stats/r-env@sha256:${'0'.repeat(64)}`, MINE, { info() {}, warn: (m: string) => warned.push(m) });
  assert.equal(v, undefined);
  assert.match(warned[0] ?? '', /\(fetch failed: [^)]+\)/, 'the reason, not only "fetch failed"');
});

test('a forgotten choice is looked up again: a server image rebuilt under the same tag is found', async () => {
  const pin = environment('4.6', { note: 'rebuilt' });
  const first = server_(pin);
  const dir = cache();
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: first });
  // The tag moves to a new image (the old one was deleted from the registry); the remembered choice is stale
  const second = publish({ 'r-env.r-series': '4.6', 'positron.version': MINE.version, 'positron.commit': MINE.commit, 'r-env.base': pin, note: 'second' }, positronTag(pin, MINE.version));
  assert.notEqual(second, first);
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: first }, 'remembered');
  forgetChoice(dir, pin, MINE.commit);
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: second });
});
