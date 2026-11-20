// "Check Setup": everything this computer needs, each problem with a concrete fix. Checks only look:
// they never start Docker or change anything.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { run } from '../exec.ts';
import type { Logger } from '../log.ts';
import type { ClientConfig } from './config.ts';
import { detectEngine, Engine } from './engine.ts';
import { localPositron } from './positron.ts';
import { gitSshTarget, INCLUDE_MARKER, sshIncludePresent } from './ssh.ts';
import { transportFor } from './transport.ts';

export interface Check {
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** What to do about it (when not ok). */
  fix?: string;
  /** A command to copy and run, if the fix is one. */
  command?: string;
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function tryRun(cmd: string, args: string[], timeoutMs = 15_000) {
  try {
    return await run(cmd, args, { timeoutMs });
  } catch {
    return undefined; // the command does not exist
  }
}

function checkPositron(appRoot?: string): Check {
  try {
    const p = localPositron(appRoot);
    return { name: 'Positron', ok: true, detail: `version ${p.version}` };
  } catch (e) {
    return { name: 'Positron', ok: false, detail: (e as Error).message, fix: 'Install Positron from positron.posit.co' };
  }
}

async function checkGit(): Promise<Check> {
  const r = await tryRun('git', ['--version']);
  if (r?.code === 0) return { name: 'git', ok: true, detail: r.stdout.trim() };
  return {
    name: 'git', ok: false, detail: 'the git command was not found',
    fix: isWin ? 'Install Git for Windows (git-scm.com/download/win)' : isMac ? 'Run: xcode-select --install' : 'Install git with your package manager',
    command: isMac ? 'xcode-select --install' : undefined,
  };
}

function checkKey(cfg: ClientConfig): Check {
  if (cfg.sshKey && existsSync(`${cfg.sshKey}.pub`)) return { name: 'SSH key', ok: true, detail: cfg.sshKey };
  return {
    name: 'SSH key', ok: false, detail: 'no SSH key in ~/.ssh (id_ed25519, id_ecdsa or id_rsa)',
    fix: 'Create one (press Enter at the questions), then add the .pub file to Gitea: Settings -> SSH / GPG Keys',
    command: 'ssh-keygen -t ed25519',
  };
}

/** git inside the container reaches Gitea with the keys of this computer's ssh-agent. */
async function checkAgent(cfg: ClientConfig): Promise<Check> {
  const r = await tryRun('ssh-add', ['-l']);
  if (r?.code === 0) {
    const n = r.stdout.trim().split('\n').length;
    return { name: 'ssh-agent', ok: true, detail: `${n} key${n > 1 ? 's' : ''} loaded` };
  }
  const key = cfg.sshKey ?? '~/.ssh/id_ed25519';
  if (isWin && (!r || /connect|agent/i.test(r.stderr))) {
    return {
      name: 'ssh-agent', ok: false, detail: 'the OpenSSH Authentication Agent service is not running',
      fix: 'In PowerShell as administrator, then add your key with ssh-add',
      command: 'Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent',
    };
  }
  return {
    name: 'ssh-agent', ok: false, detail: r ? 'no keys in the agent' : 'ssh-add was not found',
    fix: 'Add your key to the agent, otherwise git in the container cannot reach Gitea',
    command: isMac ? `ssh-add --apple-use-keychain ${key}` : `ssh-add ${key}`,
  };
}

/** Gitea answers "Hi there, <name>! You've successfully authenticated..." to ssh -T. */
async function checkGitea(cfg: ClientConfig): Promise<Check[]> {
  const out: Check[] = [];
  for (const remote of cfg.gitRemotes) {
    const t = gitSshTarget(remote);
    if (!t) continue;
    const r = await tryRun('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
      ...(t.port ? ['-p', t.port] : []), t.dest], 20_000);
    const text = `${r?.stdout ?? ''}${r?.stderr ?? ''}`;
    const name = `Gitea (${t.dest.split('@').pop()})`;
    if (/successfully authenticated/i.test(text)) out.push({ name, ok: true, detail: 'your key is accepted' });
    else if (/permission denied/i.test(text)) {
      out.push({ name, ok: false, detail: 'your key is not accepted', fix: 'Add your public key (.pub) in Gitea: Settings -> SSH / GPG Keys' });
    } else {
      out.push({ name, ok: false, detail: text.trim().split('\n').pop() || 'no answer', fix: 'Check the network (VPN?) and the address in gitRemotes' });
    }
  }
  if (!cfg.gitRemotes.length) {
    out.push({ name: 'Gitea', ok: false, detail: 'gitRemotes is not set', fix: 'Set FNKC Projects -> Git Remotes, e.g. ssh://git@gitea.example.lan:2221/stats' });
  }
  return out;
}

/** The pinentry gpg-agent uses: pinentry-program in gpg-agent.conf, otherwise GnuPG's default one. */
export function pinentryProgram(agentConf: string | undefined, components: string): string | undefined {
  const set = agentConf?.split(/\r?\n/).map((l) => /^\s*pinentry-program\s+(.+?)\s*$/.exec(l)?.[1]).filter(Boolean).pop();
  return set ?? components.split(/\r?\n/).find((l) => l.startsWith('pinentry:'))?.split(':')[2];
}

/** A pinentry that opens a window: the one that works when Positron, not a terminal, runs gpg. */
export function graphicalPinentry(program: string): boolean {
  return /pinentry-(mac|qt\d?|gtk-?\d?|gnome\d?|w32|wsl-ps1)|pinentry(-basic)?\.exe$|pinentry-mac\.app/i.test(program);
}

/** Decrypting project data (see decrypt.ts): GnuPG with a personal key and a passphrase window, or a key file. */
async function checkGpg(cfg: ClientConfig): Promise<Check[]> {
  if (cfg.gitCryptKey) {
    return existsSync(cfg.gitCryptKey)
      ? [{ name: 'Data key', ok: true, detail: `git-crypt key file ${cfg.gitCryptKey}` }]
      : [{ name: 'Data key', ok: false, detail: `gitCryptKey ${cfg.gitCryptKey} is not found`, fix: 'Fix the path in FNKC Projects -> Git Crypt Key, or clear it to use your GPG key' }];
  }
  const keys = await tryRun('gpg', ['--list-secret-keys', '--with-colons']);
  if (!keys) {
    return [{
      name: 'GnuPG', ok: false, detail: 'gpg was not found (needed to decrypt project data)',
      fix: isWin ? 'Install Gpg4win (gpg4win.org), then restart Positron' : isMac ? 'Install GnuPG with a passphrase window, then restart Positron'
        : 'Install gnupg and a graphical pinentry (pinentry-gnome3 or pinentry-qt)',
      command: isWin ? 'winget install GnuPG.Gpg4win' : isMac ? 'brew install gnupg pinentry-mac' : undefined,
    }];
  }
  const out: Check[] = [];
  const n = keys.stdout.split('\n').filter((l) => l.startsWith('sec:')).length;
  out.push(n
    ? { name: 'GPG key', ok: true, detail: `${n} personal key${n > 1 ? 's' : ''}` }
    : { name: 'GPG key', ok: false, detail: 'no personal GPG key on this computer (needed to decrypt project data)',
      fix: 'Create one, then give its public key (gpg --armor --export <your email>) to a team member: they add you to the projects (git-crypt add-gpg-user)',
      command: 'gpg --full-generate-key' });
  if (isWin) return out; // Gpg4win's pinentry is a window
  const [components, home] = await Promise.all([tryRun('gpgconf', ['--list-components']), tryRun('gpgconf', ['--list-dirs', 'homedir'])]);
  const conf = home?.code === 0 ? join(home.stdout.trim(), 'gpg-agent.conf') : undefined;
  let program = pinentryProgram(conf && existsSync(conf) ? readFileSync(conf, 'utf8') : undefined, components?.stdout ?? '');
  try { if (program) program = realpathSync(program); } catch { /* shown as configured */ }
  if (program && graphicalPinentry(program)) {
    out.push({ name: 'GPG passphrase window', ok: true, detail: basename(program) });
  } else {
    out.push({
      name: 'GPG passphrase window', ok: false,
      detail: program ? `${basename(program)} asks in a terminal: Positron cannot show it, so a key with a passphrase cannot decrypt data`
        : 'no pinentry found',
      fix: isMac ? 'Use pinentry-mac (it can also keep the passphrase in the keychain); the command installs it and sets it for gpg-agent'
        : 'Install pinentry-gnome3 or pinentry-qt and set it as pinentry-program in gpg-agent.conf',
      command: isMac ? `brew install pinentry-mac && echo "pinentry-program $(brew --prefix)/bin/pinentry-mac" >> ${conf ?? '~/.gnupg/gpg-agent.conf'} && gpgconf --kill gpg-agent` : undefined,
    });
  }
  return out;
}

async function checkHosts(cfg: ClientConfig, log: Logger): Promise<Check[]> {
  const out: Check[] = [];
  for (const h of cfg.hosts) {
    if (!h.ssh) {
      out.push(await checkLocalDocker(cfg));
      continue;
    }
    try {
      const p = await transportFor(h, cfg, log).ping();
      out.push({ name: `Server '${h.name}'`, ok: true, detail: `${h.ssh}: you are '${p.user}', fnkc-ctl ${p.version}` });
    } catch (e) {
      const msg = (e as Error).message;
      out.push({
        name: `Server '${h.name}'`, ok: false, detail: msg,
        fix: /permission denied/i.test(msg)
          ? 'The server does not know your key yet: send your .pub file to its admin (fnkc-ctl admin add-user)'
          : 'Check the network (VPN?) and the address in FNKC Projects -> Hosts',
      });
    }
  }
  return out;
}

/** Is Docker installed here? Does not start it: it starts by itself when a project runs here. */
async function checkLocalDocker(cfg: ClientConfig): Promise<Check> {
  const kind = await detectEngine(cfg.engine);
  const engine = new Engine(kind, cfg.engine, cfg.cacheDir);
  const name = 'Docker on this computer';
  try {
    await engine.docker.check();
    return { name, ok: true, detail: `${engine.label}, running` };
  } catch {
    // not running is fine; not installed is not
  }
  if (kind === 'wsl') return { name, ok: true, detail: `${engine.label}, starts when a project runs here` };
  if (kind === 'colima') {
    const docker = await tryRun('docker', ['--version']);
    return docker?.code === 0
      ? { name, ok: true, detail: 'Colima, starts when a project runs here' }
      : { name, ok: false, detail: 'Colima is installed but the docker command is not', command: 'brew install docker' };
  }
  if (kind === 'docker-desktop') {
    const installed = isMac ? existsSync('/Applications/Docker.app')
      : existsSync(`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Docker\\Docker\\Docker Desktop.exe`);
    if (installed) return { name, ok: true, detail: 'Docker Desktop, starts when a project runs here' };
    return {
      name, ok: false, detail: 'no Docker found',
      fix: isWin ? 'Run "FNKC Projects: Set Up Docker on This Computer" (Docker in WSL, no Docker Desktop needed)'
        : 'Install Colima and the docker command (only needed to run projects on this computer)',
      command: isMac ? 'brew install colima docker' : undefined,
    };
  }
  return { name, ok: false, detail: 'Docker is not running', fix: 'Start the docker service: sudo systemctl start docker' };
}

/** The Include line in ~/.ssh/config. Not there yet is fine: the first Open asks to add it. */
function checkSshConfig(cfg: ClientConfig): Check {
  const name = 'SSH configuration';
  if (!sshIncludePresent(cfg.sshDir)) {
    return { name, ok: true, detail: '~/.ssh/config does not include project connections yet: the next Open asks to add one line' };
  }
  let n = 0;
  try { n = readdirSync(join(cfg.sshDir, 'fnkc')).filter((f) => f.endsWith('.conf')).length; } catch { /* none yet */ }
  const marked = readFileSync(join(cfg.sshDir, 'config'), 'utf8').includes(INCLUDE_MARKER);
  return { name, ok: true, detail: `~/.ssh/config includes ~/.ssh/fnkc (${n} project connection${n === 1 ? '' : 's'})` +
    `${marked ? '' : '; the line gets its explanatory comment on the next Open'}. To remove: FNKC: Remove SSH Configuration` };
}

export async function runChecks(cfg: ClientConfig, log: Logger, appRoot?: string): Promise<Check[]> {
  const [git, agent, gitea, hosts, gpg] = await Promise.all([checkGit(), checkAgent(cfg), checkGitea(cfg), checkHosts(cfg, log), checkGpg(cfg)]);
  const lockRuntime = await tryRun(isWin ? 'powershell.exe' : 'python3', isWin
    ? ['-NoProfile', '-Command', '[Threading.Mutex]::new($false).Dispose()'] : ['-c', 'import fcntl']);
  const locks: Check = { name: 'Lock runtime', ok: lockRuntime?.code === 0,
    detail: isWin ? 'PowerShell named mutexes' : 'Python 3 fcntl locks',
    ...(lockRuntime?.code === 0 ? {} : { fix: isWin ? 'Enable Windows PowerShell' : 'Install Python 3 for crash-safe locks' }) };
  return [checkPositron(appRoot), locks, git, checkKey(cfg), agent, checkSshConfig(cfg), ...gitea, ...hosts, ...gpg];
}
