// "Check Setup": everything this computer needs, each problem with a concrete fix. Checks only look:
// they never start Docker or change anything.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DockerUnavailable } from '../docker.ts';
import { run } from '../exec.ts';
import type { Logger } from '../log.ts';
import type { ClientConfig } from './config.ts';
import { detectEngine, Engine } from './engine.ts';
import { localPositron } from './positron.ts';
import { teamPositronNote } from './variant.ts';
import { gitSshTarget, INCLUDE_MARKER, parseSshTarget, sshIncludePresent, type SshTarget } from './ssh.ts';
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
  /** The fix without a terminal, or when the command fails: plain steps anyone can follow. */
  manual?: string;
  /** The command changes the system: it asks for this computer's password (sudo) or Windows' permission. */
  admin?: boolean;
}

/** When nothing else helps: someone else does it, with what they need. */
export const ASK_ADMIN = 'Ask your IT admin or a team member to do it for you: send them the command and what it printed';
const linuxManual = (what: string) => `Install ${what} with your system's software app, or ask your IT admin to install it`;
const CLT_MANUAL = 'Download the "Command Line Tools for Xcode" from developer.apple.com/download/all (sign in with an Apple ID) and open the installer';

/** sudo on macOS and Linux; cmdlets that change Windows. */
export function needsAdmin(command: string): boolean {
  return /(^|&&\s*|;\s*)sudo\s|Add-WindowsCapability|Set-Service|Start-Service|Homebrew\/install/.test(command);
}

/** What the checks run on: this computer unless a test says otherwise. */
export interface DoctorOptions {
  appRoot?: string;
  platform?: NodeJS.Platform;
  /** Contents of /etc/os-release: which package manager the Linux commands use. */
  osRelease?: string;
  /** Looks for installed apps (Docker Desktop). */
  exists?: (path: string) => boolean;
  /** The team's Positron version (variant.ts teamPositron); without it the Positron row shows only this one. */
  teamPositron?: () => Promise<string | undefined>;
}

interface Ctx {
  platform: NodeJS.Platform;
  win: boolean;
  mac: boolean;
  packager?: 'apt' | 'dnf';
  exists: (path: string) => boolean;
}

/** undefined only when the command does not exist; a command that hangs or cannot start is a failed run. */
async function tryRun(cmd: string, args: string[], timeoutMs = 15_000) {
  try {
    return await run(cmd, args, { timeoutMs });
  } catch (e) {
    const msg = (e as Error).message;
    if (/command not found|ENOENT/.test(msg)) return undefined;
    return { code: -1, stdout: '', stderr: /timed out/.test(msg) ? `${cmd} did not answer in time` : `${cmd} could not be started` };
  }
}

/** apt (Debian, Ubuntu and their family) or dnf (Fedora, RHEL); other systems get the fix without a command. */
export function linuxPackager(osRelease: string): 'apt' | 'dnf' | undefined {
  const ids = [...osRelease.matchAll(/^(?:ID|ID_LIKE)=["']?([^"'\n]*)/gm)].map((m) => m[1]).join(' ');
  if (/\b(debian|ubuntu)\b/.test(ids)) return 'apt';
  if (/\b(fedora|rhel|centos)\b/.test(ids)) return 'dnf';
  return undefined;
}

function linuxInstall(c: Ctx, pkgs: { apt?: string; dnf?: string }): string | undefined {
  if (c.packager === 'apt' && pkgs.apt) return `sudo apt-get update && sudo apt-get install -y ${pkgs.apt}`;
  if (c.packager === 'dnf' && pkgs.dnf) return `sudo dnf install -y ${pkgs.dnf}`;
  return undefined;
}

/** A path as one word of a command: for PowerShell on Windows, a POSIX shell elsewhere. */
export function quotePath(p: string, platform: NodeJS.Platform): string {
  // PowerShell: single quotes expand nothing ($, backticks) and keep a comma inside one argument
  if (platform === 'win32') return /^[\w@%+=:./\\~-]+$/.test(p) ? p : `'${p.replace(/'/g, "''")}'`;
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Another version than the team's is information, not a failure: machines can be held back for good reasons. */
async function checkPositron(appRoot: string | undefined, team: (() => Promise<string | undefined>) | undefined): Promise<Check> {
  try {
    const p = localPositron(appRoot);
    const note = teamPositronNote(p.version, await team?.().catch(() => undefined));
    return { name: 'Positron', ok: true, detail: `version ${p.version}${note ? `. ${note}` : ''}` };
  } catch (e) {
    return { name: 'Positron', ok: false, detail: (e as Error).message, fix: 'Install Positron from positron.posit.co' };
  }
}

async function checkGit(c: Ctx): Promise<Check> {
  const r = await tryRun('git', ['--version']);
  if (r?.code === 0) return { name: 'git', ok: true, detail: r.stdout.trim() };
  return {
    name: 'git', ok: false, detail: 'the git command was not found',
    fix: c.win ? 'Install Git for Windows (git-scm.com/download/win), then restart Positron'
      : c.mac ? 'Install the Command Line Tools (they include git), then restart Positron' : 'Install git, then restart Positron',
    command: c.win ? 'winget install --id Git.Git -e' : c.mac ? 'xcode-select --install' : linuxInstall(c, { apt: 'git', dnf: 'git' }),
    manual: c.win ? 'Download Git for Windows from git-scm.com/download/win and run the installer, keeping the suggested answers'
      : c.mac ? CLT_MANUAL : linuxManual('git'),
  };
}

/** ssh and ssh-add are the OpenSSH client: part of macOS, an optional feature of Windows, a package on Linux. */
function installOpenSsh(c: Ctx): Pick<Check, 'fix' | 'command' | 'manual'> {
  if (c.mac) return { fix: 'Restart Positron: ssh is part of macOS and should be found then. If it stays like this, ask your IT admin' };
  return c.win
    ? { fix: 'Add the Windows feature "OpenSSH Client" (PowerShell as administrator), then restart Positron',
      command: 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
      manual: 'Open Settings -> System -> Optional features -> View features (or Add a feature), search for "OpenSSH Client" and add it' }
    : { fix: 'Install the OpenSSH client, then restart Positron', command: linuxInstall(c, { apt: 'openssh-client', dnf: 'openssh-clients' }),
      manual: linuxManual('the OpenSSH client (openssh-client)') };
}

function checkKey(cfg: ClientConfig): Check {
  if (cfg.sshKey && existsSync(`${cfg.sshKey}.pub`)) return { name: 'SSH key', ok: true, detail: cfg.sshKey };
  return {
    name: 'SSH key', ok: false, detail: 'no SSH key in ~/.ssh (id_ed25519, id_ecdsa or id_rsa)',
    fix: 'Create one (press Enter at the questions), then add the .pub file to Gitea: Settings -> SSH / GPG Keys',
    command: 'ssh-keygen -t ed25519',
    manual: 'Ask a team member to help: it is this one command, then Enter at each question',
  };
}

/** git inside the container reaches Gitea with the keys of this computer's ssh-agent. */
async function checkAgent(cfg: ClientConfig, c: Ctx): Promise<Check> {
  const name = 'ssh-agent';
  const r = await tryRun('ssh-add', ['-l']);
  if (r?.code === 0) {
    const n = r.stdout.trim().split('\n').length;
    return { name, ok: true, detail: `${n} key${n > 1 ? 's' : ''} loaded` };
  }
  if (!r) return { name, ok: false, detail: 'ssh-add was not found', ...installOpenSsh(c) };
  if (r.code === -1) return { name, ok: false, detail: r.stderr, fix: 'Restart Positron and check again; if it stays like this, ask your IT admin' };
  // Exit code 1: an agent without keys; 2: no agent to talk to
  const noAgent = r.code !== 1 || /could not open a connection|error connecting/i.test(r.stderr);
  if (noAgent && c.win) {
    return {
      name, ok: false, detail: 'the OpenSSH Authentication Agent service is not running',
      fix: 'Start it (PowerShell as administrator), then add your key with ssh-add',
      command: 'Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent',
      manual: 'Press Win+R, type services.msc and press Enter; open "OpenSSH Authentication Agent", set Startup type to Automatic, select Start, then OK. If Windows refuses, ask your IT admin',
    };
  }
  if (noAgent) {
    return {
      name, ok: false, detail: 'no ssh-agent is running for your session',
      fix: c.mac ? 'macOS starts one at login: log out and back in, then restart Positron'
        : "Turn on your desktop's SSH agent (GNOME Keyring, or systemctl --user enable --now ssh-agent with SSH_AUTH_SOCK set in your session), then restart Positron",
    };
  }
  if (!cfg.sshKey || !existsSync(cfg.sshKey)) {
    return { name, ok: false, detail: 'no keys in the agent', fix: 'Create an SSH key first (see SSH key), then add it to the agent with ssh-add' };
  }
  const key = quotePath(cfg.sshKey, c.platform);
  return {
    name, ok: false, detail: 'no keys in the agent',
    fix: 'Add your key to the agent, otherwise git in the container cannot reach Gitea',
    command: c.mac ? `ssh-add --apple-use-keychain ${key}` : `ssh-add ${key}`,
    manual: 'Ask a team member to help you add the key to the agent: it is this one command',
  };
}

const HOST_KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED/i;
const HOST_KEY_UNKNOWN = /host key verification failed|no \S+ host key is known/i;

/** ~/.ssh/known_hosts as ssh -G prints it: with ~ or expanded to the account's home folder. */
function isDefaultKnownHosts(file: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return [`~/.ssh/known_hosts`, `${userInfo().homedir}/.ssh/known_hosts`].map(norm).includes(norm(file));
}

/**
 * The ssh-keygen -R command for the known_hosts entry ssh really checks: a Host alias in ~/.ssh/config resolves to
 * its HostName and Port, or to its HostKeyAlias (stored as is), possibly in another UserKnownHostsFile (ssh -G).
 */
async function forgetHostKey(t: SshTarget, platform: NodeJS.Platform): Promise<string> {
  const r = await tryRun('ssh', ['-G', ...(t.port ? ['-p', t.port] : []), t.dest]);
  const opt = (k: string) => r?.code === 0 ? new RegExp(`^${k} (.+)$`, 'm').exec(r.stdout)?.[1].trim() : undefined;
  const alias = opt('hostkeyalias');
  const host = opt('hostname') ?? t.dest.split('@').pop()!;
  const port = opt('port') ?? t.port;
  const file = opt('userknownhostsfile')?.split(/\s+/)[0];
  const entry = alias ?? (port && port !== '22' ? `"[${host}]:${port}"` : host);
  const custom = file && !isDefaultKnownHosts(file) ? ` -f ${quotePath(file, platform)}` : '';
  return `ssh-keygen${custom} -R ${entry}`;
}

/** An ssh failure about the host key rather than the network: what to do, or undefined. */
async function hostKeyFix(text: string, t: SshTarget, what: string, connect: string, platform: NodeJS.Platform):
  Promise<Pick<Check, 'detail' | 'fix' | 'command' | 'manual'> | undefined> {
  if (HOST_KEY_CHANGED.test(text)) {
    return {
      detail: `${what} has a different host key than this computer remembers`,
      fix: `Ask the admin whether the key of ${what} changed (otherwise someone may be in between); only then forget the old key and connect again`,
      command: await forgetHostKey(t, platform),
      manual: 'Do not connect until the admin confirms that the key changed; they can then remove the old key with you',
    };
  }
  if (HOST_KEY_UNKNOWN.test(text)) {
    return {
      detail: `this computer does not know the host key of ${what} yet`,
      fix: 'Connect once in a terminal: compare the fingerprint ssh shows with the one from the admin, then answer yes',
      command: connect,
      manual: 'Ask the admin to compare the fingerprint with you',
    };
  }
  return undefined;
}

/** Gitea answers "Hi there, <name>! You've successfully authenticated..." to ssh -T. */
async function checkGitea(cfg: ClientConfig, c: Ctx): Promise<Check[]> {
  const out: Check[] = [];
  for (const remote of cfg.gitRemotes) {
    const t = gitSshTarget(remote);
    if (!t) continue;
    const r = await tryRun('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
      ...(t.port ? ['-p', t.port] : []), t.dest], 20_000);
    const text = `${r?.stdout ?? ''}${r?.stderr ?? ''}`;
    const name = `Gitea (${t.dest.split('@').pop()})`;
    const hostKey = r && await hostKeyFix(text, t, 'Gitea', `ssh -T ${t.port ? `-p ${t.port} ` : ''}${t.dest}`, c.platform);
    if (!r) out.push({ name, ok: false, detail: 'the ssh command was not found', ...installOpenSsh(c) });
    else if (/successfully authenticated/i.test(text)) out.push({ name, ok: true, detail: 'your key is accepted' });
    else if (hostKey) out.push({ name, ok: false, ...hostKey });
    else if (/permission denied/i.test(text)) {
      out.push({ name, ok: false, detail: 'your key is not accepted', fix: 'Add your public key (.pub) in Gitea: Settings -> SSH / GPG Keys' });
    } else {
      out.push({ name, ok: false, detail: text.trim().split('\n').pop() || 'no answer', fix: 'Check the network (VPN?) and the address in gitRemotes' });
    }
  }
  // Without any configuration the Configuration row says what to do; this would only repeat it
  if (!cfg.gitRemotes.length && cfg.hosts.length) {
    out.push({ name: 'Gitea', ok: false, detail: 'gitRemotes is not set', fix: 'Set FNKC Projects -> Git Remotes, e.g. ssh://git@gitea.example.lan:2221/stats' });
  }
  return out;
}

/**
 * Shell commands that make `program` the only pinentry-program in gpg-agent.conf (other lines kept; a .bak copy of
 * the file is left) and restart gpg-agent (not after a fresh install: none runs yet, and gpgconf may not be on that
 * terminal's PATH yet). sed -i.bak works with both GNU and BSD (macOS) sed.
 */
function setPinentry(program: string, conf: string | undefined, platform: NodeJS.Platform, restart = true): string {
  const file = conf ? quotePath(conf, platform) : '~/.gnupg/gpg-agent.conf';
  const dir = conf ? quotePath(dirname(conf), platform) : '~/.gnupg';
  return `mkdir -p ${dir} && chmod 700 ${dir} && touch ${file} && sed -i.bak '/^[[:space:]]*pinentry-program/d' ${file}`
    + ` && echo "pinentry-program ${program}" >> ${file}${restart ? ' && gpgconf --kill gpg-agent' : ''}`;
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
async function checkGpg(cfg: ClientConfig, c: Ctx): Promise<Check[]> {
  if (cfg.gitCryptKey) {
    return existsSync(cfg.gitCryptKey)
      ? [{ name: 'Data key', ok: true, detail: `git-crypt key file ${cfg.gitCryptKey}` }]
      : [{ name: 'Data key', ok: false, detail: `gitCryptKey ${cfg.gitCryptKey} is not found`, fix: 'Fix the path in FNKC Projects -> Git Crypt Key, or clear it to use your GPG key' }];
  }
  const keys = await tryRun('gpg', ['--list-secret-keys', '--with-colons']);
  if (!keys) {
    return [{
      name: 'GnuPG', ok: false, detail: 'gpg was not found (needed to decrypt project data)',
      fix: c.win ? 'Install Gpg4win (gpg4win.org), then restart Positron'
        : c.mac ? 'Install GnuPG with its passphrase window (pinentry-mac), then restart Positron'
          : 'Install gnupg and a graphical pinentry (pinentry-gnome3 or pinentry-qt), then restart Positron',
      command: c.win ? 'winget install --id GnuPG.Gpg4win -e'
        : c.mac ? `brew install gnupg pinentry-mac && ${setPinentry('$(brew --prefix)/bin/pinentry-mac', undefined, c.platform, false)}`
          : linuxInstall(c, { apt: 'gnupg pinentry-gnome3', dnf: 'gnupg2 pinentry-gnome3' }),
      manual: c.win ? 'Download Gpg4win from gpg4win.org and run the installer, keeping the suggested answers'
        : c.mac ? 'Download GPG Suite from gpgtools.org and install it: it includes GnuPG and the passphrase window'
          : linuxManual('GnuPG (gnupg) and pinentry-gnome3'),
    }];
  }
  const out: Check[] = [];
  const n = keys.stdout.split('\n').filter((l) => l.startsWith('sec:')).length;
  out.push(n
    ? { name: 'GPG key', ok: true, detail: `${n} personal key${n > 1 ? 's' : ''}` }
    : { name: 'GPG key', ok: false, detail: 'no personal GPG key on this computer (needed to decrypt project data)',
      fix: 'Create one, then give its public key (gpg --armor --export <your email>) to a team member: they add you to the projects (git-crypt add-gpg-user)',
      command: 'gpg --full-generate-key',
      manual: c.win ? 'Open Kleopatra (it comes with Gpg4win): File -> New OpenPGP Key Pair, enter your name and email, choose a passphrase'
        : c.mac ? 'If you have GPG Keychain (GPG Suite): New, enter your name and email, choose a passphrase. Otherwise ask a team member to help with the command'
          : 'Open "Passwords and Keys" (Seahorse): + -> GPG key, enter your name and email, choose a passphrase. Or ask a team member to help with the command' });
  if (c.win) return out; // Gpg4win's pinentry is a window
  const [components, home] = await Promise.all([tryRun('gpgconf', ['--list-components']), tryRun('gpgconf', ['--list-dirs', 'homedir'])]);
  const conf = home?.code === 0 ? join(home.stdout.trim(), 'gpg-agent.conf') : undefined;
  let program = pinentryProgram(conf && existsSync(conf) ? readFileSync(conf, 'utf8') : undefined, components?.stdout ?? '');
  try { if (program) program = realpathSync(program); } catch { /* shown as configured */ }
  if (program && graphicalPinentry(program)) {
    out.push({ name: 'GPG passphrase window', ok: true, detail: basename(program) });
  } else {
    const linux = linuxInstall(c, { apt: 'pinentry-gnome3', dnf: 'pinentry-gnome3' });
    out.push({
      name: 'GPG passphrase window', ok: false,
      detail: program ? `${basename(program)} asks in a terminal: Positron cannot show it, so a key with a passphrase cannot decrypt data`
        : 'no pinentry found',
      fix: c.mac ? 'Use pinentry-mac (it can also keep the passphrase in the keychain); the command installs it and sets it for gpg-agent'
        : linux ? 'Use pinentry-gnome3; the command installs it and sets it for gpg-agent'
          : 'Install pinentry-gnome3 or pinentry-qt and set it as pinentry-program in gpg-agent.conf',
      command: c.mac ? `brew install pinentry-mac && ${setPinentry('$(brew --prefix)/bin/pinentry-mac', conf, c.platform)}`
        : linux && `${linux} && ${setPinentry('/usr/bin/pinentry-gnome3', conf, c.platform)}`,
      manual: c.mac ? 'Install GPG Suite from gpgtools.org: it sets up the passphrase window'
        : `${linuxManual('pinentry-gnome3')}, then add the line "pinentry-program /usr/bin/pinentry-gnome3" to ~/.gnupg/gpg-agent.conf`,
    });
  }
  return out;
}

/** A server's trust root older than this (it is refreshed weekly) is reported in Check Setup. */
export const TRUST_ROOT_MAX_DAYS = 30;

async function checkHosts(cfg: ClientConfig, log: Logger, c: Ctx): Promise<Check[]> {
  const out: Check[] = [];
  for (const h of cfg.hosts) {
    if (!h.ssh) {
      out.push(await checkLocalDocker(cfg, c));
      continue;
    }
    const name = `Server '${h.name}'`;
    try {
      const p = await transportFor(h, cfg, log).ping();
      const detail = `${h.ssh}: you are '${p.user}', fnkc-ctl ${p.version}`;
      const days = p.trustRootRefreshed ? Math.floor((Date.now() - Date.parse(p.trustRootRefreshed)) / 86_400_000) : 0;
      out.push(days > TRUST_ROOT_MAX_DAYS
        // Refreshed weekly while the server reaches GitHub: this old, new images may soon be refused
        ? { name, ok: false, detail: `${detail}; its GitHub trust root was last refreshed ${days} days ago`,
          fix: `Ask the server's admin to refresh it: sudo /opt/fnkc-ctl/refresh-trust-root.sh (without GitHub access: refresh-trust-root.sh --from <file>, see the admin guide)` }
        : { name, ok: true, detail });
    } catch (e) {
      const msg = (e as Error).message;
      let t: SshTarget | undefined;
      try { t = parseSshTarget(h.ssh); } catch { /* the message says what is wrong */ }
      const hostKey = t && await hostKeyFix(msg, t, `the server '${h.name}'`, `ssh ${t.port ? `-p ${t.port} ` : ''}${t.dest} fnkc-ctl agent ping`, c.platform);
      if (hostKey) {
        out.push({ name, ok: false, ...hostKey });
      } else if (/command not found: ssh\b|spawn ssh ENOENT/i.test(msg)) {
        out.push({ name, ok: false, detail: 'the ssh command was not found', ...installOpenSsh(c) });
      } else {
        out.push({
          name, ok: false, detail: msg,
          fix: /permission denied/i.test(msg)
            ? 'The server does not know your key yet: send your .pub file to its admin (fnkc-ctl admin add-user)'
            : 'Check the network (VPN?) and the address in FNKC Projects -> Hosts',
        });
      }
    }
  }
  return out;
}

/** Is Docker installed here? Does not start it: it starts by itself when a project runs here. */
async function checkLocalDocker(cfg: ClientConfig, c: Ctx): Promise<Check> {
  const kind = await detectEngine(cfg.engine, c.platform);
  const engine = new Engine(kind, cfg.engine, cfg.cacheDir);
  const name = 'Docker on this computer';
  let problem: unknown;
  try {
    await engine.docker.check();
    return { name, ok: true, detail: `${engine.label}, running` };
  } catch (e) {
    problem = e; // not running is fine where it starts by itself; not installed is not
  }
  if (kind === 'wsl') return { name, ok: true, detail: `${engine.label}, starts when a project runs here` };
  if (kind === 'colima') {
    const docker = await tryRun('docker', ['--version']);
    return docker?.code === 0
      ? { name, ok: true, detail: 'Colima, starts when a project runs here' }
      : { name, ok: false, detail: 'Colima is installed but the docker command is not', fix: 'Install the docker command for Colima', command: 'brew install docker',
        manual: 'Ask your IT admin, or install Docker Desktop from docker.com/products/docker-desktop instead' };
  }
  if (kind === 'docker-desktop') {
    const installed = c.mac ? c.exists('/Applications/Docker.app')
      : c.exists(`${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Docker\\Docker\\Docker Desktop.exe`);
    if (installed) return { name, ok: true, detail: 'Docker Desktop, starts when a project runs here' };
    return {
      name, ok: false, detail: 'no Docker found',
      fix: c.win ? 'Run "FNKC Projects: Set Up Docker on This Computer" (Docker in WSL, no Docker Desktop needed)'
        : 'Install Colima and the docker command (only needed to run projects on this computer)',
      command: c.mac ? 'brew install colima docker' : undefined,
      manual: c.mac ? 'Install Docker Desktop from docker.com/products/docker-desktop instead (check whether your organization needs a license for it)' : undefined,
    };
  }
  // Linux: the docker service, which does not start by itself
  if (problem instanceof DockerUnavailable && problem.reason === 'missing') {
    const apt = c.packager === 'apt';
    return {
      name, ok: false, detail: 'Docker is not installed',
      fix: apt ? 'Install Docker and allow your account to use it, then log out and back in (only needed to run projects on this computer)'
        : 'Install Docker Engine (docs.docker.com/engine/install), add yourself to the docker group, then log out and back in',
      command: apt ? 'sudo apt-get update && sudo apt-get install -y docker.io && sudo usermod -aG docker "$USER"' : undefined,
      manual: 'Follow docs.docker.com/engine/install for your system, or ask your IT admin',
    };
  }
  if (/permission denied/i.test((problem as Error | undefined)?.message ?? '')) {
    return {
      name, ok: false, detail: 'Docker runs, but your account may not use it',
      fix: 'Add yourself to the docker group, then log out and back in', command: 'sudo usermod -aG docker "$USER"',
      manual: 'Ask your IT admin to add your account to the docker group',
    };
  }
  return { name, ok: false, detail: 'Docker is not running', fix: 'Start the docker service and have it start at boot', command: 'sudo systemctl enable --now docker',
    manual: 'Restart the computer; if Docker is still not running, ask your IT admin' };
}

export const CONFIGURATION_CHECK = 'Configuration';
export const GET_CONFIG = 'Get config.json from your administrator and choose FNKC Projects: Import Configuration… ' +
  '(or put it in ~/.config/fnkc-ctl/config.json)';

/** Projects run on the team's servers: a configuration without one is not set up yet (or was never placed). */
export function checkConfiguration(cfg: ClientConfig): Check {
  const servers = cfg.hosts.filter((h) => h.ssh).map((h) => h.name);
  if (servers.length) return { name: CONFIGURATION_CHECK, ok: true, detail: `server${servers.length > 1 ? 's' : ''}: ${servers.join(', ')}` };
  return {
    name: CONFIGURATION_CHECK, ok: false,
    detail: cfg.hosts.length ? 'no server is configured (only this computer)' : 'no configuration yet: no server is configured',
    fix: GET_CONFIG,
  };
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

async function checkLocks(c: Ctx): Promise<Check> {
  const r = await tryRun(c.win ? 'powershell.exe' : 'python3', c.win
    ? ['-NoProfile', '-Command', '[Threading.Mutex]::new($false).Dispose()'] : ['-c', 'import fcntl']);
  const ok = r?.code === 0;
  return {
    name: 'Lock runtime', ok, detail: c.win ? 'PowerShell named mutexes' : 'Python 3 fcntl locks',
    ...(ok ? {} : c.win ? { fix: 'Turn Windows PowerShell back on (Windows features), then restart Positron' }
      : c.mac ? { fix: 'Install the Command Line Tools (they include Python 3), then restart Positron', command: 'xcode-select --install', manual: CLT_MANUAL }
        : { fix: 'Install Python 3 for crash-safe locks, then restart Positron', command: linuxInstall(c, { apt: 'python3', dnf: 'python3' }), manual: linuxManual('Python 3 (python3)') }),
  };
}

export const HOMEBREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** On macOS the install commands use Homebrew: without it, say so first rather than offer commands that fail. */
async function checkHomebrew(checks: Check[], c: Ctx): Promise<Check | undefined> {
  if (!c.mac || !checks.some((x) => !x.ok && x.command?.startsWith('brew '))) return undefined;
  const r = await tryRun('brew', ['--version']);
  if (r?.code === 0) return undefined;
  return {
    name: 'Homebrew', ok: false, detail: 'brew was not found, and the install commands below use it',
    fix: 'Install Homebrew first (brew.sh) and follow the "Next steps" it prints, then restart Positron',
    command: HOMEBREW_INSTALL,
    manual: 'Download the Homebrew .pkg installer from github.com/Homebrew/brew/releases (the newest release) and open it',
  };
}

function readOsRelease(): string {
  try { return readFileSync('/etc/os-release', 'utf8'); } catch { return ''; }
}

export async function runChecks(cfg: ClientConfig, log: Logger, opts: DoctorOptions = {}): Promise<Check[]> {
  const platform = opts.platform ?? process.platform;
  const c: Ctx = {
    platform, win: platform === 'win32', mac: platform === 'darwin', exists: opts.exists ?? existsSync,
    packager: platform === 'linux' ? linuxPackager(opts.osRelease ?? readOsRelease()) : undefined,
  };
  const [positron, git, agent, gitea, hosts, gpg, locks] = await Promise.all([checkPositron(opts.appRoot, opts.teamPositron),
    checkGit(c), checkAgent(cfg, c), checkGitea(cfg, c), checkHosts(cfg, log, c), checkGpg(cfg, c), checkLocks(c)]);
  const checks = [checkConfiguration(cfg), positron, locks, git, checkKey(cfg), agent, checkSshConfig(cfg), ...gitea, ...hosts, ...gpg];
  const brew = await checkHomebrew(checks, c);
  return (brew ? [brew, ...checks] : checks).map((x) => x.ok || !x.command ? x
    : { ...x, admin: needsAdmin(x.command), manual: x.manual ?? ASK_ADMIN });
}
