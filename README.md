# Positron Projects

Reproducible R analysis in per-user, per-project Docker containers, primarily on a managed Linux server. The CLI and Positron extension share the same implementation. R dependencies are built once and projects select an immutable image digest in `container.json`.

**Version 0.2 changes the connection protocol and project identities. Upgrade server and clients together. Existing volumes are retained; read the [migration instructions](docs/operations.md) before reopening existing projects.**

- [Analyst workflow](docs/workflow.md)
- [Installation, migration, backups, recovery and offboarding](docs/operations.md)
- [Sensitive-data and agent execution policy](docs/data-execution.md)
- [Review remediation and deployment acceptance](docs/next-steps.md)
- [Historical architecture review](docs/architecture-review.md)

## Architecture

The local extension/CLI resolves a repository and its exact initial commit. The server checks the user's authorization, the approved image repository/digest, and the durable checkout. For an existing checkout, its own `container.json` selects the environment. Open never automatically merges or switches an existing branch.

The gateway SSH account has **all forwarding disabled**. Its forced command accepts bounded control requests and `agent connect <project-id>`. The latter verifies container ownership and streams only to that container's SSH port. There is no caller-supplied destination address or port. The client pins the container host key received through the trusted control connection. Verify the gateway's host key before first use.

Each repository gets a stable ID derived from its primary URL, avoiding equal-basename collisions. SSH aliases include the host as well as the project ID. Use one canonical URL consistently. Changing URL syntax or mirrors changes identity; migration is explicit.

Containers have separate Docker networks, capped memory/CPU/PIDs, rotated logs, and named volumes for the checkout and Positron state. Extensions are scoped to project, architecture, and Positron commit. Server binaries are shared read-only. All host mutations, admissions, and runtime installation are serialized through a host-local lock.

Human containers run trusted team code. They retain network access for Git and analysis. They are not the execution boundary for untrusted agent code or sensitive-data CI.

## Requirements and supported scope

- Server: Linux, Docker Engine, Node.js **22.18+**, OpenSSH with included configuration snippets, systemd. Use cgroup v2 for idle/OOM diagnostics.
- Client: Positron, OpenSSH, Git. CLI use requires Node.js 22.18+. Install the extension VSIX for the UI.
- Images: native linux/amd64 and linux/arm64. Emulation is rejected because command-line R startup does not establish Positron/Ark reliability.
- macOS: Colima or Docker Desktop. The selected engine uses an explicit context.
- Windows: x64 WSL2 bootstrap remains experimental pending a real pilot. Windows ARM is not supported by that bootstrap.
- Docker is started when needed; the shared daemon is left running. Stop it manually when appropriate.

## Build and install

```bash
npm ci --prefix ctl
npm --prefix ctl run check
npm --prefix ctl run package
```

Install `ctl/dist/positron-projects.vsix` from Positron's **Install from VSIX** command.
For server installation, build `npm --prefix ctl run server-bundle`, copy `ctl/dist/positron-ctl-server.tar.gz` to the server, unpack it, and run `sudo ./positron-ctl-server/install.sh`. Installation disables gateway forwarding, upgrades enrolled keys, and verifies/reloads sshd. Coordinate migration with users; existing sessions need to be closed during the upgrade.

Add a user with `sudo positron-ctl admin add-user anna /path/to/anna.pub`. The service account has Docker access; analysts do not get its shell or general forwarding. Configure exact approved image repositories and capacities in `/etc/positron-ctl/agent.json`.

Copy [the client example](ctl/examples/config.json) to `~/.config/positron-ctl/config.json`. Connection and credential settings are personal machine settings; repository workspace settings cannot override them. `decryptionHosts` explicitly names hosts allowed to receive a git-crypt key. The default list is empty.

## Project environments

```json
{
  "image": "ghcr.io/fnkc-stats/r-env@sha256:<published-64-hex-digit-manifest-digest>"
}
```

Use the digest from the image workflow's **publish-manifest** summary. The checked-in template pins the existing published amd64 image; replace it with the newly validated multi-architecture digest when available. Tags alone are rejected. Exact image repositories, not organization-wide prefixes, are allowed on the server.

The build retains `renv.lock`, its checksum, and an installed-package manifest in `/usr/local/share/r-env`. It checks R and every locked package version (including recommended packages), loads namespaces, and verifies Quarto. CI builds both architectures natively, renders a synthetic report, and runs SSH integration tests before publishing unique tags and a combined manifest. Published digests preserve the installed environment; apt repositories are not historical snapshots, so rebuilding the source later is not promised to reproduce identical OS packages.

For package changes, edit `env/renv.lock`, align R and the pinned Rocker base digest, and choose a CRAN snapshot with `env/snapshot-date.sh`. Validate the new image before updating each project's digest in a reviewed commit: `checks/run.sh <image>` checks that its packages fit together and runs the team's common tasks on synthetic data ([checks/README.md](checks/README.md)). Use a derived, independently validated image when a project needs a different package set; add its exact repository to server policy. Do not depend on personal libraries installed outside the project volume.

A project can also commit its own `renv.lock`. The first R console after each container start then runs `renv::restore()` into `<project>/renv/library` on the project volume. Later starts only check the library against the lockfile. The image's site library stays visible to the project as an renv external library. A locked package whose exact version is already in the image is used from the image, not downloaded again. Other versions, and packages the image lacks, go to the project library, which comes first, so the lockfile's versions win. Packages that are in the image but not in the lockfile can still be loaded; `renv::snapshot()` records the ones the code uses. Packages the image lacks are kept in one renv cache volume per server, shared by all users' containers, so each version is downloaded once per server (turn off with `"sharedRenvCache": false`). Packages come from the host's `rRepository` setting: CRAN by default, built from source, because servers may have no access to Posit. Projects without `renv.lock` keep using the image's packages. If a restore fails, the console shows the error; fix it and run `renv::restore()` by hand, because the automatic restore runs only once per start. The full agreement is in [docs/r-packages.md](docs/r-packages.md).

## Commands

```bash
node ctl/dist/positron-ctl.cjs doctor
node ctl/dist/positron-ctl.cjs open thesis --host server
node ctl/dist/positron-ctl.cjs open git@gitea.example.lan:stats/thesis.git --host server
node ctl/dist/positron-ctl.cjs open thesis --host server --unlock
node ctl/dist/positron-ctl.cjs list
node ctl/dist/positron-ctl.cjs stop thesis --host server
```

Automatic selects only the first configured host. It never silently falls back to a laptop. Use an explicit host to move work, after pushing changes. Stop accepts the short repository name, full URL, or stable ID from the project list.

Inside a project:

```bash
positron-projects status
positron-projects sync              # fetch only; does not merge or switch branches
positron-projects run Rscript analysis.R
positron-projects run quarto render report.qmd
positron-projects lock              # git-crypt lock; inspect plaintext outputs separately
```

Idle shutdown defaults to **0 (disabled)** on server and client. If an operator enables it, the `run` wrapper holds a job lease even during I/O waits. An explicit Stop still ends all work in that container. Ordinary Open does not re-lock a previously decrypted workspace. Agent forwarding is used only for initialization; routine Git access needs an explicitly scoped credential or a deliberate temporary forwarded SSH session.

An environment/key/configuration update will not replace a running container. Save work, finish jobs, explicitly stop, and reopen. A stopped replacement retains the previous container until initialization succeeds; failures preserve project volumes. Files outside mounted project/Positron directories are disposable.

## Verification

```bash
./lint.sh
npm --prefix ctl run test:ssh   # requires a local r-env:verified image; disposable fixtures only
# Or set POSITRON_TEST_IMAGE to another locally available compatible image.
```

Tests cover failure recovery, rollback, concurrent opens, checkout identity, branch/environment selection, quotas, and SSH denial/revocation behavior. The full production host, off-host backup destination, real-data approvals, and Windows client still require the acceptance checks in [next-steps](docs/next-steps.md).
