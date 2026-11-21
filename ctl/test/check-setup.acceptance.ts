// Check Setup on a real computer (CI: .github/workflows/check-setup.yml, on Ubuntu, macOS and Windows): with tools
// hidden, every problem is found and said clearly; then the suggested commands are run for real, exactly as a user
// would paste them, and the check is run again to see that they fixed it. Real tools print the messages the checks
// recognize (an unknown or changed host key, no agent, a stopped Docker), so the patterns are tested against them.
//
// The parts that install software, add users or stop services run only with FNKC_SYSTEM_TESTS=1 (CI runners, which
// are thrown away); without it only the read-only parts run, so it is safe on a developer's computer.
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { clientConfig } from '../src/client/config.ts';
import { type Check, runChecks } from '../src/client/doctor.ts';
import { elevatedPowerShell } from '../src/client/fix.ts';
import { assertClear } from './clear.ts';

const system = process.env.FNKC_SYSTEM_TESTS === '1';
const SYSTEM = system ? undefined : 'changes the computer: set FNKC_SYSTEM_TESTS=1 (CI only)';
const os = process.platform;
const only = (p: NodeJS.Platform) => os === p ? SYSTEM : `${p} only`;
// Short paths: GnuPG's sockets live in the home folder, and macOS limits socket paths to 104 characters
const root = mkdtempSync(os === 'win32' ? join(tmpdir(), 'fnkc-acc-') : '/tmp/fnkc-acc-');
const quiet = { info() {}, warn() {} };
const PATH = process.env.PATH!;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
const cleanup: (() => void)[] = [];
let n = 0;

after(() => {
  for (const f of cleanup.reverse()) { try { f(); } catch { /* best effort */ } }
  process.env.PATH = PATH;
  Object.assign(process.env, saved);
  // gpg-agent and keyboxd (started by the checks) keep files in the test homes open: stop them first
  if (system) try { execFileSync('gpgconf', ['--kill', 'all'], { stdio: 'ignore' }); } catch { /* no GnuPG */ }
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { console.log(`left behind: ${root} (${(e as Error).message})`); }
});

/** A new home folder (HOME, and USERPROFILE on Windows) for the next checks. */
function home(): string {
  const h = join(root, `home${n++}`);
  mkdirSync(h, { recursive: true });
  process.env.HOME = h;
  process.env.USERPROFILE = h;
  return h;
}

/**
 * The account's real home: ssh-keygen and ssh read ~/.ssh from the account, not from HOME. Keys already there are
 * moved aside for the test and put back afterwards.
 */
function realHome(): string {
  Object.assign(process.env, { HOME: saved.HOME, USERPROFILE: saved.USERPROFILE });
  const ssh = join(os === 'win32' ? saved.USERPROFILE! : saved.HOME!, '.ssh');
  for (const k of ['id_ed25519', 'id_ecdsa', 'id_rsa'].flatMap((k) => [k, `${k}.pub`])) {
    const f = join(ssh, k);
    if (!existsSync(f)) continue;
    renameSync(f, `${f}.fnkc-test`);
    cleanup.push(() => { rmSync(f, { force: true }); renameSync(`${f}.fnkc-test`, f); });
  }
  cleanup.push(() => { if (!existsSync(join(ssh, 'id_ed25519.fnkc-test'))) for (const k of ['id_ed25519', 'id_ed25519.pub']) rmSync(join(ssh, k), { force: true }); });
  return dirname(ssh);
}

async function checks(extra: Record<string, unknown> = {}, path = PATH): Promise<Check[]> {
  process.env.PATH = path;
  try {
    // This computer as a host by choice, so Docker here is checked (without "hosts" nothing is configured)
    return await runChecks(clientConfig({ hosts: [{ name: 'local' }], gitRemotes: [], ...extra }), quiet, { exists: existsSync });
  } finally {
    process.env.PATH = PATH;
  }
}
const find = (all: Check[], name: string) => {
  const c = all.find((x) => x.name === name);
  assert.ok(c, `no check '${name}': ${all.map((x) => x.name).join(', ')}`);
  return c;
};

/** Runs a suggested command as the user would: pasted into bash/zsh (Terminal) or PowerShell. */
function paste(command: string, opts: { input?: string; env?: NodeJS.ProcessEnv; path?: string } = {}) {
  const [shell, args] = os === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['/bin/bash', ['-c', command]];
  try {
    const out = execFileSync(shell, args, { input: opts.input ?? '', env: { ...process.env, PATH: opts.path ?? PATH, ...opts.env }, stdio: 'pipe', timeout: 15 * 60_000 });
    return { code: 0, out: out.toString(), stdout: out.toString() };
  } catch (e) {
    const x = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: x.status ?? -1, out: `${x.stdout ?? ''}${x.stderr ?? ''}`, stdout: `${x.stdout ?? ''}` };
  }
}
function pasteOk(command: string, opts: Parameters<typeof paste>[1] = {}) {
  const r = paste(command, opts);
  assert.equal(r.code, 0, `the suggested command failed: ${command}\n${r.out}`);
  return r.out;
}

/** The fix of `name` in `all`, run; then that check again: it must pass now. */
async function fixAndRecheck(all: Check[], name: string, again: () => Promise<Check[]>, opts: Parameters<typeof paste>[1] = {}) {
  const c = find(all, name);
  assert.equal(c.ok, false, `${name} should fail first`);
  assertClear(c, os);
  assert.ok(c.command, `${name} has no command to run`);
  pasteOk(c.command, opts);
  const now = find(await again(), name);
  assert.equal(now.ok, true, `after "${c.command}", ${name} still fails: ${now.detail}`);
  return now;
}

/** gpg-agent.conf has exactly one pinentry-program line, the expected one, and gpg-agent accepts the file. */
function assertOnePinentry(h: string, program: RegExp) {
  const lines = readFileSync(join(h, '.gnupg', 'gpg-agent.conf'), 'utf8').split('\n').filter((l) => /^\s*pinentry-program/.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], program);
  pasteOk('gpg-agent --gpgconf-test');
}

function startAgent(): void {
  const out = execFileSync('ssh-agent', ['-s']).toString();
  process.env.SSH_AUTH_SOCK = /SSH_AUTH_SOCK=([^;]+);/.exec(out)![1];
  const pid = /SSH_AGENT_PID=(\d+);/.exec(out)![1];
  cleanup.push(() => process.kill(Number(pid)));
}

// ---- Every system: a computer where nothing is installed ----

test('a bare computer: every problem is found and said clearly; commands parse', async () => {
  home();
  // Only node itself on PATH: no git, ssh, gpg, docker, python, PowerShell, brew
  const bare = join(root, 'bare-bin');
  mkdirSync(bare, { recursive: true });
  const all = await checks({ gitRemotes: ['ssh://git@gitea.invalid:2221/stats'] }, `${bare}${delimiter}${dirname(process.execPath)}`);
  const failed = all.filter((c) => !c.ok);
  for (const c of failed) assertClear(c, os);
  for (const name of ['git', 'SSH key', 'ssh-agent', 'Gitea (gitea.invalid)', 'GnuPG']) assert.ok(failed.some((c) => c.name === name), `${name} not reported`);
  if (os === 'darwin') assert.equal(all[0].name, 'Homebrew', 'brew is hidden: Homebrew comes first');
  console.log(failed.map((c) => `FAIL ${c.name}: ${c.detail}\n  -> ${c.fix}${c.command ? `\n     ${c.command}` : ''}`).join('\n'));
});

// ---- Linux ----

test('Linux: every package the apt commands install exists', { skip: only('linux') }, async () => {
  home();
  const bare = join(root, 'bare-linux');
  mkdirSync(bare, { recursive: true });
  const all = await checks({}, bare);
  const pkgs = new Set(all.flatMap((c) => [...(c.command ?? '').matchAll(/apt-get install -y ([^&]+)/g)].flatMap((m) => m[1].trim().split(/\s+/))));
  assert.ok(pkgs.has('git') && pkgs.has('gnupg'), [...pkgs].join(' '));
  for (const p of [...pkgs, 'docker.io', 'openssh-client', 'pinentry-gnome3', 'python3']) {
    const policy = execFileSync('apt-cache', ['policy', p]).toString();
    assert.match(policy, /Candidate: (?!\(none\))\S+/, `apt has no package ${p}`);
  }
});

test('Linux: SSH key and agent, fixed with the suggested commands', { skip: only('linux') }, async () => {
  realHome();
  delete process.env.SSH_AUTH_SOCK;
  let all = await checks();
  // The real ssh-add without an agent
  assert.equal(find(all, 'ssh-agent').detail, 'no ssh-agent is running for your session');
  // ssh-keygen as the user runs it: Enter at each question
  await fixAndRecheck(all, 'SSH key', () => checks(), { input: '\n\n\n' });
  startAgent();
  all = await checks();
  assert.equal(find(all, 'ssh-agent').detail, 'no keys in the agent');
  await fixAndRecheck(all, 'ssh-agent', () => checks());
});

test('Linux: a terminal pinentry is replaced by the passphrase window with the suggested command', { skip: only('linux') }, async () => {
  const h = home();
  pasteOk("gpg --batch --passphrase '' --quick-gen-key 'Check Setup <check@example.test>' default default never");
  // Whatever this computer has, start from the terminal one
  mkdirSync(join(h, '.gnupg'), { recursive: true });
  writeFileSync(join(h, '.gnupg', 'gpg-agent.conf'), 'pinentry-program /usr/bin/pinentry-curses\n');
  const all = await checks();
  assert.match(find(all, 'GPG passphrase window').detail, /pinentry-curses asks in a terminal/);
  await fixAndRecheck(all, 'GPG passphrase window', () => checks());
  assertOnePinentry(h, /\/usr\/bin\/pinentry-gnome3$/);
});

test('Linux: Docker stopped, and an account outside the docker group, fixed with the suggested commands', { skip: only('linux') }, async () => {
  home();
  pasteOk('sudo systemctl stop docker.socket docker.service');
  cleanup.push(() => paste('sudo systemctl start docker'));
  const state = () => paste('systemctl is-active docker.service docker.socket; ls -l /var/run/docker.sock; docker info --format "{{.ServerVersion}}"').out;
  const all = await checks();
  assert.equal(find(all, 'Docker on this computer').detail, 'Docker is not running', `after systemctl stop:\n${state()}`);
  await fixAndRecheck(all, 'Docker on this computer', () => checks());

  // Another account, through the command line (fnkc-ctl doctor --json), since it runs as that user
  const user = 'fnkc-nodocker';
  pasteOk(`sudo useradd -m ${user}`);
  cleanup.push(() => paste(`sudo userdel -r ${user}`));
  const cli = join(tmpdir(), 'fnkc-ctl-acceptance.cjs');
  // This file runs bundled from ctl/.cache: the command line is built to ctl/dist
  copyFileSync(join(__dirname, '..', 'dist', 'fnkc-ctl.cjs'), cli);
  const localOnly = join(tmpdir(), 'fnkc-ctl-acceptance-config.json');
  writeFileSync(localOnly, JSON.stringify({ hosts: [{ name: 'local' }] }));
  const doctor = () => JSON.parse(paste(`sudo -u ${user} -H env PATH="$PATH" ${JSON.stringify(process.execPath)} ${cli} doctor --json --config ${localOnly}`).stdout) as Check[];
  const before = doctor();
  assert.equal(find(before, 'Docker on this computer').detail, 'Docker runs, but your account may not use it');
  await fixAndRecheck(before, 'Docker on this computer', async () => doctor(), { env: { USER: user } });
});

/** sshd as this user on 127.0.0.1:<port>, answering like Gitea; restart() switches its host key. */
async function fakeGitea(dir: string, port: number) {
  mkdirSync(dir, { recursive: true });
  // sshd refuses to start without its privilege separation directory, even as a normal user
  pasteOk('sudo mkdir -p /run/sshd');
  for (const k of ['a', 'b']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, `host_${k}`)]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'client')]);
  const greeting = `Hi there, ${userInfo().username}! You've successfully authenticated with the key named test, but Gitea does not provide shell access.`;
  writeFileSync(join(dir, 'authorized_keys'), `command="echo \\"${greeting}\\"" ${readFileSync(join(dir, 'client.pub'), 'utf8')}`);
  let sshd: ChildProcess | undefined;
  const start = async (key: 'a' | 'b') => {
    sshd?.kill();
    // Its own config file: the system one includes files only root may read
    writeFileSync(join(dir, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, `host_${key}`)}`, 'UsePAM no',
      'StrictModes no', `PidFile ${join(dir, 'sshd.pid')}`, `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', ''].join('\n'));
    sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    sshd.stderr!.on('data', (d: Buffer) => { log += d.toString(); });
    const exited = new Promise<void>((r) => sshd!.once('exit', () => r()));
    for (let i = 0; i < 50; i++) {
      const up = await new Promise<boolean>((ok) => {
        const s = connect(port, '127.0.0.1');
        s.on('connect', () => { s.destroy(); ok(true); }).on('error', () => ok(false));
      });
      if (up) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
    throw new Error(`sshd did not start:\n${log}`);
  };
  cleanup.push(() => sshd?.kill());
  await start('a');
  return { start, client: join(dir, 'client') };
}

/** Runs a command in a terminal (a pty, as script(1) gives) and answers its questions as they come. */
function interactive(command: string, answers: [RegExp, string][]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('script', ['-qec', command, '/dev/null'], { env: process.env });
    let out = '';
    const pending = [...answers];
    const onData = (d: Buffer) => {
      out += d.toString();
      if (pending.length && pending[0][0].test(out)) p.stdin.write(pending.shift()![1]);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('Linux: Gitea host key unknown, then changed: real ssh messages, fixed with the suggested commands', { skip: only('linux') }, async () => {
  home();
  const port = 2221;
  const gitea = await fakeGitea(join(root, 'gitea'), port);
  startAgent();
  execFileSync('ssh-add', [gitea.client], { stdio: 'pipe' });
  const remote = `ssh://${userInfo().username}@127.0.0.1:${port}/stats`;
  const name = 'Gitea (127.0.0.1)';
  const again = () => checks({ gitRemotes: [remote] });
  // ssh reads known_hosts from the account's real home: start without an entry for this one
  paste(`ssh-keygen -R "[127.0.0.1]:${port}"`);

  let g = find(await again(), name);
  assertClear(g, os);
  assert.equal(g.detail, 'this computer does not know the host key of Gitea yet');
  assert.equal(g.command, `ssh -T -p ${port} ${userInfo().username}@127.0.0.1`);
  // The user runs it and answers yes, as the fix says
  const r = await interactive(g.command!, [[/continue connecting \(yes\/no/, 'yes\n']]);
  assert.match(r.out, /successfully authenticated/, r.out);
  g = find(await again(), name);
  assert.equal(g.ok, true, g.detail);

  // The server gets a new host key: not a network problem, and not something to accept blindly
  await gitea.start('b');
  g = find(await again(), name);
  assertClear(g, os);
  assert.equal(g.detail, 'Gitea has a different host key than this computer remembers');
  assert.equal(g.command, `ssh-keygen -R "[127.0.0.1]:${port}"`);
  pasteOk(g.command!);
  g = find(await again(), name);
  assert.equal(g.detail, 'this computer does not know the host key of Gitea yet', 'after forgetting the old key, it asks again');
});

// ---- macOS ----

// Read-only (brew info), so it runs on any Mac
test('macOS: every Homebrew formula the commands install exists', { skip: os === 'darwin' ? undefined : 'macOS only' }, async () => {
  home();
  const brewOnly = join(root, 'brew-only');
  mkdirSync(brewOnly, { recursive: true });
  const all = await checks({}, `${brewOnly}${delimiter}/usr/bin${delimiter}/bin`);
  const formulas = new Set(all.flatMap((c) => [...(c.command ?? '').matchAll(/brew install ([^&]+)/g)].flatMap((m) => m[1].trim().split(/\s+/))));
  for (const f of [...formulas, 'gnupg', 'pinentry-mac', 'colima', 'docker']) {
    assert.equal(paste(`brew info --formula ${f}`).code, 0, `no Homebrew formula ${f}`);
  }
});

const brewPrefix = () => execFileSync('brew', ['--prefix']).toString().trim();

test('macOS: GnuPG missing, fixed with the suggested command; then the passphrase window is set', { skip: only('darwin') }, async () => {
  home();
  // PATH with brew but without gpg: a folder with only brew in it
  const brewOnly = join(root, 'brew-only-gpg');
  mkdirSync(brewOnly, { recursive: true });
  // A wrapper, not a symlink: Homebrew finds its prefix from where brew is, and outside it would build from source
  writeFileSync(join(brewOnly, 'brew'), `#!/bin/sh\nexec ${join(brewPrefix(), 'bin', 'brew')} "$@"\n`, { mode: 0o755 });
  const bare = `${brewOnly}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const all = await checks({}, bare);
  const gnupg = find(all, 'GnuPG');
  assertClear(gnupg, os);
  assert.ok(!all.some((c) => c.name === 'Homebrew'), 'brew is there: no Homebrew problem');
  pasteOk(gnupg.command!, { path: bare });
  const now = await checks();
  assert.equal(find(now, 'GPG passphrase window').ok, true, find(now, 'GPG passphrase window').detail);
});

test('macOS: a terminal pinentry is replaced by pinentry-mac with the suggested command', { skip: only('darwin') }, async () => {
  const h = home();
  pasteOk('brew install pinentry');
  pasteOk("gpg --batch --passphrase '' --quick-gen-key 'Check Setup <check@example.test>' default default never");
  writeFileSync(join(h, '.gnupg', 'gpg-agent.conf'), `pinentry-program ${brewPrefix()}/bin/pinentry-tty\n`);
  const all = await checks();
  await fixAndRecheck(all, 'GPG passphrase window', () => checks());
  assertOnePinentry(h, /\/pinentry-mac$/);
});

test('macOS: SSH key and agent, fixed with the suggested commands', { skip: only('darwin') }, async () => {
  realHome();
  startAgent();
  await fixAndRecheck(await checks(), 'SSH key', () => checks(), { input: '\n\n\n' });
  const all = await checks();
  assert.match(find(all, 'ssh-agent').command!, /^ssh-add --apple-use-keychain /);
  await fixAndRecheck(all, 'ssh-agent', () => checks());
});

test('macOS: no Docker, fixed with the suggested command (Colima and docker)', { skip: only('darwin') }, async (t) => {
  if (existsSync('/Applications/Docker.app')) { t.skip('Docker Desktop is installed here'); return; }
  home();
  const all = await checks();
  const d = find(all, 'Docker on this computer');
  if (d.ok) { t.skip(`Docker is set up already: ${d.detail}`); return; }
  assert.equal(d.command, 'brew install colima docker');
  await fixAndRecheck(all, 'Docker on this computer', () => checks());
});

// ---- Windows ----

test('Windows: the elevated window keeps the exit code and the error', { skip: only('win32') }, async () => {
  const errorFile = join(root, 'elevated-error.txt');
  const run = (command: string) => paste(elevatedPowerShell(command, errorFile, false).at(-1)!);
  assert.equal(run('Write-Output fine').code, 0);
  const failed = run("throw 'it broke'");
  assert.equal(failed.code, 1, failed.out);
  assert.match(readFileSync(errorFile, 'utf8'), /it broke/);
  rmSync(errorFile, { force: true });
  assert.equal(run('cmd.exe /c exit 3').code, 1, 'a failing program fails too');
});

test('Windows: the OpenSSH Client feature the fix adds exists under that name', { skip: only('win32') }, async () => {
  const out = pasteOk("(Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0').Name");
  assert.match(out, /OpenSSH\.Client~~~~0\.0\.1\.0/);
});

test('Windows: the ssh-agent service stopped, fixed with the suggested command in an elevated window', { skip: only('win32') }, async () => {
  home();
  pasteOk('Stop-Service ssh-agent -ErrorAction SilentlyContinue; Set-Service ssh-agent -StartupType Disabled');
  let all = await checks();
  const a = find(all, 'ssh-agent');
  assertClear(a, os);
  assert.equal(a.detail, 'the OpenSSH Authentication Agent service is not running');
  assert.equal(a.admin, true);
  const errorFile = join(root, 'agent-error.txt');
  const r = paste(elevatedPowerShell(a.command!, errorFile, false).at(-1)!);
  assert.equal(r.code, 0, `${r.out}${existsSync(errorFile) ? readFileSync(errorFile, 'utf8') : ''}`);
  all = await checks();
  assert.equal(find(all, 'ssh-agent').detail, 'no keys in the agent', 'the service runs now');
  // A key (ssh-keygen's questions are covered on macOS and Linux), then the suggested ssh-add
  mkdirSync(join(process.env.USERPROFILE!, '.ssh'), { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(process.env.USERPROFILE!, '.ssh', 'id_ed25519')]);
  await fixAndRecheck(await checks(), 'ssh-agent', () => checks());
  paste('ssh-add -D');
});

test('Windows: the winget packages the commands install exist', { skip: only('win32') }, async (t) => {
  if (paste('winget --version').code !== 0) { t.skip('winget is not on this runner'); return; }
  for (const id of ['Git.Git', 'GnuPG.Gpg4win']) {
    const r = paste(`winget show --id ${id} -e --accept-source-agreements --disable-interactivity`);
    assert.equal(r.code, 0, `winget has no ${id}: ${r.out}`);
  }
});
