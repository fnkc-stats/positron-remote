// Error kinds cross the protocol as codes (errors.ts, serve.ts, transport.ts); protocol compatibility is a range.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CodedError, HostCapacity, hostError, ImageRejected, Incompatible, LockBusy, ProvenanceRefused, QuotaExceeded, ReplacementNotReady, UnknownCommand,
} from '../src/errors.ts';
import { CheckoutPinsOther, EnvironmentImageMissing } from '../src/image-store.ts';
import { answer } from '../src/serve.ts';
import { MIN_PROTOCOL, PROTOCOL_VERSION, requireCompatible, serves } from '../src/protocol.ts';
import { forgetProof, provenanceProof } from '../src/client/provenance.ts';
import { hexOf, sha256 } from '../src/oci.ts';

async function replyOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try { await answer(run); } finally { process.stdout.write = write; }
  return JSON.parse(out) as Record<string, unknown>;
}

test('the agent sends the kind of a failure as its code', async () => {
  for (const [e, code] of [
    [new QuotaExceeded('q'), 'quota'], [new HostCapacity('c'), 'capacity'], [new LockBusy('b'), 'busy'],
    [new UnknownCommand('u'), 'unknown-command'], [new ImageRejected('r'), 'image-rejected'],
    [new ProvenanceRefused('p'), 'provenance-refused'], [new ReplacementNotReady('n'), 'replacement-not-ready'], [new CheckoutPinsOther('x@sha256:1'), 'checkout-pins'],
    [new EnvironmentImageMissing({ image: 'x@sha256:1', arch: 'x64' }), 'image-missing'],
  ] as const) {
    const reply = await replyOf(() => Promise.reject(e));
    assert.equal(reply.ok, false);
    assert.equal(reply.code, code);
    assert.equal(reply.error, e.message);
  }
  // Plain errors have no code; the special cases keep their fields for older clients
  assert.equal((await replyOf(() => Promise.reject(new Error('plain')))).code, undefined);
  assert.equal((await replyOf(() => Promise.reject(new CheckoutPinsOther('x@sha256:1')))).checkoutPins, 'x@sha256:1');
});

test('the client makes the class of a code again, whatever the wording', () => {
  for (const [code, Class] of [
    ['quota', QuotaExceeded], ['capacity', HostCapacity], ['busy', LockBusy], ['incompatible', Incompatible],
    ['unknown-command', UnknownCommand], ['image-rejected', ImageRejected], ['provenance-refused', ProvenanceRefused],
    ['replacement-not-ready', ReplacementNotReady],
  ] as const) {
    const e = hostError("host 'srv': some new wording", code);
    assert.ok(e instanceof Class, code);
    assert.equal(e.message, "host 'srv': some new wording");
  }
  // A code from a newer host that this client does not know: a plain error, never guessed from the wording
  const future = hostError("host 'srv': concurrent project quota reached", 'future-kind');
  assert.ok(!(future instanceof CodedError));
});

test('a host from before codes is understood by its wording', () => {
  const legacy = (raw: string) => hostError(`host 'srv': ${raw}`, undefined, raw);
  assert.ok(legacy("unknown agent command: 'images' (ping, list)") instanceof UnknownCommand);
  assert.ok(legacy('concurrent project quota reached (2): stop another project (running: a, b)') instanceof QuotaExceeded);
  assert.ok(legacy('per-user memory budget exceeded') instanceof QuotaExceeded);
  assert.ok(legacy('this host admits no project starts at the moment (maxProjectsPerUser is 0)') instanceof HostCapacity);
  assert.ok(legacy('host capacity reserved or exhausted: stop another workload') instanceof HostCapacity);
  assert.ok(legacy('Traceback ...\nTimeoutError: operation is busy; timed out waiting for /x') instanceof LockBusy);
  assert.ok(legacy('image upload: sha256:ab has the wrong size') instanceof ImageRejected);
  assert.ok(legacy('image upload: the manifest does not match the pinned digest') instanceof ImageRejected);
  assert.ok(legacy('image provenance verification failed for x: no matching attestation') instanceof ProvenanceRefused);
  assert.ok(legacy('the manifest sent for x does not match its digest; refusing to start') instanceof ProvenanceRefused);
  assert.ok(!(legacy('project name does not match repository') instanceof CodedError));
});

test('a host serves every client protocol from its minProtocol to its protocol', () => {
  const caps = ['a'];
  assert.ok(MIN_PROTOCOL <= PROTOCOL_VERSION);
  assert.ok(serves({ protocol: 1, capabilities: caps }, 1, caps));
  // Server first: a host of protocol 2 that still serves 1 keeps the older clients working
  assert.ok(serves({ protocol: 2, minProtocol: 1, capabilities: caps }, 1, caps));
  assert.ok(!serves({ protocol: 2, minProtocol: 2, capabilities: caps }, 1, caps));
  assert.ok(!serves({ protocol: 2, capabilities: caps }, 1, caps));
  // A client newer than the host: the server is upgraded first
  assert.ok(!serves({ protocol: 1, minProtocol: 1, capabilities: caps }, 2, caps));
  assert.ok(!serves({ protocol: 1, capabilities: [] }, 1, caps));
  assert.ok(!serves({ capabilities: caps }, 1, caps));
  assert.throws(() => requireCompatible({ version: '0.1', user: 'u', protocol: PROTOCOL_VERSION + 1, minProtocol: PROTOCOL_VERSION + 1 }), Incompatible);
});

test('a cached proof belongs to its repository and digest; forgetting it leaves the others', async (t) => {
  const cache = mkdtempSync(join(tmpdir(), 'fnkc-proof-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const subject = Buffer.from('{"schemaVersion":2}');
  const image = `ghcr.io/o/r-env@${sha256(subject)}`;
  const put = (repository: string, bundle: string) => {
    const dir = join(cache, 'provenance', repository.replace('/', '__'), hexOf(sha256(subject)));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bundle.jsonl'), bundle);
    writeFileSync(join(dir, 'subject'), subject);
    return dir;
  };
  const a = put('o/a', 'bundle a\n');
  const b = put('o/b', 'bundle b\n');
  assert.equal((await provenanceProof(cache, 'o/a', image)).bundle, 'bundle a\n');
  assert.equal((await provenanceProof(cache, 'o/b', image)).bundle, 'bundle b\n');
  assert.equal((await provenanceProof(cache, 'o/a', image)).subject, subject.toString('base64'));
  forgetProof(cache, 'o/a', image);
  assert.ok(!existsSync(a));
  assert.ok(existsSync(b));
  await assert.rejects(provenanceProof(cache, 'no-owner', image), /invalid provenance repository/);
});
