// What the Start / Stop / List buttons do. The CLI calls these functions, and the extension will too.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckoutPinsOther, EnvironmentImageMissing } from '../image-store.ts';
import { forgetImage, imageUpload, pruneImageCache } from './image-download.ts';
import { withLock } from '../lock.ts';
import { Cancelled, run, throwIfCancelled } from '../exec.ts';
import { projectFolder, sshAlias } from '../layout.ts';
import type { Logger } from '../log.ts';
import type { ContainerInfo, StartRequest } from '../protocol.ts';
import { checkProject } from '../validate.ts';
import type { ClientConfig, HostConfig } from './config.ts';
import { type DataState, dataState, decryptionApproved, unlockProject } from './decrypt.ts';
import { forgetChoice, imageToRun } from './variant.ts';
import { localPositron, type PositronClient } from './positron.ts';
import { projectSource, readProjectRevision } from './project.ts';
import { type ContainerSsh, containerSshArgs, gitSshTarget, pruneSshConfig, sshIncludePresent, writeSshConfig } from './ssh.ts';
import { type Transport, transportFor } from './transport.ts';

export interface OpenOptions {
  /** A host name from the config, or "auto" (default): the first configured host. */
  host?: string;
  /**
   * Decrypt the project's data if it is encrypted and still locked: true (fail if it cannot), false, or a question
   * to the user, asked only when decryption is possible on the host (a failure is then reported, not thrown).
   */
  unlock?: boolean | ((host: string) => Promise<boolean>);
  /** The Positron client; found automatically if not given. */
  positron?: PositronClient;
  /**
   * Asked before the first Open adds its Include line to ~/.ssh/config (Positron's Remote SSH finds the containers
   * through it); false stops the Open. Without it the line is added and logged (CLI).
   */
  confirmSshInclude?: () => Promise<boolean>;
  /** Cancels the Open (the extension's Cancel button): running commands are killed, the host keeps what it finished. */
  signal?: AbortSignal;
}

/** Open stopped because the user did not want the Include line in ~/.ssh/config. */
export class SshIncludeDeclined extends Error {
  constructor() {
    super('Open needs one Include line in ~/.ssh/config: Positron finds project containers through it. Nothing was changed.');
  }
}

export interface OpenResult {
  project: string;
  host: string;
  /** SSH host to open in Positron Remote SSH. */
  alias: string;
  /** Folder to open in the container. */
  folder: string;
  container: string;
  /** Whether the checkout is encrypted and decrypted, after Open. */
  data: DataState;
  /** Why the data was not decrypted when the user asked for it. */
  decryptError?: string;
  /** The container keeps running as it was; an environment or setup update waits for an explicit stop. */
  updatePending?: boolean;
}

function hostByName(cfg: ClientConfig, name: string): HostConfig {
  const h = cfg.hosts.find((x) => x.name === name);
  if (!h) throw new Error(`unknown host '${name}' (known: ${cfg.hosts.map((x) => x.name).join(', ')})`);
  return h;
}

/** The given host, or the first configured host for "auto". */
export async function pickHost(cfg: ClientConfig, name: string, log: Logger, signal?: AbortSignal): Promise<Transport> {
  if (name !== 'auto') {
    const t = transportFor(hostByName(cfg, name), cfg, log);
    t.signal = signal;
    await t.ping();
    return t;
  }
  const errors: string[] = [];
  for (const h of cfg.hosts.slice(0, 1)) {
    const t = transportFor(h, cfg, log);
    t.signal = signal;
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
  if (opts.unlock === true && cfg.gitCryptKey && !existsSync(cfg.gitCryptKey)) throw new Error(`--unlock: gitCryptKey ${cfg.gitCryptKey} is not found`);

  if (opts.confirmSshInclude && !sshIncludePresent(cfg.sshDir) && !(await opts.confirmSshInclude())) throw new SshIncludeDeclined();

  const resolved = await readProjectRevision(src, cfg.cacheDir, log);
  const { image, revision } = resolved;
  const signal = opts.signal;
  const t = await pickHost(cfg, opts.host ?? 'auto', log, signal);
  if (opts.unlock === true && !decryptionApproved(cfg, t.host)) throw new Error(`decryption is not approved on host '${t.host.name}'; set decryptionHosts in your personal config`);
  // One Open per project at a time; other projects open meanwhile (image downloads have their own lock)
  return withLock(join(cfg.cacheDir, 'locks', `open-${src.name}`), async () => {
  log.info(`Project ${src.name}: ${image}, Positron ${positron.version}, host '${t.host.name}'`);
  await warnIfRunningElsewhere(cfg, t.host.name, src.name, log);

  // container.json pins the R environment; the container runs it with the server of this Positron (variant.ts)
  const request: StartRequest = {
    project: src.name,
    image, repository: src.urls[0], revision,
    positron: { version: positron.version, commit: positron.commit },
    sshPublicKey: readFileSync(`${key}.pub`, 'utf8').trim(),
  };
  const choose = async (pinned: string) => {
    request.image = pinned;
    const run = await imageToRun(cfg.cacheDir, pinned, positron, log);
    if (run) request.positronImage = run; else delete request.positronImage;
  };
  await choose(image);
  // An image the host lacks comes from this computer, then Open retries: the first Open of this digest on the host,
  // and again if the checkout pins another environment (chosen for anew).
  let started;
  for (let attempt = 1; ; attempt++) {
    throwIfCancelled(signal);
    try {
      started = await t.start(request);
      break;
    } catch (e) {
      if (attempt === 4) throw e;
      if (e instanceof EnvironmentImageMissing) {
        let upload;
        try {
          upload = await imageUpload(cfg.cacheDir, e.missing, log, signal);
        } catch (err) {
          // The server image chosen at an earlier Open was removed from the registry since: look for it again
          // (a rebuilt one, or NoPositronImage, which offers Build Environment)
          if (request.positronImage?.image === e.missing.image && /HTTP 404/.test((err as Error).message)) {
            log.info(`${e.missing.image} is no longer in the registry; looking for the server of this Positron again`);
            forgetChoice(cfg.cacheDir, request.image, positron.commit);
            await choose(request.image);
            continue;
          }
          throw err;
        }
        try {
          await t.installImage(e.missing, upload);
          const freed = pruneImageCache(cfg.cacheDir, cfg.imageCacheLimit, upload);
          if (freed) log.info(`Removed ${Math.round(freed / 1e6)} MB of older images from this computer's download cache`);
        } catch (err) {
          // Only content the host rejected is downloaded again; an interrupted upload reuses the cache
          if (/does not match|wrong size/.test((err as Error).message)) forgetImage(cfg.cacheDir, upload);
          throw err;
        }
      } else if (e instanceof CheckoutPinsOther) {
        log.info(`The checkout pins ${e.pinned}`);
        await choose(e.pinned);
      } else throw e;
    }
  }

  throwIfCancelled(signal);
  const alias = sshAlias(src.name, t.host.name, cfg.hosts);
  const c: ContainerSsh = { port: started.sshPort, jump: t.jump, identity: key, project: src.name, alias,
    knownHosts: join(cfg.sshDir, 'fnkc', `${alias}.known_hosts`), hostKey: started.hostKey };
  log.info(`Using ${started.image} for checkout ${started.revision}`);
  const changed = writeSshConfig(cfg.sshDir, src.name, t.host.name, c);
  if (changed) log.info(changed);

  log.info('Waiting for the container to accept SSH');
  await waitForSsh(c, 30, signal);

  const agent = await run('ssh-add', ['-l']).catch(() => ({ code: 2 }));
  if (agent.code !== 0) log.warn('no keys in ssh-agent (ssh-add): git in the container will not be able to reach Gitea');
  const gitTarget = gitSshTarget(src.urls[0]);
  if (gitTarget) {
    const hostname = gitTarget.dest.split('@').pop()!;
    const lookup = gitTarget.port ? `[${hostname}]:${gitTarget.port}` : hostname;
    const trusted = await run('ssh-keygen', ['-F', lookup, '-f', join(cfg.sshDir, 'known_hosts')]);
    if (trusted.code !== 0) throw new Error(`verify and trust the Gitea host key for ${lookup} on this computer first`);
    const installed = await run('ssh', [...containerSshArgs(c), 'umask 077; cat > ~/.ssh/known_hosts'], { input: trusted.stdout, signal });
    if (installed.code !== 0) throw new Error('could not install trusted git host keys');
  }
  // The repository is cloned here, inside the container, with this computer's ssh-agent (forwarded for this one
  // command): this computer has read only container.json.
  log.info(`Cloning into ${projectFolder(src.name)} in the container (an existing checkout is kept as it is)`);
  const sync = await run('ssh', ['-A', ...containerSshArgs(c), 'fnkc-projects', 'init', src.name, started.revision, src.urls[0]], {
    timeoutMs: 30 * 60_000, signal,
    // git reports its progress on stderr ("Cloning into ...", "* branch ..."): only problems are warnings
    onStderr: (l) => (/^(fatal|error|warning)\b/i.test(l) ? log.warn(l.replace(/^warning:\s*/i, '')) : log.info(l)),
  });
  if (sync.code !== 0) throw new Error(`project initialization failed: ${sync.stderr.trim()}`);

  const manifest = await run('ssh', [...containerSshArgs(c), `cat '${src.name}/container.json'`], { signal });
  if (manifest.code !== 0) throw new Error(`could not read ${src.name}/container.json in the container: ${manifest.stderr.trim()}`);
  let pinned: unknown;
  try {
    pinned = (JSON.parse(manifest.stdout) as { image?: unknown }).image;
  } catch (e) {
    throw new Error(`${src.name}/container.json in the checkout is not valid JSON (${(e as Error).message}): fix it in the project, then reopen`);
  }
  if (pinned !== (started.pinnedImage ?? started.image)) throw new Error('checkout environment changed during Open; reopen to resolve it');
  let data = await dataState(c, src.name);
  let decryptError: string | undefined;
  if (data === 'locked') {
    const approved = decryptionApproved(cfg, t.host);
    const wanted = approved && (typeof opts.unlock === 'function' ? await opts.unlock(t.host.name) : !!opts.unlock);
    if (wanted) {
      log.info('Decrypting the project data');
      try {
        await unlockProject(cfg, c, src.name);
        data = 'unlocked';
      } catch (e) {
        if (opts.unlock === true) throw e;
        decryptError = (e as Error).message;
        log.warn(`The data stays encrypted: ${decryptError}`);
      }
    } else if (!approved) {
      log.info(`Project data is encrypted. Decryption on host '${t.host.name}' is not approved (decryptionHosts in your config)`);
    } else if (opts.unlock === undefined) log.info('Project data is encrypted (open with --unlock to decrypt it)');
  }
  if (data === 'unlocked') log.info('Project data is decrypted; it stays so until: fnkc-projects lock');
  if (data === 'unknown') log.warn('could not tell whether the project data is encrypted (a container from an older fnkc-ctl: stop and reopen)');
  return { project: src.name, host: t.host.name, alias, folder: projectFolder(src.name), container: started.container,
    data, decryptError, updatePending: started.updatePending };
  });
}

async function waitForSsh(c: ContainerSsh, seconds = 30, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    const r = await run('ssh', [...containerSshArgs(c, 5), 'true'], { timeoutMs: Math.min(7000, deadline - Date.now()), signal })
      .catch((e: Error) => { if (e instanceof Cancelled) throw e; return { code: -1 }; });
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
        log.warn(`${project} is also running on '${h.name}': push your changes from there (fnkc-projects status) or stop it`);
      }
    } catch {
      // an unreachable host is not a problem here
    }
  }
}

export async function stopProject(cfg: ClientConfig, project: string, host: string | undefined, log: Logger): Promise<string[]> {
  // A repository name (as in the projects list), owner/name, or its URL
  project = /[:/]/.test(project) ? projectSource(project, cfg.gitRemotes).name : checkProject(project);
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

/**
 * The containers on every host. A host that answers also has the SSH entries of its deleted projects removed from
 * this computer (pruneSshConfig), so Remote SSH does not list connections that cannot work.
 */
export async function listProjects(cfg: ClientConfig, log: Logger): Promise<HostListing[]> {
  const listedAt = Date.now();
  return Promise.all(
    cfg.hosts.map(async (h) => {
      try {
        const containers = await transportFor(h, cfg, log).list();
        try {
          const pruned = pruneSshConfig(cfg.sshDir, h.name, new Set(containers.map((c) => c.project)), listedAt);
          if (pruned.length) log.info(`Removed the SSH entries of ${pruned.join(', ')} on '${h.name}': their containers are gone`);
        } catch (e) {
          log.warn(`could not tidy SSH entries: ${(e as Error).message}`);
        }
        return { host: h.name, containers };
      } catch (e) {
        return { host: h.name, error: (e as Error).message, containers: [] };
      }
    }),
  );
}
