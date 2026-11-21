// Check Setup (client/doctor.ts, client/fix.ts) on computers where things are missing or broken: every problem is
// found, said in plain words, and comes with a fix that works (commands parse, need admin rights only when they say
// so, and have a way to do it by hand). The tools the checks run are stubs on PATH, so each case is a computer of
// its own; macOS, Linux and Windows are each checked on any system.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { clientConfig } from '../src/client/config.ts';
import { type Check, HOMEBREW_INSTALL, linuxPackager, quotePath, runChecks, TRUST_ROOT_MAX_DAYS } from '../src/client/doctor.ts';
import { CAPABILITIES, PROTOCOL_VERSION } from '../src/protocol.ts';
import { adminReport, COPY_ADMIN, elevatedPowerShell, explainFailure, fixSteps, RUN_ADMIN } from '../src/client/fix.ts';
import { assertClear } from './clear.ts';

const skip = process.platform === 'win32' ? 'stub tools are shell scripts (Windows: windows.acceptance.ts)' : undefined;
const root = mkdtempSync(join(tmpdir(), 'fnkc-doctor-'));
const quiet = { info() {}, warn() {} };
const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n';
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\n';
const PATH = process.env.PATH;
const HOME = process.env.HOME;
let n = 0;

after(() => {
  process.env.PATH = PATH;
  process.env.HOME = HOME;
  rmSync(root, { recursive: true, force: true });
});

type Stub = { code?: number; stdout?: string; stderr?: string } | string;

/** A computer: a home folder and a PATH with only these tools (a string is the script's body). */
function computer(tools: Record<string, Stub> = {}) {
  const dir = join(root, String(n++));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const [name, s] of Object.entries(tools)) {
    const body = typeof s === 'string' ? s
      : `printf '%s' ${sq(s.stdout ?? '')}\nprintf '%s' ${sq(s.stderr ?? '')} >&2\nexit ${s.code ?? 0}`;
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = bin;
  process.env.HOME = home;
  return { dir, bin, home };
}
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function positronApp(dir: string) {
  const app = join(dir, 'positron');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'product.json'), JSON.stringify({ positronVersion: '2026.07.1', positronBuildNumber: 5, commit: 'd3cd' }));
  return app;
}

function sshKey(home: string, name = 'id_ed25519') {
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', name), 'private');
  writeFileSync(join(home, '.ssh', `${name}.pub`), 'ssh-ed25519 AAAA test');
  return join(home, '.ssh', name);
}

const GITEA = 'ssh://git@gitea.test:2221/stats';
const cfg = (extra: Record<string, unknown> = {}) => clientConfig({ gitRemotes: [GITEA], ...extra });
const check = (all: Check[], name: string) => {
  const c = all.find((x) => x.name === name);
  assert.ok(c, `no check '${name}' in ${all.map((x) => x.name).join(', ')}`);
  return c;
};

const PLATFORMS: { name: string; platform: NodeJS.Platform; osRelease?: string }[] = [
  { name: 'macOS', platform: 'darwin' },
  { name: 'Ubuntu', platform: 'linux', osRelease: UBUNTU },
  { name: 'Fedora', platform: 'linux', osRelease: FEDORA },
  { name: 'another Linux', platform: 'linux', osRelease: 'ID=arch\n' },
  { name: 'Windows', platform: 'win32' },
];

for (const p of PLATFORMS) {
  test(`${p.name} with nothing installed: every problem is found and said clearly, with a fix`, { skip }, async () => {
    computer();
    const all = await runChecks(cfg(), quiet, { appRoot: join(root, 'no-positron'), platform: p.platform, osRelease: p.osRelease ?? '', exists: () => false });
    const failed = all.filter((c) => !c.ok);
    for (const c of failed) assertClear(c, p.platform);
    const names = failed.map((c) => c.name);
    for (const name of ['Positron', 'Lock runtime', 'git', 'SSH key', 'ssh-agent', 'Gitea (gitea.test)', 'Docker on this computer', 'GnuPG']) {
      assert.ok(names.includes(name), `${p.name}: '${name}' not reported among ${names.join(', ')}`);
    }
    const git = check(all, 'git');
    if (p.platform === 'darwin') {
      // The install commands use Homebrew, which is missing too: that comes first, with its own installer
      assert.equal(all[0].name, 'Homebrew');
      assert.equal(all[0].command, HOMEBREW_INSTALL);
      assert.equal(git.command, 'xcode-select --install');
      assert.equal(check(all, 'Docker on this computer').command, 'brew install colima docker');
    } else if (p.platform === 'win32') {
      assert.equal(git.command, 'winget install --id Git.Git -e');
      assert.equal(git.admin, false);
      // No ssh-add: the OpenSSH Client feature, which needs administrator rights
      assert.match(check(all, 'ssh-agent').command!, /^Add-WindowsCapability/);
      assert.equal(check(all, 'ssh-agent').admin, true);
      assert.match(check(all, 'Docker on this computer').fix!, /Set Up Docker on This Computer/);
    } else if (p.osRelease === UBUNTU) {
      assert.equal(git.command, 'sudo apt-get update && sudo apt-get install -y git');
      assert.equal(check(all, 'Docker on this computer').detail, 'Docker is not installed');
      assert.match(check(all, 'Docker on this computer').command!, /docker\.io && sudo usermod -aG docker "\$USER"/);
    } else if (p.osRelease === FEDORA) {
      assert.equal(git.command, 'sudo dnf install -y git');
      assert.match(check(all, 'GnuPG').command!, /gnupg2 pinentry-gnome3/);
    } else {
      // Unknown package manager: no command that might be wrong, but a fix and the way by hand
      assert.equal(git.command, undefined);
      assert.match(git.fix!, /Install git/);
    }
    assert.ok(!all.some((c) => c.name === 'Homebrew') || p.platform === 'darwin');
  });
}

test('a computer with everything set up: all checks pass', { skip }, async () => {
  const { dir, home } = computer({
    git: { stdout: 'git version 2.47.0\n' },
    'ssh-add': { stdout: '256 SHA256:abc test (ED25519)\n' },
    ssh: { code: 1, stderr: "Hi there, alice! You've successfully authenticated with the key named test, but Gitea does not provide shell access.\n" },
    gpg: { stdout: 'sec:u:255:22:ABCDEF:1700000000:::u:::scESC:::+:::23::0:\n' },
    gpgconf: 'case "$1" in --list-components) echo "pinentry:Passphrase Entry:/usr/bin/pinentry-gnome3";; --list-dirs) echo "$HOME/.gnupg";; esac',
    python3: { code: 0 },
    docker: { stdout: '27.3.1\n' },
  });
  sshKey(home);
  const all = await runChecks(cfg(), quiet, { appRoot: positronApp(dir), platform: 'linux', osRelease: UBUNTU });
  assert.deepEqual(all.filter((c) => !c.ok), []);
  assert.equal(check(all, 'Docker on this computer').detail, 'Docker, running');
});

test('Gitea: an unknown or changed host key is not reported as a network problem', { skip }, async () => {
  computer({ ssh: { code: 255, stderr: 'No ED25519 host key is known for [gitea.test]:2221 and you have requested strict checking.\r\nHost key verification failed.\r\n' } });
  let g = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Gitea (gitea.test)');
  assertClear(g, 'linux');
  assert.match(g.detail, /does not know the host key of Gitea/);
  assert.equal(g.command, 'ssh -T -p 2221 git@gitea.test');
  assert.match(g.fix!, /compare the fingerprint/);
  assert.doesNotMatch(g.fix!, /network|VPN/);

  computer({ ssh: { code: 255, stderr: '@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@\nHost key verification failed.\n' } });
  g = check(await runChecks(cfg(), quiet, { platform: 'darwin' }), 'Gitea (gitea.test)');
  assertClear(g, 'darwin');
  assert.equal(g.command, 'ssh-keygen -R "[gitea.test]:2221"');
  assert.match(g.fix!, /Ask the admin/);

  // A Host alias in ~/.ssh/config: the entry to forget is the one ssh -G resolves (HostName and Port, or HostKeyAlias)
  const changed = '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n';
  computer({ ssh: `case "$1" in -G) printf 'hostname 10.0.0.5\\nport 2222\\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\\n';; *) printf '%s' ${sq(changed)} >&2; exit 255;; esac` });
  g = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Gitea (gitea.test)');
  assert.equal(g.command, 'ssh-keygen -R "[10.0.0.5]:2222"');
  // As real ssh -G prints it: the default file expanded to the home folder, still the default
  computer({ ssh: `case "$1" in -G) printf 'hostname 10.0.0.5\\nport 2222\\nuserknownhostsfile ${userInfo().homedir}/.ssh/known_hosts ${userInfo().homedir}/.ssh/known_hosts2\\n';; *) printf '%s' ${sq(changed)} >&2; exit 255;; esac` });
  g = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Gitea (gitea.test)');
  assert.equal(g.command, 'ssh-keygen -R "[10.0.0.5]:2222"');
  computer({ ssh: `case "$1" in -G) printf 'hostname 10.0.0.5\\nport 22\\nhostkeyalias gitea-key\\nuserknownhostsfile /etc/fnkc/known_hosts\\n';; *) printf '%s' ${sq(changed)} >&2; exit 255;; esac` });
  g = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Gitea (gitea.test)');
  assert.equal(g.command, 'ssh-keygen -f /etc/fnkc/known_hosts -R gitea-key');

  computer({ ssh: { code: 255, stderr: 'git@gitea.test: Permission denied (publickey).\n' } });
  g = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Gitea (gitea.test)');
  assert.equal(g.detail, 'your key is not accepted');

  // ssh is there but cannot be started: not "not installed"
  const { bin } = computer();
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\n');
  g = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Gitea (gitea.test)');
  assertClear(g, 'linux');
  assert.equal(g.detail, 'ssh could not be started');
  assert.match(g.fix!, /network/);

  computer({ ssh: { code: 255, stderr: 'ssh: connect to host gitea.test port 2221: Operation timed out\n' } });
  g = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Gitea (gitea.test)');
  assert.match(g.fix!, /network \(VPN\?\)/);
});

test('ssh-agent: no agent, an agent without keys, and no key at all each get their own fix', { skip }, async () => {
  let { home } = computer({ 'ssh-add': { code: 2, stderr: 'Could not open a connection to your authentication agent.\n' } });
  let a = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'ssh-agent');
  assertClear(a, 'linux');
  assert.equal(a.detail, 'no ssh-agent is running for your session');
  assert.equal(a.command, undefined);

  computer({ 'ssh-add': { code: 2, stderr: 'Error connecting to agent: No such file or directory\n' } });
  a = check(await runChecks(cfg(), quiet, { platform: 'win32' }), 'ssh-agent');
  assertClear(a, 'win32');
  assert.match(a.command!, /Start-Service ssh-agent/);
  assert.match(a.manual!, /services\.msc/);

  // No key yet: no ssh-add command for a file that does not exist
  computer({ 'ssh-add': { code: 1, stdout: 'The agent has no identities.\n' } });
  a = check(await runChecks(cfg(), quiet, { platform: 'darwin' }), 'ssh-agent');
  assertClear(a, 'darwin');
  assert.equal(a.command, undefined);
  assert.match(a.fix!, /Create an SSH key first/);

  // A key in a folder with a space (a Windows user name, say): quoted, so the command works when pasted
  ({ home } = computer({ 'ssh-add': { code: 1, stdout: 'The agent has no identities.\n' } }));
  const key = sshKey(join(home, 'Jane Doe'));
  a = check(await runChecks(cfg({ sshKey: key }), quiet, { platform: 'darwin' }), 'ssh-agent');
  assertClear(a, 'darwin');
  assert.equal(a.command, `ssh-add --apple-use-keychain '${key}'`);
  // PowerShell: single quotes, so $ and , in a user name stay part of the path; POSIX: a backslash is quoted
  assert.equal(quotePath('C:\\Users\\Jane Doe\\.ssh\\id_ed25519', 'win32'), "'C:\\Users\\Jane Doe\\.ssh\\id_ed25519'");
  assert.equal(quotePath('C:\\Users\\ad$min\\.ssh\\id_ed25519', 'win32'), "'C:\\Users\\ad$min\\.ssh\\id_ed25519'");
  assert.equal(quotePath('C:\\keys\\a,b\\id', 'win32'), "'C:\\keys\\a,b\\id'");
  assert.equal(quotePath("C:\\Users\\O'Brien\\id", 'win32'), "'C:\\Users\\O''Brien\\id'");
  assert.equal(quotePath('C:\\Users\\jane\\.ssh\\id_ed25519', 'win32'), 'C:\\Users\\jane\\.ssh\\id_ed25519');
  assert.equal(quotePath('/home/a\\b/id', 'linux'), "'/home/a\\b/id'");
  assert.equal(quotePath('/home/jane/.ssh/id_ed25519', 'linux'), '/home/jane/.ssh/id_ed25519');
});

test('Docker on Linux: not installed, not allowed and not running are told apart', { skip }, async () => {
  computer();
  let d = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: 'ID=arch\n' }), 'Docker on this computer');
  assertClear(d, 'linux');
  assert.match(d.fix!, /docs\.docker\.com/);

  computer({ docker: { code: 1, stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n' } });
  d = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Docker on this computer');
  assertClear(d, 'linux');
  assert.equal(d.command, 'sudo usermod -aG docker "$USER"');
  assert.match(d.fix!, /log out and back in/);

  // The permission line followed by another one: still the docker group, not "not running"
  computer({ docker: { code: 1, stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\nerrors pretty printing info\n' } });
  d = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Docker on this computer');
  assert.equal(d.command, 'sudo usermod -aG docker "$USER"');

  computer({ docker: { code: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' } });
  d = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Docker on this computer');
  assertClear(d, 'linux');
  assert.equal(d.command, 'sudo systemctl enable --now docker');

  // As a real docker CLI (27) did on CI with the daemon stopped: exit 0 and an empty server version
  computer({ docker: { code: 0, stdout: '\n' } });
  d = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'Docker on this computer');
  assert.equal(d.detail, 'Docker is not running');
});

test('macOS: Docker, Colima and Homebrew', { skip }, async () => {
  // Colima without the docker command
  computer({ colima: { stdout: 'colima version 0.8.1\n' }, brew: { stdout: 'Homebrew 4.4.0\n' } });
  let all = await runChecks(cfg(), quiet, { platform: 'darwin', exists: () => false });
  const d = check(all, 'Docker on this computer');
  assertClear(d, 'darwin');
  assert.equal(d.command, 'brew install docker');
  assert.ok(!all.some((c) => c.name === 'Homebrew'), 'Homebrew is installed: not reported');

  // Docker Desktop installed (not running): fine, it starts when a project runs
  computer();
  all = await runChecks(cfg(), quiet, { platform: 'darwin', exists: (p) => p === '/Applications/Docker.app' });
  assert.equal(check(all, 'Docker on this computer').ok, true);
});

test('GPG passphrase window: the command writes to the right gpg-agent.conf, quoted', { skip }, async () => {
  const gnupg = join(root, 'with space', '.gnupg');
  computer({
    gpg: { stdout: 'sec:u:255:22:ABCDEF:1700000000:::u:::scESC:::+:::23::0:\n' },
    gpgconf: `case "$1" in --list-components) echo "pinentry:Passphrase Entry:/opt/homebrew/opt/pinentry/bin/pinentry-curses";; --list-dirs) echo ${sq(gnupg)};; esac`,
  });
  let w = check(await runChecks(cfg(), quiet, { platform: 'darwin' }), 'GPG passphrase window');
  assertClear(w, 'darwin');
  assert.match(w.detail, /pinentry-curses asks in a terminal/);
  const conf = `'${join(gnupg, 'gpg-agent.conf')}'`;
  assert.ok(w.command!.includes(`sed -i.bak '/^[[:space:]]*pinentry-program/d' ${conf} && echo "pinentry-program $(brew --prefix)/bin/pinentry-mac" >> ${conf}`), w.command);
  w = check(await runChecks(cfg(), quiet, { platform: 'linux', osRelease: UBUNTU }), 'GPG passphrase window');
  assertClear(w, 'linux');
  assert.match(w.command!, /^sudo apt-get update && sudo apt-get install -y pinentry-gnome3 && mkdir -p .* && echo "pinentry-program \/usr\/bin\/pinentry-gnome3" >> .* && gpgconf --kill gpg-agent$/);
});

test('servers: an unknown host key and a missing ssh say so', { skip }, async () => {
  computer({ ssh: { code: 255, stderr: 'Host key verification failed.\n' } });
  const c = cfg({ hosts: [{ name: 'stats', ssh: 'fnkc@stats.test:2222' }] });
  const s = check(await runChecks(c, quiet, { platform: 'linux', osRelease: UBUNTU }), "Server 'stats'");
  assertClear(s, 'linux');
  assert.equal(s.command, 'ssh -p 2222 fnkc@stats.test fnkc-ctl agent ping');

  computer();
  for (const p of PLATFORMS.filter((x) => x.name !== 'another Linux')) {
    const m = check(await runChecks(c, quiet, { platform: p.platform, osRelease: p.osRelease ?? '' }), "Server 'stats'");
    assertClear(m, p.platform);
    assert.equal(m.detail, 'the ssh command was not found');
  }
});

test('servers: a trust root not refreshed for a month is reported for the admin', { skip }, async () => {
  const c = cfg({ hosts: [{ name: 'stats', ssh: 'fnkc@stats.test' }] });
  const answer = (days: number) => {
    const ping = { version: '0.4.50', protocol: PROTOCOL_VERSION, capabilities: CAPABILITIES, user: 'alice', requiresProvenance: true,
      trustRootRefreshed: new Date(Date.now() - days * 86_400_000).toISOString() };
    computer({ ssh: { stdout: JSON.stringify({ ok: true, result: ping }) + '\n' } });
  };
  answer(TRUST_ROOT_MAX_DAYS - 1);
  let s = check(await runChecks(c, quiet, { platform: 'linux', osRelease: UBUNTU }), "Server 'stats'");
  assert.equal(s.ok, true, s.detail);
  answer(45);
  s = check(await runChecks(c, quiet, { platform: 'linux', osRelease: UBUNTU }), "Server 'stats'");
  assert.equal(s.ok, false);
  assert.match(s.detail, /trust root was last refreshed 45 days ago/);
  assert.match(s.fix!, /sudo \/opt\/fnkc-ctl\/refresh-trust-root\.sh/);
});

test('the Linux package manager comes from /etc/os-release', () => {
  assert.equal(linuxPackager(UBUNTU), 'apt');
  assert.equal(linuxPackager('ID=debian\n'), 'apt');
  assert.equal(linuxPackager('ID=linuxmint\nID_LIKE="ubuntu debian"\n'), 'apt');
  assert.equal(linuxPackager(FEDORA), 'dnf');
  assert.equal(linuxPackager('ID="rocky"\nID_LIKE="rhel centos fedora"\n'), 'dnf');
  assert.equal(linuxPackager('ID=arch\n'), undefined);
  assert.equal(linuxPackager(''), undefined);
});

const GIT: Check = {
  name: 'git', ok: false, detail: 'the git command was not found', fix: 'Install git, then restart Positron',
  command: 'sudo apt-get update && sudo apt-get install -y git', admin: true, manual: "Install git with your system's software app, or ask your IT admin to install it",
};
const AGENT_WIN: Check = {
  name: 'ssh-agent', ok: false, detail: 'the OpenSSH Authentication Agent service is not running', fix: 'Start it',
  command: 'Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent', admin: true, manual: 'Press Win+R',
};

test('a fix that did not work is explained in plain words, with what to do next', () => {
  // Output as the real tools print it
  const cases: [Check, number | undefined, string, RegExp, RegExp][] = [
    [GIT, 1, 'alice is not in the sudoers file.  This incident will be reported.\n', /not allowed to install software/, new RegExp(`IT admin[\\s\\S]*${COPY_ADMIN}[\\s\\S]*by hand: Install git`)],
    [GIT, 1, 'Sorry, user alice may not run sudo on stats-laptop.\n', /not allowed to install software/, /IT admin/],
    [GIT, 1, '[sudo] password for alice: \r\nSorry, try again.\r\n[sudo] password for alice: \r\nsudo: 3 incorrect password attempts\r\n', /password was not accepted/, /log in to this computer/],
    [GIT, 100, 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (unattended-upgr)\n', /Another installation is running/, /Wait until it finishes/],
    [GIT, 100, "Err:1 http://archive.ubuntu.com/ubuntu noble InRelease\n  Temporary failure resolving 'archive.ubuntu.com'\n", /could not reach the internet/, /VPN/],
    [GIT, 1, 'curl: (6) Could not resolve host: ghcr.io\nError: Failed to download resource "gnupg"\n', /could not reach the internet/, /VPN/],
    [GIT, 100, 'E: You don\'t have enough free space in /var/cache/apt/archives/.\nNo space left on device\n', /disk of this computer is full/, /Free some space/],
    [GIT, 127, 'zsh: command not found: brew\n', /not installed: brew/, /Install Homebrew first/],
    [GIT, 127, 'bash: brew: command not found\n', /not installed: brew/, /Install Homebrew first/],
    [GIT, 1, "winget : The term 'winget' is not recognized as the name of a cmdlet, function, script file, or operable program.\n", /not installed: winget/, /Restart Positron/],
    [AGENT_WIN, 1, 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.\n', /chose No/, /choose Yes/],
    [AGENT_WIN, 1, "Set-Service : Service 'OpenSSH Authentication Agent (ssh-agent)' cannot be configured due to the following error: Access is denied\n", /not allowed to install software/, /IT admin/],
    [AGENT_WIN, 1, 'Add-WindowsCapability : The requested operation requires elevation.\n', /not allowed/, /IT admin/],
    [GIT, 255, 'git@gitea.test: Permission denied (publickey).\n', /key is not accepted/, /public key/],
    [GIT, 1, 'cp: /usr/local/bin/x: Permission denied\n', /not allowed to change a file/, /IT admin/],
    [GIT, 0, '', /finished, but git is still not ready/, /installer window/],
    [GIT, 3, 'something unexpected\n', /stopped with an error/, /last lines in the terminal/],
  ];
  for (const [c, code, out, problem, next] of cases) {
    const o = explainFailure(c, code, `\x1b[1m${out}\x1b[0m`, c);
    assert.match(o.problem, problem, out);
    assert.match(o.next, next, out);
    for (const s of [o.problem, o.next]) {
      assert.match(s, /^[A-Z]/, s);
      assert.match(s, /\.$/, s);
      assert.doesNotMatch(s, /undefined|\x1b/, s);
    }
  }
});

test('the report for an administrator has the check, the command and the end of its output', () => {
  const r = adminReport(GIT, 'linux', `${'line\n'.repeat(50)}alice is not in the sudoers file.\n`);
  assert.match(r, /Check Setup on Linux: "git" is not ready/);
  assert.match(r, /Command \(needs administrator rights\): sudo apt-get update && sudo apt-get install -y git/);
  assert.match(r, /not in the sudoers file/);
  assert.ok(r.split('\n').length < 40, 'only the end of a long output');
});

test('an administrator command on Windows runs in an elevated window that keeps its exit code and error', () => {
  const args = elevatedPowerShell(AGENT_WIN.command!, 'C:\\Users\\Jane O\'Brien\\AppData\\Local\\Temp\\fnkc-fix.txt');
  const outer = args.at(-1)!;
  assert.match(outer, /Start-Process -FilePath powershell\.exe -Verb RunAs -Wait -PassThru/);
  assert.match(outer, /exit \$p\.ExitCode/);
  const inner = Buffer.from(/'-EncodedCommand','([^']+)'/.exec(outer)![1], 'base64').toString('utf16le');
  assert.ok(inner.includes(`try { ${AGENT_WIN.command}; if ($LASTEXITCODE)`), inner);
  assert.ok(inner.includes("-LiteralPath 'C:\\Users\\Jane O''Brien\\AppData\\Local\\Temp\\fnkc-fix.txt'"), 'the path is quoted for PowerShell');
  assert.match(fixSteps(AGENT_WIN, 'win32'), new RegExp(`^1\\. "${RUN_ADMIN}" opens a separate PowerShell window`));
});

