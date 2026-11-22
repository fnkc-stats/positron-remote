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
import { forgetChoice, imageToRun, NoPositronImage, positronTag, teamPositron, teamPositronNote } from '../src/client/variant.ts';

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
  // The next Open asks only where the tag points: the labels of both images are kept
  requests.length = 0;
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: run });
  assert.deepEqual(requests, [`/v2/fnkc-stats/r-env/manifests/${positronTag(pin, MINE.version)}`]);
});

test('when the registry does not answer, the image chosen before runs, with the reason', async () => {
  const pin = environment('4.6', { note: 'offline' });
  const run = server_(pin);
  const dir = cache();
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: run });
  const tag = tags.get(positronTag(pin, MINE.version))!;
  tags.delete(positronTag(pin, MINE.version));
  const warned: string[] = [];
  try {
    assert.deepEqual(await imageToRun(dir, pin, MINE, { info() {}, warn: (m: string) => warned.push(m) }), { image: run });
  } finally {
    tags.set(positronTag(pin, MINE.version), tag);
  }
  assert.match(warned[0] ?? '', /using the one chosen before/);
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

test('a server image that replaced the tag runs at the next Open, and so does the one a rollback restores', async () => {
  const pin = environment('4.6', { note: 'rebuilt' });
  const first = server_(pin);
  const dir = cache();
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: first });
  // A corrected recipe: the tag moves to a new image while the old one stays in the registry
  const firstTag = tags.get(positronTag(pin, MINE.version))!;
  const second = publish({ 'r-env.r-series': '4.6', 'positron.version': MINE.version, 'positron.commit': MINE.commit, 'r-env.base': pin, note: 'second' }, positronTag(pin, MINE.version));
  assert.notEqual(second, first);
  const info: string[] = [];
  assert.deepEqual(await imageToRun(dir, pin, MINE, { info: (m: string) => info.push(m), warn() {} }), { image: second });
  assert.match(info[0] ?? '', /was replaced: .* \(was .*\)/);
  // positron-promote.yml moves it back
  tags.set(positronTag(pin, MINE.version), firstTag);
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: first });
  // A forgotten choice is looked up as before
  forgetChoice(dir, pin, MINE.commit);
  assert.deepEqual(await imageToRun(dir, pin, MINE, log), { image: first });
});

test('a tag moved to an image of another environment is refused, even with a choice made before', async () => {
  const pin = environment('4.6', { note: 'hijack' });
  server_(pin);
  const dir = cache();
  await imageToRun(dir, pin, MINE, log);
  const other = environment('4.6', { note: 'elsewhere' });
  publish({ 'positron.version': MINE.version, 'positron.commit': MINE.commit, 'r-env.base': other }, positronTag(pin, MINE.version));
  await assert.rejects(imageToRun(dir, pin, MINE, log), /is not the project's environment for this Positron/);
});

test("the team's Positron comes from env/positron.args on main, and the version read last time when GitHub does not answer", async (t) => {
  const cache = mkdtempSync(join(tmpdir(), 'fnkc-team-'));
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const asked: string[] = [];
  let answer: Response | Error = new Response('POSITRON_VERSION=2026.11.1-4\nPOSITRON_COMMIT=e915\n');
  globalThis.fetch = (async (url: string | URL) => {
    asked.push(String(url));
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  assert.equal(await teamPositron(cache, 'fnkc-stats/positron-remote', false), undefined, 'never read: unknown');
  assert.deepEqual(asked, [], 'offline asks nothing');
  assert.equal(await teamPositron(cache, 'fnkc-stats/positron-remote'), '2026.11.1-4');
  assert.deepEqual(asked, ['https://raw.githubusercontent.com/fnkc-stats/positron-remote/main/env/positron.args']);
  answer = new Error('fetch failed');
  assert.equal(await teamPositron(cache, 'fnkc-stats/positron-remote'), '2026.11.1-4', 'offline: the version read last time');
  answer = new Response('POSITRON_VERSION=$(evil)\n');
  assert.equal(await teamPositron(cache, 'fnkc-stats/positron-remote'), '2026.11.1-4', 'not a version: ignored');
  assert.equal(await teamPositron(cache, '../../x'), '2026.11.1-4', 'a malformed repository is not fetched');
  assert.equal(asked.length, 3);
});

test("another Positron than the team's is not an error: both ways out are named", () => {
  assert.equal(teamPositronNote('2026.11.1-4', '2026.11.1-4'), undefined);
  assert.equal(teamPositronNote('2026.07.1-5', undefined), undefined, 'team version unknown: nothing to say');
  const note = teamPositronNote('2026.07.1-5', '2026.11.1-4')!;
  assert.match(note, /The team uses Positron 2026\.11\.1-4/);
  assert.match(note, /once an administrator builds the environment for it/);
  assert.match(note, /or after you update Positron to 2026\.11\.1-4/);
});
