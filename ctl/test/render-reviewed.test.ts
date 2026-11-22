// The real-data renderer (server/render-reviewed.py) runs only the image ID fnkc-ctl resolved (host-image.ts), never a
// tag: the tag of an uploaded image (repository:sha256-<hex>) can be moved to any image, so a tag Docker knows is no proof.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(__dirname, '..', '..', 'server', 'render-reviewed.py');
const image = `ghcr.io/fnkc-stats/r-env@sha256:${'a'.repeat(64)}`;
const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['--version']).status === 0;

/** Calls local_image() with a stand-in fnkc-ctl (FNKC_CTL) and a `docker` on PATH that knows every name. */
function localImage(t: { after(fn: () => void): void }, ctl: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fnkc-render-reviewed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ctl.cjs'), `require('fs').writeFileSync(${JSON.stringify(join(dir, 'ctl-args'))}, JSON.stringify(process.argv.slice(2)));\n${ctl}\n`);
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho "$@" >> '${join(dir, 'docker-calls')}'\nexit 0\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  const driver = 'import importlib.util, sys\n'
    + 'spec = importlib.util.spec_from_file_location("rr", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n'
    + 'try:\n    print("OK " + m.local_image(sys.argv[2]))\nexcept ValueError as e:\n    print("REFUSED " + str(e))\n';
  const r = spawnSync(python, ['-I', '-B', '-c', driver, script, image], {
    encoding: 'utf8', env: { ...process.env, FNKC_CTL: join(dir, 'ctl.cjs'), PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  return { out: r.stdout.trim(), ctlArgs: JSON.parse(read('ctl-args') || 'null') as string[] | null, docker: read('docker-calls') };
}

test('render-reviewed runs the image ID fnkc-ctl resolved', { skip: !hasPython || process.platform === 'win32' }, (t) => {
  const id = `sha256:${'b'.repeat(64)}`;
  const r = localImage(t, `console.log(${JSON.stringify(id)});`);
  assert.equal(r.out, `OK ${id}`);
  assert.deepEqual(r.ctlArgs, ['admin', 'resolve-image', image]);
  assert.equal(r.docker, '', 'no name lookup of its own');
});

test('render-reviewed refuses an uploaded tag without a matching record, even though Docker has the tag', { skip: !hasPython || process.platform === 'win32' }, (t) => {
  for (const why of ['no record of the upload of the image on this host', 'the tag now names another image; refusing it']) {
    const r = localImage(t, `process.stderr.write('Error: ${why}\\n'); process.exit(1);`);
    assert.equal(r.out, `REFUSED approved image cannot be used: ${why}`);
    assert.equal(r.docker, '');
  }
});

test('render-reviewed refuses anything but an image ID from fnkc-ctl', { skip: !hasPython || process.platform === 'win32' }, (t) => {
  const r = localImage(t, `console.log('ghcr.io/fnkc-stats/r-env:sha256-${'a'.repeat(64)}');`);
  assert.match(r.out, /^REFUSED unexpected image ID/);
});
