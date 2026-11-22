// The image the backup helper may run: resolved to the immutable ID the host verified, never to whatever a tag names.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentConfig } from '../src/agent-config.ts';
import type { ImageJson } from '../src/docker.ts';
import { resolveHostImage } from '../src/host-image.ts';
import { provenancePolicy } from '../src/provenance.ts';

const REPO = 'ghcr.io/fnkc-stats/r-env';
const hex = (c: string) => c.repeat(64);
const id = (c: string) => `sha256:${hex(c)}`;
const pinned = `${REPO}@sha256:${hex('a')}`;
const tag = `${REPO}:sha256-${hex('a')}`;

function fixture(t: { after(fn: () => void): void }, file: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-host-image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = agentConfig('check', { imageStagingDir: join(dir, 'staging'), verifiedDir: join(dir, 'verified'), ...file });
  const images = new Map<string, ImageJson>();
  const docker = { image: async (ref: string) => images.get(ref) ?? null };
  const record = (digestHex: string, imageId: string) => {
    mkdirSync(join(dir, 'staging', 'loaded'), { recursive: true });
    writeFileSync(join(dir, 'staging', 'loaded', digestHex), `${imageId}\n`);
  };
  return { cfg, images, docker, record, dir };
}

test('a pulled image resolves to its ID only when Docker carries the pinned digest', async (t) => {
  const { cfg, images, docker } = fixture(t);
  images.set(pinned, { Id: id('1'), Architecture: 'amd64', RepoDigests: [pinned] });
  assert.equal(await resolveHostImage(cfg, docker, pinned), id('1'));
  // A tag next to the digest is ignored, as for the agent
  assert.equal(await resolveHostImage(cfg, docker, `${REPO}:4.6@sha256:${hex('a')}`), id('1'));
  images.set(pinned, { Id: id('1'), Architecture: 'amd64', RepoDigests: [] });
  await assert.rejects(resolveHostImage(cfg, docker, pinned), /does not carry that digest/);
});

test('an uploaded image resolves only while its tag still names the recorded image ID', async (t) => {
  const { cfg, images, docker, record } = fixture(t);
  images.set(tag, { Id: id('2'), Architecture: 'amd64', RepoTags: [tag] });
  await assert.rejects(resolveHostImage(cfg, docker, pinned), /no record of the upload/);
  record(hex('a'), id('2'));
  assert.equal(await resolveHostImage(cfg, docker, pinned), id('2'));
  // The tag moved to another image during maintenance: refused, although the reference is the approved one
  images.set(tag, { Id: id('3'), Architecture: 'amd64', RepoTags: [tag] });
  await assert.rejects(resolveHostImage(cfg, docker, pinned), new RegExp(`now names ${id('3')}, not the image ${id('2')}`));
  // A damaged record is no record
  record(hex('a'), 'whatever');
  await assert.rejects(resolveHostImage(cfg, docker, pinned), /no record of the upload/);
});

test('ambiguous, missing and disallowed images are refused', async (t) => {
  const { cfg, images, docker, record } = fixture(t);
  await assert.rejects(resolveHostImage(cfg, docker, pinned), /not on this host/);
  await assert.rejects(resolveHostImage(cfg, docker, `ghcr.io/evil/r-env@sha256:${hex('a')}`), /not allowed/);
  await assert.rejects(resolveHostImage(cfg, docker, 'ghcr.io/fnkc-stats/r-env:latest'), /pinned/);
  images.set(pinned, { Id: id('1'), Architecture: 'amd64', RepoDigests: [pinned] });
  images.set(tag, { Id: id('2'), Architecture: 'amd64', RepoTags: [tag] });
  record(hex('a'), id('2'));
  await assert.rejects(resolveHostImage(cfg, docker, pinned), /names another image than/);
  images.set(tag, { Id: id('1'), Architecture: 'amd64', RepoTags: [tag] });
  assert.equal(await resolveHostImage(cfg, docker, pinned), id('1'));
});

test('with requireProvenance, only digests verified on this host under the current policy', async (t) => {
  const { cfg, images, docker, dir } = fixture(t, { requireProvenance: true });
  images.set(pinned, { Id: id('1'), Architecture: 'amd64', RepoDigests: [pinned] });
  await assert.rejects(resolveHostImage(cfg, docker, pinned), /has not passed provenance verification/);
  mkdirSync(join(dir, 'verified'));
  writeFileSync(join(dir, 'verified', hex('a')), 'other/repo|.github/workflows/positron.yml|refs/heads/main');
  await assert.rejects(resolveHostImage(cfg, docker, pinned), /has not passed provenance verification/);
  writeFileSync(join(dir, 'verified', hex('a')), provenancePolicy(cfg));
  assert.equal(await resolveHostImage(cfg, docker, pinned), id('1'));
});
