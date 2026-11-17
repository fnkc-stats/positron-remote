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

Later on 2026-11-17 (project renv libraries, shared renv cache, no Posit access from hosts, Positron server upload from the client, no core dumps):

- TypeScript type checking and all 29 unit/lifecycle tests passed, including the missing-server round trip (report, refuse bad commit or image, install, retry) and the container settings.
- The SSH integration test passed, now also sending a 5 MB archive through the forced `install-server` command unchanged and refusing an unapproved image.
- In the published amd64 `r-env` image (emulated on ARM64), with `packagemanager.posit.co` and `cdn.posit.co` unreachable: the automatic restore used the image's packages at locked versions, built a missing package from CRAN source into the shared cache, and a second project linked it from the cache. `renv/.gitignore` was written and renv's consent question no longer blocks the console.
- With `--ulimit core=0`, a crashing process wrote no core file (without it: 276 MB in the working directory).
- Not yet covered: the upload over a real gateway with a real Positron server archive, and Positron itself starting R during a long restore.

Later on 2026-11-17 (R environment checks; `r-base` image with R libraries on the host):

- `checks/run.sh` passed all 9 steps in the published amd64 `r-env` image (emulated) and in a native ARM64 build of the same lockfile; the 28 recorded results were identical. A simulated partial update was caught: an older rlang in front of the image library (33 packages flagged), and a newer TMB without rebuilding glmmTMB (load warning).
- The `r-base` stage (656 MB compressed, against 933 MB) built natively on ARM64 and passed the SSH integration test.
- `env/renv.lock` built from CRAN source into a library for that image in 23 minutes on 6 CPUs (about 13 minutes of version lookups and downloads, 8.5 of compiling; renv 1.3 installs in parallel). With the library mounted, all 9 check steps passed and the 28 recorded results were identical to the `r-env` image's.
- `positron-ctl build-library` against a local registry: the full lockfile built in 22 minutes, passed all checks inside the command and was marked ready, with the build record and check results kept in the volume. A library that fails the checks is not marked ready; `--skip-checks`, continuing an unfinished build, and a second run on a ready library behaved as documented. Start refuses missing and unfinished libraries (lifecycle tests).
- pak as renv's installer could not resolve the lockfile (dependency conflicts for most exact older versions), so it is not used.
- Not yet covered: a library build on the real server, its download speed from CRAN and `crandb.r-pkg.org`, and Positron opening a project that pins a library.

These results cover the local ARM64 Docker environment. Native AMD64 CI, the production installer, full Positron UI behavior, Windows, and the reviewed real-data runner still need the deployment checks below. No production deployment or image publication was performed.

## Deployment acceptance

Repository changes cannot configure infrastructure that is not connected to this workspace. Complete the following before production use:

1. Schedule migration and install server/client 0.2 together. Close existing gateway sessions; verify effective sshd policy. Existing old volumes are retained and must be deliberately migrated.
2. Publish the validated image and commit its multi-architecture digest to each project. Configure exact repository allowlists and realistic host/user budgets.
3. Configure an encrypted **off-host** restic repository and credentials. Schedule backups while projects are stopped. Run a restore drill on a different host and record recovery times. The script alone is not a working backup service.
4. Configure filesystem capacity alerts and, where required, filesystem/project quotas. Docker named-volume disk quotas are storage-driver-specific; application memory quotas and rotated logs do not bound arbitrary analysis output. Keep sufficient free disk space for images, restored volumes, and artifacts.
5. On a dedicated real-data runner, create the approval directory and immutable data snapshot process. Review each exact commit; configure private report access and human output review. No Gitea secrets-bearing PR workflow or report publication has been enabled by these changes.
6. Pilot two users on the real Linux server: own/foreign access, concurrent opens, disconnects, I/O-bound jobs, environment upgrade/rollback, memory exhaustion, offboarding, and restoration.
7. Complete the Windows x64 WSL2/SSH/Positron pilot and full Positron tests on each supported architecture. Unit tests and command-line R rendering do not establish IDE compatibility. Windows ARM remains unsupported.

The host lock fails closed after an abrupt process death. An operator must inspect its recorded PID and remove an abandoned lock only after establishing that no mutation is active. This is deliberate: elapsed time alone is not proof that a long image installation has died.

## Not needed: environment image without registry access

The target server can reach Docker Hub and `ghcr.io` (confirmed 2026-11-17), so this plan is not needed; it stays here in case another host lacks registry access. Projects that use the `r-base` image with a library on the host also need only the small image from the registry; their packages are built on the host from CRAN.

Original plan (decided on 2026-11-17, postponed). The server may have no access to `ghcr.io`, as it has none to Posit. Then Open cannot pull the pinned `r-env` image. The plan mirrors the Positron server upload:

1. Start answers "image missing" (repository, digest, the host's architecture) instead of failing on `docker pull`.
2. The client downloads the image from ghcr.io over HTTPS with the registry API: the manifest by its pinned digest, the platform manifest for the host's architecture, the config and the layers (about 0.9 GB compressed for `r-env`). No Docker is needed on the client. Blobs are cached on the client.
3. The client streams them through the gateway with a new agent command.
4. The host verifies every blob's SHA-256 against the manifest, and the manifest's SHA-256 against the pinned digest. Because the content is fixed by the digest, any user can provide the image safely.
5. The host loads it (OCI archive, Docker 25 or newer) and tags it locally with a name derived from the digest. A loaded image usually does not keep its registry digest, so every place the agent refers to `<repository>@sha256:<digest>` (inspect, pull, create, helper containers) must use that local name.
6. Test locally with ghcr.io blocked inside the container engine, and with a corrupted blob (must be rejected).

Alternatives considered: an internal registry the server can reach (no code changes), or a manual `docker save | docker load` by an administrator (still needs step 5).
