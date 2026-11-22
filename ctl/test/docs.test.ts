// Every command, setting, configuration key, flag, script and workflow is described in the Markdown documentation
// (docs/reference.md lists them all). Fails when something is added without documentation. New files count, as in lint.sh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = (...patterns: string[]) => execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', ...patterns], { encoding: 'utf8' }).split('\n').filter(Boolean);
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const docs = tracked('*.md').map(read).join('\n');
const undocumented = (items: string[]) => [...new Set(items)].filter((i) => !docs.includes(i)).sort();

test('every extension command and setting is documented', () => {
  const pkg = JSON.parse(read('ctl/package.json')) as {
    contributes: { commands: { title: string }[]; configuration: { properties: Record<string, unknown> } };
  };
  assert.deepEqual(undocumented(pkg.contributes.commands.map((c) => c.title)), []);
  assert.deepEqual(undocumented(Object.keys(pkg.contributes.configuration.properties).map((k) => `\`${k.split('.').slice(1).join('.')}\``)), []);
});

test('every agent.json and config.json key is documented', () => {
  const keys = (file: string) => [...read(file).matchAll(/(?:file\.|str\('|list\(')([a-zA-Z]+)/g)].map((m) => `\`${m[1]}\``);
  assert.deepEqual(undocumented(keys('ctl/src/agent-config.ts')), []);
  assert.deepEqual(undocumented(keys('ctl/src/client/config.ts')), []);
});

test('every fnkc-ctl flag and command is documented', () => {
  const cli = read('ctl/src/cli.ts');
  assert.deepEqual(undocumented([...cli.matchAll(/^\s+'?([a-z][a-z-]+)'?: \{ type:/gm)].map((m) => `--${m[1]}`)), []);
  assert.deepEqual(undocumented([...cli.matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1])), []);
});

test('every command inside the container is documented', () => {
  const script = read('ctl/container/fnkc-projects.sh');
  assert.deepEqual(undocumented([...script.matchAll(/^ {2}([a-z]+)\)/gm)].map((m) => `fnkc-projects ${m[1]}`)), []);
});

test('every script and workflow is documented', () => {
  const scripts = tracked('*.sh', '*.py', '*.ps1').filter((f) => !f.startsWith('ctl/test/') && !f.startsWith('checks/tasks/'));
  assert.deepEqual(undocumented(scripts.map((f) => f.split('/').pop()!)), []);
  assert.deepEqual(undocumented(tracked('.github/workflows/*.yml').map((f) => f.split('/').pop()!)), []);
});

// The restore volume belongs to the analyst: the inspection command in docs/operations.md must not let its .git/config
// run programs (core.fsmonitor, hooks, gpg.program) or its file and author names reach the operator's terminal raw.
// restore-inspection-integration.py runs the same block against such a volume.
test('the restore inspection command does not trust the volume', () => {
  const block = read('docs/operations.md').match(/```bash\n((?:(?!```)[\s\S])*target=\/restore,readonly(?:(?!```)[\s\S])*)```/)?.[1];
  assert.ok(block, 'inspection block in docs/operations.md');
  assert.match(block, /ls -lab \/restore/);
  assert.doesNotMatch(block.replace(/ls -lab \/restore/, ''), /\bls\b/, 'every ls escapes names');
  const guarded = 'git -c safe.directory=/restore -c core.fsmonitor= -c core.hooksPath=/dev/null -c log.showSignature=false -C /restore';
  assert.equal(block.split(/\bgit /).length - 1, 1, 'git runs only through the guarded function');
  assert.ok(block.includes(guarded), guarded);
  assert.match(block, /' 2>&1 \| cat -v\n\s*$/, 'all output through cat -v');
});
