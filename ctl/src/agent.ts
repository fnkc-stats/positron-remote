// Host-side lifecycle and access policy. All Docker mutations share a host-local lock.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import type { AgentConfig } from './agent-config.ts';
import { ENTRYPOINT, IDLE_WATCH, PROJECTS_SCRIPT, RPROFILE } from './assets.ts';
import { Docker, type ContainerJson, sshPortOf } from './docker.ts';
import { type Arch, CONTAINER_HOME, extensionsVolume, LABEL, libraryVolume, projectNames, R_SITE_LIBRARY, RENV_CACHE_DIR, RENV_CACHE_VOLUME, SERVER_DATA_DIR, serverVolume } from './layout.ts';
import { type BuildOptions, buildLibrary, type LibraryInfo, libraryMissing, libraryState, listLibraries, lockfileHash } from './library.ts';
import { withLock } from './lock.ts';
import type { Logger } from './log.ts';
import { ensureServer, installServer, prepareExtensions } from './positron-server.ts';
import { type ContainerInfo, CTL_VERSION, type LibraryBuild, type PingResult, type StartRequest, type StartResult } from './protocol.ts';
import { checkRepository, manifestImage, manifestLibrary, repositoryId } from './repository.ts';
import { tarOf } from './tar.ts';
import { checkCommit, checkImage, checkLibrary, checkProject, checkSshKey, checkVersion } from './validate.ts';

export function memoryBytes(value: string): number {
  const units: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return parseFloat(value) * (units[value.slice(-1).toLowerCase()] ?? 1);
}

export class Agent {
  readonly cfg: AgentConfig;
  readonly log: Logger;
  readonly docker: Docker;
  constructor(cfg: AgentConfig, log: Logger, docker = new Docker(cfg.docker)) {
    this.cfg = cfg; this.log = log; this.docker = docker;
  }

  private locked<T>(work: () => Promise<T>): Promise<T> {
    return withLock(join(this.cfg.lockDir, 'host'), work);
  }

  private authorized(): void {
    // Recheck for every command: existing SSH transports must not bypass offboarding.
    if (this.cfg.keysDir) this.publicKey();
  }

  ping(): PingResult {
    this.authorized();
    return { version: CTL_VERSION, user: this.cfg.user };
  }

  async start(req: StartRequest): Promise<StartResult> {
    return this.locked(() => this.startLocked(req));
  }

  /**
   * Installs a Positron server archive sent by the client (after start answered serverMissing). `image` must be
   * an allowed image already on this host; it runs the install helper and sets the architecture.
   */
  async installServer(commitArg: string | undefined, imageArg: string | undefined, archive: Readable): Promise<{ installed: true }> {
    this.authorized();
    const commit = checkCommit(commitArg);
    const image = checkImage(imageArg, this.cfg.allowedImages);
    return this.locked(async () => {
      const img = await this.docker.image(image);
      if (!img) throw new Error('install-server: the image is not on this host; open the project first');
      await installServer(this.docker, image, archOf(img.Architecture), commit, archive, 0, this.log);
      return { installed: true as const };
    });
  }

  private async startLocked(req: StartRequest): Promise<StartResult> {
    this.authorized();
    const project = checkProject(req.project);
    const repository = checkRepository(req.repository);
    if (repositoryId(repository) !== project) throw new Error('project identity does not match repository');
    let revision = checkCommit(req.revision);
    let image = checkImage(req.image, this.cfg.allowedImages);
    let library = req.library === undefined ? undefined : checkLibrary(req.library);
    const version = checkVersion(req.positron?.version);
    const commit = checkCommit(req.positron?.commit);
    const key = this.publicKey(req);
    const d = this.docker;
    const names = projectNames(this.cfg.user, project);
    let c = await this.own(names.container, project);
    if (c && c.Config.Labels?.[LABEL.repository] !== repository) throw new Error('container repository identity differs');
    await this.pull(image);

    // Inspect the durable checkout without executing its code, hooks or git configuration helpers.
    const volume = await d.run(['volume', 'inspect', names.projectVolume]);
    if (volume.code === 0) {
      const checkout = await d.run(['run', '--rm', '--network', 'none', '--user', '1000:1000',
        '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
        '-v', `${names.projectVolume}:/work:ro`, '--entrypoint', 'sh', image, '-c',
        'if [ ! -d /work/.git ]; then [ -z "$(ls -A /work)" ] && exit 44; echo "nonempty project volume has no .git directory" >&2; exit 1; fi; git -C /work config --get remote.origin.url; git -C /work rev-parse HEAD; cat /work/container.json']);
      if (checkout.code === 0) {
        const [origin, head, ...manifest] = checkout.stdout.trim().split('\n');
        if (checkRepository(origin) !== repository) throw new Error('existing checkout belongs to another repository');
        revision = checkCommit(head);
        image = checkImage(manifestImage(manifest.join('\n')), this.cfg.allowedImages);
        library = manifestLibrary(manifest.join('\n'));
        await this.pull(image);
      } else if (checkout.code !== 44) throw new Error(`cannot read existing checkout: ${checkout.stderr}`);
    } else if (!/no such volume/i.test(volume.stderr)) throw new Error(`cannot inspect project volume: ${volume.stderr}`);

    const img = await d.image(image);
    const arch = archOf(img?.Architecture);
    const [hostArch, ncpu, mem] = (await d.ok(['info', '--format', '{{.Architecture}} {{.NCPU}} {{.MemTotal}}'])).trim().split(' ');
    const hostMemory = Number(mem);
    if (!hostMemory || !Number(ncpu)) throw new Error('cannot determine host capacity');
    const hostIs: Record<string, Arch> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' };
    if (hostIs[hostArch] !== arch) throw new Error('image architecture differs from host; use a native image or the remote server');
    // The library volume is per image ID: a library built for another image (or architecture) is never mounted
    const libVolume = library && libraryVolume(img!.Id, library);
    if (library && libVolume) {
      const state = await libraryState(d, image, libVolume);
      if (state !== 'ready') throw libraryMissing(library, image, state, !this.cfg.keysDir);
    }
    const files = [
      { name: 'usr/local/bin/positron-entrypoint', mode: 0o755, data: ENTRYPOINT },
      { name: 'usr/local/bin/positron-projects', mode: 0o755, data: PROJECTS_SCRIPT },
      { name: 'usr/local/bin/positron-idle-watch', mode: 0o755, data: IDLE_WATCH },
      { name: 'usr/local/lib/positron/Rprofile.R', mode: 0o644, data: RPROFILE },
    ];
    const ext = extensionsVolume(this.cfg.user, arch, project, commit);
    const args = this.createArgs(project, repository, image, arch, key, ext, Number(ncpu), library, libVolume || undefined);
    const setup = createHash('sha256').update(JSON.stringify([args, files, img?.Id])).digest('hex');
    const changed = c && c.Config.Labels?.[LABEL.setup] !== setup;
    if (changed && c?.State.Running) throw new Error('environment update pending: stop this project explicitly after saving work and finishing jobs, then reopen');
    if (!c?.State.Running) await this.admit(hostMemory);

    await ensureServer(d, this.cfg, image, arch, version, commit, this.log);
    await prepareExtensions(d, image, arch, ext, version, commit, this.cfg.skipExtensions, this.log);
    const network = `${names.container}-net`;
    const net = await d.run(['network', 'inspect', network]);
    if (net.code !== 0) {
      if (!/no such network|not found/i.test(net.stderr)) throw new Error(`cannot inspect network: ${net.stderr}`);
      await d.ok(['network', 'create', '--label', `${LABEL.managed}=1`, network]);
    }
    const previous = `${names.container}-previous`;
    let renamed = false;
    let created = false;
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
        await d.ok(['start', names.container]);
      }
      const result = { ...await this.ready(project, image, revision, created), ...(library ? { library } : {}) };
      if (renamed) await d.ok(['rm', previous]);
      return result;
    } catch (e) {
      if (created) await d.run(['rm', '-f', names.container]); // never removes volumes
      if (renamed && !(await d.container(names.container))) await d.ok(['rename', previous, names.container]);
      throw e;
    }
  }

  /**
   * Builds the R library of `lockfile` for `image` and checks it (see library.ts). Only for administrators on a
   * server (positron-ctl admin build-library) and for this computer; users cannot ask for it over SSH.
   */
  async buildLibrary(imageArg: string, lockfile: string, o: Partial<Omit<BuildOptions, 'repository'>> = {}): Promise<LibraryBuild> {
    const image = checkImage(imageArg, this.cfg.allowedImages);
    await this.locked(() => this.pull(image));
    const img = await this.docker.image(image);
    if (!img) throw new Error(`image not found after pull: ${image}`);
    const [hostArch, ncpu] = (await this.docker.ok(['info', '--format', '{{.Architecture}} {{.NCPU}}'])).trim().split(' ');
    const hostIs: Record<string, Arch> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' };
    if (hostIs[hostArch] !== archOf(img.Architecture)) throw new Error('image architecture differs from host: build the library on a host of its architecture');
    const opts: BuildOptions = { jobs: o.jobs ?? Math.max(1, Number(ncpu) || 1), skipChecks: o.skipChecks ?? false, repository: this.cfg.rRepository };
    // One build per library at a time; the host lock is not held, so projects keep starting during the build
    return withLock(join(this.cfg.lockDir, `library-${lockfileHash(lockfile).slice(7, 23)}`), async () =>
      ({ ...await buildLibrary(this.docker, image, img.Id, lockfile, opts, this.log), image }));
  }

  libraries(): Promise<LibraryInfo[]> {
    return listLibraries(this.docker);
  }

  private async pull(image: string): Promise<void> {
    if (!(await this.docker.image(image))) {
      this.log.info(`Pulling immutable environment ${image}`);
      await this.docker.ok(['pull', '-q', image], { timeoutMs: 20 * 60_000 });
    }
  }

  private async ready(project: string, image: string, revision: string, created: boolean): Promise<StartResult> {
    const container = projectNames(this.cfg.user, project).container;
    for (let i = 0; i < 30; i++) {
      const c = await this.own(container, project);
      if (!c?.State.Running) throw new Error(`container failed to start: ${container}; inspect its logs`);
      const key = await this.docker.run(['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
      const port = sshPortOf(c);
      const health = await this.docker.run(['exec', container, 'sh', '-c', 'test "$(cat /proc/1/comm)" = sshd && /usr/sbin/sshd -t']);
      if (key.code === 0 && health.code === 0 && port) return { container, sshPort: port, created, image, revision, hostKey: checkSshKey(key.stdout) };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('container host key was not initialized');
  }

  private async admit(hostMemory: number): Promise<void> {
    const all = await this.docker.containers([]);
    const running = all.filter((c) => c.State.Running);
    const own = running.filter((c) => c.Config.Labels?.[LABEL.user] === this.cfg.user);
    const requested = memoryBytes(this.cfg.limits.memory!);
    const budget = (cs: ContainerJson[]) => cs.reduce((n, c) => n + (c.HostConfig?.Memory || hostMemory), 0);
    if (own.length >= this.cfg.maxProjectsPerUser) throw new Error('concurrent project quota reached; stop another project');
    if (budget(own) + requested > memoryBytes(this.cfg.maxMemoryPerUser)) throw new Error('per-user memory budget exceeded');
    if (budget(running) + requested > hostMemory - memoryBytes(this.cfg.reserveMemory)) throw new Error('host capacity reserved or exhausted; stop another workload or ask the administrator');
  }

  async stop(project: string): Promise<{ stopped: boolean }> {
    return this.locked(async () => {
      this.authorized();
      const name = projectNames(this.cfg.user, checkProject(project)).container;
      const c = await this.own(name, project);
      if (!c) return { stopped: false };
      if (c.State.Running) await this.docker.ok(['stop', '--time', '60', name]);
      return { stopped: true };
    });
  }

  async list(): Promise<ContainerInfo[]> {
    this.authorized();
    const cs = await this.docker.containers([`${LABEL.managed}=1`, `${LABEL.user}=${this.cfg.user}`]);
    const memory = new Map<string, string>();
    const names = cs.filter((c) => c.State.Running).map((c) => c.Name.replace(/^\//, ''));
    if (names.length) {
      const stats = await this.docker.run(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}', ...names], { timeoutMs: 15_000 });
      for (const line of stats.stdout.split('\n')) {
        const [name, use] = line.split('\t');
        if (name && use) memory.set(name, use);
      }
    }
    return cs.filter((c) => !c.Name.endsWith('-previous')).map((c) => ({
      memory: memory.get(c.Name.replace(/^\//, '')),
      project: c.Config.Labels?.[LABEL.project] ?? '', repository: c.Config.Labels?.[LABEL.repository],
      container: c.Name.replace(/^\//, ''), running: c.State.Running, state: c.State.Status,
      image: c.Config.Image, sshPort: sshPortOf(c),
    }));
  }

  /** Raw SSH stream; the caller can never specify an address, port, user, or Docker operation. */
  async connectProject(project: string): Promise<void> {
    this.authorized();
    const enrolledKey = this.cfg.keysDir ? this.publicKey() : undefined;
    const name = projectNames(this.cfg.user, checkProject(project)).container;
    const c = await this.own(name, project);
    const port = c && sshPortOf(c);
    if (!c?.State.Running || !port) throw new Error('project is not running');
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

  private createArgs(project: string, repository: string, image: string, arch: Arch, key: string, ext: string, hostCpus: number,
    library?: string, libVolume?: string): string[] {
    const n = projectNames(this.cfg.user, project);
    const cpus = String(Math.min(Number(this.cfg.limits.cpus), hostCpus));
    return ['create', '--name', n.container, '--hostname', hostnameOf(project),
      '--label', `${LABEL.managed}=1`, '--label', `${LABEL.user}=${this.cfg.user}`, '--label', `${LABEL.project}=${project}`,
      '--label', `${LABEL.repository}=${repository}`, '--restart', 'no', '--platform', platformOf(arch),
      '--network', `${n.container}-net`, '-p', '127.0.0.1::22',
      '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
      '-e', `SSH_PUBLIC_KEY=${key}`, '-e', `POSITRON_PROJECT=${project}`, '-e', `POSITRON_IMAGE_DIGEST=${image}`, '-e', `POSITRON_IDLE_MINUTES=${this.cfg.idleMinutes}`,
      '-e', `POSITRON_R_REPOSITORY=${this.cfg.rRepository}`,
      '-e', `OMP_NUM_THREADS=${Math.max(1, Math.floor(Number(cpus)))}`, '-e', 'OPENBLAS_NUM_THREADS=1',
      ...(this.cfg.idleCheckSeconds ? ['-e', `POSITRON_IDLE_INTERVAL=${this.cfg.idleCheckSeconds}`] : []),
      '-v', `${n.projectVolume}:${CONTAINER_HOME}/${project}`, '-v', `${n.dataVolume}:${SERVER_DATA_DIR}/data`,
      '-v', `${ext}:${SERVER_DATA_DIR}/extensions`, '-v', `${serverVolume(arch)}:${SERVER_DATA_DIR}/bin:ro`,
      ...(this.cfg.sharedRenvCache ? ['-v', `${RENV_CACHE_VOLUME}:${RENV_CACHE_DIR}`] : []),
      // The project's R library replaces the image's site library, read-only, as R and renv already expect it
      ...(library && libVolume ? ['-v', `${libVolume}:${R_SITE_LIBRARY}:ro`, '-e', `POSITRON_LIBRARY=${library}`] : []),
      '--memory', this.cfg.limits.memory!, '--memory-swap', this.cfg.limits.memory!, '--cpus', cpus,
      '--pids-limit', String(this.cfg.limits.pids),
      // No core dumps: a process that crashes while the container stops would write a file of several GB
      // into its working directory, the project folder. Soft and hard limit 0, so a session cannot raise it.
      '--ulimit', 'core=0', '--entrypoint', '/usr/local/bin/positron-entrypoint', image];
  }
}

function archOf(arch: string | undefined): Arch {
  if (arch === 'amd64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`unsupported image architecture: ${arch}`);
}
export const platformOf = (arch: Arch) => arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
export const hostnameOf = (project: string) => project.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'project';
