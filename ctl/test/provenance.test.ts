import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentConfig } from '../src/agent-config.ts';
import { verifyImageProvenance } from '../src/provenance.ts';

const image = `ghcr.io/fnkc-stats/r-env@sha256:${'a'.repeat(64)}`;

test('server provenance verification fails closed and pins the expected signer policy', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-provenance-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trustedRootFile = join(dir, 'trusted-root.jsonl');
  writeFileSync(trustedRootFile, '{"trustedRoot":true}\n');
  const cfg = agentConfig('alice', { keysDir: join(dir, 'keys'), trustedRootFile });
  await assert.rejects(verifyImageProvenance(cfg, image, undefined, async () => { throw new Error('must not run'); }), /missing or oversized/);
  let checked = false;
  await verifyImageProvenance(cfg, image, '{"verificationMaterial":{}}\n', async (cmd, args) => {
    assert.equal(cmd, 'gh');
    assert.deepEqual(args.slice(0, 3), ['attestation', 'verify', `oci://${image}`]);
    assert.ok(args.includes('--custom-trusted-root'));
    assert.ok(args.includes(trustedRootFile));
    assert.ok(args.includes('--signer-workflow'));
    assert.ok(args.includes('fnkc-stats/positron-remote/.github/workflows/positron.yml'));
    assert.ok(args.includes('--source-ref') && args.includes('refs/heads/main'));
    const bundleFile = args[args.indexOf('--bundle') + 1];
    assert.equal(readFileSync(bundleFile, 'utf8'), '{"verificationMaterial":{}}\n');
    checked = true;
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.ok(checked);
  await assert.rejects(verifyImageProvenance(cfg, image, 'bad proof', async () => ({ code: 1, stdout: '', stderr: 'verification failed\n' })), /verification failed/);
});

test('local-only agents may opt out; enrolled server agents require provenance by default', () => {
  assert.equal(agentConfig('alice').requireProvenance, false);
  assert.equal(agentConfig('alice', { keysDir: '/etc/fnkc-ctl/keys' }).requireProvenance, true);
  assert.equal(agentConfig('alice', { keysDir: '/etc/fnkc-ctl/keys', requireProvenance: false }).requireProvenance, false);
});
