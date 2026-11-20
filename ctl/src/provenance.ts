// The host's check that a runnable image was built by the team's workflow, without the registry or GitHub: the client
// sends the image's attestation bundles and its top manifest (client/provenance.ts); the manifest's sha256 must be
// the pinned digest, and `gh attestation verify` checks the bundles against that file with the installed Sigstore
// trust root (offline verification of a file: GitHub's documented procedure). A digest that passed is remembered,
// so later starts of it need neither the proof nor gh.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from './exec.ts';
import type { AgentConfig } from './agent-config.ts';
import { hexOf, parseReference } from './oci.ts';

export type ProvenanceCommand = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

const MAX_BUNDLE = 1024 * 1024;
const MAX_SUBJECT = 4 * 1024 * 1024;

/** What must have signed an image for this host: the policy a remembered verification was made under. */
export const provenancePolicy = (cfg: AgentConfig) => `${cfg.provenanceRepository}|${cfg.provenanceWorkflow}|refs/heads/main`;

/** Whether `image` passed verification on this host under the current policy. */
export function provenanceVerified(cfg: AgentConfig, image: string): boolean {
  const file = join(cfg.verifiedDir, hexOf(parseReference(image).digest));
  try { return readFileSync(file, 'utf8') === provenancePolicy(cfg); } catch { return false; }
}

/**
 * Verifies `image` (repository@sha256:...) before a container is created from it. `proof` comes from the client;
 * it is not needed for a digest verified before.
 */
export async function verifyImageProvenance(
  cfg: AgentConfig, image: string, proof: { bundle?: string; subject?: string }, command: ProvenanceCommand = run,
): Promise<void> {
  if (!cfg.requireProvenance || provenanceVerified(cfg, image)) return;
  const { digest } = parseReference(image);
  const { bundle, subject } = proof;
  if (!bundle || Buffer.byteLength(bundle) > MAX_BUNDLE) throw new Error(`missing or oversized image provenance bundle for ${image}; refusing to start (update FNKC Projects on your computer)`);
  if (!subject || subject.length > (MAX_SUBJECT * 4) / 3 + 4) throw new Error(`missing or oversized image manifest for ${image}; refusing to start (update FNKC Projects on your computer)`);
  const manifest = Buffer.from(subject, 'base64');
  if (`sha256:${createHash('sha256').update(manifest).digest('hex')}` !== digest) throw new Error(`the manifest sent for ${image} does not match its digest; refusing to start`);
  if (!existsSync(cfg.trustedRootFile) || !readFileSync(cfg.trustedRootFile, 'utf8').trim()) throw new Error('the configured GitHub attestation trust root is missing or empty');
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'fnkc-provenance-'));
    const bundleFile = join(dir, 'bundle.jsonl');
    const subjectFile = join(dir, 'manifest.json');
    writeFileSync(bundleFile, bundle, { mode: 0o600 });
    writeFileSync(subjectFile, manifest, { mode: 0o600 });
    const result = await command('gh', ['attestation', 'verify', subjectFile, '--repo', cfg.provenanceRepository,
      '--bundle', bundleFile, '--custom-trusted-root', cfg.trustedRootFile,
      '--signer-workflow', `${cfg.provenanceRepository}/${cfg.provenanceWorkflow}`, '--source-ref', 'refs/heads/main'], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim().split('\n').pop() || 'signature, image digest, signer, or source branch did not match policy');
  } catch (e) {
    throw new Error(`image provenance verification failed for ${image}: ${(e as Error).message}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  remember(cfg, digest);
}

function remember(cfg: AgentConfig, digest: string): void {
  try {
    mkdirSync(cfg.verifiedDir, { recursive: true, mode: 0o700 });
    const file = join(cfg.verifiedDir, hexOf(digest));
    writeFileSync(`${file}.tmp`, provenancePolicy(cfg), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch { /* the next start verifies again */ }
}
