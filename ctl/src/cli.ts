// fnkc-ctl: starts project containers for Positron on this computer or on a server.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { addUser, adminOptions, listUsers, removeUser } from './admin.ts';
import { offboardingReport, unverifiedProjects } from './offboard.ts';
import { Agent } from './agent.ts';
import { agentConfig, readJsonFile, unknownConfigKeys } from './agent-config.ts';
import { formatAdminStatus, readAdminStatus } from './admin-status.ts';
import { Docker } from './docker.ts';
import { resolveHostImage } from './host-image.ts';
import { loadClientConfig, requireHosts } from './client/config.ts';
import { runChecks } from './client/doctor.ts';
import { applyCleanup, cleanupPlan, cleanupText, digestsIn, loadOverview, overviewText } from './client/images.ts';
import { type HostStop, listProjects, openProject, stopProject, stopSummary } from './client/open.ts';
import { checkRemoval, deleteProject, lostWork, removalReport } from './client/remove.ts';
import { removeSshSetup, sshIncludePresent } from './client/ssh.ts';
import { localPositron, positronCli } from './client/positron.ts';
import { extendPath, run } from './exec.ts';
import { stderrLogger } from './log.ts';
import { CAPABILITIES, CTL_VERSION, PROTOCOL_VERSION, type StartResult } from './protocol.ts';
import { Entry, formatSupportExport, keyFingerprint, readJournal, sshClient, startFields, supportExport } from './journal.ts';
import { environmentOf, finishBuild, startBuild } from './client/build.ts';
import { teamPositron } from './client/variant.ts';
import { answer, handle, parseCommand, readStdin } from './serve.ts';
import { withLock } from './lock.ts';
import { join } from 'node:path';
import { sanitizeUser } from './validate.ts';
import { ReplacementNotReady } from './errors.ts';

const HELP = `fnkc-ctl ${CTL_VERSION}: project containers for Positron, on this computer or on a server

On your computer:
  fnkc-ctl open <project> [--host <name>] [--unlock] [--no-window] [--discard-replacement]
      start the project's container (on the first reachable host, or --host) and open it in Positron;
      <project> is a repository name under gitRemotes, owner/name on that Gitea, a link to the repository from
      Gitea's web pages, or a full git URL; the container and the projects list
      use the repository's name, and the repository is cloned inside the container;
      --discard-replacement: a new environment container that does not start is removed and started afresh
      (the project's files are kept)
  fnkc-ctl stop <project> [--host <name>] [--status-file <file>]
      stop the container (volumes are kept; dependencies are unchanged); owner/name or a URL stops only that
      repository's container; without --host on every host: exits 1 if a host could not be checked (the
      others are still stopped); --status-file writes the outcome on each host as JSON
  fnkc-ctl remove <project> --host <name> [--delete] [--lose-work]
      what deleting the stopped project would lose (work not on Gitea, file by file) and which container,
      volumes and network go; --delete deletes them if all work is on Gitea, --delete --lose-work also otherwise
  fnkc-ctl ssh-config [--remove]              whether ~/.ssh/config includes the project connections (~/.ssh/fnkc);
      --remove takes the Include line and ~/.ssh/fnkc out again (the next Open adds them back)
  fnkc-ctl list                               containers on all hosts
  fnkc-ctl images [--templates <pattern>]     environment images: published ones by R series, which image each Gitea
      template pins (templateRepository in the config, default
      template-r-{series}, or --templates), what each host has and its containers use
  fnkc-ctl images --cleanup [--older-than <days>] [--keep <file>] [--delete]
      what can go from the registry: environments that are not the newest of their series, not pinned by a
      template or in --keep (a file with the digests all projects pin), not used by containers on the hosts, and
      at least --older-than days old (default 30), with their Positron layers; and layers for an old Positron
      nobody uses. --delete removes them (gh, with delete:packages); otherwise only lists them
  fnkc-ctl doctor [--json]                    check this computer's setup (key, agent, Gitea, hosts, Docker)
  fnkc-ctl build <environment image | R series> [--positron <version>] [--wait <run id>]
      add the server of a Positron version (default: the Positron on this computer) to an R environment (as
      container.json pins it; or the newest of a series) in GitHub CI (positron workflow of envRepository, with
      gh): projects on that environment then open from that Positron. --wait: wait again for a run started before
  Options: --config <file> (default: $FNKC_CTL_CONFIG or ~/.config/fnkc-ctl/config.json; it names the hosts, there is none without it)
  fnkc-ctl --version [--json]                 this build; --json adds the protocol and capabilities it needs from a server

On a Docker host (what the commands above call; replies are JSON):
  fnkc-ctl agent ping|list|images|stop <project> [<repository>]|checkout <project>|remove-check <project>|remove <project> <fingerprint>|start|install-image <image> [--user <name>] [--agent-config <file>]
      start reads the request as JSON on stdin; install-image reads the image the client sends
  fnkc-ctl serve --user <name> [--agent-config <file>]
      forced command for the server's fnkc account: runs the agent command in SSH_ORIGINAL_COMMAND
      and writes one line per request to the system journal (journalctl -t fnkc-ctl)
  Agent config: --agent-config, $FNKC_CTL_AGENT_CONFIG, or /etc/fnkc-ctl/agent.json if it exists

On a server, as root (who may start containers there):
  fnkc-ctl admin add-user <name> <public key file | "ssh-ed25519 AAAA...">
  fnkc-ctl admin remove-user <name> [--lose-work]
      revoke the key, then stop the user's projects; refused while a project has work not on Gitea or cannot be
      checked (as admin remove-project shows); --lose-work revokes at once, without the check
  fnkc-ctl admin list-users
  fnkc-ctl admin status [--sizes] [--json]
      every user's projects (also of removed users): state, last start, memory, image, Positron, volumes; the host's
      memory against its limits. --sizes adds the volume sizes (slow on a full disk)
  fnkc-ctl admin projects <user> [--sizes] [--json]
      the same for one user, also after admin remove-user
  fnkc-ctl admin remove-project <user> <project> [--delete] [--lose-work]
      what deleting the project would lose (as fnkc-ctl remove shows it); --delete deletes it unless work is not on
      Gitea, --lose-work deletes it anyway. A running project is stopped first: admin stop-all <user>
  fnkc-ctl admin stop-all <user> | --all-users [--yes]
      stops the running projects (of one user, or of all: before a reboot or an upgrade); lists them and asks first
  fnkc-ctl admin support-export [--since <time>] [--identifiers] [--json]
      the request journal for a support ticket (default: the last day; --since takes journalctl's times): command,
      result, error category, duration, versions; users, addresses, projects, images and messages are left out
      unless --identifiers (then review it before sharing, as raw journalctl output)
  fnkc-ctl admin check-config [file]
      checks agent.json (default: as for the agent) and prints the settings in force, defaults filled in; warns
      about keys it ignores (typos). Needs no root; run it after every edit
  fnkc-ctl admin resolve-image <repository@sha256:...>
      prints the local image ID of an allowed image after checking provenance (if required) and that Docker's name
      for it still points at the image the digest names; volume-backup.sh and render-reviewed.py run only that ID
  Options: --account <service account> (default fnkc), --agent-config <file> (for keysDir)
`;

/** Asks on the terminal; --yes answers for scripts. */
async function confirm(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('this needs a confirmation: run it in a terminal, or add --yes');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await new Promise<string>((r) => rl.question(`${question} [y/N] `, r))).trim());
  } finally { rl.close(); }
}

function loadAgentFile(path: string | undefined): Record<string, unknown> {
  const p = path ?? process.env.FNKC_CTL_AGENT_CONFIG;
  if (p) return readJsonFile(p);
  return existsSync('/etc/fnkc-ctl/agent.json') ? readJsonFile('/etc/fnkc-ctl/agent.json') : {};
}

async function main(argv: string[]): Promise<number> {
  extendPath();
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      unlock: { type: 'boolean' },
      positron: { type: 'string' },
      wait: { type: 'string' },
      'no-window': { type: 'boolean' },
      'discard-replacement': { type: 'boolean' },
      config: { type: 'string' },
      templates: { type: 'string' },
      cleanup: { type: 'boolean' },
      'older-than': { type: 'string' },
      keep: { type: 'string' },
      delete: { type: 'boolean' },
      'lose-work': { type: 'boolean' },
      remove: { type: 'boolean' },
      user: { type: 'string' },
      account: { type: 'string' },
      'agent-config': { type: 'string' },
      'status-file': { type: 'string' },
      sizes: { type: 'boolean' },
      'all-users': { type: 'boolean' },
      since: { type: 'string' },
      identifiers: { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const [cmd, ...rest] = pos;
  // --json: what this build needs from a server (published with each release: client/update.ts, Requirements)
  if (o.version) return console.log(o.json ? JSON.stringify({ version: CTL_VERSION, protocol: PROTOCOL_VERSION, capabilities: CAPABILITIES }) : CTL_VERSION), 0;
  if (o.help || !cmd) return process.stdout.write(HELP), cmd || o.help ? 0 : 2;
  const log = stderrLogger;

  switch (cmd) {
    case 'agent': {
      const agent = new Agent(agentConfig(o.user ?? sanitizeUser(userInfo().username), loadAgentFile(o['agent-config'])), log);
      return answer(() => handle(agent, rest, readStdin));
    }
    case 'serve': {
      if (!o.user) throw new Error('serve: --user is required');
      const user = o.user;
      // One journal line per request, whatever its outcome (journal.ts)
      const entry = new Entry({ user, from: sshClient() });
      try {
        const file = loadAgentFile(o['agent-config']);
        if (!file.keysDir) throw new Error('server mode requires keysDir');
        const agent = new Agent(agentConfig(user, file), entry.tee(log));
        const words = parseCommand(process.env.SSH_ORIGINAL_COMMAND ?? '');
        const [command, arg] = words;
        entry.set({ command, ...(command === 'install-image' ? { image: arg } : { project: arg }) });
        if (command === 'connect') {
          if (words.length !== 2) throw new Error('connect requires exactly one project');
          await agent.connectProject(words[1]);
          entry.end();
          return 0;
        }
        const input = async () => {
          const raw = await readStdin();
          entry.set(startFields(raw));
          return raw;
        };
        return await answer(() => handle(agent, words, input), (error, result) => {
          if (command === 'start' && result) {
            const r = result as StartResult;
            entry.set({ running: r.image, created: r.created, updatePending: r.updatePending });
          }
          entry.end(error);
        });
      } catch (e) {
        entry.end(e);
        throw e;
      }
    }
    case 'admin': {
      if (rest[0] === 'check-config') {
        if (rest.length > 2) throw new Error('usage: fnkc-ctl admin check-config [file]');
        const file = loadAgentFile(rest[1] ?? o['agent-config']);
        const { user: _, ...effective } = agentConfig('check', file);
        for (const u of unknownConfigKeys(file)) {
          log.warn(`"${u.key}" is not a setting and is ignored${u.suggestion ? ` (did you mean "${u.suggestion}"?)` : ''}`);
        }
        console.log(JSON.stringify(effective, null, 2));
        return 0;
      }
      if (rest[0] === 'resolve-image') {
        // Read-only, for the host's backup helper (volume-backup.sh): the immutable ID of an approved, verified image
        if (rest.length !== 2) throw new Error('usage: fnkc-ctl admin resolve-image <repository@sha256:...>');
        const cfg = agentConfig('check', loadAgentFile(o['agent-config']));
        console.log(await resolveHostImage(cfg, new Docker(cfg.docker), rest[1]));
        return 0;
      }
      if (process.getuid?.() !== 0) throw new Error('admin commands require root');
      if (rest[0] === 'support-export') {
        // For a support ticket: how requests went, without who, from where, on which project, or message text (journal.ts)
        if (rest.length !== 1) throw new Error('usage: fnkc-ctl admin support-export [--since <time>] [--identifiers] [--json]');
        const since = o.since ?? '-1d';
        const x = supportExport(readJournal(since), since, !!o.identifiers);
        process.stdout.write(o.json ? `${JSON.stringify(x, null, 2)}\n` : formatSupportExport(x));
        if (o.identifiers) log.warn('this export names users, addresses and projects and quotes messages: review it before sharing');
        return 0;
      }
      const file = loadAgentFile(o['agent-config']);
      const keysDir = file.keysDir;
      const opts = adminOptions(typeof keysDir === 'string' ? keysDir : undefined, o.account);
      const [sub, name, key] = rest;
      // Changes to who may use the server, and what root stops or deletes, are journalled with the administrator (sudo)
      const entry = new Entry({ user: name, command: `admin-${sub}`, by: process.env.SUDO_USER });
      if (sub === 'add-user' && name && key) {
        const cfg = agentConfig(name, file);
        try {
          await withLock(join(cfg.lockDir, 'host'), async () => {
            log.info(`${name} may now start containers here (${addUser(name, key, opts)})`);
          });
          entry.set({ key: keyFingerprint(readFileSync(join(opts.keysDir, `${name}.pub`), 'utf8')) });
          entry.end();
        } catch (e) { entry.end(e); throw e; }
      } else if (sub === 'remove-user' && name) {
        const cfg = agentConfig(name, file);
        const keyFile = join(opts.keysDir, `${name}.pub`);
        if (existsSync(keyFile)) entry.set({ key: keyFingerprint(readFileSync(keyFile, 'utf8')) });
        // Q4: all work must be on Gitea before the key goes (a revoked user cannot push it, nobody else can). Only while
        // the user still has access (run again after a failed stop, it only stops), and not with --lose-work: an urgent
        // revocation never waits for the inspection.
        const checked = !o['lose-work'] && (listUsers(opts).includes(name) || existsSync(keyFile));
        entry.set({ lostWork: !!o['lose-work'] });
        if (o['lose-work']) log.warn(`--lose-work: revoking without checking ${name}'s projects for work not on Gitea; see it later: fnkc-ctl admin remove-project ${name} <project>`);
        try {
          if (checked) {
            const agent = new Agent(cfg, log, undefined, { asAdmin: true });
            const projects = (await readAdminStatus(agent.docker, cfg, listUsers(opts), false)).projects
              .filter((p) => p.user === name).map((p) => p.project);
            const found = await unverifiedProjects(projects, (p) => agent.removalCheck(p));
            const { lines, refusal } = offboardingReport(name, found);
            for (const l of lines) log.info(l);
            entry.set({ unverified: found.map((p) => p.project).join(',') });
            if (refusal) {
              log.warn(refusal);
              entry.end(new Error('not revoked: work not on Gitea or not checked'));
              return 1;
            }
          }
          // The key goes first (under the host lock, like add-user): from then on every request of the user fails,
          // and a start in progress fails its check under the host lock. Then each project stops under its own lock.
          await withLock(join(cfg.lockDir, 'host'), async () => { removeUser(name, opts); });
          const { stopped, failed } = await new Agent(cfg, log, undefined, { asAdmin: true }).stopAll();
          entry.set({ stopped: stopped.join(','), failed: failed.join(',') });
          if (stopped.length) log.info(`stopped: ${stopped.join(', ')}`);
          // The check refused running projects, so these were opened after it: their work since then is not checked
          if (checked && stopped.length) {
            log.warn(`opened after the check: ${stopped.join(', ')}; see what is not on Gitea: fnkc-ctl admin remove-project ${name} <project>`);
          }
          if (failed.length) {
            for (const f of failed) log.warn(`could not stop ${f}`);
            throw new Error(`${name} is revoked, but ${failed.length} container(s) still run: stop them with docker stop after inspection`);
          }
          entry.end();
        } catch (e) { entry.end(e); throw e; }
        const left = (await readAdminStatus(new Agent(cfg, log).docker, cfg, listUsers(opts), false)).projects.filter((p) => p.user === name);
        log.info(`${name} revoked; containers stopped, volumes kept for you to decide`);
        for (const p of left) log.info(`  ${p.project}: ${p.state}; volumes ${p.volumes.map((v) => v.name).join(', ') || 'none'}`);
        if (left.length) log.info(`See what deleting one would lose: fnkc-ctl admin remove-project ${name} <project>`);
      } else if (sub === 'list-users') {
        for (const u of listUsers(opts)) console.log(u);
      } else if ((sub === 'status' && !name) || (sub === 'projects' && name)) {
        const cfg = agentConfig(name ?? 'root', file);
        const status = await readAdminStatus(new Agent(cfg, log).docker, cfg, listUsers(opts), !!o.sizes);
        if (sub === 'projects') status.projects = status.projects.filter((p) => p.user === name);
        process.stdout.write(o.json ? JSON.stringify(status, null, 2) + '\n' : formatAdminStatus(status));
      } else if (sub === 'remove-project' && name && key) {
        const agent = new Agent(agentConfig(name, file), log, undefined, { asAdmin: true });
        const check = await agent.removalCheck(key);
        process.stdout.write(removalReport(check, hostname()));
        if (!o.delete) return 0;
        if (lostWork(check).length && !o['lose-work']) {
          log.warn(`not deleted: the work above is not on Gitea. Ask ${name} to push it (only they can, and only until admin remove-user), or add --lose-work to delete it anyway`);
          return 1;
        }
        entry.set({ project: key, lostWork: lostWork(check).length > 0 });
        try {
          const { removed } = await agent.remove(key, check.fingerprint);
          entry.set({ removed: removed.join(',') });
          entry.end();
          log.info(`Deleted ${name}'s ${key}: ${removed.join(', ')}`);
        } catch (e) { entry.end(e); throw e; }
      } else if (sub === 'stop-all' && (name ? !o['all-users'] : o['all-users'])) {
        const cfg = agentConfig(name ?? 'root', file);
        const status = await readAdminStatus(new Agent(cfg, log).docker, cfg, listUsers(opts), false);
        const running = status.projects.filter((p) => p.running && (!name || p.user === name));
        if (!running.length) return log.info('no project is running'), 0;
        for (const p of running) console.log(`  ${p.user}: ${p.project}${p.lastStart ? ` (since ${p.lastStart.slice(0, 16).replace('T', ' ')})` : ''}`);
        if (!(await confirm(`Stop these ${running.length} project(s)? Unsaved work in their sessions is lost`, o.yes))) return log.info('nothing stopped'), 1;
        const failures: string[] = [];
        const done: string[] = [];
        for (const user of [...new Set(running.map((p) => p.user))]) {
          const { stopped, failed } = await new Agent(agentConfig(user, file), log, undefined, { asAdmin: true }).stopAll();
          if (stopped.length) log.info(`${user}: stopped ${stopped.join(', ')}`);
          done.push(...stopped.map((p) => `${user}/${p}`));
          failures.push(...failed.map((f) => `${user}: ${f}`));
        }
        for (const f of failures) log.warn(`could not stop ${f}`);
        entry.set({ user: name ?? '*', stopped: done.join(','), failed: failures.join(',') });
        entry.end(failures.length ? new Error(`${failures.length} project(s) could not be stopped`) : undefined);
        return failures.length ? 1 : 0;
      } else {
        throw new Error('usage: fnkc-ctl admin add-user <name> <key> | remove-user <name> [--lose-work] | list-users | status | projects <user> | ' +
          'remove-project <user> <project> [--delete] [--lose-work] | stop-all <user> | stop-all --all-users | support-export | check-config [file] | resolve-image <image>');
      }
      return 0;
    }
    case 'open': {
      if (rest.length !== 1) throw new Error('usage: fnkc-ctl open <project> [--host <name>] [--unlock] [--discard-replacement]');
      const cfg = loadClientConfig(o.config);
      // Before Positron is looked for: without a configuration every other problem is a consequence of it
      requireHosts(cfg);
      const positron = localPositron();
      const r = await openProject(cfg, rest[0], { host: o.host, unlock: o.unlock, positron, discardReplacement: o['discard-replacement'] }, log)
        .catch((e: unknown) => {
          if (!(e instanceof ReplacementNotReady)) throw e;
          throw new Error(`${e.message}\nTo remove the container that does not start and start it afresh (the project's files are kept): ` +
            `fnkc-ctl open ${rest[0]}${o.host ? ` --host ${o.host}` : ''} --discard-replacement`);
        });
      const cli = positronCli(positron);
      if (!o['no-window'] && cli) {
        log.info(`Opening ${r.folder} on ${r.alias} in Positron`);
        await run(cli, ['--new-window', '--remote', `ssh-remote+${r.alias}`, r.folder], { timeoutMs: 30_000 });
      } else {
        log.info(`Ready. In Positron: Remote SSH -> ${r.alias}, folder ${r.folder}`);
      }
      return 0;
    }
    case 'build': {
      if (rest.length !== 1) throw new Error('usage: fnkc-ctl build <environment image | R series> [--positron <version>] [--wait <run id>]');
      const cfg = loadClientConfig(o.config);
      const req = { environment: await environmentOf(cfg, rest[0]), positron: o.positron ?? localPositron().version };
      let id: number;
      if (o.wait) {
        id = Number(o.wait);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('--wait takes the run id (the number in the run URL)');
      } else {
        const started = await startBuild(cfg, req, log);
        log.info(`Run ${started.id}: ${started.url} (Ctrl+C stops waiting, not the build; then: fnkc-ctl build ${req.environment} --positron ${req.positron} --wait ${started.id})`);
        id = started.id;
      }
      const image = await finishBuild(cfg, req, id, log);
      log.info(`Built: projects on ${req.environment} now open from Positron ${req.positron}`);
      console.log(image);
      return 0;
    }
    case 'stop': {
      if (rest.length !== 1) throw new Error('usage: fnkc-ctl stop <project> [--host <name>] [--status-file <file>]');
      // --status-file: the outcome as JSON, for the extension's stop in the background (its window has closed)
      // hosts: the outcome on each host (stopProject); ok is false if a host could not be checked
      const status = (ok: boolean, message: string, hosts?: HostStop[]) => {
        if (o['status-file']) writeFileSync(o['status-file'], JSON.stringify({ ok, project: rest[0], host: o.host, message, hosts, at: new Date().toISOString() }));
      };
      try {
        const results = await stopProject(loadClientConfig(o.config), rest[0], o.host, log);
        const { message, found, failed } = stopSummary(rest[0], results);
        // A host that could not be checked may still run the project: a partial stop is a failure (exit 1)
        if (found && !failed) log.info(message); else log.warn(message);
        status(!failed, message, results);
        return failed ? 1 : 0;
      } catch (e) {
        status(false, (e as Error).message);
        throw e;
      }
    }
    case 'remove': {
      if (rest.length !== 1 || !o.host) throw new Error('usage: fnkc-ctl remove <project> --host <name> [--delete] [--lose-work]');
      const cfg = loadClientConfig(o.config);
      const check = await checkRemoval(cfg, rest[0], o.host, log);
      process.stdout.write(removalReport(check, o.host));
      if (!o.delete) return 0;
      if (lostWork(check).length && !o['lose-work']) {
        log.warn('not deleted: the work above is not on Gitea. Push it first, or add --lose-work to delete it anyway');
        return 1;
      }
      const removed = await deleteProject(cfg, check, o.host, log);
      log.info(`Deleted ${check.project} on ${o.host}: ${removed.join(', ')}`);
      return 0;
    }
    case 'ssh-config': {
      const { sshDir } = loadClientConfig(o.config);
      if (o.remove) {
        const done = removeSshSetup(sshDir);
        log.info(done.length ? `Removed ${done.join(' and ')}` : 'There was no FNKC Projects SSH configuration');
      } else {
        console.log(sshIncludePresent(sshDir) ? `${sshDir}/config includes ${sshDir}/fnkc/*.conf` : `${sshDir}/config does not include the project connections (Open adds it)`);
      }
      return 0;
    }
    case 'doctor': {
      const doctorCfg = loadClientConfig(o.config);
      const checks = await runChecks(doctorCfg, log, { teamPositron: () => teamPositron(doctorCfg.cacheDir, doctorCfg.envRepository) });
      if (o.json) console.log(JSON.stringify(checks));
      else {
        for (const c of checks) {
          console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
          if (!c.ok && c.fix) console.log(`     -> ${c.fix}`);
          if (!c.ok && c.command) console.log(`        ${c.command}${c.admin ? (process.platform === 'win32' ? '   (PowerShell as administrator)' : '   (asks for your password)') : ''}`);
          if (!c.ok && c.manual) console.log(`     by hand: ${c.manual}`);
        }
      }
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    case 'list': {
      const cfg = loadClientConfig(o.config);
      requireHosts(cfg);
      for (const h of await listProjects(cfg, log)) {
        console.log(`== ${h.host}${h.error ? `: unreachable (${h.error})` : ''}`);
        for (const c of h.containers) {
          console.log(`  ${c.project.padEnd(24)} ${c.state.padEnd(10)} ${(c.memory ?? '').padEnd(20)} ${c.image}`);
        }
      }
      return 0;
    }
    case 'images': {
      const cfg = loadClientConfig(o.config);
      const quiet = { info() {}, warn() {} };
      const o2 = await loadOverview(cfg, o.templates ?? cfg.templateRepository, quiet, listProjects(cfg, quiet));
      if (!o.cleanup) {
        console.log(overviewText(o2));
        return o2.registry.error ? 1 : 0;
      }
      const days = o['older-than'] === undefined ? 30 : Number(o['older-than']);
      if (!Number.isFinite(days) || days < 0) throw new Error(`--older-than must be a number of days, not '${o['older-than']}'`);
      const keep = o.keep ? digestsIn(readFileSync(o.keep, 'utf8')) : undefined;
      const plan = cleanupPlan(o2, { olderThanDays: days, keep });
      console.log(cleanupText(plan));
      if (!o.delete || !plan.removals.length) return plan.blockers.length ? 1 : 0;
      const deleted = await applyCleanup(cfg, plan, log);
      console.log(`\nDeleted ${deleted.length} registry entr${deleted.length === 1 ? 'y' : 'ies'}:\n${deleted.map((d) => `  ${d}`).join('\n')}`);
      return 0;
    }
    default:
      throw new Error(`unknown command '${cmd}' (fnkc-ctl --help)`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: Error) => { process.stderr.write(`Error: ${e.message}\n`); process.exitCode = 1; },
);
