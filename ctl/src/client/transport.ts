// How the client reaches a host's agent: in-process for Docker on this computer, over SSH for a server.
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Agent } from '../agent.ts';
import { agentConfig } from '../agent-config.ts';
import { run } from '../exec.ts';
import type { Logger } from '../log.ts';
import type { ContainerInfo, PingResult, Reply, StartRequest, StartResult } from '../protocol.ts';
import { sanitizeUser } from '../validate.ts';
import type { ClientConfig, HostConfig } from './config.ts';
import { parseSshTarget, type SshTarget } from './ssh.ts';

export interface Transport {
  readonly host: HostConfig;
  /** The server to jump through to reach containers; none for this computer. */
  readonly jump?: SshTarget;
  ping(): Promise<PingResult>;
  start(req: StartRequest): Promise<StartResult>;
  stop(project: string): Promise<{ stopped: boolean }>;
  list(): Promise<ContainerInfo[]>;
}

export class LocalTransport implements Transport {
  readonly host: HostConfig;
  readonly agent: Agent;
  readonly jump = undefined;

  constructor(host: HostConfig, cfg: ClientConfig, log: Logger) {
    this.host = host;
    this.agent = new Agent(agentConfig(sanitizeUser(userInfo().username), cfg.local), log);
  }

  async ping() {
    if (!(await this.agent.docker.available())) throw new Error('Docker is not running on this computer');
    return this.agent.ping();
  }
  start(req: StartRequest) { return this.agent.start(req); }
  stop(project: string) { return this.agent.stop(project); }
  list() { return this.agent.list(); }
}

export class SshTransport implements Transport {
  readonly host: HostConfig;
  readonly jump: SshTarget;
  readonly identity?: string;
  readonly log: Logger;

  constructor(host: HostConfig, cfg: ClientConfig, log: Logger) {
    this.host = host;
    this.jump = parseSshTarget(host.ssh!);
    this.identity = cfg.sshKey;
    this.log = log;
  }

  private async call<T>(words: string[], input?: string, timeout = 10): Promise<T> {
    const args = [
      '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeout}`, '-o', 'StrictHostKeyChecking=accept-new',
      ...(this.jump.port ? ['-p', this.jump.port] : []),
      ...(this.identity && existsSync(this.identity) ? ['-i', this.identity] : []),
      this.jump.dest, 'positron-ctl', 'agent', ...words,
    ];
    // The agent's progress messages ("==> ..." / "Warning: ...") are passed on as they arrive
    const r = await run('ssh', args, {
      input,
      onStderr: (line) => {
        const m = /^(==>|Warning:)\s*(.*)$/.exec(line);
        if (m?.[1] === '==>') this.log.info(`[${this.host.name}] ${m[2]}`);
        else if (m) this.log.warn(`[${this.host.name}] ${m[2]}`);
      },
    });
    const last = r.stdout.trim().split('\n').pop() ?? '';
    let reply: Reply<T>;
    try {
      reply = JSON.parse(last) as Reply<T>;
    } catch {
      const why = r.stderr.trim().split('\n').filter((l) => !/^(==>|Warning:)/.test(l)).pop();
      throw new Error(`host '${this.host.name}' (${this.host.ssh}): ${why || `no answer from positron-ctl (exit code ${r.code})`}`);
    }
    if (!reply.ok) throw new Error(`host '${this.host.name}': ${reply.error}`);
    return reply.result;
  }

  ping() { return this.call<PingResult>(['ping']); }
  start(req: StartRequest) { return this.call<StartResult>(['start'], JSON.stringify(req)); }
  stop(project: string) { return this.call<{ stopped: boolean }>(['stop', project]); }
  list() { return this.call<ContainerInfo[]>(['list']); }
}

export function transportFor(host: HostConfig, cfg: ClientConfig, log: Logger): Transport {
  return host.ssh ? new SshTransport(host, cfg, log) : new LocalTransport(host, cfg, log);
}
