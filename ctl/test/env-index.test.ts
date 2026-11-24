// How image.yml joins the two architecture images of a new environment (.github/scripts/env-index.sh), run here with a
// fake docker: the index is made from the digests the build jobs recorded, so legs from different run attempts (a
// re-run of only the failed leg, or of only the manifest job) still publish, and nothing is looked up by tag.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const script = join(root, '.github', 'scripts', 'env-index.sh');
const IMAGE = 'ghcr.io/fnkc-stats/r-env';
const AMD64 = `sha256:${'a'.repeat(64)}`;
const ARM64 = `sha256:${'b'.repeat(64)}`;
const INDEX = `sha256:${'c'.repeat(64)}`;
const SHA = 'f'.repeat(40);
// Run 7: amd64 passed in attempt 1, arm64 failed and passed when only it was re-run (attempt 2); the manifest job runs
// in attempt 2 (or 3, if only it is re-run). The tags the legs pushed differ in their attempt.
const TAG = `4.5-env-${SHA}-7-2`;

// Records every call in $FAKE/calls. imagetools create keeps the source digests as the index ($FAKE/index; with
// $FAKE/extra, the registry adds a foreign image), inspect answers from it.
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE/calls"
[ "$1 $2" = "buildx imagetools" ] || { echo "unexpected docker call: $*" >&2; exit 2; }
case "$3" in
  create)
    shift 3; digests=""
    while [ $# -gt 0 ]; do
      case "$1" in -t|--annotation) shift 2 ;; *@sha256:*) digests="$digests \${1#*@}"; shift ;; *) echo "not a digest: $1" >&2; exit 2 ;; esac
    done
    [ -f "$FAKE/extra" ] && digests="$digests sha256:${'d'.repeat(64)}"
    printf '%s\\n' $digests > "$FAKE/index" ;;
  inspect)
    case "$4 $5" in
      "${IMAGE}:${TAG} --format") echo '{"digest":"${INDEX}"}' ;;
      "${IMAGE}@${INDEX} --raw")
        printf '{"manifests":['; sep=""
        while read -r d; do printf '%s{"digest":"%s","platform":{"os":"linux","architecture":"x"}}' "$sep" "$d"; sep=,; done < "$FAKE/index"
        printf ',{"digest":"sha256:${'e'.repeat(64)}","platform":{"os":"unknown","architecture":"unknown"}}]}\\n' ;;
      *) echo "unexpected inspect: $*" >&2; exit 2 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 2 ;;
esac
`;

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'env-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fake'), bin = join(dir, 'bin'), digests = join(dir, 'digests');
  for (const d of [fake, bin, digests]) mkdirSync(d);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = () => spawnSync('bash', [script, IMAGE, TAG, digests, 'r-env 4.5 environment'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake },
  });
  const calls = () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8') : '');
  return { fake, digests, run, calls };
}

test('joins the tested digests of legs from different attempts, never looking up architecture tags', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.digests, 'amd64'), `${IMAGE}@${AMD64}\n`); // attempt 1
  writeFileSync(join(f.digests, 'arm64'), `${IMAGE}@${ARM64}\n`); // attempt 2
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${IMAGE}@${INDEX}`);
  const create = f.calls().split('\n').find((l) => l.includes('imagetools create'));
  assert.ok(create?.includes(`-t ${IMAGE}:${TAG} `), create);
  assert.ok(create?.endsWith(`${IMAGE}@${AMD64} ${IMAGE}@${ARM64}`), create);
  assert.doesNotMatch(f.calls(), /-(amd64|arm64)\b/);
});

test('refuses to publish without both tested images', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.digests, 'amd64'), `${IMAGE}@${AMD64}\n`);
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no tested arm64 image/);
  assert.equal(f.calls(), '');
});

test('refuses a recorded image that is not this repository pinned by digest', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.digests, 'amd64'), `${IMAGE}@${AMD64}\n`);
  for (const bad of [`${IMAGE}:${TAG}-arm64`, `ghcr.io/someone/r-env@${ARM64}`]) {
    writeFileSync(join(f.digests, 'arm64'), `${bad}\n`);
    const r = f.run();
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /unexpected arm64 image/);
  }
  assert.equal(f.calls(), '');
});

test('fails when the published index holds anything but the tested images', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.digests, 'amd64'), `${IMAGE}@${AMD64}\n`);
  writeFileSync(join(f.digests, 'arm64'), `${IMAGE}@${ARM64}\n`);
  writeFileSync(join(f.fake, 'extra'), '');
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not hold exactly the tested images/);
});
