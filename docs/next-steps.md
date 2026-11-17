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
