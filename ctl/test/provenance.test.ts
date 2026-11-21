import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentConfig } from '../src/agent-config.ts';
import { provenanceVerified, verifyImageProvenance } from '../src/provenance.ts';
import { provenanceBundle } from '../src/client/provenance.ts';
import { snappyDecode } from '../src/client/snappy.ts';

const manifest = Buffer.from('{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}');
const image = `ghcr.io/fnkc-stats/r-env@sha256:${createHash('sha256').update(manifest).digest('hex')}`;
const subject = manifest.toString('base64');

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-provenance-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trustedRootFile = join(dir, 'trusted-root.jsonl');
  writeFileSync(trustedRootFile, '{"trustedRoot":true}\n');
  return agentConfig('alice', { keysDir: join(dir, 'keys'), trustedRootFile, verifiedDir: join(dir, 'verified') });
}

test('the host verifies the bundle against the manifest file offline and pins the signer policy', async (t) => {
  const cfg = setup(t);
  const never = async () => { throw new Error('must not run'); };
  await assert.rejects(verifyImageProvenance(cfg, image, {}, never), /missing or oversized image provenance bundle/);
  await assert.rejects(verifyImageProvenance(cfg, image, { bundle: '{}\n' }, never), /missing or oversized image manifest/);
  await assert.rejects(verifyImageProvenance(cfg, image, { bundle: '{}\n', subject: Buffer.from('other').toString('base64') }, never), /does not match its digest/);
  let checked = false;
  await verifyImageProvenance(cfg, image, { bundle: '{"verificationMaterial":{}}\n', subject }, async (cmd, args) => {
    assert.equal(cmd, 'gh');
    assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
    assert.ok(!args[2].startsWith('oci://'), 'a local file: no registry lookup');
    assert.deepEqual(readFileSync(args[2]), manifest);
    assert.ok(args.includes('--custom-trusted-root') && args.includes(cfg.trustedRootFile));
    assert.ok(args.includes('fnkc-stats/positron-remote/.github/workflows/positron.yml'));
    assert.ok(args.includes('--source-ref') && args.includes('refs/heads/main'));
    assert.equal(readFileSync(args[args.indexOf('--bundle') + 1], 'utf8'), '{"verificationMaterial":{}}\n');
    checked = true;
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.ok(checked);
  // Remembered: the next start needs no proof and no gh
  assert.ok(provenanceVerified(cfg, image));
  await verifyImageProvenance(cfg, image, {}, never);
  // ... but not under another policy
  assert.ok(!provenanceVerified({ ...cfg, provenanceWorkflow: '.github/workflows/other.yml' }, image));
});

test('a failed verification is not remembered', async (t) => {
  const cfg = setup(t);
  await assert.rejects(verifyImageProvenance(cfg, image, { bundle: 'bad proof', subject }, async () => ({ code: 1, stdout: '', stderr: 'verification failed\n' })),
    /verification failed \(the server's trust root was last refreshed \d{4}-\d\d-\d\d; .*refresh-trust-root\.sh\)/);
  assert.ok(!provenanceVerified(cfg, image));
});

test('local-only agents may opt out; enrolled server agents require provenance by default', () => {
  assert.equal(agentConfig('alice').requireProvenance, false);
  assert.equal(agentConfig('alice', { keysDir: '/etc/fnkc-ctl/keys' }).requireProvenance, true);
  assert.equal(agentConfig('alice', { keysDir: '/etc/fnkc-ctl/keys', requireProvenance: false }).requireProvenance, false);
});

test('snappy blocks decode literals and overlapping copies, and malformed ones are refused', () => {
  // 12 bytes: literal "abc", then a 1-byte-offset copy of 9 bytes from 3 back (overlapping)
  assert.equal(snappyDecode(Buffer.from([0x0c, 0x08, 0x61, 0x62, 0x63, 0x15, 0x03]), 100).toString(), 'abcabcabcabc');
  // 2-byte-offset copy: literal "xy", copy length 4 from offset 2
  assert.equal(snappyDecode(Buffer.from([0x06, 0x04, 0x78, 0x79, 0x0e, 0x02, 0x00]), 100).toString(), 'xyxyxy');
  // literal of 70 bytes (length in one extra byte)
  const long = Buffer.alloc(70, 0x41);
  assert.deepEqual(snappyDecode(Buffer.concat([Buffer.from([70, 60 << 2, 69]), long]), 100), long);
  assert.throws(() => snappyDecode(Buffer.from([0x0c, 0x08, 0x61, 0x62, 0x63, 0x15, 0x04]), 100), /bad copy/);
  assert.throws(() => snappyDecode(Buffer.from([0x0c, 0x08, 0x61]), 100), /truncated/);
  assert.throws(() => snappyDecode(Buffer.from([0x80, 0x80, 0x04]), 100), /exceeds the limit/);
});

test('bundles come inline from the API, or linked and snappy-compressed', async () => {
  const inline = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', n: 1 };
  const linked = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', n: 2 };
  // snappy of the linked bundle: one literal whose length (61-128 bytes) takes one extra byte
  const raw = Buffer.from(JSON.stringify(linked));
  assert.ok(raw.length > 60 && raw.length <= 128);
  const compressed = Buffer.concat([Buffer.from([raw.length, 60 << 2, raw.length - 1]), raw]);
  const fake = (async (url: string | URL) => {
    if (String(url).includes('/attestations/')) {
      return new Response(JSON.stringify({ attestations: [{ bundle: inline }, { bundle: null, bundle_url: 'https://tmp.example/b' }] }));
    }
    return new Response(compressed);
  }) as typeof fetch;
  const text = await provenanceBundle('fnkc-stats/positron-remote', image, fake);
  assert.deepEqual(text.trim().split('\n').map((l) => JSON.parse(l)), [inline, linked]);
  const none = (async () => new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch;
  await assert.rejects(provenanceBundle('fnkc-stats/positron-remote', image, none), /no GitHub build provenance exists/);
});

test('the API is asked with a token when there is one, never the bundle download; limits are named', async () => {
  const seen: { url: string; auth?: string }[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (String(url).includes('/attestations/')) return new Response(JSON.stringify({ attestations: [{ bundle: null, bundle_url: 'https://tmp.example/b' }] }));
    const raw = Buffer.from('{"n":1}');
    return new Response(Buffer.concat([Buffer.from([raw.length, (raw.length - 1) << 2]), raw]));
  }) as typeof fetch;
  await provenanceBundle('fnkc-stats/positron-remote', image, fake, 'tok123');
  assert.deepEqual(seen.map((s) => s.auth), ['Bearer tok123', undefined], 'the token goes to the API only, not to the bundle download');
  // A rejected token: asked again without it
  seen.length = 0;
  let first = true;
  const stale = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (first) { first = false; return new Response('{}', { status: 401 }); }
    return new Response(JSON.stringify({ attestations: [{ bundle: { n: 1 } }] }));
  }) as typeof fetch;
  await provenanceBundle('fnkc-stats/positron-remote', image, stale, 'old');
  assert.deepEqual(seen.map((s) => s.auth), ['Bearer old', undefined]);
  // The anonymous limit: a message that says what to do
  const limited = (async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1763690400' } })) as typeof fetch;
  await assert.rejects(provenanceBundle('fnkc-stats/positron-remote', image, limited), /rate limit reached .*until \d\d:\d\d UTC.*gh auth login/);
});

test('the GitHub token comes from the environment, else from gh, else none', async () => {
  const { githubToken } = await import('../src/client/provenance.ts');
  const never = (async () => { throw new Error('must not run'); }) as never;
  assert.equal(await githubToken({ GH_TOKEN: 'a' }, never), 'a');
  assert.equal(await githubToken({}, (async () => ({ code: 0, stdout: 'gho_x\n', stderr: '' })) as never), 'gho_x');
  assert.equal(await githubToken({}, (async () => ({ code: 1, stdout: '', stderr: 'not logged in' })) as never), undefined);
  assert.equal(await githubToken({}, (async () => { throw new Error('command not found: gh'); }) as never), undefined);
});
