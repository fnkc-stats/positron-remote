// What the Start / Stop / List buttons do. The CLI calls these functions, and the extension will too.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { run } from '../exec.ts';
import { projectFolder, sshAlias } from '../layout.ts';
import type { Logger } from '../log.ts';
import type { ContainerInfo } from '../protocol.ts';
import { checkProject } from '../validate.ts';
import type { ClientConfig, HostConfig } from './config.ts';
import { localPositron, type PositronClient } from './positron.ts';
import { projectSource, readProjectImage } from './project.ts';
import { type ContainerSsh, containerSshArgs, writeSshConfig } from './ssh.ts';
import { type Transport, transportFor } from './transport.ts';

export interface OpenOptions {
  /** A host name from the config, or "auto" (default): the first reachable one. */
  host?: string;
  /** git-crypt unlock with the config's gitCryptKey after cloning. */
  unlock?: boolean;
  /** The Positron client; found automatically if not given. */
  positron?: PositronClient;
}

export interface OpenResult {
  project: string;
  host: string;
  /** SSH host to open in Positron Remote SSH. */
  alias: string;
  /** Folder to open in the container. */
  folder: string;
  container: string;
}

function hostByName(cfg: ClientConfig, name: string): HostConfig {
  const h = cfg.hosts.find((x) => x.name === name);
  if (!h) throw new Error(`unknown host '${name}' (known: ${cfg.hosts.map((x) => x.name).join(', ')})`);
  return h;
}

/** The given host, or the first reachable one for "auto". */
export async function pickHost(cfg: ClientConfig, name: string, log: Logger): Promise<Transport> {
  if (name !== 'auto') {
    const t = transportFor(hostByName(cfg, name), cfg, log);
    await t.ping();
    return t;
  }
  const errors: string[] = [];
  for (const h of cfg.hosts) {
    const t = transportFor(h, cfg, log);
    try {
      await t.ping();
      if (errors.length) log.warn(`using host '${h.name}': ${errors.join('; ')}`);
      return t;
    } catch (e) {
      errors.push(`'${h.name}' is unreachable (${(e as Error).message})`);
    }
  }
  throw new Error(`no host is reachable: ${errors.join('; ')}`);
}

export async function openProject(cfg: ClientConfig, projectArg: string, opts: OpenOptions, log: Logger): Promise<OpenResult> {
  const src = projectSource(projectArg, cfg.gitRemotes);
  const positron = opts.positron ?? localPositron();
  const key = cfg.sshKey;
  if (!key || !existsSync(`${key}.pub`)) throw new Error('no SSH key found: create one with ssh-keygen, or set "sshKey" in the config');
  if (opts.unlock && (!cfg.gitCryptKey || !existsSync(cfg.gitCryptKey))) throw new Error('--unlock: gitCryptKey in the config is not set or not found');

  const image = await readProjectImage(src, cfg.cacheDir, cfg.defaultImage, log);
  const t = await pickHost(cfg, opts.host ?? 'auto', log);
  log.info(`Project ${src.name}: ${image}, Positron ${positron.version}, host '${t.host.name}'`);
  await warnIfRunningElsewhere(cfg, t.host.name, src.name, log);

  const started = await t.start({
    project: src.name,
    image,
    positron: { version: positron.version, commit: positron.commit },
    sshPublicKey: readFileSync(`${key}.pub`, 'utf8').trim(),
  });

  const c: ContainerSsh = { port: started.sshPort, jump: t.jump, identity: key };
  const changed = writeSshConfig(cfg.sshDir, src.name, t.host.name, c);
  if (changed) log.info(changed);

  log.info('Waiting for the container to accept SSH');
  await waitForSsh(c);

  const agent = await run('ssh-add', ['-l']).catch(() => ({ code: 2 }));
  if (agent.code !== 0) log.warn('no keys in ssh-agent (ssh-add): git in the container will not be able to reach Gitea');
  log.info(`Syncing the project into ${projectFolder(src.name)}`);
  const sync = await run('ssh', ['-A', ...containerSshArgs(c), 'positron-projects', 'sync', src.name, ...src.urls], {
    onStderr: (l) => log.warn(l.replace(/^Warning:\s*/, '')),
  });
  if (sync.code !== 0) log.warn('sync finished with errors (the container is running; retry inside it: positron-projects sync)');

  if (opts.unlock) {
    log.info('git-crypt unlock');
    const r = await run('ssh', [...containerSshArgs(c), `cd '${src.name}' && git-crypt unlock /dev/stdin`], {
      input: createReadStream(cfg.gitCryptKey!),
    });
    if (r.code !== 0) log.warn(`git-crypt unlock failed (the working tree must be clean): ${r.stderr.trim()}`);
  }
  return { project: src.name, host: t.host.name, alias: sshAlias(src.name), folder: projectFolder(src.name), container: started.container };
}

async function waitForSsh(c: ContainerSsh, seconds = 30): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    const r = await run('ssh', [...containerSshArgs(c, 5), 'true']);
    if (r.code === 0) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('could not log in to the container over SSH (see: docker logs <container> on the host)');
}

/** Work in a container on another host is not lost, but it has to be pushed to git before moving. */
async function warnIfRunningElsewhere(cfg: ClientConfig, here: string, project: string, log: Logger) {
  for (const h of cfg.hosts) {
    if (h.name === here) continue;
    try {
      const t = transportFor(h, cfg, log);
      if ((await t.list()).some((c) => c.project === project && c.running)) {
        log.warn(`${project} is also running on '${h.name}': push your changes from there (positron-projects status) or stop it`);
      }
    } catch {
      // an unreachable host is not a problem here
    }
  }
}

export async function stopProject(cfg: ClientConfig, project: string, host: string | undefined, log: Logger): Promise<string[]> {
  checkProject(project);
  const hosts = host ? [hostByName(cfg, host)] : cfg.hosts;
  const stoppedOn: string[] = [];
  for (const h of hosts) {
    try {
      if ((await transportFor(h, cfg, log).stop(project)).stopped) stoppedOn.push(h.name);
    } catch (e) {
      if (host) throw e;
      log.warn(`'${h.name}': ${(e as Error).message}`);
    }
  }
  return stoppedOn;
}

export interface HostListing {
  host: string;
  error?: string;
  containers: ContainerInfo[];
}

export async function listProjects(cfg: ClientConfig, log: Logger): Promise<HostListing[]> {
  return Promise.all(
    cfg.hosts.map(async (h) => {
      try {
        return { host: h.name, containers: await transportFor(h, cfg, log).list() };
      } catch (e) {
        return { host: h.name, error: (e as Error).message, containers: [] };
      }
    }),
  );
}
