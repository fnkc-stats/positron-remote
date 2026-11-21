// Running the fix of a failed check (doctor.ts) for someone who rarely opens a terminal: what will happen before it
// runs, and afterwards, in plain words, why it did not work and what to do instead. No vscode here, so it is tested
// directly; extension.ts shows it.
import type { Check } from './doctor.ts';

export const RUN = 'Run It for Me';
export const RUN_ADMIN = 'Open PowerShell as Administrator';
export const COPY = 'Copy Command';
export const COPY_ADMIN = 'Copy for the Administrator';

/** What happens when the command runs, step by step: shown before it runs. */
export function fixSteps(c: Check, platform: NodeJS.Platform): string {
  const steps: string[] = [];
  if (platform === 'win32' && c.admin) {
    steps.push(`"${RUN_ADMIN}" opens a separate PowerShell window that runs the command.`,
      'Windows asks whether to allow it to make changes: choose Yes.',
      'If Windows asks for an administrator\'s password you do not have, your account may not install software: ask your IT admin.');
  } else {
    steps.push(`"${RUN}" runs the command in the terminal at the bottom of Positron.`);
    if (c.admin) {
      steps.push('It asks for your password: type the one you log in to this computer with (nothing shows while you type) and press Enter.',
        'If it says you are not allowed (for example "not in the sudoers file"), your account may not install software: ask your IT admin.');
    }
    if (platform === 'win32' && /^winget\s/.test(c.command ?? '')) steps.push('An installer may ask to make changes: choose Yes.');
  }
  steps.push('Check Setup runs again afterwards and says whether it worked.');
  steps.push(`Rather do it by hand? ${c.manual ?? ''}`.trim());
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/** Where to paste a copied command. */
export function pasteHelp(c: Check, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return c.admin
      ? 'Open the Start menu, type PowerShell, right-click Windows PowerShell and choose "Run as administrator"; paste with Ctrl+V and press Enter.'
      : 'Open the Start menu, type PowerShell and open it; paste with Ctrl+V and press Enter.';
  }
  const open = platform === 'darwin' ? 'Open Terminal (Applications -> Utilities -> Terminal)' : 'Open a terminal';
  return `${open}, paste with ${platform === 'darwin' ? 'Cmd+V' : 'Ctrl+Shift+V'} and press Enter.${c.admin ? ' When it asks for your password, type your login password (nothing shows) and press Enter.' : ''}`;
}

export interface FixOutcome {
  /** What went wrong, in plain words. */
  problem: string;
  /** What to do now. */
  next: string;
}

const strip = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\r/g, '');

/**
 * Why the command of `c` did not fix it, from its exit code and what it printed; `stillFailing` is the check after the
 * command (undefined: it was not run again). Recognizes the failures a user can do something about.
 */
export function explainFailure(c: Check, exitCode: number | undefined, output: string, stillFailing?: Check): FixOutcome {
  const text = strip(output);
  const manual = c.manual ? ` Or do it by hand: ${c.manual}.` : '';
  const rules: [RegExp, FixOutcome][] = [
    [/canceled by the user|cancelled by the user|operation was canceled/i,
      { problem: 'You chose No when Windows asked for permission, so nothing was changed.', next: 'Run it again and choose Yes, or ask your IT admin.' }],
    [/incorrect password attempt|sorry, try again/i,
      { problem: 'The password was not accepted.', next: 'Run it again with the password you log in to this computer with. If you do not know it, ask your IT admin.' }],
    [/not in the sudoers|is not allowed to (run|execute)|may not run sudo|requires? (elevation|administrator)|administrator privileges|access is denied|run as administrator/i,
      { problem: 'Your account is not allowed to install software or change system settings on this computer.', next: `Ask your IT admin to do it for you ("${COPY_ADMIN}" gives them the command and this message).${manual}` }],
    [/permission denied \(publickey/i,
      { problem: 'The connection worked, but your SSH key is not accepted yet.', next: 'Add your public key (the .pub file) in Gitea, or send it to the admin, then run Check Setup again.' }],
    [/could not get lock|dpkg was interrupted|another process|is locked by another/i,
      { problem: 'Another installation is running on this computer right now.', next: 'Wait until it finishes (or restart the computer), then run it again.' }],
    [/no space left on device|not enough (disk )?space/i,
      { problem: 'The disk of this computer is full.', next: 'Free some space (empty the Trash, remove large files), then run it again.' }],
    [/could not resolve|temporary failure (in name resolution|resolving)|failed to connect|network is unreachable|unable to connect|could not connect|connection (timed out|refused)|no internet/i,
      { problem: 'It could not reach the internet (or the server).', next: 'Check the connection (VPN?), then run it again.' }],
    [/(permission denied|operation not permitted|EACCES)/i,
      { problem: 'The command was not allowed to change a file it needed.', next: `Ask your IT admin to do it for you ("${COPY_ADMIN}" gives them the command and this message).${manual}` }],
  ];
  // zsh: "command not found: brew"; bash: "bash: brew: command not found"; PowerShell: "The term 'winget' is not recognized"
  const notFound = /command not found:\s*(\S+)/i.exec(text) ?? /(\S+): command not found/i.exec(text)
    ?? /The term '([^']+)' is not recognized/i.exec(text);
  for (const [re, outcome] of rules) if (re.test(text)) return outcome;
  if (notFound) {
    const tool = notFound[1];
    return {
      problem: `A program the command needs is not installed: ${tool}.`,
      next: tool === 'brew' ? 'Install Homebrew first (see the Homebrew line in Check Setup), restart Positron, then run it again.' + manual
        : `Restart Positron and run it again; if it still says this, ask your IT admin.${manual}`,
    };
  }
  if (exitCode === 0 || exitCode === undefined) {
    return {
      problem: `The command finished, but ${c.name} is still not ready${stillFailing ? ` (${stillFailing.detail})` : ''}.`,
      next: `If an installer window opened, finish it first. Then restart Positron and run Check Setup again.${manual}`,
    };
  }
  return {
    problem: `The command stopped with an error (exit code ${exitCode}).`,
    next: `Look at the last lines in the terminal, or ask your IT admin ("${COPY_ADMIN}" gives them the command and what it printed).${manual}`,
  };
}

/** Everything an admin needs to help: which check, what was found, the command, and the end of its output. */
export function adminReport(c: Check, platform: NodeJS.Platform, output = ''): string {
  const tail = strip(output).trim().split('\n').slice(-30).join('\n');
  return [
    `FNKC Projects, Check Setup on ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'}: "${c.name}" is not ready`,
    `Found: ${c.detail}`,
    c.fix && `Suggested fix: ${c.fix}`,
    c.command && `Command${c.admin ? ' (needs administrator rights)' : ''}: ${c.command}`,
    tail && `What it printed:\n${tail}`,
  ].filter(Boolean).join('\n');
}

/**
 * powershell.exe arguments that run `command` in an elevated window (Windows asks for permission) and wait for it:
 * the exit code is the command's; on an error the window stays open (unless !pause) and the error goes to `errorFile` too.
 */
export function elevatedPowerShell(command: string, errorFile: string, pause = true): string[] {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const inner = [
    "$ErrorActionPreference = 'Stop'",
    `try { ${command}; if ($LASTEXITCODE) { throw "exit code $LASTEXITCODE" } }`,
    `catch { $_ | Out-String | Set-Content -LiteralPath ${q(errorFile)}; Write-Host $_ -ForegroundColor Red; ${pause ? "Read-Host 'It did not work. Press Enter to close this window'; " : ''}exit 1 }`,
  ].join('\n');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
  return ['-NoProfile', '-NonInteractive', '-Command', outer];
}
