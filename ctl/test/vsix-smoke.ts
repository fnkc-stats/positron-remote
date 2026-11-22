// Activation smoke for the packaged extension (npm run test:vsix [-- <file.vsix>]): installs the VSIX that is about to
// be published into a clean VS Code of the oldest version package.json accepts (engines.vscode), then, inside that
// editor, activates it and runs a harmless command (vsix-smoke-host.ts). The unit tests use a fake vscode module and
// never load dist/extension.cjs from the archive; this catches a missing entry point or an API the minimum editor
// lacks before the release. Everything lives in a throwaway directory: no user settings, extensions or fnkc-ctl config.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const ctl = resolve(import.meta.dirname, '..');
const vsix = resolve(process.argv[2] ?? join(ctl, 'dist', 'fnkc-projects.vsix'));
const manifest = JSON.parse(readFileSync(join(ctl, 'package.json'), 'utf8')) as { name: string; publisher: string; version: string; engines: { vscode: string } };
const minimum = /^\^?(\d+\.\d+\.\d+)$/.exec(manifest.engines.vscode)?.[1];
if (!minimum) throw new Error(`engines.vscode "${manifest.engines.vscode}" is not ^x.y.z: the smoke cannot tell the oldest supported editor`);

const dir = mkdtempSync(join(tmpdir(), 'fnkc-vsix-smoke-'));
try {
  const extensions = join(dir, 'extensions');
  const userData = join(dir, 'user-data');
  const home = join(dir, 'home');
  mkdirSync(join(userData, 'User'), { recursive: true });
  mkdirSync(home);
  // Activation would ask GitHub for a newer release: not this test's business, and no network beyond the download
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'fnkcProjects.checkForUpdates': false }));
  // The test runner is an extension of its own, loaded in development mode next to the installed VSIX
  const runner = join(dir, 'runner');
  mkdirSync(runner);
  writeFileSync(join(runner, 'package.json'), JSON.stringify({ name: 'fnkc-vsix-smoke', publisher: 'fnkc-stats', version: '0.0.0', engines: { vscode: manifest.engines.vscode } }));

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: minimum, cachePath: join(ctl, '.cache', 'vscode') });
  // Its own profile rather than the machine's (reuseMachineInstall only stops the helper adding a default one)
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
  const profile = [`--extensions-dir=${extensions}`, `--user-data-dir=${userData}`];
  const installed = spawnSync(cli!, [...profile, '--install-extension', vsix],
    { stdio: 'inherit', shell: process.platform === 'win32' });
  if (installed.status !== 0) throw new Error(`VS Code ${minimum} could not install ${vsix} (exit ${installed.status ?? installed.signal})`);

  // Inherited from an editor's terminal, it would start the editor as plain Node, which rejects every option
  delete process.env.ELECTRON_RUN_AS_NODE;
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: runner,
    extensionTestsPath: join(ctl, '.cache', 'vsix-smoke-host.cjs'),
    launchArgs: [...profile, '--disable-telemetry'],
    extensionTestsEnv: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      FNKC_SMOKE_ID: `${manifest.publisher}.${manifest.name}`,
      FNKC_SMOKE_VERSION: manifest.version,
      FNKC_SMOKE_EXTENSIONS: extensions,
    },
  });
  console.log(`vsix smoke: ${vsix} activated in VS Code ${minimum}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
