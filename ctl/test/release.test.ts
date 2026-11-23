// The release step of extension.yml (.github/scripts/publish-release.sh), run here with a fake gh and throwaway git
// repositories, so its decisions are tested before CI: what is published, when it is not, retries, "latest".
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const script = join(root, '.github', 'scripts', 'publish-release.sh');
const RELEASE_FILES = ['fnkc-projects.vsix', 'fnkc-projects.vsix.sha256', 'fnkc-ctl-server.tar.gz', 'fnkc-ctl-server.tar.gz.sha256', 'fnkc-projects-compat.json'];

// Release state in $FAKE: released-<tag> lists its file names, assets-<tag>/ holds their contents, draft-<tag> marks a
// draft. Knobs: fails (create refusals), edit-fails (publish refusals), corrupt (a file name stored with other bytes).
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE/calls"
store() { # tag file
  mkdir -p "$FAKE/assets-$1"
  if [ "$(cat "$FAKE/corrupt" 2>/dev/null)" = "$2" ]; then echo corrupted > "$FAKE/assets-$1/$2"; else cp "$2" "$FAKE/assets-$1/$2"; fi
  grep -qxF "$2" "$FAKE/released-$1" 2>/dev/null || echo "$2" >> "$FAKE/released-$1"
}
case "$1 $2" in
  "release view")
    if [ "$3" = "--json" ]; then cat "$FAKE/latest" 2>/dev/null; exit $?; fi
    [ -f "$FAKE/released-$3" ] || exit 1
    case "$5" in
      isDraft) if [ -f "$FAKE/draft-$3" ]; then echo true; else echo false; fi ;;
      assets) cat "$FAKE/released-$3" ;;
    esac ;;
  "release create")
    n=$(cat "$FAKE/fails" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE/fails"; echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi
    tag=$3
    touch "$FAKE/released-$tag"
    while [ $# -gt 0 ]; do
      [ "$1" = "--notes-file" ] && cp "$2" "$FAKE/notes"; [ "$1" = "--draft" ] && touch "$FAKE/draft-$tag"
      case "$1" in fnkc-*.*) [ -f "$1" ] && store "$tag" "$1";; esac; shift
    done
    touch "$FAKE/released-created" ;;
  "release upload")
    tag=$3; shift 3
    for f in "$@"; do case "$f" in --*) ;; *) [ -f "$f" ] || { echo "no such file: $f" >&2; exit 1; }; store "$tag" "$f";; esac; done ;;
  "release edit")
    n=$(cat "$FAKE/edit-fails" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE/edit-fails"; echo "HTTP 502" >&2; exit 1; fi
    [ -f "$FAKE/released-$3" ] || exit 1
    case "$*" in *--draft=false*) rm -f "$FAKE/draft-$3";; esac ;;
  "release delete")
    [ -f "$FAKE/released-$3" ] || exit 1
    rm -rf "$FAKE/released-$3" "$FAKE/draft-$3" "$FAKE/assets-$3" ;;
  "release download")
    tag=$3
    while [ $# -gt 0 ]; do [ "$1" = "-D" ] && d="$2"; shift; done
    if [ -d "$FAKE/assets-$tag" ]; then cp "$FAKE/assets-$tag/"* "$d/"; exit 0; fi
    [ -f "$FAKE/previous-bundle.tar.gz" ] || exit 1
    cp "$FAKE/previous-bundle.tar.gz" "$d/fnkc-ctl-server.tar.gz" ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`;

/** A throwaway origin and clone with one commit under ctl/, a fake gh on PATH, and the release files. */
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[k];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'clone', '-q', join(dir, 'origin.git'), 'work');
  const work = join(dir, 'work');
  const commit = (file: string, message: string) => {
    mkdirSync(join(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), `${message}\n`);
    git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', message); git(work, 'push', '-q', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  const fake = join(dir, 'fake'); mkdirSync(fake);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH); chmodSync(join(bin, 'gh'), 0o755);
  const dist = join(dir, 'dist'); mkdirSync(dist);
  for (const f of RELEASE_FILES) writeFileSync(join(dist, f), f);
  /** The .sha256 files of the build (as extension.yml writes them) for the files in dist now. */
  const sums = () => {
    for (const f of ['fnkc-projects.vsix', 'fnkc-ctl-server.tar.gz']) {
      writeFileSync(join(dist, `${f}.sha256`), `${createHash('sha256').update(readFileSync(join(dist, f))).digest('hex')}  ${f}\n`);
    }
  };
  sums();
  const publish = (sha: string, version: string) => spawnSync('bash', [script], {
    cwd: work, encoding: 'utf8',
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, VERSION: version, GITHUB_SHA: sha, DIST: dist, RETRY_SECONDS: '0', GITHUB_STEP_SUMMARY: '' },
  });
  const calls = () => (existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8') : '');
  /** A server bundle whose program embeds `version` (as every build does), with an installer saying `install`. */
  const bundle = (file: string, version: string, install = 'install') => {
    const b = join(dir, 'bundle', 'fnkc-ctl-server');
    rmSync(join(dir, 'bundle'), { recursive: true, force: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'fnkc-ctl.cjs'), `var info = { name: "fnkc-projects", version: "${version}" };\n`);
    writeFileSync(join(b, 'install.sh'), `${install}\n`);
    execFileSync('tar', ['-czf', file, '-C', join(dir, 'bundle'), 'fnkc-ctl-server']);
  };
  const has = (name: string) => existsSync(join(fake, name));
  return { commit, publish, calls, fake, git, work, bundle, dist, sums, has };
}

test('the newest commit is released as latest, with its fnkc-ctl changes in the notes', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'Add a feature');
  const r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 0, r.stderr);
  // Created as a draft with all files, checked, and only then published (and marked latest)
  assert.match(f.calls(), new RegExp(`release create fnkc-projects-v0\\.4\\.40 --draft --target ${sha} `));
  assert.match(f.calls(), /release create [^\n]*\nrelease view [^\n]*assets[^\n]*\nrelease download fnkc-projects-v0\.4\.40 [^\n]*\nrelease edit fnkc-projects-v0\.4\.40 --draft=false --latest=true\n/);
  assert.ok(!f.has('draft-fnkc-projects-v0.4.40'));
  assert.match(readFileSync(join(f.fake, 'notes'), 'utf8'), /First release/);
});

test('a superseded run is not released when newer commits change what a release contains', (t) => {
  const f = fixture(t);
  const older = f.commit('ctl/src/a.ts', 'One change');
  f.commit('ctl/src/b.ts', 'A newer change');
  const r = f.publish(older, '0.4.40');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Not released: main is at/);
  assert.doesNotMatch(f.calls(), /release create/);
});

test('a newer commit that does not change the extension does not hold the release back', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  f.commit('docs/notes.md', 'Docs only');
  const r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.calls(), /release create fnkc-projects-v0\.4\.40/);
});

test('an older version than the latest release is published without becoming latest', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.fake, 'latest'), 'fnkc-projects-v0.4.41\n');
  const sha = f.commit('ctl/src/a.ts', 'A change');
  assert.equal(f.publish(sha, '0.4.40').status, 0);
  assert.match(f.calls(), /--latest=false/);
  // 0.4.10 is newer than 0.4.9: versions compare by number, not as text
  writeFileSync(join(f.fake, 'latest'), 'fnkc-projects-v0.4.9\n');
  rmSync(join(f.fake, 'calls'));
  assert.equal(f.publish(sha, '0.4.10').status, 0);
  assert.match(f.calls(), /--latest=true/);
});

test('refusals are retried; three in a row fail the step', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  writeFileSync(join(f.fake, 'fails'), '2');
  assert.equal(f.publish(sha, '0.4.40').status, 0);
  assert.equal(f.calls().match(/release create/g)?.length, 3);
  writeFileSync(join(f.fake, 'fails'), '3');
  rmSync(join(f.fake, 'calls'));
  const r = f.publish(sha, '0.4.41');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /could not be published \(3 attempts\)/);
});

test('a re-run of a published version publishes nothing', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  writeFileSync(join(f.fake, 'released-fnkc-projects-v0.4.40'), RELEASE_FILES.join('\n') + '\n');
  const r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /exists already/);
  assert.doesNotMatch(f.calls(), /release (create|upload)/);
});

test('a re-run completes a release that was created without all its files', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  writeFileSync(join(f.fake, 'released-fnkc-projects-v0.4.40'), 'fnkc-projects.vsix\nfnkc-ctl-server.tar.gz\n');
  const r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /exists without fnkc-projects\.vsix\.sha256,.*fnkc-projects-compat\.json/);
  assert.match(f.calls(), /release upload fnkc-projects-v0\.4\.40 --clobber/);
  assert.doesNotMatch(f.calls(), /release create/);
});

test('a release still missing files after publishing fails the step', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  rmSync(join(f.dist, 'fnkc-projects-compat.json'));
  const r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /incomplete, missing: fnkc-projects-compat\.json/);
  assert.doesNotMatch(f.calls(), /release edit/);
  assert.ok(f.has('draft-fnkc-projects-v0.4.40'), 'stays a draft, which clients do not see');
});

test('a draft left by an earlier attempt is completed with this run\'s files and published', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  writeFileSync(join(f.fake, 'released-fnkc-projects-v0.4.40'), 'fnkc-projects.vsix\n');
  writeFileSync(join(f.fake, 'draft-fnkc-projects-v0.4.40'), '');
  const r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /is a draft left by an earlier attempt/);
  assert.match(f.calls(), /release upload fnkc-projects-v0\.4\.40 --clobber fnkc-projects\.vsix fnkc-projects\.vsix\.sha256 fnkc-ctl-server\.tar\.gz fnkc-ctl-server\.tar\.gz\.sha256 fnkc-projects-compat\.json/);
  assert.match(f.calls(), /release edit fnkc-projects-v0\.4\.40 --draft=false --latest=true/);
  assert.doesNotMatch(f.calls(), /release create/);
  assert.ok(!f.has('draft-fnkc-projects-v0.4.40'));
});

test('a draft whose files are not this run\'s, or do not match their checksums, is not published', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  writeFileSync(join(f.fake, 'corrupt'), 'fnkc-ctl-server.tar.gz');
  let r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fnkc-ctl-server\.tar\.gz differs from this run's file/);
  assert.match(r.stdout, /does not match its \.sha256/);
  assert.doesNotMatch(f.calls(), /release edit/);
  assert.ok(f.has('draft-fnkc-projects-v0.4.40'));
  // The re-run uploads the files again and publishes the draft
  rmSync(join(f.fake, 'corrupt'));
  r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!f.has('draft-fnkc-projects-v0.4.40'));
  // A build whose own checksum file is wrong is caught too, though every file was uploaded as it is
  writeFileSync(join(f.dist, 'fnkc-projects.vsix.sha256'), `${'0'.repeat(64)}  fnkc-projects.vsix\n`);
  rmSync(join(f.fake, 'calls'));
  r = f.publish(sha, '0.4.41');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not match its \.sha256/);
  assert.doesNotMatch(r.stdout, /differs/);
  assert.doesNotMatch(f.calls(), /release edit/);
});

test('a draft that could not be published stays a draft, and a re-run publishes it', (t) => {
  const f = fixture(t);
  const sha = f.commit('ctl/src/a.ts', 'A change');
  writeFileSync(join(f.fake, 'edit-fails'), '3');
  let r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /could not be published \(3 attempts\); a re-run publishes it/);
  assert.ok(f.has('draft-fnkc-projects-v0.4.40'));
  r = f.publish(sha, '0.4.40');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!f.has('draft-fnkc-projects-v0.4.40'));
});

test('a superseded run deletes its own draft instead of publishing it', (t) => {
  const f = fixture(t);
  const older = f.commit('ctl/src/a.ts', 'One change');
  f.commit('ctl/src/b.ts', 'A newer change');
  writeFileSync(join(f.fake, 'released-fnkc-projects-v0.4.40'), 'fnkc-projects.vsix\n');
  writeFileSync(join(f.fake, 'draft-fnkc-projects-v0.4.40'), '');
  const r = f.publish(older, '0.4.40');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Not released: main is at/);
  assert.match(f.calls(), /release delete fnkc-projects-v0\.4\.40 --yes/);
  assert.doesNotMatch(f.calls(), /release (create|upload|edit)/);
  assert.ok(!f.has('released-fnkc-projects-v0.4.40'));
});

test('CI selects the required gates for each changed path', (t) => {
  const f = fixture(t);
  let base = f.commit('README.md', 'Initial');
  const scope = (file: string, event = 'push') => {
    const head = f.commit(file, `${event} ${file}`);
    const output = execFileSync('bash', [join(root, '.github/scripts/ci-scope.sh')], {
      cwd: f.work, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, GITHUB_EVENT_NAME: event },
    });
    base = head;
    return output.trim().split('\n').filter((line) => line.endsWith('=true')).map((line) => line.split('=')[0]);
  };
  assert.deepEqual(scope('docs/manual.md'), []);
  assert.deepEqual(scope('ctl/src/sidebar.ts'), ['extension']);
  assert.deepEqual(scope('ctl/src/client/ssh.ts'), ['extension', 'environment']);
  assert.deepEqual(scope('checks/run.sh'), ['environment']);
  f.commit('ctl/media/logo.svg', 'UI change');
  assert.deepEqual(scope('env/Dockerfile'), ['extension', 'environment']);
  assert.deepEqual(scope('project-template/container.json'), ['pin']);
  assert.deepEqual(scope('.github/scripts/publish-release.sh'), []);
  assert.deepEqual(scope('.github/scripts/publish-release.sh', 'pull_request'), ['extension']);
});

test('the notes say whether the server bundle changed since the previous release', (t) => {
  const f = fixture(t);
  f.commit('ctl/src/a.ts', 'Before');
  f.git(f.work, 'tag', 'fnkc-projects-v0.4.39');
  writeFileSync(join(f.fake, 'latest'), 'fnkc-projects-v0.4.39\n');
  const sha = f.commit('ctl/src/client/b.ts', 'A client change');
  const notes = () => readFileSync(join(f.fake, 'notes'), 'utf8');
  const release = (install: string) => {
    for (const x of ['notes', 'released-created', 'released-fnkc-projects-v0.4.40', 'assets-fnkc-projects-v0.4.40']) rmSync(join(f.fake, x), { recursive: true, force: true });
    f.bundle(join(f.dist, 'fnkc-ctl-server.tar.gz'), '0.4.40', install);
    f.sums();
    const r = f.publish(sha, '0.4.40');
    assert.equal(r.status, 0, r.stderr);
    return notes();
  };
  // Only the embedded version differs
  f.bundle(join(f.fake, 'previous-bundle.tar.gz'), '0.4.39');
  assert.match(release('install'), /Server bundle \(fnkc-ctl-server\.tar\.gz\) changed since fnkc-projects-v0\.4\.39: no/);
  assert.match(release('install, now better'), /changed since fnkc-projects-v0\.4\.39: yes: install it on the servers/);
  rmSync(join(f.fake, 'previous-bundle.tar.gz'));
  assert.match(release('install'), /changed since fnkc-projects-v0\.4\.39: unknown/);
  assert.match(notes(), /Changes since fnkc-projects-v0\.4\.39:\n- A client change/);
});
