// fnkc-ctl: starts project containers for Positron on this computer or on a server.
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { addUser, adminOptions, listUsers, removeUser } from './admin.ts';
import { Agent } from './agent.ts';
import { agentConfig, readJsonFile } from './agent-config.ts';
import { loadClientConfig } from './client/config.ts';
import { runChecks } from './client/doctor.ts';
import { applyCleanup, cleanupPlan, cleanupText, digestsIn, loadOverview, overviewText } from './client/images.ts';
import { listProjects, openProject, stopProject } from './client/open.ts';
import { checkRemoval, deleteProject, lostWork, removalReport } from './client/remove.ts';
import { removeSshSetup, sshIncludePresent } from './client/ssh.ts';
import { localPositron, positronCli } from './client/positron.ts';
import { extendPath, run } from './exec.ts';
import { stderrLogger } from './log.ts';
import { CAPABILITIES, CTL_VERSION, PROTOCOL_VERSION } from './protocol.ts';
import { environmentOf, finishBuild, startBuild } from './client/build.ts';
import { answer, handle, parseCommand, readStdin } from './serve.ts';
import { withLock } from './lock.ts';
import { join } from 'node:path';
import { sanitizeUser } from './validate.ts';

const HELP = `fnkc-ctl ${CTL_VERSION}: project containers for Positron, on this computer or on a server

On your computer:
  fnkc-ctl open <project> [--host <name>] [--unlock] [--no-window]
      start the project's container (on the first reachable host, or --host) and open it in Positron;
      <project> is a repository name under gitRemotes, owner/name on that Gitea, a link to the repository from
      Gitea's web pages, or a full git URL; the container and the projects list
      use the repository's name, and the repository is cloned inside the container
  fnkc-ctl stop <project> [--host <name>]     stop the container (volumes are kept; dependencies are unchanged)
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
  fnkc-ctl doctor                             check this computer's setup (key, agent, Gitea, hosts, Docker)
  fnkc-ctl build <environment image | R series> [--positron <version>] [--wait <run id>]
      add the server of a Positron version (default: the Positron on this computer) to an R environment (as
      container.json pins it; or the newest of a series) in GitHub CI (positron workflow of envRepository, with
      gh): projects on that environment then open from that Positron. --wait: wait again for a run started before
  Options: --config <file> (default: $FNKC_CTL_CONFIG or ~/.config/fnkc-ctl/config.json)
  fnkc-ctl --version [--json]                 this build; --json adds the protocol and capabilities it needs from a server

On a Docker host (what the commands above call; replies are JSON):
  fnkc-ctl agent ping|list|images|stop <project>|remove-check <project>|remove <project> <fingerprint>|start|install-image <image> [--user <name>] [--agent-config <file>]
      start reads the request as JSON on stdin; install-image reads the image the client sends
  fnkc-ctl serve --user <name> [--agent-config <file>]
      forced command for the server's fnkc account: runs the agent command in SSH_ORIGINAL_COMMAND
  Agent config: --agent-config, $FNKC_CTL_AGENT_CONFIG, or /etc/fnkc-ctl/agent.json if it exists

On a server, as root (who may start containers there):
  fnkc-ctl admin add-user <name> <public key file | "ssh-ed25519 AAAA...">
  fnkc-ctl admin remove-user <name>
  fnkc-ctl admin list-users
  Options: --account <service account> (default fnkc), --agent-config <file> (for keysDir)
`;

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
      const file = loadAgentFile(o['agent-config']);
      if (!file.keysDir) throw new Error('server mode requires keysDir');
      const agent = new Agent(agentConfig(user, file), log);
      const words = parseCommand(process.env.SSH_ORIGINAL_COMMAND ?? '');
      if (words[0] === 'connect') {
        if (words.length !== 2) throw new Error('connect requires exactly one project');
        await agent.connectProject(words[1]);
        return 0;
      }
      return answer(() => handle(agent, words, readStdin));
    }
    case 'admin': {
      if (process.getuid?.() !== 0) throw new Error('admin commands require root');
      const file = loadAgentFile(o['agent-config']);
      const keysDir = file.keysDir;
      const opts = adminOptions(typeof keysDir === 'string' ? keysDir : undefined, o.account);
      const [sub, name, key] = rest;
      if (sub === 'add-user' && name && key) {
        const cfg = agentConfig(name, file);
        await withLock(join(cfg.lockDir, 'host'), async () => {
          log.info(`${name} may now start containers here (${addUser(name, key, opts)})`);
        });
      } else if (sub === 'remove-user' && name) {
        const cfg = agentConfig(name, file);
        // The key goes first (under the host lock, like add-user): from then on every request of the user fails,
        // and a start in progress fails its check under the host lock. Then each project stops under its own lock.
        await withLock(join(cfg.lockDir, 'host'), async () => { removeUser(name, opts); });
        const { stopped, failed } = await new Agent(cfg, log).stopAllForRevocation();
        if (stopped.length) log.info(`stopped: ${stopped.join(', ')}`);
        if (failed.length) {
          for (const f of failed) log.warn(`could not stop ${f}`);
          throw new Error(`${name} is revoked, but ${failed.length} container(s) still run: stop them with docker stop after inspection`);
        }
        log.info(`${name} revoked; containers stopped, volumes retained for administrator archival`);
      } else if (sub === 'list-users') {
        for (const u of listUsers(opts)) console.log(u);
      } else {
        throw new Error('usage: fnkc-ctl admin add-user <name> <key> | remove-user <name> | list-users');
      }
      return 0;
    }
    case 'open': {
      if (rest.length !== 1) throw new Error('usage: fnkc-ctl open <project> [--host <name>] [--unlock]');
      const positron = localPositron();
      const r = await openProject(loadClientConfig(o.config), rest[0], { host: o.host, unlock: o.unlock, positron }, log);
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
      if (rest.length !== 1) throw new Error('usage: fnkc-ctl stop <project> [--host <name>]');
      const on = await stopProject(loadClientConfig(o.config), rest[0], o.host, log);
      if (on.length) log.info(`Stopped ${rest[0]} on ${on.join(', ')}`);
      else log.warn(`no container of ${rest[0]} found on the reachable hosts`);
      return 0;
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
      const checks = await runChecks(loadClientConfig(o.config), log);
      for (const c of checks) {
        console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
        if (!c.ok && c.fix) console.log(`     -> ${c.fix}`);
        if (!c.ok && c.command) console.log(`        ${c.command}`);
      }
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    case 'list': {
      for (const h of await listProjects(loadClientConfig(o.config), log)) {
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
