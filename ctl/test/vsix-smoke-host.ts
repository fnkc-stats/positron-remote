// Runs inside the editor started by vsix-smoke.ts: the extension there must be the installed VSIX (not this
// checkout), activate without throwing, register every command it contributes, and run Show Log.
import assert from 'node:assert/strict';
import { relative, isAbsolute } from 'node:path';
import * as vscode from 'vscode';

export async function run() {
  const id = process.env.FNKC_SMOKE_ID!;
  const ext = vscode.extensions.getExtension(id);
  assert.ok(ext, `${id} is not installed`);
  const inside = relative(process.env.FNKC_SMOKE_EXTENSIONS!, ext.extensionPath);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), `${id} was loaded from ${ext.extensionPath}, not from the installed VSIX`);
  const pkg = ext.packageJSON as { version: string; contributes: { commands: { command: string }[] } };
  assert.equal(pkg.version, process.env.FNKC_SMOKE_VERSION, 'the installed VSIX is not the one just packaged');

  await ext.activate();
  assert.ok(ext.isActive, `${id} did not activate`);
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], 'contributed commands that activation did not register');
  await vscode.commands.executeCommand('fnkcProjects.showLog');
  console.log(`vsix smoke: ${id} ${pkg.version} active, ${pkg.contributes.commands.length} commands registered, Show Log ran`);
}
