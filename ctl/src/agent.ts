// The host side: starts, stops and lists one user's project containers on the Docker of this machine.
// On a server it runs under the forced SSH command (see serve.ts), so users never get Docker itself.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig } from './agent-config.ts';
import { ENTRYPOINT, IDLE_WATCH, PROJECTS_SCRIPT, RPROFILE } from './assets.ts';
import { Docker, type ContainerJson, sshPortOf } from './docker.ts';
import { type Arch, CONTAINER_HOME, extensionsVolume, LABEL, projectNames, SERVER_DATA_DIR, serverVolume } from './layout.ts';
import type { Logger } from './log.ts';
import { ensureServer, prepareExtensions } from './positron-server.ts';
import { type ContainerInfo, CTL_VERSION, type PingResult, type StartRequest, type StartResult } from './protocol.ts';
import { tarOf } from './tar.ts';
import { checkCommit, checkImage, checkProject, checkSshKey, checkVersion } from './validate.ts';

export class Agent {
  readonly cfg: AgentConfig;
  readonly log: Logger;
  readonly docker: Docker;
  private hostCpus?: number;
  private hostMemory?: number;

  constructor(cfg: AgentConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log;
    this.docker = new Docker(cfg.docker);
  }

  ping(): PingResult {
    return { version: CTL_VERSION, user: this.cfg.user };
  }

  async start(req: StartRequest): Promise<StartResult> {
    const project = checkProject(req.project);
    const image = checkImage(req.image, this.cfg.allowedImages);
    const version = checkVersion(req.positron?.version);
    const commit = checkCommit(req.positron?.commit);
    const key = this.publicKey(req);
    const d = this.docker;
    const names = projectNames(this.cfg.user, project);

    if (!(await d.image(image))) {
      this.log.info(`Pulling ${image} (the first time takes a few minutes)`);
      const r = await d.run(['pull', '-q', image]);
      if (r.code !== 0) {
        // r-env is built for amd64 only; on Apple Silicon (arm64) Docker runs it under emulation
        if (!/no matching manifest|no match for platform/i.test(r.stderr)) throw new Error(`docker pull: ${r.stderr.trim()}`);
        this.log.info(`${image} has no build for this machine's architecture, pulling linux/amd64 (runs under emulation)`);
        await d.ok(['pull', '-q', '--platform', 'linux/amd64', image]);
      }
    }
    const img = await d.image(image);
    const arch = archOf(img?.Architecture);
    const [hostArch, ncpu, mem] = (await d.ok(['info', '--format', '{{.Architecture}} {{.NCPU}} {{.MemTotal}}'])).trim().split(' ');
    this.hostCpus = Number(ncpu) || undefined;
    this.hostMemory = Number(mem) || undefined;
    const hostIs: Record<string, Arch> = { x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' };
    if (hostIs[hostArch] && hostIs[hostArch] !== arch) {
      this.log.warn(`${image} is built for ${arch}, this machine is ${hostArch}: it runs under emulation, ` +
        'and Positron\'s R session may hang at start. Run the project on the server, or use an image built for this machine.');
    }
    await ensureServer(d, this.cfg, image, arch, version, commit, this.log);
    await prepareExtensions(d, image, arch, extensionsVolume(this.cfg.user, arch), version, commit, this.cfg.skipExtensions, this.log);

    // The r-env image stays as it is: the entrypoint and the helpers are copied into the container
    const files = [
      { name: 'usr/local/bin/positron-entrypoint', mode: 0o755, data: ENTRYPOINT },
      { name: 'usr/local/bin/positron-projects', mode: 0o755, data: PROJECTS_SCRIPT },
      { name: 'usr/local/bin/positron-idle-watch', mode: 0o755, data: IDLE_WATCH },
      { name: 'usr/local/lib/positron/Rprofile.R', mode: 0o644, data: RPROFILE },
    ];
    const args = this.createArgs(project, image, arch, key);
    // Any change of the setup (image, key, limits, idle time, the scripts) means a new container
    // ... and the image itself: the same tag may point to a new build (e.g. rebuilt, or built for this machine)
    const setup = createHash('sha256').update(JSON.stringify([args, files, img?.Id])).digest('hex').slice(0, 16);

    let c = await this.own(names.container, project);
    let created = false;
    if (c && c.Config.Labels?.[LABEL.setup] !== setup) {
      this.log.info('The container setup changed (image, key, limits or scripts): recreating it, the project files are kept');
      await d.ok(['rm', '-f', names.container]);
      c = null;
      // Extensions are shared per user now; the project's own copy is not needed any more
      if ((await d.run(['volume', 'rm', names.legacyExtensionsVolume])).code === 0) {
        this.log.info(`Removed ${names.legacyExtensionsVolume}: extensions are now shared by your projects`);
      }
    }
    if (!c) {
      this.log.info(`Creating container ${names.container}`);
      await d.ok([args[0], '--label', `${LABEL.setup}=${setup}`, ...args.slice(1)]);
      await d.ok(['cp', '-', `${names.container}:/`], { input: tarOf(files) });
      created = true;
    }
    await d.ok(['start', names.container]);

    const started = await d.container(names.container);
    const port = started && sshPortOf(started);
    if (!port) throw new Error(`could not find the SSH port of ${names.container} (docker logs ${names.container})`);
    return { container: names.container, sshPort: port, created };
  }

  async stop(project: string): Promise<{ stopped: boolean }> {
    const names = projectNames(this.cfg.user, checkProject(project));
    const c = await this.own(names.container, project);
    if (!c) return { stopped: false };
    if (c.State.Running) {
      this.log.info(`Stopping ${names.container}`);
      await this.docker.ok(['stop', names.container]);
    }
    return { stopped: true };
  }

  async list(): Promise<ContainerInfo[]> {
    const cs = await this.docker.containers([`${LABEL.managed}=1`, `${LABEL.user}=${this.cfg.user}`]);
    const memory = await this.memoryUse(cs.filter((c) => c.State.Running).map((c) => c.Name.replace(/^\//, '')));
    return cs.map((c) => ({
      memory: memory.get(c.Name.replace(/^\//, '')),
      project: c.Config.Labels?.[LABEL.project] ?? '',
      container: c.Name.replace(/^\//, ''),
      running: c.State.Running,
      state: c.State.Status,
      image: c.Config.Image,
      sshPort: sshPortOf(c),
    }));
  }

  /** "used / limit" per running container, from one docker stats call (it takes a second or two). */
  private async memoryUse(names: string[]): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    if (!names.length) return m;
    const r = await this.docker.run(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}', ...names]);
    for (const line of r.stdout.split('\n')) {
      const [name, use] = line.split('\t');
      if (name && use) m.set(name.trim(), use.trim());
    }
    return m;
  }

  /** The container by name, if it exists; refuses to touch a container that is not this user's project. */
  private async own(name: string, project: string): Promise<ContainerJson | null> {
    const c = await this.docker.container(name);
    if (!c) return null;
    const l = c.Config.Labels ?? {};
    if (l[LABEL.managed] !== '1' || l[LABEL.user] !== this.cfg.user || l[LABEL.project] !== project) {
      throw new Error(`container ${name} exists but was not created by positron-ctl for this user and project`);
    }
    return c;
  }

  private publicKey(req: StartRequest): string {
    if (!this.cfg.keysDir) return checkSshKey(req.sshPublicKey);
    const file = join(this.cfg.keysDir, `${this.cfg.user}.pub`);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`no SSH key for user '${this.cfg.user}' on this host (${file})`);
    }
    return checkSshKey(text.split(/\r?\n/)[0]);
  }

  private createArgs(project: string, image: string, arch: Arch, key: string): string[] {
    const n = projectNames(this.cfg.user, project);
    const { pids } = this.cfg.limits;
    // Without a configured limit, one runaway R script could still take the whole host: keep a quarter free.
    // No swap beyond the limit: hitting it stops the R session quickly instead of slowing everyone down.
    const memory = this.cfg.limits.memory
      ?? (this.hostMemory ? `${Math.floor((this.hostMemory * 0.75) / 2 ** 20)}m` : undefined);
    let cpus = this.cfg.limits.cpus;
    // Docker refuses more CPUs than the host has; the configured limit may be meant for a bigger machine
    if (cpus && this.hostCpus && Number(cpus) > this.hostCpus) {
      this.log.warn(`the cpus limit (${cpus}) is more than this host has, using ${this.hostCpus}`);
      cpus = String(this.hostCpus);
    }
    return [
      'create', '--name', n.container, '--hostname', hostnameOf(project),
      '--label', `${LABEL.managed}=1`, '--label', `${LABEL.user}=${this.cfg.user}`, '--label', `${LABEL.project}=${project}`,
      // A container that stopped itself when idle stays stopped (also after a reboot) until the next Open
      '--restart', 'no', '--platform', platformOf(arch),
      // sshd is reachable only from the host itself; from elsewhere through the host (ProxyJump)
      '-p', '127.0.0.1::22',
      '-e', `SSH_PUBLIC_KEY=${key}`, '-e', `POSITRON_PROJECT=${project}`,
      '-e', `POSITRON_IDLE_MINUTES=${this.cfg.idleMinutes}`,
      ...(this.cfg.idleCheckSeconds ? ['-e', `POSITRON_IDLE_INTERVAL=${this.cfg.idleCheckSeconds}`] : []),
      '-v', `${n.projectVolume}:${CONTAINER_HOME}/${project}`,
      '-v', `${n.dataVolume}:${SERVER_DATA_DIR}/data`,
      '-v', `${extensionsVolume(this.cfg.user, arch)}:${SERVER_DATA_DIR}/extensions`,
      '-v', `${serverVolume(arch)}:${SERVER_DATA_DIR}/bin:ro`,
      ...(memory ? ['--memory', memory, '--memory-swap', memory] : []),
      ...(cpus ? ['--cpus', cpus] : []),
      ...(pids ? ['--pids-limit', String(pids)] : []),
      '--entrypoint', '/usr/local/bin/positron-entrypoint',
      image,
    ];
  }
}

function archOf(dockerArch: string | undefined): Arch {
  if (dockerArch === 'amd64') return 'x64';
  if (dockerArch === 'arm64') return 'arm64';
  throw new Error(`unsupported image architecture: ${dockerArch ?? 'unknown'}`);
}

/** Docker platform of an image architecture (passed explicitly so an emulated image runs without warnings). */
export const platformOf = (arch: Arch) => (arch === 'x64' ? 'linux/amd64' : 'linux/arm64');

/** Host name inside the container: the project name as a valid DNS label. */
export function hostnameOf(project: string): string {
  return project.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'project';
}
