// The npm scripts the Windows job runs (extension.yml) go through cmd.exe, which has no single quotes: a quoted
// argument with spaces splits into several (esbuild then sees extra input files). Caught here, before CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ctl = join(__dirname, '..', '..');
const scripts = (JSON.parse(readFileSync(join(ctl, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

/** The scripts a command runs, following "npm run <name>" inside them. */
function closure(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name) || !scripts[name]) return [];
  seen.add(name);
  return [name, ...[...scripts[name].matchAll(/npm run (?:-s )?([\w:-]+)/g)].flatMap((m) => closure(m[1], seen))];
}

test('scripts that run on Windows use no single quotes (cmd.exe)', () => {
  const workflow = readFileSync(join(ctl, '..', '.github', 'workflows', 'extension.yml'), 'utf8');
  const windows = /^  windows:\n([\s\S]*?)(?=^  \S)/m.exec(workflow)![1];
  const used = [...windows.matchAll(/npm --prefix ctl run ([\w:-]+)/g)].flatMap((m) => closure(m[1]));
  assert.ok(used.includes('build:cli'), 'the Windows job builds the CLI');
  assert.deepEqual(used.filter((s) => scripts[s].includes("'")), []);
});
