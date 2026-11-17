# Remediation and deployment acceptance

The findings in `architecture-review.md` refer to revision `914cbe6`, before these changes. Version 0.2 implements:

| Review findings | Repository changes |
| --- | --- |
| 1: broad SSH forwarding | Forwarding disabled; ownership-checking raw broker; pinned container host keys; revocation checks |
| 2: real-data CI trust | Operator-owned exact-commit approval runner; separate data snapshot; no workload network; private logs and outputs |
| 3: mutable/mismatched environment | Digest-only images; actual checkout manifest; initial commit-pinned clone; no implicit merge |
| 4–6: destructive/racy lifecycle | Running updates refused; stopped rollback; repair/retry; cross-process locks; atomic server installation; scoped extensions |
| 7: capacity | Concurrent-project/user-memory/host-reserve admission; CPU/PID limits; helper limits; rotated logs |
| 8: persistence and backups | Explicit persistence contract; encrypted restic stream backup and fresh-volume restore tool |
| 9: idle jobs | Shutdown off by default; explicit job leases for enabled shutdown |
| 10: identity | Repository-derived project IDs, exact-origin checks, host-specific SSH aliases/window identity |
| 11–13: credentials and failure behavior | Personal-only policy, approved decryption hosts, temporary forwarding, strict errors/deadlines/output limits, explicit Docker contexts |
| 14–16: tests/build/docs | Lifecycle and SSH integration tests, native architecture image gates, preserved R manifests, aligned Node requirement, rewritten guides |

## Validation completed on 2026-11-17

- Repository lint, shell checks, workflow checks, TypeScript type checking, and all 26 unit/lifecycle tests passed.
- Built the R image natively on ARM64. As UID 1000 with networking disabled, all 272 locked package versions and namespaces passed verification and the synthetic Quarto HTML report rendered successfully.
- Actual OpenSSH tests passed: gateway TCP forwarding denied, owned-project broker connection allowed, foreign-project connection denied, and active transport disconnected after enrollment revocation. The git-crypt check also distinguishes unlocked data from a subsequently locked checkout.
- Encrypted restic backup/check/restore passed with disposable volumes, including private-file contents, UID/mode preservation, and refusal to overwrite an existing restore target.
- Built the 0.2.0 extension VSIX and server archive. Python operator/integration scripts passed syntax checks.

Later on 2026-11-17 (project renv libraries, shared renv cache, no Posit access from hosts, Positron server upload from the client, no core dumps; the renv parts were removed again below):

- TypeScript type checking and all 29 unit/lifecycle tests passed, including the missing-server round trip (report, refuse bad commit or image, install, retry) and the container settings.
- The SSH integration test passed, now also sending a 5 MB archive through the forced `install-server` command unchanged and refusing an unapproved image.
- In the published amd64 `r-env` image (emulated on ARM64), with `packagemanager.posit.co` and `cdn.posit.co` unreachable: the automatic restore used the image's packages at locked versions, built a missing package from CRAN source into the shared cache, and a second project linked it from the cache. `renv/.gitignore` was written and renv's consent question no longer blocks the console.
- With `--ulimit core=0`, a crashing process wrote no core file (without it: 276 MB in the working directory).
- Not yet covered: the upload over a real gateway with a real Positron server archive, and Positron itself starting R during a long restore.

Later on 2026-11-17 (every binary in the image; images sent by the client; derived images). The run-time renv restore, the shared renv cache and `rRepository` were removed, and so was the short-lived `r-base` image with R libraries built on the host: containers never install packages, and hosts need no access to Posit, CRAN or the registry.

- TypeScript type checking and all 30 unit/lifecycle tests passed, including the image round trip: start reports the missing image with the host's architecture; the client downloads it from a registry with the token handshake, only for that architecture and each layer once, then from its cache; a changed byte, a truncated or overlong upload and an unapproved repository are rejected before Docker sees anything, and the staging folder is left empty; after the upload, start uses the uploaded tag while the container still names the pinned digest.
- Against real registries and Docker 29 (containerd image store, ARM64): `alpine` from Docker Hub by index digest went through download, the host's checks, `docker load` and a run without network. The published amd64 `r-env` (16 layers, 933 MB) downloaded from ghcr.io in 3 minutes, passed the host's checks and loaded; R 4.5.1 with its 288 packages started without network.
- Derived image, built locally on the native ARM64 `r-env`: `env/derived/lock.sh` skipped a package the base already had and recorded `beepr` with its missing dependency `audio`. `verify.R` passed for 274 versions (272 + 2) and the package check passed without network. An `extra.lock` that changes a base version (rlang) is rejected.
- Lint passed, including actionlint for the reusable image workflow and the derived images workflow, and hadolint for the derived Dockerfile.
- Not yet covered: an upload over a real gateway, CI runs of the new workflows, and the reviewed renderer and backup helper with an uploaded image.

These results cover the local ARM64 Docker environment. Native AMD64 CI, the production installer, full Positron UI behavior, Windows, and the reviewed real-data runner still need the deployment checks below. No production deployment or image publication was performed.

## Deployment acceptance

Repository changes cannot configure infrastructure that is not connected to this workspace. Complete the following before production use:

1. Schedule migration and install server/client 0.2 together. Close existing gateway sessions; verify effective sshd policy. Existing old volumes are retained and must be deliberately migrated.
2. Publish the validated image and commit its multi-architecture digest to each project. Configure exact repository allowlists (`r-env` and each derived `r-env-<name>` in use) and realistic host/user budgets. Give `imageStagingDir` room for the largest image. Have one client send each pinned image before the pilot, so the first analyst does not wait for it.
3. Configure an encrypted **off-host** restic repository and credentials. Schedule backups while projects are stopped. Run a restore drill on a different host and record recovery times. The script alone is not a working backup service.
4. Configure filesystem capacity alerts and, where required, filesystem/project quotas. Docker named-volume disk quotas are storage-driver-specific; application memory quotas and rotated logs do not bound arbitrary analysis output. Keep sufficient free disk space for images, restored volumes, and artifacts.
5. On a dedicated real-data runner, create the approval directory and immutable data snapshot process. Review each exact commit; configure private report access and human output review. No Gitea secrets-bearing PR workflow or report publication has been enabled by these changes.
6. Pilot two users on the real Linux server: own/foreign access, concurrent opens, disconnects, I/O-bound jobs, environment upgrade/rollback, memory exhaustion, offboarding, and restoration.
7. Complete the Windows x64 WSL2/SSH/Positron pilot and full Positron tests on each supported architecture. Unit tests and command-line R rendering do not establish IDE compatibility. Windows ARM remains unsupported.

The host lock fails closed after an abrupt process death. An operator must inspect its recorded PID and remove an abandoned lock only after establishing that no mutation is active. This is deliberate: elapsed time alone is not proof that a long image installation has died.
