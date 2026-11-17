# Positron Projects

Reproducible R analysis in per-user, per-project Docker containers, primarily on a managed Linux server. The CLI and Positron extension share the same implementation. Every binary a project needs, R packages included, is built once into an image, and projects select its immutable digest in `container.json`. Hosts need no access to Posit, CRAN or the image registry: what a host lacks (the image, the Positron server) is downloaded on the user's computer, sent through the gateway and checked by the host.

**Version 0.2 changes the connection protocol and project identities. Upgrade server and clients together. Existing volumes are retained; read the [migration instructions](docs/operations.md) before reopening existing projects.**

- [Analyst workflow](docs/workflow.md)
- [Installation, migration, backups, recovery and offboarding](docs/operations.md)
- [Sensitive-data and agent execution policy](docs/data-execution.md)
- [Review remediation and deployment acceptance](docs/next-steps.md)
- [Historical architecture review](docs/architecture-review.md)
- [R packages: the images, adding packages, CRAN and renv policy](docs/r-packages.md)

## Quick start

**Analysts** (details: [workflow](docs/workflow.md)):

1. Get from the administrator: the server address and its SSH host key fingerprint, the Gitea address, and the extension file `positron-projects.vsix`. Send them your **public** SSH key (`~/.ssh/id_ed25519.pub`) and add it to your Gitea account.
2. In Positron: **Extensions → … → Install from VSIX**, choose `positron-projects.vsix`.
3. Copy [ctl/examples/config.json](ctl/examples/config.json) to `~/.config/positron-ctl/config.json` and fill in the host and Gitea addresses (or set them in **Settings → Positron Projects**).
4. Check the host keys against the fingerprints you were given, then `ssh-add` your key.
5. Run **Positron Projects: Check Setup** from the Command Palette and fix anything it reports.
6. Run **Positron Projects: Open Project…** and enter the repository name, e.g. `thesis`. The first Open of a new image on a host takes several minutes; later Opens take seconds.
7. Work in the window that opens. Commit and push as usual. When finished, **Positron Projects: Stop This Project and Close the Window**.

A new project repository needs a `container.json` at its root: copy [project-template/container.json](project-template/container.json).

**Administrators**: [Build and install](#build-and-install) below, then the [operator runbook](docs/operations.md). **Maintainers of the R environment**: [Changing the team image r-env](docs/r-packages.md#changing-the-team-image-r-env).

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

The build retains `renv.lock`, its checksum, and an installed-package manifest in `/usr/local/share/r-env`. It checks R and every locked package version (including recommended packages), loads namespaces, and verifies Quarto. CI ([image.yml](.github/workflows/image.yml)) builds both architectures natively, renders a synthetic report, runs the [R environment checks](checks/README.md) and SSH integration tests, all without network, before publishing unique tags and a combined manifest. Published digests preserve the installed environment; apt repositories are not historical snapshots, so rebuilding the source later is not promised to reproduce identical OS packages.

To add packages to `r-env`, run `env/add-packages.sh <package>...`; it adds them and their missing dependencies to `env/renv.lock` from the image's own CRAN snapshot. For newer R or package versions, align R and the pinned Rocker base digest and choose a CRAN snapshot with `env/snapshot-date.sh`. Validate the new image before updating each project's digest in a reviewed commit: `checks/run.sh <image>` checks that its packages fit together and runs the team's common tasks on synthetic data ([checks/README.md](checks/README.md)). When a project needs packages `r-env` lacks, it pins a derived image `r-env-<name>`: a published `r-env` digest plus `env/derived/<name>/extra.lock`, built and checked by the same CI; add its exact repository to server policy. Containers never install packages at run time; do not depend on personal libraries. The full workflow, and the policies for CRAN downloads and renv: [docs/r-packages.md](docs/r-packages.md).

When a host does not have the pinned image, Open downloads it on your computer by digest, sends it through the gateway, and the host checks every layer against the digest before loading it, once per host and image. The same happens for the Positron server matching your Positron. Hosts with registry access can pull instead (`pullImages`). See [operations](docs/operations.md#environment-images).

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
