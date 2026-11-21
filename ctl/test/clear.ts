// What every failed check of Check Setup must give the user (client/doctor.ts, client/fix.ts): used by the unit tests
// (doctor.test.ts, stub tools) and on real computers (check-setup.acceptance.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { type Check, needsAdmin } from '../src/client/doctor.ts';
import { fixSteps, pasteHelp } from '../src/client/fix.ts';

// Words that mean nothing to someone who does not program, and signs of a message assembled from missing parts
const JARGON = /ENOENT|EACCES|spawn |errno|stack|exit code \d|undefined|null|\[object|NaN/;

/** What a failed check tells the user is clear and complete; its command parses and its admin flag is right. */
export function assertClear(c: Check, platform: NodeJS.Platform) {
  const where = `${platform} / ${c.name}`;
  assert.equal(c.ok, false, where);
  assert.ok(c.fix, `${where}: a problem without a fix`);
  assert.match(c.fix, /^[A-Z"]/, `${where}: the fix starts with a capital letter: ${c.fix}`);
  assert.ok(c.fix.length >= 15 && c.fix.length <= 260, `${where}: the fix is short and says something: ${c.fix}`);
  for (const [field, text] of Object.entries({ name: c.name, detail: c.detail, fix: c.fix, manual: c.manual ?? '' })) {
    assert.doesNotMatch(text, JARGON, `${where}: ${field} reads like an internal error: ${text}`);
  }
  if (!c.command) return;
  assert.doesNotMatch(c.command, /undefined|null|\$\{/, `${where}: ${c.command}`);
  assert.ok(c.manual && /^[A-Z]/.test(c.manual), `${where}: a command without a way to do it by hand`);
  assert.equal(c.admin, needsAdmin(c.command), `${where}: admin flag of ${c.command}`);
  if (platform !== 'win32') {
    // The command is valid shell (bash and zsh both read it the same; parsing runs nothing)
    execFileSync('/bin/bash', ['-n', '-c', c.command], { stdio: 'pipe' });
    if (/sudo/.test(c.command)) assert.ok(c.admin, `${where}: sudo without the password note`);
  } else {
    assert.doesNotMatch(c.command, /sudo|apt-get|brew /, `${where}: a Unix command on Windows: ${c.command}`);
    // On Windows itself: the command is valid PowerShell (the parser runs nothing)
    if (process.platform === 'win32') assertPowerShell(c.command, where);
  }
  const steps = fixSteps(c, platform);
  assert.ok(steps.includes(c.manual!), `${where}: the steps include the way by hand`);
  if (c.admin && platform === 'win32') assert.match(steps, /choose Yes[\s\S]*IT admin/, where);
  else if (c.admin) assert.match(steps, /password[\s\S]*nothing shows[\s\S]*not allowed[\s\S]*IT admin/, where);
  assert.match(pasteHelp(c, platform), platform === 'win32' ? /PowerShell/ : /Terminal|terminal/, where);
  if (c.admin && platform === 'win32') assert.match(pasteHelp(c, platform), /Run as administrator/, where);
}


/** `command` parses as Windows PowerShell. */
export function assertPowerShell(command: string, where = command) {
  const script = '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:FNKC_CMD, [ref]$null, [ref]$e); '
    + 'if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FNKC_CMD: command }, stdio: 'pipe' });
  } catch (e) {
    assert.fail(`${where}: not valid PowerShell: ${command}\n${(e as { stdout?: Buffer }).stdout ?? ''}`);
  }
}
