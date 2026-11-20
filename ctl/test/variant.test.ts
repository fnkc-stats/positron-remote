// Open's choice of the project's environment for this computer's Positron (client/variant.ts), against a registry
// on this computer that serves images with labels, as ghcr.io does.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PositronMismatch, positronVariant, variantTags } from '../src/client/variant.ts';

const digest = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const blobs = new Map<string, Buffer>();
const tags = new Map<string, Buffer>();
const requests: string[] = [];
const LOCK = 'f'.repeat(64);
const TEAM = { version: '2026.11.1-4', commit: 'e'.repeat(40) };
const MINE = { version: '2026.07.1-5', commit: 'd'.repeat(40) };
let base = '';
let server: ReturnType<typeof createServer>;

/** A multi-architecture image with these labels; returns the index digest. */
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
  return digest(index);
}
const env = (positron: { version: string; commit: string }, lock = LOCK, series = '4.6') =>
  ({ 'positron.version': positron.version, 'positron.commit': positron.commit, 'r-env.lock-sha256': lock, 'r-env.r-series': series });
const sha = 'a'.repeat(40);
const log = { info() {}, warn() {} };

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    const m = /^\/v2\/fnkc-stats\/r-env\/(manifests|blobs)\/(.+)$/.exec(url);
    if (url.startsWith('/v2/fnkc-stats/r-env/tags/list')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ name: 'fnkc-stats/r-env', tags: [...tags.keys()] }));
    }
    const body = m && (blobs.get(m[2]) ?? tags.get(m[2]));
    if (!body) { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', m[1] === 'manifests' ? JSON.parse(body.toString()).mediaType : 'application/octet-stream');
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `localhost:${(server.address() as AddressInfo).port}/fnkc-stats/r-env`;
});
after(() => server.close());

test('the newest image for this Positron with the same R packages is chosen', async () => {
  const pinned = publish(env(TEAM));
  publish(env(MINE), `4.6-positron-2026.07.1-5-${sha}-100-1`); // older run
  const newest = publish(env(MINE), `4.6-positron-2026.07.1-5-${sha}-200-1`);
  publish(env(MINE, 'b'.repeat(64)), `4.6-positron-2026.07.1-5-${sha}-300-1`); // newer, but other R packages
  publish(env(MINE), `4.5-positron-2026.07.1-5-${sha}-400-1`); // another series
  publish(env(MINE), `4.6-positron-2026.07.1-5-${sha}-400-1-arm64`); // one architecture only
  const cache = mkdtempSync(join(tmpdir(), 'fnkc-variant-'));
  const v = await positronVariant(cache, `${base}@${pinned}`, MINE, log);
  assert.deepEqual(v, { image: `${base}@${newest}`, lockSha256: LOCK });
  // The labels of an image are read once
  requests.length = 0;
  await positronVariant(cache, `${base}@${pinned}`, MINE, log);
  assert.ok(!requests.some((r) => r.endsWith(pinned)), `pinned image read again: ${requests.join(', ')}`);
});

test('a pinned image that serves this Positron, or one from before the label, is used as it is', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'fnkc-variant-'));
  assert.equal(await positronVariant(cache, `${base}@${publish(env(MINE))}`, MINE, log), undefined);
  const old = publish({ 'positron.version': TEAM.version, 'positron.commit': TEAM.commit });
  assert.equal(await positronVariant(cache, `${base}@${old}`, MINE, log), undefined, 'the host refuses it with its usual message');
});

test('without an image for this Positron, Open says which build to start', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'fnkc-variant-'));
  const pinned = publish(env(TEAM, 'c'.repeat(64), '4.2'));
  await assert.rejects(positronVariant(cache, `${base}@${pinned}`, MINE, log), (e: unknown) => {
    assert.ok(e instanceof PositronMismatch);
    assert.equal(e.series, '4.2');
    assert.equal(e.positron, MINE.version);
    assert.match(e.message, /fnkc-ctl build 4\.2 --positron 2026\.07\.1-5/);
    return true;
  });
});

test('an unreachable registry leaves the decision to the host', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'fnkc-variant-'));
  const warned: string[] = [];
  const v = await positronVariant(cache, `localhost:1/fnkc-stats/r-env@sha256:${'0'.repeat(64)}`, MINE, { info() {}, warn: (m) => warned.push(m) });
  assert.equal(v, undefined);
  assert.equal(warned.length, 1);
});

test('variant tags: this series and Positron version, whole images, newest run first', () => {
  assert.deepEqual(variantTags([
    `4.6-positron-2026.07.1-5-${sha}-9-1`, `4.6-positron-2026.07.1-5-${sha}-10-1`, `4.6-positron-2026.07.1-5-${sha}-10-2`,
    `4.6-positron-2026.07.1-5-${sha}-10-2-amd64`, `4.6-${sha}-11-1`, `4.6-positron-2026.07.1-50-${sha}-12-1`, `4.60-positron-2026.07.1-5-${sha}-13-1`,
  ], '4.6', '2026.07.1-5'), [`4.6-positron-2026.07.1-5-${sha}-10-2`, `4.6-positron-2026.07.1-5-${sha}-10-1`, `4.6-positron-2026.07.1-5-${sha}-9-1`]);
});
