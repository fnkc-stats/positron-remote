// resolveStart (client/start.ts): every reply Open recovers from, with fakes for the host and this computer's caches
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckoutPinsOther, EnvironmentImageMissing } from '../src/image-store.ts';
import { ImageRejected, ProvenanceRefused } from '../src/errors.ts';
import { Cancelled } from '../src/exec.ts';
import type { ImageMissing, StartRequest, StartResult } from '../src/protocol.ts';
import { RegistryHttpError, type ImageUpload } from '../src/client/image-download.ts';
import { NoProvenance } from '../src/client/provenance.ts';
import { resolveStart, START_BUDGET, type StartDeps } from '../src/client/start.ts';

const pin = (c: string) => `ghcr.io/fnkc-stats/r-env@sha256:${c.repeat(64)}`;
const ENV_A = pin('a'), ENV_B = pin('b');
const SERVER_A = pin('1'), SERVER_A2 = pin('2'), SERVER_B = pin('3');
const missing = (image: string): ImageMissing => ({ image, arch: 'x64' });
const upload = (image: string): ImageUpload => ({ manifests: [Buffer.from(image)], blobs: [], size: 1 });

type Reply = Error | ((r: StartRequest) => Error | undefined);
/**
 * A host that answers each start with the next of `replies` (an error, or a function of the request), then starts.
 * `servers`: imageToRun's answers per pin, in order (the last one repeats); `proofs`: images with an attestation.
 */
function fake(o: {
  replies?: Reply[]; servers?: Record<string, (string | undefined)[]>; requiresProvenance?: boolean;
  proofs?: Set<string>; proofError?: (image: string, n: number) => Error | undefined;
  uploadError?: (image: string) => Error | undefined; installError?: Error; freed?: number; signal?: AbortSignal;
}) {
  const calls: string[] = [];
  const requests: StartRequest[] = [];
  const replies = [...(o.replies ?? [])];
  const chosen = new Map<string, number>();
  const proofFetches = new Map<string, number>();
  const logs: string[] = [];
  const deps: StartDeps = {
    async start(r) {
      requests.push(structuredClone(r));
      calls.push(`start ${r.positronImage?.image ?? r.image}`);
      const next = replies.shift();
      const e = typeof next === 'function' ? next(r) : next;
      if (e) throw e;
      return { container: 'c', sshPort: 2222, created: true, image: r.positronImage?.image ?? r.image, pinnedImage: r.image,
        revision: 'r', hostKey: 'ssh-ed25519 AAAA' } as StartResult;
    },
    async installImage(m) { calls.push(`install ${m.image}`); if (o.installError) throw o.installError; },
    requiresProvenance: !!o.requiresProvenance,
    async imageToRun(p) {
      const list = o.servers?.[p] ?? [undefined];
      const n = chosen.get(p) ?? 0;
      const v = list[Math.min(n, list.length - 1)];
      return v ? { image: v } : undefined;
    },
    forgetChoice(p) { calls.push(`forgetChoice ${p}`); chosen.set(p, (chosen.get(p) ?? 0) + 1); },
    async provenanceProof(img) {
      const n = (proofFetches.get(img) ?? 0) + 1;
      proofFetches.set(img, n);
      calls.push(`proof ${img}`);
      const e = o.proofError?.(img, n);
      if (e) throw e;
      if (o.proofs && !o.proofs.has(img)) throw new NoProvenance(`no provenance for ${img}`);
      return { bundle: `bundle ${img} #${n}`, subject: `subject ${img}` };
    },
    forgetProof(img) { calls.push(`forgetProof ${img}`); },
    async imageUpload(m) {
      calls.push(`upload ${m.image}`);
      const e = o.uploadError?.(m.image);
      if (e) throw e;
      return upload(m.image);
    },
    forgetImage(u) { calls.push(`forgetImage ${u.manifests[0].toString()}`); },
    pruneImageCache() { calls.push('prune'); return o.freed ?? 0; },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
    signal: o.signal,
  };
  const request: StartRequest = { project: 'study', repository: 'git@example.test:org/study.git', revision: 'r', image: ENV_A,
    positron: { version: '2026.11.1-1', commit: 'd'.repeat(40) } };
  return { deps, request, calls, requests, logs };
}

test('a host that has the image starts it: the server of this Positron, no proof when the host needs none', async () => {
  const f = fake({ servers: { [ENV_A]: [SERVER_A] } });
  const started = await resolveStart(f.deps, f.request);
  assert.equal(started.image, SERVER_A);
  assert.deepEqual(f.calls, [`start ${SERVER_A}`]);
  assert.deepEqual(f.requests[0].positronImage, { image: SERVER_A });
  assert.equal(f.requests[0].provenanceBundle, undefined);
});

test('a host that requires provenance gets the proof of the image it runs', async () => {
  const f = fake({ servers: { [ENV_A]: [SERVER_A] }, requiresProvenance: true });
  await resolveStart(f.deps, f.request);
  assert.equal(f.requests[0].provenanceBundle, `bundle ${SERVER_A} #1`);
  assert.equal(f.requests[0].provenanceSubject, `subject ${SERVER_A}`);
});

test('an image the host lacks is uploaded from this computer once, then Open starts again', async () => {
  const f = fake({ servers: { [ENV_A]: [SERVER_A] }, replies: [new EnvironmentImageMissing(missing(SERVER_A))], freed: 5e8 });
  await resolveStart(f.deps, f.request);
  assert.deepEqual(f.calls, [`start ${SERVER_A}`, `upload ${SERVER_A}`, `install ${SERVER_A}`, 'prune', `start ${SERVER_A}`]);
  assert.ok(f.logs.some((l) => /Removed 500 MB/.test(l)));
});

test('a host that still lacks the image after its upload fails the Open, without a second upload', async () => {
  const e = new EnvironmentImageMissing(missing(SERVER_A));
  const f = fake({ servers: { [ENV_A]: [SERVER_A] }, replies: [e, e, e] });
  await assert.rejects(resolveStart(f.deps, f.request), (x) => x === e);
  assert.equal(f.calls.filter((c) => c.startsWith('upload')).length, 1);
});

test('content the host rejects is dropped from the cache; an interrupted upload keeps it', async () => {
  const rejected = fake({ replies: [new EnvironmentImageMissing(missing(ENV_A))], installError: new ImageRejected('digest mismatch') });
  await assert.rejects(resolveStart(rejected.deps, rejected.request), ImageRejected);
  assert.ok(rejected.calls.includes(`forgetImage ${ENV_A}`));
  const interrupted = fake({ replies: [new EnvironmentImageMissing(missing(ENV_A))], installError: new Error('connection reset') });
  await assert.rejects(resolveStart(interrupted.deps, interrupted.request), /connection reset/);
  assert.ok(!interrupted.calls.some((c) => c.startsWith('forgetImage')));
  assert.ok(!interrupted.calls.includes('prune'));
});

test('a server image gone from the registry is chosen again once; gone again fails the Open', async () => {
  const gone = (img: string) => (img === SERVER_A || img === SERVER_A2 ? new RegistryHttpError(404, `/v2/${img}`) : undefined);
  const f = fake({ servers: { [ENV_A]: [SERVER_A, SERVER_B] }, uploadError: gone,
    replies: [new EnvironmentImageMissing(missing(SERVER_A)), new EnvironmentImageMissing(missing(SERVER_B))] });
  await resolveStart(f.deps, f.request);
  assert.deepEqual(f.calls, [`start ${SERVER_A}`, `upload ${SERVER_A}`, `forgetChoice ${ENV_A}`, `start ${SERVER_B}`,
    `upload ${SERVER_B}`, `install ${SERVER_B}`, 'prune', `start ${SERVER_B}`]);
  assert.ok(f.logs.some((l) => /no longer in the registry/.test(l)));

  assert.equal(START_BUDGET.registryGone, 1);
  const twice = fake({ servers: { [ENV_A]: [SERVER_A, SERVER_A2] }, uploadError: gone,
    replies: [new EnvironmentImageMissing(missing(SERVER_A)), new EnvironmentImageMissing(missing(SERVER_A2))] });
  await assert.rejects(resolveStart(twice.deps, twice.request), (e) => e instanceof RegistryHttpError && e.status === 404);
  assert.equal(twice.calls.filter((c) => c.startsWith('forgetChoice')).length, 1);
});

test('a 404 for an image Open did not choose, or another registry error, fails the Open as it is', async () => {
  const envGone = fake({ uploadError: () => new RegistryHttpError(404, '/v2/x'), replies: [new EnvironmentImageMissing(missing(ENV_A))] });
  await assert.rejects(resolveStart(envGone.deps, envGone.request), RegistryHttpError);
  assert.ok(!envGone.calls.some((c) => c.startsWith('forgetChoice')));
  const down = fake({ servers: { [ENV_A]: [SERVER_A] }, uploadError: () => new RegistryHttpError(503, '/v2/x'),
    replies: [new EnvironmentImageMissing(missing(SERVER_A))] });
  await assert.rejects(resolveStart(down.deps, down.request), (e) => e instanceof RegistryHttpError && e.status === 503);
});

test('a checkout that pins another environment: Open chooses for that one once', async () => {
  const f = fake({ servers: { [ENV_A]: [SERVER_A], [ENV_B]: [SERVER_B] }, requiresProvenance: true, replies: [new CheckoutPinsOther(ENV_B)] });
  const started = await resolveStart(f.deps, f.request);
  assert.equal(started.image, SERVER_B);
  assert.equal(f.requests[1].image, ENV_B);
  assert.deepEqual(f.requests[1].positronImage, { image: SERVER_B });
  assert.equal(f.requests[1].provenanceBundle, `bundle ${SERVER_B} #1`, 'the proof of the new image, not the old one');

  const moving = fake({ replies: [new CheckoutPinsOther(ENV_B), new CheckoutPinsOther(ENV_A)] });
  await assert.rejects(resolveStart(moving.deps, moving.request), (e) => e instanceof CheckoutPinsOther && e.pinned === ENV_A);
  assert.equal(moving.requests.length, 2);
});

test('each kind of retry has its own budget: another pin, then an upload of the new image, still starts', async () => {
  // With one budget shared by all kinds (before resolveStart), these used up the attempts between them
  const gone = (img: string) => (img === SERVER_B ? new RegistryHttpError(404, '/v2/x') : undefined);
  const f = fake({
    servers: { [ENV_A]: [SERVER_A], [ENV_B]: [SERVER_B, SERVER_A2] }, uploadError: gone, requiresProvenance: true,
    replies: [new EnvironmentImageMissing(missing(SERVER_A)), new CheckoutPinsOther(ENV_B), new EnvironmentImageMissing(missing(SERVER_B)),
      new EnvironmentImageMissing(missing(SERVER_A2)), new ProvenanceRefused('stale attestation')],
  });
  const started = await resolveStart(f.deps, f.request);
  assert.equal(started.image, SERVER_A2);
  assert.equal(f.requests.length, 6);
});

test('a refused cached proof is fetched again once; refused again fails the Open', async () => {
  const f = fake({ servers: { [ENV_A]: [SERVER_A] }, requiresProvenance: true, replies: [new ProvenanceRefused('signer not allowed')] });
  await resolveStart(f.deps, f.request);
  assert.deepEqual(f.calls, [`proof ${SERVER_A}`, `start ${SERVER_A}`, `forgetProof ${SERVER_A}`, `proof ${SERVER_A}`, `start ${SERVER_A}`]);
  assert.equal(f.requests[1].provenanceBundle, `bundle ${SERVER_A} #2`);
  assert.ok(f.logs.some((l) => /refused the cached provenance/.test(l)));

  const refused = new ProvenanceRefused('signer not allowed');
  const twice = fake({ servers: { [ENV_A]: [SERVER_A] }, requiresProvenance: true, replies: [refused, refused] });
  await assert.rejects(resolveStart(twice.deps, twice.request), (e) => e === refused);
  assert.equal(twice.calls.filter((c) => c.startsWith('forgetProof')).length, 1);
});

test('a refusal whose new proof cannot be fetched, or with no proof sent, fails with the refusal', async () => {
  const refused = new ProvenanceRefused('signer not allowed');
  const offline = fake({ servers: { [ENV_A]: [SERVER_A] }, requiresProvenance: true, replies: [refused],
    proofError: (_img, n) => (n === 2 ? new Error('GitHub unreachable') : undefined) });
  await assert.rejects(resolveStart(offline.deps, offline.request), (e) => e === refused);
  const noProof = fake({ replies: [refused] });
  await assert.rejects(resolveStart(noProof.deps, noProof.request), (e) => e === refused);
  assert.ok(!noProof.calls.some((c) => c.startsWith('forgetProof')));
});

test('a proof that cannot be fetched (GitHub down) is left out: the host decides', async () => {
  const f = fake({ servers: { [ENV_A]: [SERVER_A] }, requiresProvenance: true, proofError: () => new Error('ETIMEDOUT') });
  await resolveStart(f.deps, f.request);
  assert.equal(f.requests[0].provenanceBundle, undefined);
  assert.ok(f.logs.some((l) => /could not fetch the image's provenance \(ETIMEDOUT\)/.test(l)));
});

test('a server image without an attestation is looked up again once (a forced rebuild); none fails with Build Environment', async () => {
  const rebuilt = fake({ servers: { [ENV_A]: [SERVER_A, SERVER_A2] }, requiresProvenance: true, proofs: new Set([SERVER_A2]) });
  const started = await resolveStart(rebuilt.deps, rebuilt.request);
  assert.equal(started.image, SERVER_A2);
  assert.equal(rebuilt.requests[0].provenanceBundle, `bundle ${SERVER_A2} #1`);

  const same = fake({ servers: { [ENV_A]: [SERVER_A] }, requiresProvenance: true, proofs: new Set() });
  await assert.rejects(resolveStart(same.deps, same.request), /no provenance for .*; rebuild this environment with FNKC Projects: Build Environment/);
  assert.equal(same.requests.length, 0, 'nothing is started');
  // The environment itself has no attestation: nothing to choose instead
  const env = fake({ requiresProvenance: true, proofs: new Set() });
  await assert.rejects(resolveStart(env.deps, env.request), NoProvenance);
});

test('Cancel stops the Open between attempts', async () => {
  const controller = new AbortController();
  const f = fake({ signal: controller.signal, replies: [(_r) => { controller.abort(); return new EnvironmentImageMissing(missing(ENV_A)); }] });
  await assert.rejects(resolveStart(f.deps, f.request), Cancelled);
  assert.equal(f.requests.length, 1);
});

test("after the start, the checkout's container.json must still pin what the host started from", async () => {
  const { checkoutMatches } = await import('../src/client/open.ts');
  const started = { image: SERVER_A, pinnedImage: ENV_A };
  checkoutMatches(JSON.stringify({ image: ENV_A }), 'study', started);
  checkoutMatches(JSON.stringify({ image: ENV_A }), 'study', { image: ENV_A });
  assert.throws(() => checkoutMatches(JSON.stringify({ image: ENV_B }), 'study', started), /checkout environment changed during Open/);
  assert.throws(() => checkoutMatches('{"image": ', 'study', started), /study\/container.json in the checkout is not valid JSON/);
});
