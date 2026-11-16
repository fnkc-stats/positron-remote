// Version of the Positron client on this computer: the container gets exactly the matching server.
// The extension will pass vscode.env.appRoot; the CLI looks in the usual install locations.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PositronClient {
  version: string;
  commit: string;
  /** Folder with product.json (the app root). */
  appRoot: string;
}

function candidates(): string[] {
  const env = process.env.POSITRON_APP;
  if (env) return [env, join(env, 'Contents', 'Resources', 'app'), join(env, 'resources', 'app')];
  switch (process.platform) {
    case 'darwin':
      return ['/Applications', join(homedir(), 'Applications')].map((d) => join(d, 'Positron.app', 'Contents', 'Resources', 'app'));
    case 'win32': {
      const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles];
      return roots.filter((r): r is string => !!r).map((r) => join(r, 'Positron', 'resources', 'app'));
    }
    default:
      return ['/usr/share/positron/resources/app', '/opt/Positron/resources/app'];
  }
}

export function readPositron(appRoot: string): PositronClient {
  const p = JSON.parse(readFileSync(join(appRoot, 'product.json'), 'utf8')) as Record<string, unknown>;
  const version = `${String(p.positronVersion)}-${String(p.positronBuildNumber)}`;
  return { version, commit: String(p.commit), appRoot };
}

export function localPositron(appRoot?: string): PositronClient {
  const roots = appRoot ? [appRoot] : candidates();
  const found = roots.find((r) => existsSync(join(r, 'product.json')));
  if (!found) {
    throw new Error(`Positron not found (looked in ${roots.join(', ')}); set POSITRON_APP to the Positron app folder`);
  }
  return readPositron(found);
}

/** The Positron command-line launcher next to the app (code on macOS, positron elsewhere). */
export function positronCli(c: PositronClient): string | undefined {
  const list =
    process.platform === 'darwin'
      ? [join(c.appRoot, 'bin', 'code')]
      : process.platform === 'win32'
        ? [join(dirname(dirname(c.appRoot)), 'bin', 'positron.cmd')]
        : [join(dirname(dirname(c.appRoot)), 'bin', 'positron'), '/usr/bin/positron'];
  return list.find((p) => existsSync(p));
}
