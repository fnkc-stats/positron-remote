// Pure resource policy plus a Docker snapshot, called under the short admission lock.
import type { Docker, ContainerJson } from './docker.ts';
import type { AgentConfig } from './agent-config.ts';
import { LABEL } from './layout.ts';

export function memoryBytes(value: string): number {
  const units: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return parseFloat(value) * (units[value.slice(-1).toLowerCase()] ?? 1);
}

export async function admit(docker: Docker, cfg: AgentConfig, hostMemory: number): Promise<void> {
    const all = await docker.containers([]);
    const running = all.filter((c) => c.State.Running);
    const own = running.filter((c) => c.Config.Labels?.[LABEL.user] === cfg.user);
    const requested = memoryBytes(cfg.limits.memory!);
    const budget = (cs: ContainerJson[]) => cs.reduce((n, c) => n + (c.HostConfig?.Memory || hostMemory), 0);
    if (own.length >= cfg.maxProjectsPerUser) throw new Error('concurrent project quota reached; stop another project');
    if (budget(own) + requested > memoryBytes(cfg.maxMemoryPerUser)) throw new Error('per-user memory budget exceeded');
    const available = hostMemory - memoryBytes(cfg.reserveMemory);
    if (budget(running) + requested > available) {
      const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)}g`;
      const unlimited = running.filter((c) => !c.HostConfig?.Memory).map((c) => c.Name.replace(/^\//, ''));
      const cause = unlimited.length
        ? `running containers without a memory limit count as the whole host: ${unlimited.join(', ')}; stop them or give them --memory`
        : requested > available
          ? `the host has ${gib(hostMemory)} with ${cfg.reserveMemory} reserved, less than the ${cfg.limits.memory} a project needs; lower limits.memory or reserveMemory`
          : `running containers already use ${gib(budget(running))} of ${gib(available)}; stop another workload`;
      throw new Error(`host capacity reserved or exhausted: ${cause}`);
    }
  }

