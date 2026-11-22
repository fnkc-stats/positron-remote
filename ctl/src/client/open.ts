// What the Start / Stop / List buttons do. The CLI calls these functions, and the extension will too.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgetImage, imageUpload, pruneImageCache } from './image-download.ts';
import { CodedError, UnknownCommand } from '../errors.ts';
import { withLock } from '../lock.ts';
import { Cancelled, run, throwIfCancelled } from '../exec.ts';
import { projectFolder, sshAlias } from '../layout.ts';
import type { Logger } from '../log.ts';
import type { BusyProcess, ContainerInfo, StartRequest, StartResult } from '../protocol.ts';
import { checkProject } from '../validate.ts';
import { type ClientConfig, type HostConfig, hostByName, requireHosts } from './config.ts';
import { type DataState, dataState, decryptionApproved, unlockProject } from './decrypt.ts';
import { forgetChoice, imageToRun } from './variant.ts';
import { forgetProof, provenanceProof } from './provenance.ts';
import { localPositron, type PositronClient } from './positron.ts';
import { type ProjectSource, projectSource, readProjectRevision } from './project.ts';
import { resolveStart, type StartDeps } from './start.ts';
import { addSshInclude, type ContainerSsh, containerSshArgs, gitSshTarget, pruneSshConfig, sshIncludePresent, writeSshConfig } from './ssh.ts';
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
  /**
   * Asked before the container starts when this computer's ssh-agent has no keys, so git in the container cannot
   * reach Gitea; false stops the Open. Without it the Open goes on with a warning (CLI).
   */
  confirmEmptyAgent?: () => Promise<boolean>;
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

/** The given host, or the first configured host for "auto". */
export async function pickHost(cfg: ClientConfig, name: string, log: Logger, signal?: AbortSignal): Promise<Transport> {
  if (name !== 'auto') {
    const t = transportFor(hostByName(cfg, name), cfg, log);
    t.signal = signal;
    await t.ping();
    return t;
  }
  requireHosts(cfg);
  const errors: string[] = [];
  for (const h of cfg.hosts.slice(0, 1)) {
    const t = transportFor(h, cfg, log);
    t.signal = signal;
    try {
      await t.ping();
      if (errors.length) log.warn(`using host '${h.name}': ${errors.join('; ')}`);
      return t;
    } catch (e) {
      // A host that answered with a reason (incompatible, busy) is not unreachable: its error stays as it is
      if (e instanceof CodedError || e instanceof Cancelled) throw e;
      errors.push(`'${h.name}' is unreachable (${(e as Error).message})`);
    }
  }
  throw new Error(`no host is reachable: ${errors.join('; ')}`);
}

export async function openProject(cfg: ClientConfig, projectArg: string, opts: OpenOptions, log: Logger): Promise<OpenResult> {
  requireHosts(cfg); // first: without a configuration every other problem is a consequence of it
  const src = projectSource(projectArg, cfg.gitRemotes);
  const positron = opts.positron ?? localPositron();
  const key = cfg.sshKey;
  if (!key || !existsSync(`${key}.pub`)) throw new Error('no SSH key found: create one with ssh-keygen, or set "sshKey" in the config');
  if (opts.unlock === true && cfg.gitCryptKey && !existsSync(cfg.gitCryptKey)) throw new Error(`--unlock: gitCryptKey ${cfg.gitCryptKey} is not found`);

  if (opts.confirmSshInclude && !sshIncludePresent(cfg.sshDir)) {
    if (!(await opts.confirmSshInclude())) throw new SshIncludeDeclined();
    // Right away: an Open that fails later must not ask again next time
    const added = addSshInclude(cfg.sshDir);
    if (added) log.info(added);
  }

  // The container clones over this computer's forwarded ssh-agent: without keys the clone fails minutes later
  if (gitSshTarget(src.urls[0]) && (await run('ssh-add', ['-l']).catch(() => ({ code: 2 }))).code !== 0) {
    if (opts.confirmEmptyAgent) {
      if (!(await opts.confirmEmptyAgent())) throw new Cancelled();
    } else log.warn('no keys in ssh-agent (ssh-add): git in the container will not be able to reach Gitea');
  }

  const resolved = await readProjectRevision(src, cfg.cacheDir, log);
  const { image, revision } = resolved;
  const signal = opts.signal;
  const t = await pickHost(cfg, opts.host ?? 'auto', log, signal);
  if (opts.unlock === true && !decryptionApproved(cfg, t.host)) throw new Error(`decryption is not approved on host '${t.host.name}'; set decryptionHosts in your personal config`);
  // One Open per project at a time; other projects open meanwhile (image downloads have their own lock)
  return withLock(join(cfg.cacheDir, 'locks', `open-${src.name}`), async () => {
  log.info(`Project ${src.name}: ${image}, Positron ${positron.version}, host '${t.host.name}'`);
  await warnIfRunningElsewhere(cfg, t.host.name, src.name, src.urls[0], log, { signal });

  // container.json pins the R environment; the container runs it with the server of this Positron (variant.ts)
  const request: StartRequest = {
    project: src.name,
    image, repository: src.urls[0], revision,
    positron: { version: positron.version, commit: positron.commit },
    sshPublicKey: readFileSync(`${key}.pub`, 'utf8').trim(),
  };
  const started = await resolveStart(startDeps(cfg, t, src.name, positron, log, signal), request);

  throwIfCancelled(signal);
  const alias = sshAlias(src.name, t.host.name, cfg.hosts);
  const c: ContainerSsh = { port: started.sshPort, jump: t.jump, identity: key, project: src.name, alias,
    knownHosts: join(cfg.sshDir, 'fnkc', `${alias}.known_hosts`), hostKey: started.hostKey };
  log.info(`Using ${started.image} for checkout ${started.revision}`);
  await prepareContainer(cfg, c, src, t.host.name, started.revision, log, signal);
  await verifyCheckout(c, src.name, started, signal);
  const { data, decryptError } = await decryptData(cfg, c, src.name, t.host, opts.unlock, log);
  return { project: src.name, host: t.host.name, alias, folder: projectFolder(src.name), container: started.container,
    data, decryptError, updatePending: started.updatePending };
  });
}

/** The real effects of resolveStart: this host, and this computer's caches (image choice, proofs, downloads). */
function startDeps(cfg: ClientConfig, t: Transport, project: string, positron: PositronClient, log: Logger, signal?: AbortSignal): StartDeps {
  return {
    start: (r) => t.start(r),
    installImage: (m, u) => t.installImage(m, u),
    ...(t.capabilities?.includes(CHECKOUT_QUERY) ? { checkout: () => t.checkout(project) } : {}),
    requiresProvenance: !!t.requiresProvenance,
    imageToRun: (pinned) => imageToRun(cfg.cacheDir, pinned, positron, log),
    forgetChoice: (pinned) => forgetChoice(cfg.cacheDir, pinned, positron.commit),
    // The proof is cached by repository and digest: GitHub is asked once per image on this computer
    provenanceProof: (img) => provenanceProof(cfg.cacheDir, cfg.envRepository, img),
    forgetProof: (img) => forgetProof(cfg.cacheDir, cfg.envRepository, img),
    imageUpload: (m) => imageUpload(cfg.cacheDir, m, log, signal),
    forgetImage: (u) => forgetImage(cfg.cacheDir, u),
    pruneImageCache: (u) => pruneImageCache(cfg.cacheDir, cfg.imageCacheLimit, u),
    log, signal,
  };
}

/**
 * The started container made ready for Positron: its SSH entry on this computer, the Gitea host keys this computer
 * trusts, and the project cloned inside it with this computer's ssh-agent (forwarded for that one command): this
 * computer has read only container.json.
 */
async function prepareContainer(
  cfg: ClientConfig, c: ContainerSsh, src: ProjectSource, hostName: string, revision: string, log: Logger, signal?: AbortSignal,
) {
  const changed = writeSshConfig(cfg.sshDir, src.name, hostName, c);
  if (changed) log.info(changed);

  log.info('Waiting for the container to accept SSH');
  await waitForSsh(c, 30, signal);

  const gitTarget = gitSshTarget(src.urls[0]);
  if (gitTarget) {
    const hostname = gitTarget.dest.split('@').pop()!;
    const lookup = gitTarget.port ? `[${hostname}]:${gitTarget.port}` : hostname;
    const trusted = await run('ssh-keygen', ['-F', lookup, '-f', join(cfg.sshDir, 'known_hosts')]);
    if (trusted.code !== 0) throw new Error(`verify and trust the Gitea host key for ${lookup} on this computer first`);
    const installed = await run('ssh', [...containerSshArgs(c), 'umask 077; cat > ~/.ssh/known_hosts'], { input: trusted.stdout, signal });
    if (installed.code !== 0) throw new Error('could not install trusted git host keys');
  }
  log.info(`Cloning into ${projectFolder(src.name)} in the container (an existing checkout is kept as it is)`);
  const sync = await run('ssh', ['-A', ...containerSshArgs(c), 'fnkc-projects', 'init', src.name, revision, src.urls[0]], {
    timeoutMs: 30 * 60_000, signal,
    // git reports its progress on stderr ("Cloning into ...", "* branch ..."): only problems are warnings
    onStderr: (l) => (/^(fatal|error|warning)\b/i.test(l) ? log.warn(l.replace(/^warning:\s*/i, '')) : log.info(l)),
  });
  if (sync.code !== 0) throw new Error(`project initialization failed: ${sync.stderr.trim()}`);
}

/** The checkout in the container still pins the environment the host started (it can change during an Open). */
async function verifyCheckout(c: ContainerSsh, project: string, started: StartResult, signal?: AbortSignal) {
  const manifest = await run('ssh', [...containerSshArgs(c), `cat '${project}/container.json'`], { signal });
  if (manifest.code !== 0) throw new Error(`could not read ${project}/container.json in the container: ${manifest.stderr.trim()}`);
  checkoutMatches(manifest.stdout, project, started);
}

/** Throws unless the checkout's container.json (`manifest`) pins what the host started from. */
export function checkoutMatches(manifest: string, project: string, started: Pick<StartResult, 'image' | 'pinnedImage'>): void {
  let pinned: unknown;
  try {
    pinned = (JSON.parse(manifest) as { image?: unknown }).image;
  } catch (e) {
    throw new Error(`${project}/container.json in the checkout is not valid JSON (${(e as Error).message}): fix it in the project, then reopen`);
  }
  if (pinned !== (started.pinnedImage ?? started.image)) throw new Error('checkout environment changed during Open; reopen to resolve it');
}

/** Decrypts the project data if it is locked, decryption is approved on this host, and the user wants it. */
async function decryptData(cfg: ClientConfig, c: ContainerSsh, project: string, host: HostConfig, unlock: OpenOptions['unlock'], log: Logger):
  Promise<{ data: DataState; decryptError?: string }> {
  let data = await dataState(c, project);
  let decryptError: string | undefined;
  if (data === 'locked') {
    const approved = decryptionApproved(cfg, host);
    const wanted = approved && (typeof unlock === 'function' ? await unlock(host.name) : !!unlock);
    if (wanted) {
      log.info('Decrypting the project data');
      try {
        await unlockProject(cfg, c, project);
        data = 'unlocked';
      } catch (e) {
        if (unlock === true) throw e;
        decryptError = (e as Error).message;
        log.warn(`The data stays encrypted: ${decryptError}`);
      }
    } else if (!approved) {
      log.info(`Project data is encrypted. Decryption on host '${host.name}' is not approved (decryptionHosts in your config)`);
    } else if (unlock === undefined) log.info('Project data is encrypted (open with --unlock to decrypt it)');
  }
  if (data === 'unlocked') log.info('Project data is decrypted; it stays so until: fnkc-projects lock');
  if (data === 'unknown') log.warn('could not tell whether the project data is encrypted (a container from an older fnkc-ctl: stop and reopen)');
  return { data, decryptError };
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
  throw new Error('could not log in to the project container: it started but does not accept SSH connections. ' +
    'Copy the details for your administrator (docker logs on the host shows why)');
}

const CHECKOUT_QUERY = 'checkout-query-v1';

/** How long Open waits for the other hosts' answer to "does this project run there?" before going on without it. */
export const ELSEWHERE_WAIT_MS = 10_000;

/**
 * Work in a container on another host is not lost, but it has to be pushed to git before moving. Advisory: the other
 * hosts are asked at once, for this project only (agent checkout; an older host lists its containers), and an
 * unreachable or slow host is skipped after ELSEWHERE_WAIT_MS. Open's Cancel ends the wait.
 */
export async function warnIfRunningElsewhere(cfg: ClientConfig, here: string, project: string, repository: string, log: Logger,
  o: { signal?: AbortSignal; waitMs?: number; transport?: (h: HostConfig) => Transport } = {}) {
  const { signal, waitMs = ELSEWHERE_WAIT_MS, transport = (h) => transportFor(h, cfg, log) } = o;
  const others = cfg.hosts.filter((h) => h.name !== here);
  if (!others.length) return;
  // A timer that keeps the process alive (AbortSignal.timeout's does not: a CLI waiting only on a stalled host would exit)
  const expired = new AbortController();
  const timer = setTimeout(() => expired.abort(), waitMs);
  const bounded = AbortSignal.any([expired.signal, ...(signal ? [signal] : [])]);
  // Docker on this computer does not stop at the signal: the wait ends anyway, its read-only answer is dropped
  const gaveUp = new Promise<undefined>((res) => bounded.addEventListener('abort', () => res(undefined), { once: true }));
  const runs = await Promise.all(others.map(async (h) => {
    const t = transport(h);
    t.signal = bounded;
    const asked = runsThere(t, project, repository).then((yes) => (yes ? h.name : undefined), () => undefined);
    return Promise.race([asked, gaveUp]); // an unreachable or slow host is not a problem here
  })).finally(() => clearTimeout(timer));
  throwIfCancelled(signal);
  for (const name of runs) {
    if (name) log.warn(`${project} is also running on '${name}': push your changes from there (fnkc-projects status) or stop it`);
  }
}

async function runsThere(t: Transport, project: string, repository: string): Promise<boolean> {
  const same = (r: string | undefined) => r === undefined || r.replace(/\/+$/, '') === repository.replace(/\/+$/, '');
  try {
    const s = await t.checkout(project);
    return !!s.container?.running && same(s.container.repository);
  } catch (e) {
    if (!(e instanceof UnknownCommand)) throw e;
    return (await t.list()).some((c) => c.project === project && c.running && same(c.repository));
  }
}

export async function stopProject(cfg: ClientConfig, project: string, host: string | undefined, log: Logger): Promise<string[]> {
  // A repository name (as in the projects list), owner/name, or its URL
  project = /[:/]/.test(project) ? projectSource(project, cfg.gitRemotes).name : checkProject(project);
  requireHosts(cfg);
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

/** What still computes in the running project on `host` (Stop shows it first). */
export async function busyProcesses(cfg: ClientConfig, project: string, host: string, log: Logger): Promise<BusyProcess[]> {
  return transportFor(hostByName(cfg, host), cfg, log).busy(checkProject(project));
}

/** 3 more days for a project that computes without a window, before its host stops it. */
export async function keepProject(cfg: ClientConfig, project: string, host: string, log: Logger): Promise<{ until: string }> {
  return transportFor(hostByName(cfg, host), cfg, log).keep(checkProject(project));
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
