// resolveStart (client/start.ts): every reply Open recovers from, with fakes for the host and this computer's caches
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckoutPinsOther, EnvironmentImageMissing } from '../src/image-store.ts';
import { ImageRejected, ProvenanceRefused, ReplacementNotReady } from '../src/errors.ts';
import { Cancelled } from '../src/exec.ts';
import type { CheckoutState, ContainerInfo, ImageMissing, StartRequest, StartResult, StopResult } from '../src/protocol.ts';
import { UnknownCommand } from '../src/errors.ts';
import type { ClientConfig, HostConfig } from '../src/client/config.ts';
import type { Transport } from '../src/client/transport.ts';
import { RegistryHttpError, type ImageUpload } from '../src/client/image-download.ts';
import { NoProvenance } from '../src/client/provenance.ts';
import { ReplacementStillNotReady, resolveStart, START_BUDGET, type StartDeps, TransferCancelled } from '../src/client/start.ts';

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
  /** The host's answer to the checkout query (an error is thrown); absent: the host cannot answer it. */
  checkout?: CheckoutState | Error; noServer?: Set<string>;
}) {
  const calls: string[] = [];
  const requests: StartRequest[] = [];
  const replies = [...(o.replies ?? [])];
  const chosen = new Map<string, number>();
  const proofFetches = new Map<string, number>();
  const logs: string[] = [];
  const looked: string[] = [];
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
    ...(o.checkout ? { async checkout() { calls.push('checkout'); if (o.checkout instanceof Error) throw o.checkout; return o.checkout!; } } : {}),
    requiresProvenance: !!o.requiresProvenance,
    async imageToRun(p) {
      looked.push(p);
      if (o.noServer?.has(p)) throw new Error(`no server of this Positron for ${p}`);
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
  return { deps, request, calls, requests, logs, looked };
}

test('a host that has the image starts it: the server of this Positron, no proof when the host needs none', async () => {
  const f = fake({ servers: { [ENV_A]: [SERVER_A] } });
  const started = await resolveStart(f.deps, f.request);
  assert.equal(started.image, SERVER_A);
  assert.deepEqual(f.calls, [`start ${SERVER_A}`]);
  assert.deepEqual(f.requests[0].positronImage, { image: SERVER_A });
  assert.equal(f.requests[0].provenanceBundle, undefined);
});

test('a replacement that does not become ready: Discard and retry once, with the question; a second failure says what to do', async () => {
  const notReady = new ReplacementNotReady("host 'srv': the new environment of study started but did not become ready: ...; last lines of its readiness log:\nsshd: bad option");
  // Discarded and started afresh
  const asked: string[] = [];
  const ok = fake({ replies: [notReady] });
  ok.deps.discardReplacement = async (m) => { asked.push(m); return true; };
  await resolveStart(ok.deps, ok.request);
  assert.deepEqual(asked, [notReady.message], 'the question shows the failure with its log');
  assert.equal(ok.requests[0].discardReplacement, undefined);
  assert.equal(ok.requests[1].discardReplacement, true);
  // The fresh container fails too: no third start, and the message says to ask an administrator or revert the pin
  const twice = fake({ replies: [notReady, notReady] });
  twice.deps.discardReplacement = async () => true;
  await assert.rejects(resolveStart(twice.deps, twice.request), (e: Error) => e instanceof ReplacementStillNotReady &&
    /does not start on this host/.test(e.message) && /administrator/.test(e.message) && /revert the change of the environment pin/.test(e.message) &&
    e.message.includes('sshd: bad option'));
  assert.equal(twice.requests.length, 2);
  // Declined, or no one to ask (an older host, the CLI without --discard-replacement): the failure ends the Open
  const declined = fake({ replies: [notReady] });
  declined.deps.discardReplacement = async () => false;
  await assert.rejects(resolveStart(declined.deps, declined.request), (e) => e === notReady);
  const silent = fake({ replies: [notReady] });
  await assert.rejects(resolveStart(silent.deps, silent.request), (e) => e === notReady);
  assert.equal(declined.requests.length + silent.requests.length, 2);
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

test('Cancel during the image download or upload is a TransferCancelled naming the image (Retry Open); elsewhere a plain Cancelled', async () => {
  const downloading = fake({ replies: [new EnvironmentImageMissing(missing(ENV_A))], uploadError: () => new Cancelled() });
  const d = await resolveStart(downloading.deps, downloading.request).then(() => assert.fail('started'), (e: unknown) => e);
  assert.ok(d instanceof TransferCancelled && d.image === ENV_A, String(d));
  assert.ok(!downloading.calls.includes(`install ${ENV_A}`), 'nothing is sent');
  const sending = fake({ replies: [new EnvironmentImageMissing(missing(ENV_A))], installError: new Cancelled() });
  const s = await resolveStart(sending.deps, sending.request).then(() => assert.fail('started'), (e: unknown) => e);
  assert.ok(s instanceof TransferCancelled && s.image === ENV_A, String(s));
  assert.ok(!sending.calls.some((c) => c.startsWith('forgetImage')), 'the downloaded image stays in the cache');
  const before = fake({ checkout: new Cancelled() });
  const b = await resolveStart(before.deps, before.request).then(() => assert.fail('started'), (e: unknown) => e);
  assert.ok(b instanceof Cancelled && !(b instanceof TransferCancelled), String(b));
});

test("after the start, the checkout's container.json must still pin what the host started from", async () => {
  const { checkoutMatches } = await import('../src/client/open.ts');
  const started = { image: SERVER_A, pinnedImage: ENV_A };
  checkoutMatches(JSON.stringify({ image: ENV_A }), 'study', started);
  checkoutMatches(JSON.stringify({ image: ENV_A }), 'study', { image: ENV_A });
  assert.throws(() => checkoutMatches(JSON.stringify({ image: ENV_B }), 'study', started), /checkout environment changed during Open/);
  assert.throws(() => checkoutMatches('{"image": ', 'study', started), /study\/container.json in the checkout is not valid JSON/);
});

test('a warm host: the checkout\'s pin is used even when remote HEAD pins an environment without this Positron', async () => {
  // A fresh client cache, remote HEAD advanced to ENV_A, which has no server of this Positron; the checkout pins ENV_B
  const f = fake({ servers: { [ENV_B]: [SERVER_B] }, noServer: new Set([ENV_A]), requiresProvenance: true,
    checkout: { container: { running: false }, checkout: 'present', repository: 'git@example.test:org/study.git', revision: 'old', image: ENV_B } });
  const started = await resolveStart(f.deps, f.request);
  assert.equal(started.image, SERVER_B);
  assert.deepEqual([f.requests[0].image, f.requests[0].revision], [ENV_B, 'old']);
  assert.deepEqual(f.looked, [ENV_B], "remote HEAD's environment is never looked up");
  assert.equal(f.calls[0], 'checkout', 'the host is asked before any image is chosen');
  assert.ok(f.logs.some((l) => l.includes(`The checkout on the host pins ${ENV_B}`)));
});

test('no checkout, one that cannot be read, another repository\'s, or no answer: remote HEAD is used; Cancel is not swallowed', async () => {
  const states: (CheckoutState | Error)[] = [
    { checkout: 'none' },
    { checkout: 'unknown', reason: 'busy' },
    { checkout: 'present', repository: 'git@example.test:other/study.git', revision: 'old', image: ENV_B },
    new Error('connection reset'),
  ];
  for (const checkout of states) {
    const f = fake({ servers: { [ENV_A]: [SERVER_A] }, checkout });
    assert.equal((await resolveStart(f.deps, f.request)).image, SERVER_A);
    assert.deepEqual([f.requests[0].image, f.requests[0].revision], [ENV_A, 'r']);
  }
  const cancelled = fake({ checkout: new Cancelled() });
  await assert.rejects(resolveStart(cancelled.deps, cancelled.request), Cancelled);
  assert.equal(cancelled.requests.length, 0);
});

test('Gitea unreachable and the host has the checkout: Open starts it without reading remote HEAD', async () => {
  const f = fake({ servers: { [ENV_B]: [SERVER_B] },
    checkout: { container: { running: false }, checkout: 'present', repository: 'git@example.test:org/study.git', revision: 'old', image: ENV_B } });
  const { image: _i, revision: _r, ...open } = f.request;
  f.deps.remoteHead = async () => { f.calls.push('remoteHead'); throw new Error('could not fetch project study: Connection timed out'); };
  f.deps.remoteHeadUnneeded = () => f.calls.push('remoteHeadUnneeded');
  const started = await resolveStart(f.deps, open);
  assert.equal(started.image, SERVER_B);
  assert.deepEqual([f.requests[0].image, f.requests[0].revision], [ENV_B, 'old']);
  assert.ok(!f.calls.includes('remoteHead'), 'remote HEAD is not needed');
  // Its reading, started early by openProject, is stopped right after the adoption, before the start
  assert.deepEqual(f.calls.slice(0, 2), ['checkout', 'remoteHeadUnneeded']);
});

test('no checkout to adopt: remote HEAD is read after asking the host, and its failure fails the Open', async () => {
  const states: (CheckoutState | Error | undefined)[] = [{ checkout: 'none' }, { checkout: 'unknown', reason: 'busy' }, new Error('reset'), undefined];
  for (const checkout of states) {
    const f = fake({ servers: { [ENV_A]: [SERVER_A] }, checkout });
    const { image: _i, revision: _r, ...open } = f.request;
    f.deps.remoteHead = async () => { f.calls.push('remoteHead'); return { image: ENV_A, revision: 'head' }; };
    f.deps.remoteHeadUnneeded = () => f.calls.push('remoteHeadUnneeded');
    assert.equal((await resolveStart(f.deps, open)).image, SERVER_A);
    assert.ok(!f.calls.includes('remoteHeadUnneeded'));
    assert.deepEqual([f.requests[0].image, f.requests[0].revision], [ENV_A, 'head']);
    assert.deepEqual(f.calls.slice(0, checkout ? 2 : 1), [...(checkout ? ['checkout'] : []), 'remoteHead']);
  }
  const down = fake({ checkout: { checkout: 'none' } });
  const gitea = new Error('could not fetch project study');
  down.deps.remoteHead = async () => { throw gitea; };
  await assert.rejects(resolveStart(down.deps, down.request), (e) => e === gitea);
  assert.equal(down.requests.length, 0);
});

/** Another host for warnIfRunningElsewhere: answers the checkout query (or lists, if older), or never answers. */
function otherHost(name: string, o: { running?: boolean; repository?: string; older?: boolean; stalls?: boolean }) {
  const asked: string[] = [];
  const t = {
    host: { name } as HostConfig,
    signal: undefined as AbortSignal | undefined,
    async checkout(project: string): Promise<CheckoutState> {
      asked.push(`checkout ${project}`);
      if (o.stalls) return new Promise(() => {}); // a host that never answers and ignores the signal (local Docker)
      if (o.older) throw new UnknownCommand("unknown agent command: 'checkout'");
      return { container: o.running === undefined ? undefined : { running: o.running, repository: o.repository }, checkout: 'none' };
    },
    async list(): Promise<ContainerInfo[]> {
      asked.push('list');
      return o.running === undefined ? [] : [{ project: 'study', repository: o.repository, container: 'c', running: o.running, state: '', image: '' }];
    },
  };
  return { t: t as unknown as Transport, asked };
}

test('running elsewhere: other hosts are asked at once about this project only; another repository of the same name is not it', async () => {
  const { warnIfRunningElsewhere } = await import('../src/client/open.ts');
  const repo = 'git@example.test:org/study.git';
  const hosts = {
    here: otherHost('here', { running: true, repository: repo }),
    runs: otherHost('runs', { running: true, repository: repo }),
    stopped: otherHost('stopped', { running: false, repository: repo }),
    other: otherHost('other', { running: true, repository: 'git@example.test:someone/study.git' }),
    older: otherHost('older', { running: true, repository: repo, older: true }),
  };
  const cfg = { hosts: Object.values(hosts).map((h) => h.t.host) } as ClientConfig;
  const logs: string[] = [];
  await warnIfRunningElsewhere(cfg, 'here', 'study', repo, { info() {}, warn: (m) => logs.push(m) },
    { transport: (h) => hosts[h.name as keyof typeof hosts].t });
  assert.deepEqual(logs.map((l) => /running on '(\w+)'/.exec(l)?.[1]), ['runs', 'older']);
  assert.deepEqual(hosts.here.asked, [], 'the host Open uses is not asked');
  assert.deepEqual(hosts.runs.asked, ['checkout study'], 'no full listing where the host answers the query');
  assert.deepEqual(hosts.older.asked, ['checkout study', 'list'], 'an older host is listed instead');
});

test('running elsewhere: a stalled host is given up after the wait, and Cancel ends the wait at once', async () => {
  const { warnIfRunningElsewhere } = await import('../src/client/open.ts');
  const repo = 'git@example.test:org/study.git';
  const stalled = otherHost('stalled', { stalls: true });
  const runs = otherHost('runs', { running: true, repository: repo });
  const cfg = { hosts: [stalled.t.host, runs.t.host, { name: 'here' } as HostConfig] } as ClientConfig;
  const pick = (h: HostConfig) => (h.name === 'stalled' ? stalled.t : runs.t);
  const logs: string[] = [];
  const log = { info() {}, warn: (m: string) => logs.push(m) };
  let begun = Date.now();
  await warnIfRunningElsewhere(cfg, 'here', 'study', repo, log, { transport: pick, waitMs: 200 });
  assert.ok(Date.now() - begun < 2000, 'the stalled host does not hold Open (and its project lock)');
  assert.equal(logs.length, 1, 'the hosts that answered still warn');
  assert.ok(stalled.t.signal?.aborted, "the stalled host's call is cancelled");

  const controller = new AbortController();
  begun = Date.now();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(warnIfRunningElsewhere(cfg, 'here', 'study', repo, log, { transport: pick, signal: controller.signal, waitMs: 60_000 }), Cancelled);
  assert.ok(Date.now() - begun < 2000, 'Cancel does not wait for the stalled host');
});

test('Stop with owner/name or a URL stops only that repository; another of the same name on another host keeps running', async () => {
  const { stopProject } = await import('../src/client/open.ts');
  const { QualifiedStopUnsupported } = await import('../src/client/transport.ts');
  const teamA = 'ssh://git@gitea.test:2221/team-a/study.git';
  // Each host has a container named study: team-a's, team-b's, and one on a host with an older fnkc-ctl
  const hosts: Record<string, { repository: string; older?: boolean; asked: string[] }> = {
    a: { repository: teamA, asked: [] },
    b: { repository: 'ssh://git@gitea.test:2221/team-b/study.git', asked: [] },
    old: { repository: teamA, older: true, asked: [] },
  };
  const transport = (h: HostConfig) => {
    const host = hosts[h.name];
    return {
      async stop(project: string, repository?: string) {
        host.asked.push(repository ? `stop ${project} ${repository}` : `stop ${project}`);
        if (repository && host.older) throw new QualifiedStopUnsupported(h.name);
        if (repository && repository !== host.repository) return { stopped: false, otherRepository: host.repository };
        return { stopped: true };
      },
    } as unknown as Transport;
  };
  const cfg = { gitRemotes: ['ssh://git@gitea.test:2221/stats'], hosts: Object.keys(hosts).map((name) => ({ name })) } as ClientConfig;
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`warn: ${m}`) };

  const outcomes = (r: { host: string; outcome: string }[]) => r.map((x) => `${x.host}:${x.outcome}`);
  assert.deepEqual(outcomes(await stopProject(cfg, 'team-a/study', undefined, log, { transport })), ['a:stopped', 'b:other-repository', 'old:failed']);
  assert.deepEqual(hosts.b.asked, [`stop study ${teamA}`], 'the repository goes with the stop');
  assert.ok(logs.some((l) => l.includes("'b'") && l.includes('team-b/study') && l.includes('left running')));
  assert.ok(logs.some((l) => l.startsWith("warn: 'old'") && l.includes('nothing was stopped')), 'an older host is not stopped blindly');
  assert.deepEqual(outcomes(await stopProject(cfg, 'https://gitea.test/team-a/study/src/branch/main', undefined, log, { transport }))[0], 'a:stopped', 'a web link is qualified too');
  await assert.rejects(stopProject(cfg, 'team-a/study', 'old', log, { transport }), QualifiedStopUnsupported);

  for (const h of Object.values(hosts)) h.asked.length = 0;
  assert.deepEqual(outcomes(await stopProject(cfg, 'study', undefined, log, { transport })), ['a:stopped', 'b:stopped', 'old:stopped'], 'the plain name stops it everywhere, as before');
  assert.deepEqual(hosts.old.asked, ['stop study']);
});

test('Stop on every host tells absent, already stopped, stopped and failed apart; all failed is not "nothing found"', async () => {
  const { stopProject, stopSummary } = await import('../src/client/open.ts');
  // What each host answers: this fnkc-ctl's outcomes, an older host's bare boolean, or no answer
  const answers: Record<string, StopResult | Error> = {
    run: { stopped: true, outcome: 'stopped' },
    idle: { stopped: true, outcome: 'already-stopped' },
    gone: { stopped: false, outcome: 'absent' },
    older: { stopped: true },
    olderGone: { stopped: false },
    down: new Error("host 'down': Connection refused"),
    down2: new Error('Docker is not running'),
  };
  const transport = (h: HostConfig) => ({
    async stop() { const a = answers[h.name]; if (a instanceof Error) throw a; return a; },
  }) as unknown as Transport;
  const cfgOf = (names: string[]) => ({ gitRemotes: [], hosts: names.map((name) => ({ name })) }) as unknown as ClientConfig;
  const warnings: string[] = [];
  const log = { info: () => {}, warn: (m: string) => warnings.push(m) };

  const all = await stopProject(cfgOf(['down', 'down2']), 'study', undefined, log, { transport });
  assert.deepEqual(all.map((r) => [r.host, r.outcome, r.error]), [['down', 'failed', "host 'down': Connection refused"], ['down2', 'failed', 'Docker is not running']]);
  assert.equal(warnings.length, 2, 'each host that could not be checked is warned about');
  const allSummary = stopSummary('study', all);
  assert.deepEqual([allSummary.found, allSummary.failed], [false, true]);
  assert.match(allSummary.message, /^study: could not check 'down' \(.*\), 'down2' \(Docker is not running\): it may still be running there$/);

  const mixed = await stopProject(cfgOf(['run', 'idle', 'gone', 'older', 'olderGone', 'down']), 'study', undefined, log, { transport });
  assert.deepEqual(mixed.map((r) => r.outcome), ['stopped', 'already-stopped', 'absent', 'stopped', 'absent', 'failed'],
    "an older host's stopped:true stays 'stopped' (it cannot tell already stopped)");
  const mixedSummary = stopSummary('study', mixed);
  assert.deepEqual([mixedSummary.found, mixedSummary.failed], [true, true]);
  assert.equal(mixedSummary.message, "study: stopped on 'run', 'older'; already stopped on 'idle'; no container on 'gone', 'olderGone'; " +
    "could not check 'down' (host 'down': Connection refused): it may still be running there");

  const fine = stopSummary('study', await stopProject(cfgOf(['run', 'gone']), 'study', undefined, log, { transport }));
  assert.deepEqual([fine.found, fine.failed], [true, false]);
  await assert.rejects(stopProject(cfgOf(['run', 'down']), 'study', 'down', log, { transport }), /Connection refused/, 'a chosen host fails the stop');
});
