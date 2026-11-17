**Architecture and implementation review — 16 November 2026**

Current remediation status: [version 0.2 changes and deployment acceptance](next-steps.md). This document records the original findings.

Reviewed revision: `914cbe6`. Scope: tracked source, container scripts, R lockfile, image and lint workflows, extension, Windows bootstrap, server installation, tests, and documentation. Application code was not changed.

**Assessment: a useful prototype for a trusted team, with important work remaining before shared production use or execution of agent-generated code against sensitive data.** Keep the shared environment image, CLI/extension reuse, and persistent project volumes. Prioritize security boundaries, reproducibility, and lifecycle recovery before adding more features.

The code is small and reasonably understandable. Server-side ownership checks, strict user/project identifiers, server-owned public keys, bounded request size, Docker argument arrays, no Docker-socket mount in analyst containers, and read-only server binaries are good foundations. The implementation is substantially ahead of parts of the documentation.

**Verification performed**

- `npm run check`: TypeScript checking, all 14 tests, and both bundles passed.
- `./lint.sh`: passed. Hadolint emitted one informational SC2016 message, below its configured failure threshold.
- Disposable runs of the available environment image started R 4.5.1 and Quarto 1.11.9. The cached native arm64 image had all 272 lockfile package versions matching; 288 installed package entries were reported in total. The downloaded amd64 image also passed the basic command-line startup check. This does not establish Positron/Ark compatibility under emulation.
- A disposable SSH container using the repository's key restriction pattern successfully forwarded to a harmless, unrelated loopback TCP service. This confirms finding 1. No real Docker socket or project volume was exposed.
- A mock of Docker calls reproduced finding 5: after an interrupted `docker cp`, the second start skipped copying the entrypoint and tried to start the incomplete container.
- A suspected direct Unix-socket forwarding bypass was tested and rejected by OpenSSH's permission checks. It is **not** a confirmed vulnerability. Explicitly disabling unnecessary forwarding is still sensible hardening.
- Actual production host configuration, backup systems, Gitea policies, Windows behavior, full image rebuilds, and a complete Positron connection were not verified. Deployment-dependent consequences below are identified as such.

**Priorities**

| Priority | Finding | Required outcome |
| --- | --- | --- |
| Before shared deployment | 1. SSH forwarding grants excessive access | Only authorized container endpoints are reachable |
| Before sensitive-data automation | 2. Proposed CI trust boundary is insufficient | Reviewed code and controlled report disclosure |
| Before routine analysis | 3. Images are mutable and not tied to checked-out code | Immutable environment selected from the actual revision |
| Before routine analysis | 4–6. Replacement, partial setup, and concurrent starts are unsafe | Recoverable, serialized lifecycle operations |
| Before team rollout | 7–9. Capacity, persistence, and job protection are incomplete | Quotas, tested restore, explicit job leases |
| Before broader rollout | 10–13. Identity, credentials, network, and client behavior need hardening | Unambiguous project identity and explicit access policy |
| Before declaring support | 14–16. Testing, R validation, and documentation need expansion | Tested platform matrix and usable operations guide |

**1. High — the SSH gateway permits access to every loopback TCP service. Confirmed.**

Evidence: [admin.ts](../ctl/src/admin.ts), `authorizedKeysLine`, line 40; [install.sh](../ctl/server/install.sh), lines 53–70.

`restrict,port-forwarding,permitopen="127.0.0.1:*"` permits connections to all host loopback TCP ports, not just the requesting user's container. A forced command restricts command execution; forwarding channels do not pass through `Agent.own()`. Other containers still require their own SSH keys, but a database, debug endpoint, dashboard, or Docker API listening on loopback may have different authentication assumptions. The test reached a mock TCP service using exactly this key policy.

The installer also does not enforce local-only TCP forwarding. Reverse forwarding is therefore subject to the host's existing configuration. The impact depends on deployed services and sshd settings; this is not evidence of a demonstrated host takeover.

Fix: explicitly configure the service account with `AllowTcpForwarding local` and `AllowStreamLocalForwarding no`, then replace the wildcard with exact per-user permitted endpoints. This needs root-managed endpoint allocation/authorization, or an ownership-checking connection proxy. Fail installation if effective restrictions are incompatible. Test that normal ProxyJump works while unrelated ports, other users' endpoints, and reverse forwarding are denied. [OpenSSH key restrictions](https://man.openbsd.org/sshd.8) and [sshd configuration](https://man.openbsd.org/sshd_config) define these controls.

**2. High — keeping data away from the AI author does not make its generated code safe to run with data. Planned architecture risk.**

Evidence: [README](../README.md), lines 206–211; [meeting-summary.md](../meeting-summary.md). The sensitive-data CI pipeline is a proposal, not an existing workflow.

The proposed sequence is: agent writes R/Quarto code without data; PR CI unlocks real data and executes that code. The code can still read every supplied record and put it in HTML, logs, artifacts, or outbound requests. Disabling outbound traffic alone does not stop disclosure through the rendered report. A container does not distinguish intended analysis from unintended data export.

Fix: run automatic PR checks on synthetic fixtures without secrets. Run real-data jobs only for a reviewed, immutable commit on a separate ephemeral runner. Use a trusted workflow definition, read-only input data, a non-root process, limited network access, and no Docker socket. Keep outputs and logs access-controlled; review outputs before wider publication. Ensure subsequent commits invalidate approval. For notifications, send authenticated report links rather than public reports or embedded sensitive results. The general untrusted-code/secret separation is also described in [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use); the concrete implementation here must fit Gitea.

**3. High — the environment is neither immutable nor reliably associated with the code being analyzed. Static findings.**

Evidence: [validate.ts](../ctl/src/validate.ts), lines 46–59; [env-image.yml](../.github/workflows/env-image.yml), lines 26–50; [project.ts](../ctl/src/client/project.ts), lines 53–78; [open.ts](../ctl/src/client/open.ts), lines 67–90; [positron-projects.sh](../ctl/container/positron-projects.sh), lines 67–83.

The validator explicitly rejects digests. A date-plus-commit tag is still mutable: a same-day rerun at the same commit publishes the same tag, including when changing platforms. The build uses a mutable Rocker base tag and current apt repositories. The agent only pulls an image if it is absent locally, so two machines can retain different contents under the same tag. The image-ID fingerprint detects local changes, not changes only in the registry. [Docker documents digests as immutable image identifiers](https://docs.docker.com/reference/cli/docker/image/pull/).

Separately, the client reads `container.json` from remote `HEAD` before connecting to the persistent working tree. That working tree can be on an older commit, a feature branch, or contain edits. Sync deliberately preserves those states. For example, main changes from image A to B while the analyst is on a branch requiring A: reopening can replace the container with B while preserving the old branch. Even a first clone can race a new remote commit between metadata fetch and clone.

Fix: support and enforce approved image digests; publish human-readable tags as labels for convenience. Use unique build identifiers and record architecture plus manifest/platform digest. Resolve the repository revision and its environment together. Existing projects should use their actual checkout's manifest; new projects should clone the exact resolved commit. Make branch/environment changes visible and explicit. Record code commit, dirty state, image digest, data version/hash, parameters, and random seed with each report. Avoid silently using a default image for production projects.

**4. High — opening a project can forcibly destroy an active session. Static finding.**

Evidence: [agent.ts](../ctl/src/agent.ts), lines 73–92.

Any setup fingerprint change causes `docker rm -f`, including changes to image, key, limits, idle settings, and embedded scripts. There is no running-job check or graceful migration. A second client opening the same project can kill an existing R calculation. Mounted files survive, but R memory, unfinished outputs, and files outside the mounted directories do not.

Fix: distinguish reconnect from upgrade. Reconnect to an already-running environment and report a pending upgrade; apply changes once stopped or after an explicit disruptive-upgrade action. Preserve the previous stopped container until replacement initialization succeeds. Security revocation should have its own immediate-stop path. Do not rely on retaining Docker volumes as a substitute for protecting active work.

**5. High — interrupted creation leaves an unrecoverable setup on ordinary retry. Reproduced with mocked Docker.**

Evidence: [agent.ts](../ctl/src/agent.ts), lines 89–94.

The final setup label is attached during `docker create`, before the entrypoint is copied. If `docker cp` fails, the container remains with a valid setup label. A retry finds the matching fingerprint, skips copying, and tries to start the missing entrypoint. The mock produced two failures with only one copy attempt: first `simulated interrupted docker cp`, then `entrypoint is missing`.

Fix: treat creation as a transaction. Track initialization separately, verify required assets, and remove only the incomplete container on failure while preserving its volumes. Prefer immutable, tested runtime assets in a small derived image if that simplifies initialization. Add fault-injection tests for create/copy/start failures and recovery.

**6. High — shared resources and lifecycle operations have no inter-process locking. Static finding.**

Evidence: [agent.ts](../ctl/src/agent.ts), `start`; [positron-server.ts](../ctl/src/positron-server.ts), lines 30–37 and 94–110; [project.ts](../ctl/src/client/project.ts), shared cache.

Each SSH request runs a separate process. Two opens can race container creation/removal, server installation, extension preparation, and git-cache updates. Server extraction uses `.tmp-<commit>-$$` inside separate helper containers; the shell is normally PID 1 in each, so the directory is not globally unique. Installation also removes the destination before moving the new tree into place. Extensions are writable and shared across all projects for a user/architecture, even across Positron versions.

Fix: use cross-process locks scoped to user/project, server architecture/commit, and extension cache. Generate temporary names outside the helper PID namespace, then atomically publish a validated installation. Never remove a live server tree during publication. Version extension sets by Positron commit and policy, or give each project its own writable extension directory. Use a trusted pinned helper image rather than any requested environment image to write shared runtime volumes. Test simultaneous opens, interrupted installation, and two client versions.

**7. High — per-container memory limits do not provide team capacity management. Static finding.**

Evidence: [agent.ts](../ctl/src/agent.ts), lines 162–193; [agent.json](../ctl/examples/agent.json).

There is no per-user or host-wide admission limit. Users can create many projects, each receiving 8 GB in the example or 75% of host memory when unspecified. Four containers with 8 GB limits can already consume a 32 GB host's entire nominal memory budget, leaving no allowance for the OS and Docker. CPU is unlimited in the server example; disk usage and Docker logs have no configured bounds. Helper containers are outside the project resource-limit path.

Fix: reserve host capacity, enforce concurrent-project and aggregate per-user budgets under the same admission lock, and set default CPU/PID limits for projects and helpers. Add volume capacity monitoring, disk/inode alerts, log rotation, and a retention policy for server versions and images. Derive R parallel-worker/thread defaults from allocated resources. For a small team, a single Docker server with these controls can remain adequate; a cluster is not yet required.

**8. High — persistence is not a backup and the persisted boundary is easy to misunderstand. Static finding.**

Evidence: [agent.ts](../ctl/src/agent.ts), volume mounts at lines 185–188; [entrypoint.sh](../ctl/container/entrypoint.sh); [workflow.md](workflow.md).

Only the project directory and selected Positron directories persist. Files elsewhere in the home directory, personal R libraries there, Git configuration, and SSH known-host state can disappear on replacement. No backup/restore implementation or runbook exists in this repository. A pushed Git commit does not protect untracked files, unpushed changes, all results, or IDE state. Host/disk loss can remove all of these persistent volumes at once.

Fix: document the exact persistence contract and separate disposable environment state from durable work. Back up project data with an encrypted, access-controlled, off-host mechanism; choose consistency rules for running jobs. Define recovery-point/recovery-time targets and actually restore a project onto another host. Protect decrypted backups as sensitive data. Keep reproducible R libraries in images, with an explicit workflow for requesting package additions.

**9. High for long jobs — low CPU usage is not proof that work has finished. Static finding.**

Evidence: [idle-watch.sh](../ctl/container/idle-watch.sh), lines 18–43.

A disconnected project is stopped when average CPU remains below 5% of one core. A valid job waiting on database/network I/O, a lock, a scheduler, or an external process can meet that definition. Shutdown terminates PID 1 without application checkpointing. Conversely, stray background CPU use can prevent cleanup indefinitely. The OOM scoring adjustment improves the chance R is selected, but cannot guarantee that only R dies in every case.

Fix: add explicit job leases, such as `job run`/`keep-alive`, with visible expiration and ownership. Auto-stop only when there are neither interactive connections nor active job leases. Give shutdown a documented grace period and support checkpointable workloads. Until this exists, use `idleMinutes: 0` for unattended long-job environments. Test I/O-bound work as well as CPU-bound work and verify behavior on the supported cgroup version.

**10. High — a project name is not a unique repository or connection identity. Static finding.**

Evidence: [project.ts](../ctl/src/client/project.ts), lines 18–25 and 53; [layout.ts](../ctl/src/layout.ts), lines 16–34; [ssh.ts](../ctl/src/client/ssh.ts), lines 75–82; [extension.ts](../ctl/src/extension.ts), `currentProject` and `stopCurrent`.

`org-a/study.git` and `org-b/study.git` become the same project, cache, container, and volumes. Existing repositories are not checked against the requested origin before reuse. A full URL initially works, but the sidebar only retains the short project name when reopening. Opening the same project on a second host overwrites the same SSH alias; an existing window later derives its stop target from that mutable file and can stop the wrong host.

Fix: assign a stable project ID based on an explicit identifier or canonical repository identity, keeping display names separate. Store the canonical remote, checkout, owner, and host in project metadata. Validate existing origin before reuse. Give SSH aliases and window connection state a host-specific identity; stopping a window must use the endpoint it actually opened.

**11. High before agent use — unlocked data and forwarded credentials have long-lived scope. Static finding.**

Evidence: [open.ts](../ctl/src/client/open.ts), lines 85–99; [ssh.ts](../ctl/src/client/ssh.ts), lines 30–60; [admin.ts](../ctl/src/admin.ts), `removeUser`; [README](../README.md), line 172.

Opening with `--unlock` leaves the decrypted working tree and git-crypt state in the persistent project volume. A later ordinary Open does not lock it again. Those commands are not separate security modes. The SSH config forwards the user's agent throughout the IDE session and disables container host-key verification. Code running as the analyst can use that forwarded agent while it is available, even though it cannot simply extract the private key. Removing a user only removes future gateway authorization; it does not terminate established sessions or erase the key already inside a running container.

Fix: keep human, agent, and real-data CI volumes separate. Give agents scoped repository credentials and no human forwarded agent or decrypted volume. Display actual unlock state, define explicit lock/key-retention behavior, and never assume stopping a container re-encrypts files. Pin container host keys through the authenticated control connection or use SSH host certificates. Make offboarding terminate access and sessions according to policy; preserve/archive data separately. Consider project-specific git-crypt keys and an approved-host policy for decryption.

**12. Medium–high — container networking and image trust are broader than the project isolation claim. Static finding.**

Evidence: [agent.ts](../ctl/src/agent.ts), `createArgs`; [agent-config.ts](../ctl/src/agent-config.ts), `DEFAULT_ALLOWED_IMAGES`; [positron-server.ts](../ctl/src/positron-server.ts), `helperArgs`.

Project containers use Docker's default bridge and unrestricted outbound networking. Loopback-only publishing controls host-port exposure; it does not isolate peers sharing that bridge. Other services reachable over container IPs can still matter. The allowed image prefix trusts every image under the organization, including code executed as root in helpers that write shared server files. These are substantial trust assumptions. [Docker's bridge documentation](https://docs.docker.com/engine/network/drivers/bridge/) describes peer communication and default network attachment.

Fix: state that human workspaces run trusted team code; do not advertise this as a hardened sandbox for arbitrary code. Use per-project networks and explicit egress policy where needed. Allow exact approved repositories/digests, pin helper images, and protect publication rights. For batch/agent workloads, run a non-root analysis image with capabilities dropped, no-new-privileges, bounded resources, and a read-only filesystem where practical. Test SSH-specific hardening separately because sshd needs additional privileges. Isolate untrusted or data-sensitive runners on separate hosts/VMs when their trust boundary demands it.

**13. Medium — failure handling and local host selection can mislead users. Static findings.**

Evidence: [open.ts](../ctl/src/client/open.ts), lines 42–58 and 85–101; [transport.ts](../ctl/src/client/transport.ts), `SshTransport.call`; [engine.ts](../ctl/src/client/engine.ts), `Engine`; [exec.ts](../ctl/src/exec.ts), `run`.

Clone/sync and requested unlock failures only warn; Open still returns success. Several operations have only SSH connection timeouts, with no deadline after connecting. Child output is accumulated without bounds. Docker calls for Colima/Desktop/system use the ambient Docker context and environment, so a host labeled local can actually target a separately configured remote daemon. The engine ownership marker is a single existence flag rather than an identity-aware lifecycle record. Automatic server-to-local fallback can also move decrypted work onto a laptop without an explicit data-placement policy.

Fix: distinguish ready, usable-but-stale, and failed states; fail a first clone or requested unlock clearly. Add total deadlines, cancellation, bounded logs, and process cleanup. Bind each engine to an explicit validated Docker endpoint/context, and track ownership by engine identity. Allow fallback only to policy-approved hosts. Make Windows CLI launching account for `.cmd` launchers, and verify that custom SSH identities work through ProxyJump rather than only on the direct control connection.

**14. High confidence gap — tests validate helpers, not the platform's critical promises.**

Evidence: [units.test.ts](../ctl/test/units.test.ts), [lint.yml](../.github/workflows/lint.yml), [env-image.yml](../.github/workflows/env-image.yml).

The 14 tests are useful but mostly cover validators, string formatting, configuration, and tar generation. They do not exercise actual Agent lifecycle, SSH ownership enforcement, failed setup recovery, upgrades with active jobs, clone/sync behavior, idle shutdown, backup restore, or Windows/Positron integration. The image workflow publishes without an analysis/report smoke-test stage; it does not build images on PRs. Separate lint and publication workflows do not establish that publication waits for successful validation.

Fix: make the reproduced failures regression tests. Add disposable Linux integration tests using two users and multiple projects, including denial tests, concurrent starts, interrupted creation, volume persistence, branch/environment mismatch, and offboarding. Render a representative Quarto document and load required native R packages before image promotion. Build on PR without publication, then publish validated digests from trusted commits. Pin third-party Actions to reviewed commit SHAs and add dependency/image vulnerability review, provenance, and an explicit release/rollback process.

**15. Medium — R environment validation is a good start, but the reproducibility contract is incomplete.**

Evidence: [Dockerfile](../env/Dockerfile), lines 14–53; [renv.lock](../env/renv.lock); [snapshot-date.sh](../env/snapshot-date.sh).

R_VERSION currently matches the lockfile and the inspected image matched all locked packages. However, the build's version check explicitly exempts recommended packages, does not assert the running R version against the lockfile, and only checks version strings. The lockfile is deleted from the image, and additional installed packages are not recorded in an image manifest. Apt and the base image are not pinned by content. The snapshot helper tolerates failed lookups and therefore supplies a candidate date rather than proof that every dependency has an available binary for every architecture.

Fix: preserve the lockfile and a machine-readable manifest inside the image; assert R, Quarto, and package versions during CI. Either align recommended packages or document and validate explicit exceptions. Pin the base digest and retain published project image digests; if rebuild-from-source fidelity is required, also retain/snapshot OS and package sources. Add native-package/report tests on each supported architecture. Establish a documented policy for project-specific packages, ideally a common base plus per-project immutable dependency image. Capture data versions, RNG settings, locale, timezone, and relevant numerical/thread configuration alongside analysis results.

**16. Medium — rollout documentation and supported-platform claims are inconsistent.**

Evidence: [README](../README.md), [workflow.md](workflow.md), [next-steps.md](next-steps.md), [package.json](../ctl/package.json), [install.sh](../ctl/server/install.sh), [setup-wsl.ps1](../ctl/windows/setup-wsl.ps1).

The analyst guide is marked obsolete and describes local folders/Dev Containers, while current work is held in Docker volumes through a custom remote workflow. The next-steps document lists already-implemented sidebar and diagnostic work as future work. Server instructions accept Node 20 while the package requires Node 22.18 and bundles target Node 22. Idle defaults vary between 60 and 120 minutes in prose/settings. Several image comments still refer to removed paths. The Windows bootstrap hardcodes x86_64 and needs a real end-to-end pilot, including networking and credential-agent behavior.

Fix: publish one supported matrix for client OS/CPU, image architecture, Positron version, Node, Docker, and cgroups. Align executable checks and documentation. Write a short analyst guide covering onboarding, opening, package changes, saving/pushing, data unlock state, job survival, host movement, recovery, and support diagnostics. Keep operator installation, updates, backups, offboarding, and incident procedures in a separate runbook. Clearly mark untested combinations.

**Recommended target and delivery order**

For this team's current scale, keep a single managed Linux Docker host and the existing CLI/extension. Make the environment independent of the editor, and give each execution role a distinct access policy:

| Role | Workspace | Data | Credentials | Execution policy |
| --- | --- | --- | --- | --- |
| Human analyst | Durable project volume with backups | Explicitly authorized; unlock state visible | Narrow human access | Interactive, quota-managed, job-aware |
| Coding agent | Disposable clone and synthetic fixtures | No decrypted data or human volumes | Scoped repository access | Restricted network and runtime |
| Real-data report job | Fresh checkout of an approved commit | Read-only authorized snapshot | Short-lived minimum credentials | Ephemeral runner, controlled output publication |

Use the same immutable R dependency artifact across these roles; they need different mounts, network permissions, credentials, and entrypoints. The current image has no final `USER analyst`, so a direct batch `docker run` should explicitly select a non-root user or use a dedicated batch image.

1. Close gateway forwarding exposure; define the CI/data threat model; stop automatic destructive upgrades; repair partial creation; introduce project identity and cross-process locks.
2. Pin image digests and bind environment resolution to the actual checkout. Add release smoke tests and the lifecycle/security integration tests.
3. Add aggregate capacity controls, backups with a restore drill, explicit job leases, and reliable offboarding. Correct the analyst/operator documentation.
4. Pilot with two people and one representative analysis on the real server. Test disconnect/reconnect, concurrent opens, package upgrade/rollback, data unlock, job completion, and restoration. Then test each supported client platform.
5. Add agent and real-data CI execution only after the separate access policies and approval/output controls are implemented.

The primary success measure should be that two analysts can reopen the same code/data/environment combination, finish a long analysis despite disconnection, recover their work after host failure, and cannot cross the intended access boundaries. Passing lint and producing a container image are necessary but do not establish those outcomes.
