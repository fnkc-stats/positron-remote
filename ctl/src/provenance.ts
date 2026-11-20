import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from './exec.ts';
import type { AgentConfig } from './agent-config.ts';

export type ProvenanceCommand = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

/** Verifies an image's Sigstore/GitHub build provenance without contacting the registry or GitHub. */
export async function verifyImageProvenance(
  cfg: AgentConfig, image: string, bundle: string | undefined, command: ProvenanceCommand = run,
): Promise<void> {
  if (!cfg.requireProvenance) return;
  if (!bundle || Buffer.byteLength(bundle) > 1024 * 1024) throw new Error('missing or oversized image provenance bundle; refusing to start');
  if (!readFileSync(cfg.trustedRootFile, 'utf8').trim()) throw new Error('the configured GitHub attestation trust root is empty');
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'fnkc-provenance-'));
    const file = join(dir, 'bundle.jsonl');
    writeFileSync(file, bundle, { mode: 0o600 });
    const signer = `${cfg.provenanceRepository}/${cfg.provenanceWorkflow}`;
    const result = await command('gh', ['attestation', 'verify', `oci://${image}`, '--repo', cfg.provenanceRepository,
      '--bundle', file, '--custom-trusted-root', cfg.trustedRootFile,
      '--signer-workflow', signer, '--source-ref', 'refs/heads/main'], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim().split('\n').pop() || 'signature, image digest, signer, or source branch did not match policy');
  } catch (e) {
    throw new Error(`image provenance verification failed for ${image}: ${(e as Error).message}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
