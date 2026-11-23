// What positron.yml decides about the image a positron-* tag points to (.github/scripts/positron-tag.sh), run here with
// a fake gh and docker and a throwaway git history: an older run never moves the tag back to its older recipe, and a
// failing attestation service is retried and then stops the run instead of rebuilding.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const script = join(root, '.github', 'scripts', 'positron-tag.sh');
const REPO = 'fnkc-stats/positron-remote';
const IMAGE = 'ghcr.io/fnkc-stats/r-env';
const DIGEST = `sha256:${'a'.repeat(64)}`;

// $FAKE/image: the image's JSON (docker buildx imagetools inspect --format '{{json .Image}}'). $FAKE/verify: one
// outcome per gh attestation verify call, in order (the last repeats): ok, or an error message. $FAKE/compare-fails:
// how many compare calls answer HTTP 502 first. Compare answers from the git history in $HISTORY, as GitHub does.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE/calls"
case "$1 $2" in
  "attestation verify")
    n=$(cat "$FAKE/verify-n" 2>/dev/null || echo 1)
    echo $((n + 1)) > "$FAKE/verify-n"
    line=$(sed -n "\${n}p" "$FAKE/verify"); [ -n "$line" ] || line=$(tail -n 1 "$FAKE/verify")
    [ "$line" = ok ] && { echo "Verification succeeded"; exit 0; }
    echo "$line" >&2; exit 1 ;;
  "api repos/${REPO}/compare/"*)
    n=$(cat "$FAKE/compare-fails" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE/compare-fails"; echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    range=\${2##*/compare/}; base=\${range%%...*}; head=\${range##*...}
    git -C "$HISTORY" cat-file -e "$base^{commit}" 2>/dev/null && git -C "$HISTORY" cat-file -e "$head^{commit}" 2>/dev/null \\
      || { echo "HTTP 404: Not Found" >&2; exit 1; }
    if [ "$base" = "$head" ]; then echo identical
    elif git -C "$HISTORY" merge-base --is-ancestor "$base" "$head"; then echo ahead
    elif git -C "$HISTORY" merge-base --is-ancestor "$head" "$base"; then echo behind
    else echo diverged; fi ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`;
const FAKE_DOCKER = `#!/bin/sh
[ "$1 $2 $3 $4" = "buildx imagetools inspect ${IMAGE}@${DIGEST}" ] || { echo "unexpected docker call: $*" >&2; exit 2; }
cat "$FAKE/image"
`;

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'positron-tag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake'), bin = join(dir, 'bin'), history = join(dir, 'history');
  for (const d of [fake, bin, history]) mkdirSync(d);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'docker'), 0o755);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: history, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (message: string) => { git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  /** The tag's image, published from main commit `revision` (none: an image from before the label). */
  const published = (revision?: string) => {
    const labels = { 'positron.recipe': 'r', ...(revision ? { 'org.opencontainers.image.revision': revision } : {}) };
    // A multi-architecture index, as the tag holds
    writeFileSync(join(fake, 'image'), JSON.stringify({ 'linux/amd64': { config: { Labels: labels } }, 'linux/arm64': { config: { Labels: labels } } }));
  };
  const run = (what: string, sha = '') => spawnSync('bash', [script, what, `${IMAGE}@${DIGEST}`], {
    encoding: 'utf8',
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, HISTORY: history, GITHUB_REPOSITORY: REPO, GITHUB_SHA: sha, RETRY_SECONDS: '0' },
  });
  const calls = () => { try { return readFileSync(join(fake, 'calls'), 'utf8'); } catch { return ''; } };
  return { fake, git, commit, published, run, calls };
}

test('an older run after a newer one does not move the tag back to its recipe', (t) => {
  const f = fixture(t);
  const older = f.commit('recipe 1');
  const newer = f.commit('recipe 2');

  // The newer run promoted first; the older one (or its rerun) reaches promotion afterwards
  f.published(newer);
  const r = f.run('newest', older);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, new RegExp(`published from main commit ${newer}.*\\(behind\\).*positron-promote\\.yml`));

  // The usual order: the newer run replaces what the older one published
  f.published(older);
  assert.equal(f.run('newest', newer).status, 0);
});

test('the same commit, an image without a recorded commit and unrelated history', (t) => {
  const f = fixture(t);
  const base = f.commit('base');
  const main = f.commit('main');
  f.published(main);
  assert.equal(f.run('newest', main).status, 0);
  assert.doesNotMatch(f.calls(), /compare/, 'the same commit needs no comparison');

  f.published();
  assert.equal(f.run('newest', main).status, 0);

  f.git('checkout', '-q', '-b', 'other', base);
  const other = f.commit('rewritten');
  f.published(main);
  const r = f.run('newest', other);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\(diverged\)/);
});

test('a comparison that cannot be made stops; a transient one is retried', (t) => {
  const f = fixture(t);
  const older = f.commit('one');
  const newer = f.commit('two');
  f.published(`${'b'.repeat(40)}`);
  const unknown = f.run('newest', newer);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /could not compare.*HTTP 404/);

  f.published(older);
  writeFileSync(join(f.fake, 'compare-fails'), '2');
  assert.equal(f.run('newest', newer).status, 0);
  writeFileSync(join(f.fake, 'compare-fails'), '9');
  const down = f.run('newest', newer);
  assert.equal(down.status, 2);
  assert.match(down.stderr, /attempt 3 of 4 failed.*\n.*could not compare.*HTTP 502/);
});

test('provenance: verified, missing or invalid, and an attestation service that keeps failing', (t) => {
  const f = fixture(t);
  const verify = (...outcomes: string[]) => {
    writeFileSync(join(f.fake, 'verify'), `${outcomes.join('\n')}\n`);
    rmSync(join(f.fake, 'verify-n'), { force: true });
    return f.run('provenance');
  };
  assert.equal(verify('ok').status, 0);

  const missing = verify(`Error: failed to fetch attestations: no attestations found for subject ${DIGEST}`);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /no attestations found/);
  const policy = verify('Error: verifying with issuer "sigstore.dev": expected SourceRepositoryRef to be refs/heads/main, got refs/heads/x');
  assert.equal(policy.status, 1);

  // Transient errors: retried, and an answer after them counts
  assert.equal(verify('HTTP 503: Service Unavailable', 'Post "https://api.github.com": dial tcp: i/o timeout', 'ok').status, 0);
  const notMissing = verify('HTTP 502: Bad Gateway', 'no attestations found');
  assert.equal(notMissing.status, 1, 'a real answer after a retry is still the answer');

  // Still failing after every attempt: inconclusive, the caller stops instead of rebuilding
  const down = verify('HTTP 502: Bad Gateway');
  assert.equal(down.status, 2);
  assert.match(down.stderr, /after 4 attempts: HTTP 502/);
  assert.equal(f.calls().split('\n').filter((l) => l.startsWith('attestation verify')).length, 1 + 1 + 1 + 3 + 2 + 4);

  // An error that is no verdict is not read as one either
  const odd = verify('Error: something unexpected');
  assert.equal(odd.status, 2);
  assert.match(odd.stderr, /could not check the provenance/);
});

test('only an image pinned by digest is checked', (t) => {
  const f = fixture(t);
  const r = spawnSync('bash', [script, 'newest', `${IMAGE}:positron-x`], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: REPO, GITHUB_SHA: 'x' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not an image pinned by digest/);
  assert.equal(f.calls(), '');
});
