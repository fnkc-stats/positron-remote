// A stand-in for the vscode module, so tests can run the extension (src/extension.ts) without Positron: the test
// bundle maps "vscode" to this file (package.json, npm test). It records what the extension shows and answers its
// questions with what a test puts into `ui`.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Handler = (...args: unknown[]) => unknown;

/** What the extension asked and showed, and the answers a test gives. */
export const ui = {
  /** Answer for showQuickPick: the item to pick (undefined: the user cancels). */
  quickPick: (_items: { label: string; description?: string }[], _opts: { title?: string }) => undefined as unknown,
  /** Answer for showInformationMessage: one of the buttons, or undefined. */
  info: (_message: string, _buttons: string[], _options?: { modal?: boolean; detail?: string }) => undefined as string | undefined,
  inputBox: (_opts: { title?: string; value?: string }) => undefined as string | undefined,
  /** Answer for showWarningMessage: one of the buttons, or undefined. */
  warning: (_message: string, _buttons: string[], _options?: { modal?: boolean; detail?: string }) => undefined as string | undefined,
  /** Documents the extension showed through its content providers: uri path -> text. */
  documents: new Map<string, string>(),
  shown: [] as { kind: 'info' | 'warning' | 'error'; message: string }[],
  clipboard: '',
  opened: [] as string[],
  /** Commands of Positron itself the extension ran (install, reload), with their arguments. */
  ran: [] as { id: string; args: unknown[] }[],
  settings: {} as Record<string, unknown>,
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  reset() {
    this.quickPick = () => undefined;
    this.info = () => undefined;
    this.inputBox = () => undefined;
    this.warning = () => undefined;
    this.documents = new Map();
    this.shown = [];
    this.clipboard = '';
    this.opened = [];
    this.ran = [];
    this.settings = {};
    this.workspaceFolders = undefined;
  },
};

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  constructor(scheme: string, authority: string, path: string) { this.scheme = scheme; this.authority = authority; this.path = path; }
  get fsPath() { return this.path; }
  static file(p: string) { return new Uri('file', '', p); }
  static parse(s: string) { const u = new URL(s); return new Uri(u.protocol.replace(/:$/, ''), u.host, u.pathname); }
  static from(c: { scheme: string; authority?: string; path?: string }) { return new Uri(c.scheme, c.authority ?? '', c.path ?? ''); }
  static joinPath(base: Uri, ...parts: string[]) { return new Uri(base.scheme, base.authority, join(base.path, ...parts)); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

/** The panels the extension created, by view id: their data providers, for tests to walk. */
export const trees = new Map<string, { provider: unknown; view: { badge: unknown } }>();

const registered = new Map<string, Handler>();
export const commands = {
  registerCommand(id: string, fn: Handler) {
    if (registered.has(id)) throw new Error(`command registered twice: ${id}`);
    registered.set(id, fn);
    return { dispose: () => registered.delete(id) };
  },
  async executeCommand(id: string, ...args: unknown[]) {
    if (id === 'vscode.openFolder') { ui.opened.push(String(args[0])); return; }
    if (id.startsWith('workbench.')) { ui.ran.push({ id, args }); return; }
    if (id.startsWith('markdown.')) {
      const u = args[0] as Uri;
      ui.documents.set(u.path, String(providers.get(u.scheme)?.provideTextDocumentContent(u) ?? ''));
      ui.ran.push({ id, args });
      return;
    }
    const fn = registered.get(id);
    if (!fn) throw new Error(`command not found: ${id}`);
    return fn(...args);
  },
  /** For tests: the ids the extension registered. */
  registered: () => [...registered.keys()],
};

const disposable = { dispose() {} };
const outputChannel = { info() {}, warn() {}, error() {}, show() {}, dispose() {}, appendLine() {} };

export const window = {
  createOutputChannel: () => outputChannel,
  showQuickPick: async (items: unknown, opts: { title?: string } = {}) => ui.quickPick(await items as { label: string }[], opts),
  showInputBox: async (opts: { title?: string; value?: string }) => ui.inputBox(opts),
  showInformationMessage: async (message: string, ...rest: unknown[]) => {
    ui.shown.push({ kind: 'info', message });
    const options = typeof rest[0] === 'object' && rest[0] !== null ? rest.shift() as { modal?: boolean; detail?: string } : undefined;
    return ui.info(message, rest as string[], options);
  },
  showWarningMessage: async (message: string, ...rest: unknown[]) => {
    ui.shown.push({ kind: 'warning', message });
    const options = typeof rest[0] === 'object' && rest[0] !== null ? rest.shift() as { modal?: boolean; detail?: string } : undefined;
    return ui.warning(message, rest as string[], options);
  },
  showErrorMessage: async (message: string) => { ui.shown.push({ kind: 'error', message }); return undefined; },
  withProgress: async (_opts: unknown, fn: (p: { report(v: unknown): void }, t: { onCancellationRequested(f: () => void): void }) => unknown) =>
    fn({ report() {} }, { onCancellationRequested() {} }),
  createTreeView: (id: string, opts: { treeDataProvider: unknown }) => {
    const view = { visible: false, badge: undefined as unknown, dispose() {} };
    trees.set(id, { provider: opts.treeDataProvider, view });
    return view;
  },
  createStatusBarItem: () => ({ show() {}, dispose() {} }),
  createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
};

const providers = new Map<string, { provideTextDocumentContent(u: Uri): string }>();

export const workspace = {
  registerTextDocumentContentProvider(scheme: string, p: { provideTextDocumentContent(u: Uri): string }) {
    providers.set(scheme, p);
    return { dispose: () => providers.delete(scheme) };
  },
  get workspaceFolders() { return ui.workspaceFolders; },
  getConfiguration: () => ({
    inspect: (k: string) => ({ globalValue: ui.settings[k] }),
    get: (k: string, d?: unknown) => ui.settings[k] ?? d,
    update: async (k: string, v: unknown) => { ui.settings[k] = v; },
  }),
  onDidChangeConfiguration: () => disposable,
  saveAll: async () => true,
  fs: {
    stat: async (u: Uri) => statSync(u.fsPath),
    readFile: async (u: Uri) => readFileSync(u.fsPath),
    writeFile: async (u: Uri, data: Uint8Array) => { mkdirSync(dirname(u.fsPath), { recursive: true }); writeFileSync(u.fsPath, data); },
  },
};

export const env = {
  appRoot: '',
  clipboard: { writeText: async (t: string) => { ui.clipboard = t; } },
  openExternal: async (u: Uri) => { ui.opened.push(u.toString()); return true; },
};

export class TreeItem {
  label: unknown;
  collapsibleState?: number;
  constructor(label: unknown, collapsibleState?: number) { this.label = label; this.collapsibleState = collapsibleState; }
}
export class ThemeIcon {
  id: string;
  color?: unknown;
  constructor(id: string, color?: unknown) { this.id = id; this.color = color; }
}
export class ThemeColor {
  id: string;
  constructor(id: string) { this.id = id; }
}
export class MarkdownString {
  value: string;
  constructor(value = '') { this.value = value; }
}
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => { this.listeners.push(l); return disposable; };
  fire(e: T) { for (const l of this.listeners) l(e); }
  dispose() {}
}
export const ProgressLocation = { Notification: 15, Window: 10 };
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const ViewColumn = { Active: -1, Beside: -2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1 };
