// positron-ctl: starts project containers for Positron on this computer or on a server.
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { addUser, adminOptions, listUsers, removeUser } from './admin.ts';
import { Agent } from './agent.ts';
import { agentConfig, readJsonFile } from './agent-config.ts';
import { loadClientConfig } from './client/config.ts';
import { runChecks } from './client/doctor.ts';
import { listProjects, openProject, stopProject } from './client/open.ts';
import { localPositron, positronCli } from './client/positron.ts';
import { extendPath, run } from './exec.ts';
import { stderrLogger } from './log.ts';
import { CTL_VERSION, type LibraryBuild } from './protocol.ts';
import type { LibraryInfo } from './library.ts';
import { LocalTransport } from './client/transport.ts';
import { answer, handle, parseCommand, readStdin } from './serve.ts';
import { LABEL } from './layout.ts';
import { withLock } from './lock.ts';
import { join } from 'node:path';
import { sanitizeUser } from './validate.ts';

const HELP = `positron-ctl ${CTL_VERSION}: project containers for Positron, on this computer or on a server

On your computer:
  positron-ctl open <project> [--host <name>] [--unlock] [--no-window]
      start the project's container (on the first reachable host, or --host) and open it in Positron;
      <project> is a repository name under gitRemotes, or a full git URL
  positron-ctl stop <project> [--host <name>]     stop the container (the project volumes are kept)
  positron-ctl list                               containers on all hosts
  positron-ctl doctor                             check this computer's setup (key, agent, Gitea, hosts, Docker)
  positron-ctl build-library <image> <renv.lock> [--jobs <n>] [--skip-checks]
      build an R library for projects that pin it ("library" in container.json) in Docker on this computer:
      packages from source for the image, then the R environment checks; prints the "library" value
  positron-ctl libraries                          R libraries built in Docker on this computer
  Options: --config <file> (default: $POSITRON_CTL_CONFIG or ~/.config/positron-ctl/config.json)

On a Docker host (what the commands above call; replies are JSON):
  positron-ctl agent ping|list|stop <project>|start [--user <name>] [--agent-config <file>]
      start reads the request as JSON on stdin
  positron-ctl serve --user <name> [--agent-config <file>]
      forced command for the server's positron account: runs the agent command in SSH_ORIGINAL_COMMAND
  Agent config: --agent-config, $POSITRON_CTL_AGENT_CONFIG, or /etc/positron-ctl/agent.json if it exists

On a server, as root (who may start containers there):
  positron-ctl admin add-user <name> <public key file | "ssh-ed25519 AAAA...">
  positron-ctl admin remove-user <name>
  positron-ctl admin list-users
  positron-ctl admin build-library <image> <renv.lock> [--jobs <n>] [--skip-checks]
      the same as build-library above, for the projects on this server (packages from rRepository)
  positron-ctl admin libraries
  Options: --account <service account> (default positron), --agent-config <file> (for keysDir)
`;

function loadAgentFile(path: string | undefined): Record<string, unknown> {
  const p = path ?? process.env.POSITRON_CTL_AGENT_CONFIG;
  if (p) return readJsonFile(p);
  return existsSync('/etc/positron-ctl/agent.json') ? readJsonFile('/etc/positron-ctl/agent.json') : {};
}

function buildOptions(o: { jobs?: string; 'skip-checks'?: boolean }) {
  if (o.jobs !== undefined && !/^[1-9][0-9]{0,2}$/.test(o.jobs)) throw new Error('--jobs must be a whole number from 1');
  return { jobs: o.jobs === undefined ? undefined : Number(o.jobs), skipChecks: o['skip-checks'] };
}

function printBuild(r: LibraryBuild) {
  stderrLogger.info(r.existing ? `Already built and checked: ${r.volume}` : `Built ${r.volume}; checks ${r.checks}`);
  stderrLogger.info(`Projects use it with this image in container.json: {"image": "${r.image}", "library": "${r.library}"}`);
  console.log(r.library);
}

function printLibraries(ls: LibraryInfo[]) {
  for (const l of ls) console.log(`${l.volume}  ${l.library}  image ${l.image}`);
}

async function main(argv: string[]): Promise<number> {
  extendPath();
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      host: { type: 'string' },
      unlock: { type: 'boolean' },
      'no-window': { type: 'boolean' },
      config: { type: 'string' },
      user: { type: 'string' },
      account: { type: 'string' },
      'agent-config': { type: 'string' },
      jobs: { type: 'string' },
      'skip-checks': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  const [cmd, ...rest] = pos;
  if (o.version) return console.log(CTL_VERSION), 0;
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
        await withLock(join(cfg.lockDir, 'host'), async () => {
          removeUser(name, opts);
          const d = new Agent(cfg, log).docker;
          for (const c of await d.containers([`${LABEL.managed}=1`, `${LABEL.user}=${name}`])) {
            if (c.State.Running) await d.ok(['stop', '--time', '30', c.Name.replace(/^\//, '')]);
          }
        });
        log.info(`${name} revoked; containers stopped, volumes retained for administrator archival`);
      } else if (sub === 'list-users') {
        for (const u of listUsers(opts)) console.log(u);
      } else if (sub === 'build-library' && name && key) {
        // As the service account's agent would see it: the same allowed images and R repository
        printBuild(await new Agent(agentConfig('admin', file), log).buildLibrary(name, readFileSync(key, 'utf8'), buildOptions(o)));
      } else if (sub === 'libraries') {
        printLibraries(await new Agent(agentConfig('admin', file), log).libraries());
      } else {
        throw new Error('usage: positron-ctl admin add-user <name> <key> | remove-user <name> | list-users | build-library <image> <renv.lock> | libraries');
      }
      return 0;
    }
    case 'open': {
      if (rest.length !== 1) throw new Error('usage: positron-ctl open <project> [--host <name>] [--unlock]');
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
    case 'stop': {
      if (rest.length !== 1) throw new Error('usage: positron-ctl stop <project> [--host <name>]');
      const on = await stopProject(loadClientConfig(o.config), rest[0], o.host, log);
      if (on.length) log.info(`Stopped ${rest[0]} on ${on.join(', ')}`);
      else log.warn(`no container of ${rest[0]} found on the reachable hosts`);
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
    case 'build-library': {
      if (rest.length !== 2) throw new Error('usage: positron-ctl build-library <image> <renv.lock> [--jobs <n>] [--skip-checks]');
      const agent = await new LocalTransport({ name: 'local' }, loadClientConfig(o.config), log).agent();
      printBuild(await agent.buildLibrary(rest[0], readFileSync(rest[1], 'utf8'), buildOptions(o)));
      return 0;
    }
    case 'libraries': {
      printLibraries(await (await new LocalTransport({ name: 'local' }, loadClientConfig(o.config), log).agent()).libraries());
      return 0;
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
    default:
      throw new Error(`unknown command '${cmd}' (positron-ctl --help)`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e: Error) => { process.stderr.write(`Error: ${e.message}\n`); process.exitCode = 1; },
);
