// Which running project containers wait for an environment or setup update. The host says so only when Open connects
// to a container that a new start would set up differently (StartResult.updatePending); the Projects panel keeps
// showing it after that message is gone. Kept per host and container in the extension's global state, so it survives
// a reload. A container that is stopped or gone has no pending update: the next Open creates it anew.
import type { ContainerInfo } from './protocol.ts';

/** The part of vscode.Memento this needs. */
export interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'updatePending';

export class PendingUpdates {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private all(): string[] {
    return this.store.get<string[]>(KEY) ?? [];
  }

  has(host: string, container: string): boolean {
    return this.all().includes(`${host}/${container}`);
  }

  /** After an Open of that container: whether the host said an update waits. */
  async set(host: string, container: string, pending: boolean): Promise<void> {
    if (pending === this.has(host, container)) return;
    const id = `${host}/${container}`;
    await this.store.update(KEY, pending ? [...this.all(), id] : this.all().filter((k) => k !== id));
  }

  /** Forgets the containers of `host` that its listing shows stopped or no longer has. */
  async prune(host: string, containers: ContainerInfo[]): Promise<void> {
    const running = new Set(containers.filter((c) => c.running).map((c) => `${host}/${c.container}`));
    const all = this.all();
    const next = all.filter((k) => !k.startsWith(`${host}/`) || running.has(k));
    if (next.length !== all.length) await this.store.update(KEY, next);
  }
}
