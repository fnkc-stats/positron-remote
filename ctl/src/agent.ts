import { outsideProject, parseRemovalOutput, REMOVAL_SCRIPT, writableContent } from './removal-inspection.ts';
export { outsideProject, parseRemovalOutput, isAuxiliary, REMOVAL_SCRIPT } from './removal-inspection.ts';
import { admit, memoryBytes } from './capacity.ts';
// Application layer: project operations serialize independently; admission alone holds the host lock.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { Readable } from 'node:stream';
import type { RunResult } from './exec.ts';
import { join } from 'node:path';
import type { AgentConfig } from './agent-config.ts';
import { ENVIRONMENT, ENTRYPOINT, IDLE_WATCH, PROJECTS_SCRIPT, RPROFILE, SNAPSHOT } from './assets.ts';
import { Docker, type ContainerJson, type ImageJson, pinnedImageOf, sshPortOf } from './docker.ts';
import { CheckoutPinsOther, EnvironmentImageMissing, imageOnHost, receiveImage } from './image-store.ts';
import { type Arch, CONTAINER_HOME, CONTAINER_USER, extensionsVolume, IMAGE_LABEL, LABEL, LIBRARY_DIR, projectNames, recoveryName, isProjectContainer, SERVER_DATA_DIR } from './layout.ts';
import { withLock } from './lock.ts';
import type { Logger } from './log.ts';
import { checkPositron, imagePositron, prepareExtensions } from './positron-server.ts';
import { runHelper } from './helper.ts';
import { ReplacementNotReady } from './errors.ts';
import { type BusyProcess, type ContainerInfo, CTL_VERSION, PROTOCOL_VERSION, CAPABILITIES, type CheckoutState, type HostImage, OPTIONAL_CAPABILITIES, type PingResult, type RemovalCheck, type StartRequest, type StartResult, type StopResult, MIN_PROTOCOL } from './protocol.ts';
import { checkRepository, manifestImage, repositoryName, sameRepository } from './repository.ts';
import { tarOf } from './tar.ts';
import { checkCommit, checkImage, checkProject, checkSshKey, checkVersion } from './validate.ts';
import { trustRootRefreshed, verifyImageProvenance } from './provenance.ts';

/** How long a stop waits for the container before Docker kills it. */
export const STOP_SECONDS = 90;

/**
 * Prints the checkout's origin, HEAD and container.json, or a ready initialization's request (repository, revision) and
 * manifest; exit 44: no checkout yet (empty volume, or an initialization not ready). Files are read only if they are
 * regular (not symlinks, FIFOs or devices) and at most 64 KiB: the user controls the volume.
 */
export const CHECKOUT_SCRIPT = 'r() { if [ ! -f "$1" ] || [ -L "$1" ]; then echo "$1 is not a regular file" >&2; return 1; fi; ' +
  'if [ "$(($(wc -c < "$1")))" -gt 65536 ]; then echo "$1 is too large (over 64 KiB)" >&2; return 1; fi; head -c 65536 "$1"; }; ' +
  'if [ -d /work/.fnkc-init ]; then if [ -f /work/.fnkc-init/ready ]; then req=$(r /work/.fnkc-init/request) || exit 1; printf "%s\\n" "$req" | sed -n 1,2p; ' +
  'if [ -e /work/container.json ] || [ -L /work/container.json ]; then r /work/container.json; else r /work/.fnkc-init/repo/container.json; fi; exit; ' +
  'else exit 44; fi; fi; if [ ! -d /work/.git ]; then [ -z "$(ls -A /work)" ] && exit 44; echo "nonempty project volume has no .git directory" >&2; exit 1; fi; ' +
  'git -C /work config --get remote.origin.url; git -C /work rev-parse HEAD; r /work/container.json';

/**
 * How long reading a checkout may take. The helper reads a few small files, and the start or the checkout query holds
 * the project's lock meanwhile.
 */
export const CHECKOUT_READ_MS = 20_000;
/** How long the removal check may take: it hashes every byte of the project's volumes. */
export const REMOVAL_READ_MS = 10 * 60_000;

/** Options of the helper containers that read a user's volumes (checkout, removal check), after HELPER_OPTIONS (helper.ts). */
const READ_HELPER = ['--user', '1000:1000', '--pids-limit', '64'];

/** A container that computes with no window: the user is asked after a day, it stops 3 days after the last window. */
export const BUSY_NOTICE_MINUTES = 24 * 60;
export const BUSY_STOP_MINUTES = 3 * 24 * 60;

/**
 * How long an image upload waits for an upload of another image to finish (one is received at a time). An upload of
 * r-env takes minutes; the client's data waits in the SSH connection meanwhile.
 */
export const UPLOAD_QUEUE_MS = 60 * 60_000;

/**
 * Linux capabilities of project containers (all others are dropped). CHOWN/FOWNER/DAC_OVERRIDE: the entrypoint
 * gives mount points and authorized_keys to the analyst; SETUID/SETGID/SYS_CHROOT: sshd's login and privilege
 * separation; NET_BIND_SERVICE: port 22; KILL: sshd and the idle watch signal sessions; AUDIT_WRITE: sshd's
 * login records.
 */
export const CONTAINER_CAPABILITIES = ['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'NET_BIND_SERVICE', 'SETGID', 'SETUID', 'SYS_CHROOT'];

export { memoryBytes } from './capacity.ts';

/** How many readiness checks a start makes (READY_POLL_MS apart) before the container counts as not ready. */
export const READY_CHECKS = 30;
/** Lines of the container's log, and characters in all, that a readiness failure carries to the user. */
const READY_LOG_LINES = 20;
const READY_LOG_CHARS = 4000;

/** The project's container did not pass readiness; the message ends with the tail of its readiness log. */
class NotReady extends Error {}

export class Agent {
  readonly cfg: AgentConfig;
  readonly log: Logger;
  readonly docker: Docker;
  /** Root's admin commands on the server: they act on a user's projects also after the user's key is gone. */
  readonly asAdmin: boolean;
  /** Pause between readiness checks (tests shorten it). */
  readyPollMs = 200;
  constructor(cfg: AgentConfig, log: Logger, docker = new Docker(cfg.docker), opts: { asAdmin?: boolean } = {}) {
    this.cfg = cfg; this.log = log; this.docker = docker; this.asAdmin = !!opts.asAdmin;
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return withLock(join(this.cfg.lockDir, 'host'), work);
  }

  private projectLocked<T>(project: string, work: () => Promise<T>, timeoutMs?: number): Promise<T> {
    return withLock(join(this.cfg.lockDir, `project-${this.cfg.user}-${checkProject(project)}`), work, timeoutMs);
  }

  private authorized(): void {
    // Recheck for every command: existing SSH transports must not bypass offboarding.
    if (this.cfg.keysDir && !this.asAdmin) this.publicKey();
  }

  ping(): PingResult {
    this.authorized();
    return { version: CTL_VERSION, protocol: PROTOCOL_VERSION, minProtocol: MIN_PROTOCOL, capabilities: [...CAPABILITIES, ...OPTIONAL_CAPABILITIES], user: this.cfg.user,
      requiresProvenance: this.cfg.requireProvenance,
      ...(this.cfg.requireProvenance ? { trustRootRefreshed: trustRootRefreshed(this.cfg) } : {}) };
  }

  async start(req: StartRequest): Promise<StartResult> {
    return this.projectLocked(checkProject(req.project), () => this.startLocked(req));
  }

  /**
   * Receives the pinned environment image from the client (after start answered imageMissing) and loads it once
   * every byte matches the digest. Received without the host lock, so other projects keep starting meanwhile.
   */
  async installImage(imageArg: string | undefined, source: Readable): Promise<{ installed: true }> {
    this.authorized();
    const image = checkImage(imageArg, this.cfg.allowedImages);
    if (await this.imageId(image, false)) {
      source.destroy();
      return { installed: true };
    }
    const { arch } = await this.host();
    await withLock(join(this.cfg.lockDir, 'image-upload'), async () => {
      this.authorized();
      if (await this.imageId(image, false)) { source.destroy(); return; }
      await receiveImage(this.docker, image, arch, source, this.cfg.imageStagingDir, this.log,
        (work) => withLock(join(this.cfg.lockDir, 'image-store'), work, 35 * 60_000), {
          reserveBytes: memoryBytes(this.cfg.imageReserve), maxUnpackedBytes: memoryBytes(this.cfg.maxUnpackedImage),
          maxStoredBytes: memoryBytes(this.cfg.maxImageStorage),
        });
    }, UPLOAD_QUEUE_MS, () => this.log.info('Waiting for another image upload to this host to finish')).finally(() => source.destroy());
    return { installed: true };
  }

  /** Architecture, CPUs and memory of the Docker host. */
  private async host(): Promise<{ arch: Arch; cpus: number; memory: number }> {
    const [hostArch, ncpu, mem] = (await this.docker.ok(['info', '--format', '{{.Architecture}} {{.NCPU}} {{.MemTotal}}'])).trim().split(' ');
    const hostIs: Record<string, Arch> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' };
    if (!hostIs[hostArch]) throw new Error(`unsupported host architecture: ${hostArch}`);
    if (!Number(mem) || !Number(ncpu)) throw new Error('cannot determine host capacity');
    return { arch: hostIs[hostArch], cpus: Number(ncpu), memory: Number(mem) };
  }

  private async startLocked(req: StartRequest): Promise<StartResult> {
    this.authorized();
    const project = checkProject(req.project);
    const repository = checkRepository(req.repository);
    if (repositoryName(repository) !== project) throw new Error('project name does not match repository');
    let revision = checkCommit(req.revision);
    let image = checkImage(req.image, this.cfg.allowedImages);
    // The pinned environment with the server of the client's Positron (client/variant.ts, env/positron.Dockerfile)
    const variant = req.positronImage === undefined ? undefined : { image: checkImage(req.positronImage?.image, this.cfg.allowedImages) };
    const version = checkVersion(req.positron?.version);
    const commit = checkCommit(req.positron?.commit);
    const key = this.publicKey(req);
    const d = this.docker;
    const names = projectNames(this.cfg.user, project);
    let c = await this.own(names.container, project);
    if (c && c.Config.Labels?.[LABEL.repository] !== repository) throw new Error(`project ${project} on this host is ${c.Config.Labels?.[LABEL.repository]}, not ${repository}`);
    const previousName = recoveryName(this.cfg.user, project);
    const legacy = await d.container(`${names.container}-previous`);
    if (legacy?.Config.Labels?.[LABEL.user] === this.cfg.user && legacy.Config.Labels?.[LABEL.project] === project) {
      if (await d.container(previousName)) throw new Error('multiple recovery containers; operator inspection required');
      await d.ok(['rename', legacy.Name.replace(/^\//, ''), previousName]);
    }
    const recovery = await this.own(previousName, project);
    let discarded = false;
    if (recovery && !c) {
      await d.ok(['rename', previousName, names.container]);
      c = await this.own(names.container, project);
    } else if (recovery && c) {
      // Do not delete either side of an interrupted replacement before the new one passes readiness.
      if (!c.State.Running) {
        await d.ok(['rm', names.container]);
        await d.ok(['rename', previousName, names.container]);
        c = await this.own(names.container, project);
      } else {
        try {
          await this.ready(project, c.Config.Image, revision, false);
          await d.ok(['rm', previousName]);
        } catch (e) {
          if (!(e instanceof NotReady)) throw e;
          if (!req.discardReplacement) throw replacementNotReady(project, e);
          // Discard and retry (the user chose it after ReplacementNotReady): the replacement that still does not pass
          // readiness never served anyone, so it is removed (never its volumes) and the container is created afresh
          // below. The recovery container stays as it is for operators until a start succeeds; no rollback to it.
          this.log.warn(`Discarding the replacement container of ${project} that does not pass readiness; starting it afresh (the project files are kept)`);
          await d.ok(['rm', '-f', names.container]);
          c = null;
          discarded = true;
        }
      }
    }
    if (c && c.Config.Labels?.[LABEL.repository] !== repository) throw new Error('recovered project belongs to another repository');
    const host = await this.host();
    // Docker's immutable ID of the image to run, never a tag that could be moved. With a variant,
    // the pinned image is not needed on this host at all, also not for reading the checkout below.
    // A running container's own image may also be an uploaded tag without a record (loaded before records existed):
    // `trusted` is then false, and it serves only to reconnect to that container as it is (environment: `running`)
    // and to read its checkout (as agent checkout does), never to create, replace or start the project's container.
    const running = c?.State.Running ? c.Image : undefined;
    // A running container is never replaced (docs/policies.md), so the pinned image is needed only once it stops: while
    // it runs, an image this host does not have at all means a reconnect with the update pending, not an upload. An
    // uploaded tag this host cannot trust is still answered with imageMissing, so that the upload replaces it.
    const pinned = (want: string) => this.environment(want, host.arch, running).catch(async (e: unknown) => {
      if (running !== undefined && e instanceof EnvironmentImageMissing &&
        (await imageOnHost(this.docker, this.cfg.imageStagingDir, want)).state === 'absent') return undefined;
      throw e;
    });
    let env = await pinned(variant?.image ?? image);

    // Without the pinned image, or with only the running container's unrecorded one, the checkout is read with the
    // running container's own image ID, as agent checkout does: the image that container already runs, over the same
    // volume (read-only, as an unprivileged helper without network), so it adds no code the project did not run
    const found = await this.readCheckout(names.projectVolume, env?.id ?? running!, repository, project);
    if (found) {
      revision = found.revision;
      // The client chose the image for the environment it read; the checkout pins another one: choose for that
      if (variant && found.image !== image) throw new CheckoutPinsOther(found.image);
      image = found.image;
      env = await pinned(variant?.image ?? image);
    }
    if (env === undefined) return this.connectPending(c!, project, revision, image, commit);
    const ref = env.id;

    const img = await d.image(ref);
    const arch = archOf(img?.Architecture);
    if (host.arch !== arch) throw new Error('image architecture differs from host; use a native image or the remote server');
    const run = variant?.image ?? image;
    if (variant && img?.Config?.Labels?.[IMAGE_LABEL.base] !== image) {
      throw new Error(`${variant.image} is not built on ${image} (its ${IMAGE_LABEL.base} label is ` +
        `'${img?.Config?.Labels?.[IMAGE_LABEL.base] ?? ''}'): it would not run the project's environment`);
    }
    checkPositron(img, run, { version, commit });
    const files = [
      { name: 'usr/local/bin/fnkc-entrypoint', mode: 0o755, data: ENTRYPOINT },
      { name: 'usr/local/bin/fnkc-projects', mode: 0o755, data: PROJECTS_SCRIPT },
      { name: 'usr/local/bin/fnkc-idle-watch', mode: 0o755, data: IDLE_WATCH },
      { name: 'usr/local/lib/fnkc/Rprofile.R', mode: 0o644, data: RPROFILE },
      { name: 'usr/local/lib/fnkc/environment.R', mode: 0o644, data: ENVIRONMENT },
      { name: 'usr/local/lib/fnkc/snapshot.R', mode: 0o644, data: SNAPSHOT },
    ];
    const ext = extensionsVolume(this.cfg.user, arch, project, commit);
    // The setup names the pinned image, not Docker's name for it, so pulling an uploaded image changes nothing
    const args = this.createArgs(project, repository, run, arch, key, ext, host.cpus);
    const setup = createHash('sha256').update(JSON.stringify([args, files, img?.Id])).digest('hex');
    args[args.length - 1] = ref;
    // The label alone does not prove which image a stopped container would start: it must also run the verified ID
    const changed = c && (c.Config.Labels?.[LABEL.setup] !== setup || c.Image !== ref);
    if (changed && c?.State.Running) return this.connectPending(c, project, revision, image, commit);
    // Past this point a container is created or started from `ref` unless it runs unchanged: that needs an image this
    // host trusts (imageOnHost ready). The running container's unrecorded image (above) is reconnected to only; anything
    // else asks for an upload, before the provenance check and before any create, copy or start below.
    if (!env.trusted && (!c || changed || !c.State.Running)) throw new EnvironmentImageMissing({ image: run, arch: host.arch });
    // Before any container is created from the image (a container that exists was verified when it was created, and
    // connect checks its mark): a running project reconnects even while GitHub, or the client's proof, is unavailable
    if (!c || changed) await verifyImageProvenance(this.cfg, run, { bundle: req.provenanceBundle, subject: req.provenanceSubject });

    await this.ensureVolumes(project, [names.projectVolume, names.dataVolume, names.libraryVolume, ext]);
    // Only before a container starts (new, replaced or stopped): a running one (unchanged here; changed returned above)
    // keeps its server's extensions as they are, and a reconnect never waits for the helpers or touches the live volume.
    if (!c?.State.Running) {
      await prepareExtensions(d, ref, arch, ext, version, commit, this.cfg.skipExtensions, this.log, { user: this.cfg.user, project });
    }
    const network = `${names.container}-net`;
    const net = await d.run(['network', 'inspect', network]);
    if (net.code !== 0) {
      if (!/no such network|not found/i.test(net.stderr)) throw new Error(`cannot inspect network: ${net.stderr}`);
      await d.ok(['network', 'create', '--label', `${LABEL.managed}=1`, network]);
    }
    const previous = recoveryName(this.cfg.user, project);
    let renamed = false;
    let created = false;
    let result: StartResult;
    try {
      if (changed) {
        if (await d.container(previous)) throw new Error(`previous recovery container exists: ${previous}; ask the administrator to inspect it`);
        await d.ok(['rename', names.container, previous]);
        renamed = true; c = null;
      }
      if (!c) {
        await d.ok([args[0], '--label', `${LABEL.setup}=${setup}`, '--label', `${LABEL.revision}=${revision}`, ...args.slice(1)]);
        created = true;
      }
      // Copy on every stopped start, including retries after a crash between create and copy.
      if (!c?.State.Running) {
        await d.ok(['cp', '-', `${names.container}:/`], { input: tarOf(files) });
        await this.locked(async () => {
          // Again under the host lock: an offboarding (admin remove-user) may have run since the check above
          this.authorized();
          await admit(this.docker, this.cfg, host.memory);
          await d.ok(['start', names.container]);
        });
      }
      result = await this.ready(project, run, revision, created);
    } catch (e) {
      if (created) await d.run(['rm', '-f', names.container]); // never removes volumes
      if (renamed && !(await d.container(names.container))) await d.ok(['rename', previous, names.container]);
      // A replacement (renamed, or created after a discard) that does not become ready: the client may offer Discard and retry
      if (e instanceof NotReady && (renamed || discarded)) throw replacementNotReady(project, e);
      throw e;
    }
    // Readiness is the commit point: from here on the replacement stays, whatever happens to its predecessor.
    if (variant) result.pinnedImage = image;
    if (renamed || discarded) await this.removePredecessor(previous);
    return result;
  }

  /**
   * The durable checkout in `volume`, read with the image `ref` without executing its code, hooks or git configuration
   * helpers: its revision and pinned image, or undefined when there is no checkout yet (no volume, an empty one, or an
   * initialization not ready for promotion). A checkout of another repository than `repository` is refused.
   */
  private async readCheckout(volume: string, ref: string, repository: string | undefined, project: string):
    Promise<{ repository: string; revision: string; image: string } | undefined> {
    const d = this.docker;
    const v = await d.run(['volume', 'inspect', volume]);
    if (v.code !== 0) {
      if (/no such volume/i.test(v.stderr)) return undefined;
      throw new Error(`cannot inspect project volume: ${v.stderr}`);
    }
    const checkout = await this.readHelper(project, ['--memory', '256m', '-v', `${volume}:/work:ro`, '--entrypoint', 'sh', ref, '-c', CHECKOUT_SCRIPT],
      CHECKOUT_READ_MS, [0, 44]).catch((e: Error) => {
      if (/operation timed out/.test(e.message)) throw new Error(`cannot read existing checkout: timed out after ${CHECKOUT_READ_MS / 1000} s`);
      throw e;
    });
    if (checkout.code === 44) return undefined;
    if (checkout.code !== 0) throw new Error(`cannot read existing checkout: ${checkout.stderr}`);
    const [origin, head, ...manifest] = checkout.stdout.trim().split('\n');
    const found = checkRepository(origin);
    if (repository !== undefined && found !== repository) throw new Error(`the checkout of ${project} on this host belongs to another repository (${origin})`);
    return { repository: found, revision: checkCommit(head), image: checkImage(manifestImage(manifest.join('\n')), this.cfg.allowedImages) };
  }

  /**
   * Runs a helper container that reads the user's volumes (READ_HELPER) with `args` (the image and its command among
   * them), for at most `timeoutMs` (runHelper: `exited` are the codes of a container that ran to its end).
   */
  private readHelper(project: string, args: string[], timeoutMs: number, exited: number[]): Promise<RunResult> {
    return runHelper(this.docker, this.log, { kind: 'read', user: this.cfg.user, project, args: [...READ_HELPER, ...args], timeoutMs, exited });
  }

  /**
   * The project on this host as Open needs it before choosing an image (agent checkout): its container, and the
   * checkout's repository, revision and pinned environment. Read-only: nothing is pulled or started, and the checkout is
   * read with an image this host already has (the project container's, else the newest environment image). The start
   * reads the checkout again under its lock, since it can change after this answer.
   */
  async checkout(projectArg: string): Promise<CheckoutState> {
    this.authorized();
    const project = checkProject(projectArg);
    const names = projectNames(this.cfg.user, project);
    const c = await this.own(names.container, project) ?? await this.own(recoveryName(this.cfg.user, project), project);
    const container = c ? { repository: c.Config.Labels?.[LABEL.repository], running: c.State.Running } : undefined;
    const ref = c?.Image ?? await this.trustedEnvironmentImage();
    if (!ref) {
      // Without a volume there is no checkout, whichever images the host has
      const volume = await this.docker.run(['volume', 'inspect', names.projectVolume]);
      if (volume.code !== 0 && /no such volume/i.test(volume.stderr)) return { container, checkout: 'none' };
      return { container, checkout: 'unknown', reason: 'this host has no environment image to read the checkout with' };
    }
    try {
      // Under the project lock, briefly: a removal must not run between the volume check and the mount (docker run
      // would create the volume anew), and a long start is not waited for
      const found = await this.projectLocked(project, () => this.readCheckout(names.projectVolume, ref, undefined, project), 5_000);
      return found ? { container, checkout: 'present', ...found } : { container, checkout: 'none' };
    } catch (e) {
      return { container, checkout: 'unknown', reason: (e as Error).message };
    }
  }

  /**
   * The image ID to read a user's volumes with when the project has no container: the newest environment image whose
   * pin this host trusts (imageOnHost ready), never one picked by its name alone (an uploaded tag without a record,
   * or moved to another image). Undefined when there is none.
   */
  private async trustedEnvironmentImage(): Promise<string | undefined> {
    const imgs = (await this.docker.images()).filter((i) => pinsOf(i, this.cfg.allowedImages).length)
      .sort((a, b) => (b.Created ?? '').localeCompare(a.Created ?? ''));
    for (const img of imgs) {
      for (const pin of pinsOf(img, this.cfg.allowedImages)) {
        const have = await imageOnHost(this.docker, this.cfg.imageStagingDir, pin).catch(() => undefined);
        if (have?.state === 'ready') return have.id;
      }
    }
    return undefined;
  }

  /**
   * Removes the container a ready replacement took over from. A failure (or a lost acknowledgement of a removal that
   * happened) never touches the replacement: a predecessor still there is removed by the next Open's recovery.
   */
  private async removePredecessor(previous: string): Promise<void> {
    const r = await this.docker.run(['rm', previous]).catch((e: Error) => ({ code: -1, stderr: e.message }));
    if (r.code === 0 || !(await this.docker.container(previous).catch(() => 'unknown'))) return;
    this.log.warn(`could not remove the replaced container ${previous} (${r.stderr.trim()}); the next Open removes it`);
  }

  /**
   * Docker's immutable ID of the pinned image on this host. A missing image is pulled only with pullImages; otherwise,
   * or if the pull fails, start answers imageMissing and the client sends the image (installImage).
   *
   * `running`: the image ID of the project's running container. An uploaded tag without a record of its upload (an
   * image loaded by an fnkc-ctl before those records) that still names exactly that ID is accepted, so that the
   * project reconnects as it is (docs/policies.md: a running container is never replaced), with `trusted` false: the
   * caller uses it only for that running container; a moved tag, a damaged record, or a tag naming another image is
   * never accepted.
   */
  private async environment(image: string, arch: Arch, running?: string): Promise<{ id: string; trusted: boolean }> {
    const have = await this.imageId(image, true, running);
    if (have) return have;
    if (this.cfg.pullImages) return withLock(join(this.cfg.lockDir, 'image-store'), async () => {
      const cached = await this.imageId(image, false);
      if (cached) return cached;
      this.log.info(`Pulling immutable environment ${image}`);
      const r = await this.docker.run(['pull', '-q', image], { timeoutMs: 20 * 60_000 }).catch((e: Error) => ({ code: -1, stderr: e.message }));
      const pulled = r.code === 0 ? await this.imageId(image, false) : undefined;
      if (pulled) return pulled;
      this.log.warn(`could not pull ${image} (${r.code === 0 ? 'Docker does not show it by its digest' : r.stderr.trim().split('\n').pop()}); it will be sent from your computer`);
      throw new EnvironmentImageMissing({ image, arch });
    }, 35 * 60_000);
    throw new EnvironmentImageMissing({ image, arch });
  }

  /**
   * The immutable ID of the pinned image on this host (imageOnHost), trusted when it is ready; undefined when it is
   * missing or only an uploaded tag this host cannot trust is there (except the running container's own unrecorded
   * image, `running`, returned untrusted): that one is never run, the client sends the image again and receiveImage
   * loads it under the tag anew.
   */
  private async imageId(image: string, warn: boolean, running?: string): Promise<{ id: string; trusted: boolean } | undefined> {
    const have = await imageOnHost(this.docker, this.cfg.imageStagingDir, image);
    if (have.state === 'ready') {
      if (have.stray) await this.untagStray(image, have.stray);
      return { id: have.id, trusted: true };
    }
    if (have.state === 'unrecorded' && running !== undefined && have.id === running) {
      if (warn) {
        this.log.warn(`${have.tag} on this host has no record of its upload; the running project keeps it until it stops, ` +
          'then the image will be sent from your computer again');
      }
      return { id: have.id, trusted: false };
    }
    if (warn && have.state !== 'absent') {
      const why = have.state === 'moved' ? 'names another image than was uploaded'
        : have.state === 'invalid' ? 'has a damaged record of its upload' : 'has no record of its upload';
      this.log.warn(`${have.tag} on this host ${why}; ` +
        'it is not used, and the image will be sent from your computer again');
    }
    return undefined;
  }

  /**
   * The uploaded tag of `image` names another image than the pulled one, which is used (imageOnHost): normal on the
   * containerd image store, where a pull and a load of the same content get different IDs. The tag is removed so that
   * nothing names that image as the pin; a container that uses it keeps it (Docker refuses the untag), with a warning.
   */
  private async untagStray(image: string, stray: { tag: string; id: string }): Promise<void> {
    const r = await this.docker.run(['image', 'rm', '--no-prune', stray.tag]).catch((e: Error) => ({ code: -1, stderr: e.message }));
    this.log.warn(`${stray.tag} names ${stray.id}, not the image Docker pulled for ${image}, which is used; ` +
      (r.code === 0 ? 'the stray tag was removed' : `could not remove the stray tag (${r.stderr.trim().split('\n').pop()})`));
  }

  /**
   * The running container no longer matches the setup a new start would create (a new image pin, fnkc-ctl update,
   * key or limits): it is never replaced under running work. The client connects to it as it is and is told that an
   * update waits for the next explicit stop. Only if it serves the client's Positron build: another build's client
   * could not connect (Remote SSH would try to download its server).
   */
  private async connectPending(c: ContainerJson, project: string, revision: string, pinned: string, commit: string): Promise<StartResult> {
    const running = imagePositron(await this.docker.image(c.Image ?? c.Config.Image));
    if (running?.commit !== commit) {
      throw new Error(`${project} is running with the server of Positron ${running?.version ?? 'unknown'}, not this computer's: ` +
        'stop it after saving work and finishing jobs, then reopen it from this Positron');
    }
    const runs = pinnedImageOf(c);
    this.log.warn(`${project} keeps running as it is: an environment or setup update waits until you stop it`);
    const result = await this.ready(project, runs, revision, false);
    // The checkout pins `pinned` now; the client compares its container.json with this
    return { ...result, pinnedImage: pinned, updatePending: true };
  }

  private async ready(project: string, image: string, revision: string, created: boolean): Promise<StartResult> {
    const container = projectNames(this.cfg.user, project).container;
    let checks = '';
    for (let i = 0; i < READY_CHECKS; i++) {
      const c = await this.own(container, project);
      if (!c?.State.Running) throw new NotReady(`container failed to start: ${container}${await this.readinessLog(container, checks)}`);
      const key = await this.docker.run(['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
      const port = sshPortOf(c);
      const health = await this.docker.run(['exec', container, 'sh', '-c', 'kill -0 "$(cat /run/fnkc-sshd.pid)" && /usr/sbin/sshd -t']);
      if (key.code === 0 && health.code === 0 && port) return { container, sshPort: port, created, image, revision, hostKey: checkSshKey(key.stdout) };
      checks = [key.code ? key.stderr : '', health.code ? health.stderr : '', port ? '' : 'no SSH port published'].map((x) => x.trim()).filter(Boolean).join('\n');
      await new Promise((resolve) => setTimeout(resolve, this.readyPollMs));
    }
    throw new NotReady(`container host key was not initialized: ${container}${await this.readinessLog(container, checks)}`);
  }

  /**
   * The tail of a container's readiness log for the user: the last readiness check's errors and the last lines Docker
   * logged for it (the entrypoint's output), printable characters only and bounded. Empty if there is nothing to show.
   */
  private async readinessLog(container: string, checks: string): Promise<string> {
    const logs = await this.docker.run(['logs', '--tail', String(READY_LOG_LINES), container], { timeoutMs: 10_000 })
      .catch(() => ({ code: -1, stdout: '', stderr: '' }));
    const clean = (x: string) => x.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
    const parts = [clean(checks), logs.code === 0 ? clean(`${logs.stdout}\n${logs.stderr}`) : ''].filter(Boolean);
    if (!parts.length) return '';
    const text = parts.join('\n');
    return `; last lines of its readiness log:\n${text.length > READY_LOG_CHARS ? `…${text.slice(-READY_LOG_CHARS)}` : text}`;
  }

  /**
   * Stops the project's container. With `repository` (a qualified stop: owner/name or a URL, capability
   * qualified-stop-v1), only a container created for that repository: one of another repository with the same name,
   * or without a repository label, is left as it is and named in the result.
   */
  async stop(project: string, repository?: string): Promise<StopResult> {
    if (repository !== undefined) repository = checkRepository(repository);
    return this.projectLocked(project, async () => {
      this.authorized();
      if (repository !== undefined) {
        const c = await this.own(projectNames(this.cfg.user, checkProject(project)).container, project);
        const label = c?.Config.Labels?.[LABEL.repository];
        if (c && !(label && sameRepository(label, repository))) return { stopped: false, outcome: 'other-repository', otherRepository: label ?? '' };
      }
      const outcome = await this.stopLocked(project);
      return { stopped: outcome !== 'absent', outcome };
    });
  }

  /** Stops the project's container, if it has one; the caller holds the project lock. Volumes are kept. */
  private async stopLocked(project: string): Promise<'absent' | 'already-stopped' | 'stopped'> {
    const name = projectNames(this.cfg.user, checkProject(project)).container;
    const c = await this.own(name, project);
    if (!c) return 'absent';
    if (!c.State.Running) return 'already-stopped';
    // Stopping preserves volumes and never rewrites dependencies.
    await this.docker.ok(['stop', '--time', String(STOP_SECONDS), name], { timeoutMs: (STOP_SECONDS + 30) * 1000 });
    return 'stopped';
  }

  /**
   * Root's admin commands (remove-user after the key is gone, stop-all): stops each running project of the user
   * under its project lock, like a stop of the user's own, so it waits for a start in progress instead of racing it.
   * Returns the projects that could not be stopped, with the reason.
   */
  async stopAll(): Promise<{ stopped: string[]; failed: string[] }> {
    const cs = await this.docker.containers([`${LABEL.managed}=1`, `${LABEL.user}=${this.cfg.user}`]);
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const c of cs.filter((x) => isProjectContainer(x) && x.State.Running)) {
      const project = c.Config.Labels?.[LABEL.project] ?? '';
      try {
        await this.projectLocked(project, () => this.stopLocked(project));
        stopped.push(project);
      } catch (e) {
        failed.push(`${project}: ${(e as Error).message}`);
      }
    }
    return { stopped, failed };
  }

  async list(): Promise<ContainerInfo[]> {
    this.authorized();
    const cs = await this.docker.containers([`${LABEL.managed}=1`, `${LABEL.user}=${this.cfg.user}`]);
    const memory = new Map<string, string>();
    const names = cs.filter((c) => c.State.Running).map((c) => c.Name.replace(/^\//, ''));
    if (names.length) {
      // Memory figures are a convenience: a busy host whose stats are slow still gets its list
      const stats = await this.docker.run(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}', ...names], { timeoutMs: 15_000 })
        .catch((e: Error) => { this.log.warn(`memory use not shown: ${e.message}`); return { stdout: '' }; });
      for (const line of stats.stdout.split('\n')) {
        const [name, use] = line.split('\t');
        if (name && use) memory.set(name, use);
      }
    }
    const projects = cs.filter((c) => isProjectContainer(c));
    // What the idle watch last wrote (only where it runs: idleMinutes on this host)
    const idle = new Map<string, Partial<ContainerInfo>>();
    if (this.cfg.idleMinutes) {
      await Promise.all(projects.filter((c) => c.State.Running).map(async (c) => {
        const name = c.Name.replace(/^\//, '');
        const r = await this.docker.run(['exec', name, 'cat', '/run/fnkc-idle'], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: '' }));
        if (r.code === 0) idle.set(name, idleState(r.stdout, this.cfg.idleCheckSeconds ?? 60));
      }));
    }
    return projects.map((c) => ({
      memory: memory.get(c.Name.replace(/^\//, '')),
      project: c.Config.Labels?.[LABEL.project] ?? '', repository: c.Config.Labels?.[LABEL.repository],
      container: c.Name.replace(/^\//, ''), running: c.State.Running, state: c.State.Status,
      image: pinnedImageOf(c), sshPort: sshPortOf(c), ...idle.get(c.Name.replace(/^\//, '')),
    }));
  }

  /** What still computes in the running project (Stop shows it before it ends them); [] if it does not run. */
  async busy(project: string): Promise<BusyProcess[]> {
    this.authorized();
    const name = projectNames(this.cfg.user, checkProject(project)).container;
    const c = await this.own(name, project);
    if (!c?.State.Running) return [];
    const r = await this.docker.run(['exec', '--user', CONTAINER_USER, name, 'fnkc-projects', 'busy'], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`could not tell what runs in ${project}: ${r.stderr.trim().split('\n').pop() || `exit code ${r.code}`}`);
    return parseBusy(r.stdout);
  }

  /** Keeps the running project for 3 more days without a window (the idle watch reads /run/fnkc-keep). */
  async keep(project: string): Promise<{ until: string }> {
    return this.projectLocked(project, async () => {
      this.authorized();
      const name = projectNames(this.cfg.user, checkProject(project)).container;
      const c = await this.own(name, project);
      if (!c?.State.Running) throw new Error(`${project} is not running`);
      await this.docker.ok(['exec', name, 'touch', '/run/fnkc-keep']);
      return { until: new Date(Date.now() + BUSY_STOP_MINUTES * (this.cfg.idleCheckSeconds ?? 60) * 1000).toISOString() };
    });
  }

  /**
   * The environment images on this host (only repositories in allowedImages), with how many project containers
   * use each. Containers of other users are only counted: their names stay private.
   */
  async images(): Promise<HostImage[]> {
    this.authorized();
    const [imgs, cs] = await Promise.all([this.docker.images(), this.docker.containers([`${LABEL.managed}=1`])]);
    const result: HostImage[] = [];
    for (const img of imgs) {
      const references = pinsOf(img, this.cfg.allowedImages);
      if (!references.length) continue;
      const users = cs.filter((c) => c.Image === img.Id);
      result.push({
        references, id: img.Id, architecture: img.Architecture, size: img.Size ?? 0, created: img.Created,
        labels: Object.fromEntries(Object.entries(img.Config?.Labels ?? {}).filter(([k]) => /^(r-env|positron)\./.test(k))),
        containers: users.length, running: users.filter((c) => c.State.Running).length,
        projects: users.filter((c) => c.Config.Labels?.[LABEL.user] === this.cfg.user && isProjectContainer(c)).map((c) => c.Config.Labels?.[LABEL.project] ?? '').filter(Boolean).sort(),
      });
    }
    return result.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  }

  /**
   * Removes an environment image no container uses (offered for Docker on this computer only, not over SSH).
   * Each of its names is removed without force, so Docker itself refuses while any container still uses it.
   */
  async removeImage(id: string): Promise<{ removed: true }> {
    return withLock(join(this.cfg.lockDir, 'image-store'), async () => {
      if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`not an image ID: ${id}`);
      const img = await this.docker.image(id);
      if (!img) return { removed: true };
      if (!pinsOf(img, this.cfg.allowedImages).length) throw new Error('only environment images can be removed here');
      const users = (await this.docker.containers([])).filter((c) => c.Image === id).map((c) => c.Name.replace(/^\//, ''));
      if (users.length) throw new Error(`the image is used by ${users.join(', ')}: remove those containers first`);
      for (const ref of [...(img.RepoTags ?? []), ...(img.RepoDigests ?? [])]) {
        const r = await this.docker.run(['image', 'rm', ref]);
        if (r.code !== 0 && !/no such image/i.test(r.stderr)) throw new Error(`could not remove ${ref}: ${r.stderr.trim()}`);
      }
      if (await this.docker.image(id)) await this.docker.ok(['image', 'rm', id]);
      return { removed: true };
    });
  }

  /**
   * What deleting the stopped project would lose (RemovalCheck). Read-only and without the host lock: the checkout
   * is read by a throwaway container without network, as in start.
   */
  async removalCheck(project: string): Promise<RemovalCheck> {
    return this.projectLocked(project, () => this.inspectRemoval(project, true));
  }

  /**
   * Deletes the project's container, volumes and network, if it is still as `fingerprint` (from removalCheck) says:
   * a project opened or changed since is refused, so nothing is lost that the user did not see.
   */
  async remove(project: string, fingerprint: string): Promise<{ removed: string[] }> {
    return this.projectLocked(project, async () => {
      const check = await this.inspectRemoval(project, false);
      if (check.fingerprint !== fingerprint) throw new Error(`${project} changed since it was checked: check it again before deleting`);
      const removed: string[] = [];
      // Without force: Docker refuses a running container, and a volume that any container still uses
      if (check.container) { await this.docker.ok(['rm', check.container]); removed.push(check.container); }
      for (const v of check.volumes) { await this.docker.ok(['volume', 'rm', v.name]); removed.push(v.name); }
      if (check.network) { await this.docker.ok(['network', 'rm', check.network]); removed.push(check.network); }
      this.log.info(`Deleted ${project}: ${removed.join(', ')}`);
      return { removed };
    });
  }

  private async inspectRemoval(projectArg: string, sizes: boolean): Promise<RemovalCheck> {
    this.authorized();
    const project = checkProject(projectArg);
    const names = projectNames(this.cfg.user, project);
    const d = this.docker;
    const c = await this.own(names.container, project);
    if (c?.State.Running) throw new Error(`${project} is running: stop it first`);
    for (const name of [recoveryName(this.cfg.user, project), `${names.container}-previous`]) {
      const previous = await d.container(name);
      if (previous?.Config.Labels?.[LABEL.user] === this.cfg.user && previous.Config.Labels?.[LABEL.project] === project) {
        throw new Error(`a recovery container ${name} exists; reopen the project to recover it before removal`);
      }
    }
    const volumes = await this.projectVolumes(project);
    const network = `${names.container}-net`;
    const hasNetwork = (await d.run(['network', 'inspect', network])).code === 0;
    if (!c && !volumes.length) throw new Error(`there is no project ${project} on this host`);

    const image = c?.Image ?? await this.trustedEnvironmentImage();
    let out = '';
    if (image) {
      const mounts = volumes.flatMap((v) => ['-v', v.name === names.projectVolume ? `${v.name}:/work:ro` : `${v.name}:/v/${v.name}:ro`]);
      // The script keeps git's output in /tmp: a small tmpfs, counted in the helper's memory limit
      const r = await this.readHelper(project, ['--memory', '512m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
        '-e', `SIZES=${sizes ? 1 : 0}`, ...mounts, '--entrypoint', 'bash', image, '-c', REMOVAL_SCRIPT], REMOVAL_READ_MS, [0]);
      if (r.code !== 0) throw new Error(`could not read the project's volumes: ${r.stderr.trim().split('\n').pop()}`);
      out = r.stdout;
    }
    const parsed = parseRemovalOutput(out);
    let git = parsed.git;
    if (volumes.some((v) => v.name === names.projectVolume) && !git) {
      git = { error: 'there is no environment image on this host to read the checkout with', unpushedCount: 0, unpushed: [],
        stashes: [], changed: [], untracked: [], ignored: [], regenerable: [], auxiliary: [], topLevel: [] };
    }
    const content = /^@@fnkc:content\n([0-9a-f]{64})(?:\s|$)/m.exec(out)?.[1];
    if (volumes.length && !content) throw new Error('cannot fingerprint all project volumes; deletion is unavailable');
    const writable = c ? await writableContent(d, names.container) : undefined;
    const root = writable?.root;
    const outside = writable ? outsideProject(writable.diff, project) : [];
    const kib = (name: string) => parsed.sizes.get(name === names.projectVolume ? '/work' : `/v/${name}`);
    const check: Omit<RemovalCheck, 'fingerprint'> = {
      project, container: c ? names.container : undefined,
      volumes: volumes.map((v) => ({ ...v, kib: sizes ? kib(v.name) : undefined })),
      network: hasNetwork ? network : undefined, git, outside,
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...check, content, root, id: c?.Image, volumes: check.volumes.map((v) => v.name) })).digest('hex');
    return { ...check, fingerprint };
  }

  /** The volumes of this user's project that exist, with what each holds. */
  private async projectVolumes(project: string): Promise<{ name: string; holds: string }[]> {
    const n = projectNames(this.cfg.user, project);
    const holds: Record<string, string> = {
      [n.projectVolume]: `the project folder ~/${project}: the git checkout, data and results`,
      [n.dataVolume]: "Positron's settings, state and history for this project",
      [n.libraryVolume]: "the project's R packages (renv cache)",
      [n.legacyExtensionsVolume]: 'Positron extensions (from an older fnkc-ctl)',
    };
    const ext = new RegExp(`^fnkc-ext-${this.cfg.user}-${project.replace(/[.]/g, '\\.')}-(x64|arm64)-[0-9a-f]{12}$`);
    const all = (await this.docker.ok(['volume', 'ls', '-q'])).split(/\s+/).filter(Boolean);
    return all.filter((v) => holds[v] || ext.test(v)).sort()
      .map((name) => ({ name, holds: holds[name] ?? 'Positron extensions in the container' }));
  }

  /**
   * Creates the project's volumes that do not exist yet, labelled with their user and project, so admin status and
   * an administrator find them by label (volumes from before have only their names).
   */
  private async ensureVolumes(project: string, volumes: string[]): Promise<void> {
    const existing = new Set((await this.docker.ok(['volume', 'ls', '-q'])).split(/\s+/).filter(Boolean));
    for (const v of volumes.filter((x) => !existing.has(x))) {
      await this.docker.ok(['volume', 'create', '--label', `${LABEL.managed}=1`, '--label', `${LABEL.user}=${this.cfg.user}`,
        '--label', `${LABEL.project}=${project}`, v]);
    }
  }

  /** Raw SSH stream; the caller can never specify an address, port, user, or Docker operation. */
  async connectProject(project: string): Promise<void> {
    this.authorized();
    const enrolledKey = this.cfg.keysDir ? this.publicKey() : undefined;
    const name = projectNames(this.cfg.user, checkProject(project)).container;
    const c = await this.own(name, project);
    const port = c && sshPortOf(c);
    if (!c?.State.Running || !port) throw new Error('project is not running');
    if (this.cfg.requireProvenance) {
      const image = c.Config.Env?.find((v) => v.startsWith('FNKC_IMAGE_DIGEST='))?.slice('FNKC_IMAGE_DIGEST='.length);
      const mark = `${image ?? ''}|${this.cfg.provenanceRepository}|${this.cfg.provenanceWorkflow}`;
      if (!image || c.Config.Labels?.[LABEL.provenance] !== mark) {
        throw new Error('project has no current verified-image mark; stop and reopen it to verify provenance');
      }
    }
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      const timer = setTimeout(() => socket.destroy(new Error('container connection timed out')), 10_000);
      // Revocation ends already-established raw transports as well as future requests.
      const revoke = setInterval(() => {
        try { this.authorized(); if (enrolledKey && this.publicKey() !== enrolledKey) socket.destroy(); } catch { socket.destroy(); }
      }, 5000);
      socket.once('connect', () => { clearTimeout(timer); process.stdin.pipe(socket); socket.pipe(process.stdout); });
      socket.once('error', reject);
      socket.once('close', () => { clearTimeout(timer); clearInterval(revoke); process.stdin.unpipe(socket); process.stdin.pause(); resolve(); });
      process.stdout.once('error', () => socket.destroy());
    });
  }

  private async own(name: string, project: string): Promise<ContainerJson | null> {
    const c = await this.docker.container(name);
    if (!c) return null;
    const l = c.Config.Labels ?? {};
    if (l[LABEL.managed] !== '1' || l[LABEL.user] !== this.cfg.user || l[LABEL.project] !== project) throw new Error(`refusing container not owned by this user/project: ${name}`);
    return c;
  }

  private publicKey(req?: StartRequest): string {
    if (!this.cfg.keysDir) return checkSshKey(req?.sshPublicKey);
    return checkSshKey(readFileSync(join(this.cfg.keysDir, `${this.cfg.user}.pub`), 'utf8').trim());
  }

  private createArgs(project: string, repository: string, image: string, arch: Arch, key: string, ext: string, hostCpus: number): string[] {
    const n = projectNames(this.cfg.user, project);
    const cpus = String(Math.min(Number(this.cfg.limits.cpus), hostCpus));
    return ['create', '--name', n.container, '--hostname', hostnameOf(project),
      '--label', `${LABEL.managed}=1`, '--label', `${LABEL.user}=${this.cfg.user}`, '--label', `${LABEL.project}=${project}`,
      '--label', `${LABEL.repository}=${repository}`, '--restart', 'no', '--platform', platformOf(arch),
      // Only where verification is required: the mark says that this image passed it under this policy
      ...(this.cfg.requireProvenance ? ['--label', `${LABEL.provenance}=${image}|${this.cfg.provenanceRepository}|${this.cfg.provenanceWorkflow}`] : []),
      '--network', `${n.container}-net`, '-p', '127.0.0.1::22',
      ...Object.entries(this.cfg.extraHosts).flatMap(([name, ip]) => ['--add-host', `${name}:${ip}`]),
      '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
      '-e', `SSH_PUBLIC_KEY=${key}`, '-e', `FNKC_PROJECT=${project}`, '-e', `FNKC_IMAGE_DIGEST=${image}`, '-e', `FNKC_IDLE_MINUTES=${this.cfg.idleMinutes}`,
      '-e', `FNKC_CRAN_MIRROR=${this.cfg.cranMirror}`,
      '-e', `OMP_NUM_THREADS=${Math.max(1, Math.floor(Number(cpus)))}`, '-e', 'OPENBLAS_NUM_THREADS=1',
      ...(this.cfg.idleCheckSeconds ? ['-e', `FNKC_IDLE_INTERVAL=${this.cfg.idleCheckSeconds}`] : []),
      '-e', `FNKC_BUSY_NOTICE_MINUTES=${BUSY_NOTICE_MINUTES}`, '-e', `FNKC_BUSY_STOP_MINUTES=${BUSY_STOP_MINUTES}`,
      '-v', `${n.projectVolume}:${CONTAINER_HOME}/${project}`, '-v', `${n.dataVolume}:${SERVER_DATA_DIR}/data`,
      '-v', `${n.libraryVolume}:${LIBRARY_DIR}`,
      '-v', `${ext}:${SERVER_DATA_DIR}/extensions`,
      '--memory', this.cfg.limits.memory!, '--memory-swap', this.cfg.limits.memory!, '--cpus', cpus,
      '--pids-limit', String(this.cfg.limits.pids),
      // No core dumps: a process that crashes while the container stops would write a file of several GB
      // into its working directory, the project folder. Soft and hard limit 0, so a session cannot raise it.
      '--ulimit', 'core=0',
      // Root in the container (the entrypoint, sshd) keeps only what they need: ownership of mount points and
      // keys, sshd's privilege separation and port 22. No raw sockets, device nodes or file capabilities, and no
      // privilege gains through setuid programs (the analyst has no sudo).
      '--cap-drop', 'ALL', ...CONTAINER_CAPABILITIES.flatMap((c) => ['--cap-add', c]),
      '--security-opt', 'no-new-privileges',
      // docker-init as PID 1 reaps orphaned processes and passes docker stop to the entrypoint.
      '--init', '--entrypoint', '/usr/local/bin/fnkc-entrypoint', image];
  }
}

/**
 * The pins (repository@sha256:...) a host image answers to, in the allowed repositories: the digest it was pulled
 * by, or the tag the agent gives an uploaded image (uploadedTag: repository:sha256-<hex>).
 */
export function pinsOf(img: Pick<ImageJson, 'RepoTags' | 'RepoDigests'>, allowed: string[]): string[] {
  const pins = new Set<string>();
  for (const d of img.RepoDigests ?? []) {
    const [repo, digest] = d.split('@');
    if (allowed.includes(repo) && /^sha256:[0-9a-f]{64}$/.test(digest ?? '')) pins.add(d);
  }
  for (const t of img.RepoTags ?? []) {
    const m = /^(.+):sha256-([0-9a-f]{64})$/.exec(t);
    if (m && allowed.includes(m[1])) pins.add(`${m[1]}@sha256:${m[2]}`);
  }
  return [...pins].sort();
}

function archOf(arch: string | undefined): Arch {
  if (arch === 'amd64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`unsupported image architecture: ${arch}`);
}
export const platformOf = (arch: Arch) => arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
export const hostnameOf = (project: string) => project.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'project';


/** /run/fnkc-idle (container/idle-watch.sh) as ContainerInfo fields; one check is `interval` seconds. */
export function idleState(text: string, interval: number, now = Date.now()): Partial<ContainerInfo> {
  const v = new Map(text.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2 && /^\d+$/.test(p[1])).map(([k, n]) => [k, Number(n)]));
  if (!v.has('no_window')) return {};
  const at = (checks: number) => new Date(now + checks * interval * 1000).toISOString();
  const noWindow = v.get('no_window')!;
  const out: Partial<ContainerInfo> = { busy: v.get('busy') === 1 };
  if (noWindow > 0 && v.has('stop_in')) {
    out.noWindowSince = at(-noWindow);
    // Quiet: the idle rule comes first
    const idleLeft = (v.get('idle_limit') ?? 0) - (v.get('idle') ?? 0);
    out.stopsAt = at(Math.max(0, out.busy ? v.get('stop_in')! : Math.min(v.get('stop_in')!, idleLeft)));
  }
  if (v.get('notice') === 1) out.notice = true;
  return out;
}

/** fnkc-projects busy: "<pid> <cpu> <what>" per line. */
export function parseBusy(text: string): BusyProcess[] {
  return text.split('\n').map((l) => /^(\d+) (\d+) (.+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), cpu: Number(m[2]), what: m[3].trim() }));
}

/** A replacement that does not pass readiness, as the client sees it: what happened and what Discard and retry does. */
function replacementNotReady(project: string, e: NotReady): ReplacementNotReady {
  return new ReplacementNotReady(`the new environment of ${project} started but did not become ready: ${e.message}`);
}
