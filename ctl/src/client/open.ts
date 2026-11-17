// What the Start / Stop / List buttons do. The CLI calls these functions, and the extension will too.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PositronServerMissing } from '../positron-server.ts';
import { forgetArchive, serverArchive } from './server-archive.ts';
import { withLock } from '../lock.ts';
import { run } from '../exec.ts';
import { projectFolder, sshAlias } from '../layout.ts';
import type { Logger } from '../log.ts';
import type { ContainerInfo } from '../protocol.ts';
import { checkProject } from '../validate.ts';
import type { ClientConfig, HostConfig } from './config.ts';
import { localPositron, type PositronClient } from './positron.ts';
import { projectSource, readProjectRevision } from './project.ts';
import { type ContainerSsh, containerSshArgs, gitSshTarget, writeSshConfig } from './ssh.ts';
import { type Transport, transportFor } from './transport.ts';

export interface OpenOptions {
  /** A host name from the config, or "auto" (default): the first configured host. */
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

/** The given host, or the first configured host for "auto". */
export async function pickHost(cfg: ClientConfig, name: string, log: Logger): Promise<Transport> {
  if (name !== 'auto') {
    const t = transportFor(hostByName(cfg, name), cfg, log);
    await t.ping();
    return t;
  }
  const errors: string[] = [];
  for (const h of cfg.hosts.slice(0, 1)) {
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

  const resolved = await readProjectRevision(src, cfg.cacheDir, log);
  const { image, library, revision } = resolved;
  const t = await pickHost(cfg, opts.host ?? 'auto', log);
  if (opts.unlock && !cfg.decryptionHosts.includes(t.host.name)) throw new Error(`decryption is not approved on host '${t.host.name}'; set decryptionHosts in your personal config`);
  return withLock(join(cfg.cacheDir, 'locks', 'open'), async () => {
  log.info(`Project ${src.name}: ${image}${library ? `, R library ${library.slice(0, 19)}...` : ''}, Positron ${positron.version}, host '${t.host.name}'`);
  await warnIfRunningElsewhere(cfg, t.host.name, src.name, log);

  const request = {
    project: src.name,
    image, ...(library ? { library } : {}), repository: src.urls[0], revision,
    positron: { version: positron.version, commit: positron.commit },
    sshPublicKey: readFileSync(`${key}.pub`, 'utf8').trim(),
  };
  let started;
  try {
    started = await t.start(request);
  } catch (e) {
    // First Open with this Positron version on the host: the archive comes from this computer, then retry
    if (!(e instanceof PositronServerMissing)) throw e;
    const file = await serverArchive(cfg.cacheDir, e.missing, log);
    try {
      await t.installServer(e.missing, file);
    } catch (err) {
      forgetArchive(cfg.cacheDir, e.missing);
      throw err;
    }
    started = await t.start(request);
  }

  const alias = sshAlias(src.name, t.host.name);
  const c: ContainerSsh = { port: started.sshPort, jump: t.jump, identity: key, project: src.name, alias,
    knownHosts: join(cfg.sshDir, 'positron', `${alias}.known_hosts`), hostKey: started.hostKey };
  log.info(`Using ${started.image} for checkout ${started.revision}`);
  const changed = writeSshConfig(cfg.sshDir, src.name, t.host.name, c);
  if (changed) log.info(changed);

  log.info('Waiting for the container to accept SSH');
  await waitForSsh(c);

  const agent = await run('ssh-add', ['-l']).catch(() => ({ code: 2 }));
  if (agent.code !== 0) log.warn('no keys in ssh-agent (ssh-add): git in the container will not be able to reach Gitea');
  const gitTarget = gitSshTarget(src.urls[0]);
  if (gitTarget) {
    const hostname = gitTarget.dest.split('@').pop()!;
    const lookup = gitTarget.port ? `[${hostname}]:${gitTarget.port}` : hostname;
    const trusted = await run('ssh-keygen', ['-F', lookup, '-f', join(cfg.sshDir, 'known_hosts')]);
    if (trusted.code !== 0) throw new Error(`verify and trust the Gitea host key for ${lookup} on this computer first`);
    const installed = await run('ssh', [...containerSshArgs(c), 'umask 077; cat > ~/.ssh/known_hosts'], { input: trusted.stdout });
    if (installed.code !== 0) throw new Error('could not install trusted git host keys');
  }
  log.info(`Initializing ${projectFolder(src.name)} (existing checkouts are preserved)`);
  const sync = await run('ssh', ['-A', ...containerSshArgs(c), 'positron-projects', 'init', src.name, started.revision, src.urls[0]], {
    onStderr: (l) => log.warn(l.replace(/^Warning:\s*/, '')),
  });
  if (sync.code !== 0) throw new Error(`project initialization failed: ${sync.stderr.trim()}`);

  const manifest = await run('ssh', [...containerSshArgs(c), `cat '${src.name}/container.json'`]);
  const checkout = manifest.code === 0 ? JSON.parse(manifest.stdout) as { image?: string; library?: string } : undefined;
  if (!checkout || checkout.image !== started.image || checkout.library !== started.library) throw new Error('checkout environment changed during Open; reopen to resolve it');
  if (opts.unlock) {
    log.info('git-crypt unlock');
    const r = await run('ssh', [...containerSshArgs(c), `cd '${src.name}' && git-crypt unlock /dev/stdin`], {
      input: createReadStream(cfg.gitCryptKey!),
    });
    if (r.code !== 0) throw new Error(`git-crypt unlock failed: ${r.stderr.trim()}`);
  }
  const state = await run('ssh', [...containerSshArgs(c), `cd '${src.name}' && positron-projects status`]);
  if (state.code !== 0) throw new Error(`could not verify project data state: ${state.stderr.trim()}`);
  log.info(`${state.stdout.trim()}. Ordinary Open never re-locks a previously unlocked checkout.`);
  return { project: src.name, host: t.host.name, alias, folder: projectFolder(src.name), container: started.container };
  });
}

async function waitForSsh(c: ContainerSsh, seconds = 30): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const r = await run('ssh', [...containerSshArgs(c, 5), 'true'], { timeoutMs: Math.min(7000, deadline - Date.now()) })
      .catch(() => ({ code: -1 }));
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
  if (!/^[A-Za-z0-9_.-]+$/.test(project)) project = projectSource(project, cfg.gitRemotes).name;
  else if (!/-[0-9a-f]{12}$/.test(project)) project = projectSource(project, cfg.gitRemotes).name;
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
