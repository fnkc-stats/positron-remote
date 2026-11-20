// Image provenance end to end, with real data: the client's proof for a published, attested image (GitHub API and
// registry, client/provenance.ts), then the host's verification (provenance.ts) with gh in a container without any
// network and without GitHub credentials, as on an offline server. Also checks that a wrong signer policy fails.
//   npm run test:provenance -- <ghcr.io/<owner>/r-env@sha256:...> [<owner>/<repo>]
// Needs Docker, gh (its binary is mounted into the container) and network access for the client part.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfig } from '../src/agent-config.ts';
import { run } from '../src/exec.ts';
import { provenanceProof } from '../src/client/provenance.ts';
import { type ProvenanceCommand, provenanceVerified, verifyImageProvenance } from '../src/provenance.ts';

const [image, repository = 'fnkc-stats/positron-remote'] = process.argv.slice(2);
if (!image) throw new Error('usage: test:provenance -- <image@sha256:...> [<owner>/<repo>]');

const work = mkdtempSync(join(tmpdir(), 'fnkc-provenance-it-'));
try {
  const gh = (await run('sh', ['-c', 'command -v gh'])).stdout.trim();
  assert.ok(gh, 'gh is required');
  // The trust root is downloaded beforehand, as install.sh does while the server has network
  const root = await run(gh, ['attestation', 'trusted-root'], { timeoutMs: 120_000 });
  assert.equal(root.code, 0, root.stderr);
  const trustedRootFile = join(work, 'trusted-root.jsonl');
  writeFileSync(trustedRootFile, root.stdout);

  // gh as on an offline host: no network, no credentials, only the files it is given
  const offline: ProvenanceCommand = (cmd, args, opts) => run('docker', ['run', '--rm', '--network', 'none',
    '-v', `${gh}:/usr/local/bin/gh:ro`, '-v', `${tmpdir()}:${tmpdir()}:ro`, '--tmpfs', '/home/gh', '-e', 'HOME=/home/gh',
    'ubuntu:24.04', cmd, ...args], opts);

  const proof = await provenanceProof(join(work, 'cache'), repository, image);
  const cfg = agentConfig('ci', { keysDir: join(work, 'keys'), trustedRootFile, verifiedDir: join(work, 'verified'), provenanceRepository: repository });
  assert.equal(cfg.requireProvenance, true);

  await assert.rejects(verifyImageProvenance({ ...cfg, provenanceWorkflow: '.github/workflows/not-the-signer.yml', verifiedDir: join(work, 'v2') }, image, proof, offline),
    /verification failed/, 'a wrong signer workflow must fail');
  await verifyImageProvenance(cfg, image, proof, offline);
  assert.ok(provenanceVerified(cfg, image));
  console.log(`PASS: ${image} verified offline (gh without network or credentials); a wrong signer policy is refused`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
