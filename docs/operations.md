# Operator runbook

Version 0.2 requires Linux/systemd, Docker Engine, Node 22.18+, and root for installation/enrollment. Treat access to the Docker daemon and image publication as administrator privileges. Human containers are for trusted team code. Run sensitive-data automation on a separate host.

## Install and configure

Build `npm --prefix ctl run server-bundle`, transfer the resulting `ctl/dist/positron-ctl-server.tar.gz`, unpack, and run `sudo ./positron-ctl-server/install.sh`. The installer updates the program, creates the service account and shared lock directory, converts the old default image prefix to an exact repository, regenerates managed authorized-key lines, writes a forwarding-denial sshd snippet, validates it and reloads sshd. It needs the standard `/etc/ssh/sshd_config.d/*.conf` include. It does not terminate old SSH sessions; do that in the scheduled migration window.

Configure `/etc/positron-ctl/agent.json` using `ctl/examples/agent.json`:

- `allowedImages`: exact trusted repositories; every request must include a SHA-256 digest. Protect write access to those repositories.
- `limits`: positive memory and CPU limits plus PID limit. An 8 GB per-project cap is not an 8 GB reservation at the OS level; admission conservatively sums configured caps.
- `maxProjectsPerUser`, `maxMemoryPerUser`, `reserveMemory`: admission budgets. Running containers without a memory cap count as consuming host capacity, so remove/cap unrelated unlimited workloads before admitting analysis projects.
- `lockDir`: `/var/lib/positron-ctl/locks`, shared by service requests, root administration, and backup tooling. Never use different lock directories against the same host daemon.
- `idleMinutes`: keep 0 initially. If enabled, teach analysts to use `positron-projects run` for jobs.
- `rRepository`: R package repository for containers, default `https://cloud.r-project.org`. The server needs HTTPS access to it. Use an internal CRAN mirror if there is one.
- Positron servers: the host never downloads them. On the first Open with a new Positron version, the client downloads the archive on the user's computer and sends it through the gateway. The host checks that the archive's `product.json` names the expected build, then installs it once into `positron-server-<arch>` for all users. Any enrolled user can therefore provide a server build that colleagues run (trusted team). To pre-stage versions instead, put `positron-reh-linux-<arch>-<version>.tar.gz` files into `serverArchiveDir`; they are used first. `serverUrlTemplate` only tells clients where to download.
- `sharedRenvCache`: default `true`. One renv package cache volume (`positron-renv-cache`) is writable by all users' containers, so each package version is downloaded once per server. Set `false` if users must not be able to change each other's packages. Cleanup and trust are described in [r-packages.md](r-packages.md).

Verify effective policy with `sudo sshd -T -C user=positron,host=localhost,addr=127.0.0.1`. `disableforwarding` must be `yes`. Add users with `sudo positron-ctl admin add-user anna anna.pub`. Supply verified gateway/Gitea host-key fingerprints through a trusted channel. Client SSH operations fail until those host keys are trusted.

Run the host on a filesystem with monitored free space and inodes. Configure project/filesystem quotas if output growth must be bounded. Log rotation is configured on project containers, but named volumes, cached images, and retained IDE runtimes still require capacity management. Do not run indiscriminate `docker system prune --volumes`: that can destroy stopped users' work. Remove only reviewed, backed-up, unreferenced resources.

## Upgrade from 0.1

1. Schedule a maintenance window. Ask analysts to finish jobs, save work, and push commits. Explicitly stop old project containers and close old gateway SSH sessions. Do not run old and new agents concurrently against the same volumes.
2. Back up each old project volume and Positron data volume. If the filesystem contains decrypted data or keys, the backup is sensitive. Keep the old volumes untouched until migration and restore checks pass.
3. Install server and client 0.2 together. Update each project's `container.json` to a published digest. For multi-platform use, select the combined manifest digest after both CI architectures pass.
   Every project now requires this root manifest; `defaultImage` and `.devcontainer/devcontainer.json` are no longer environment fallbacks.
4. New project IDs are `<repository-basename>-<12-hex-url-hash>`. Use the same canonical URL for everyone. Get the ID with the project list after a first attempt to Open, or with `node --input-type=module -e "import {repositoryId} from './ctl/src/repository.ts'; console.log(repositoryId('git@gitea.example.lan:stats/thesis.git'))"` from this repository using Node 22.18+.
5. Restore the old project backup into the corresponding **new, absent** `positron-<user>-<new-id>-project` volume before opening. If an empty/new clone was already created, stop it and have an administrator inspect/archive it before replacing anything. Never overwrite an existing volume with the restore command.
6. Check the restored origin uses the canonical URL. Update the checkout's own manifest to a digest; uncommitted manifests are read explicitly. Reopen, verify files/branch/unpushed work, and render a known report. Old volumes remain available for rollback.
7. Remove obsolete `~/.ssh/positron/<old-name>.conf` entries after all old windows close. New entries and metadata contain the full host/project identity. Do not reuse an old SSH alias to stop a new project.

## Backups and restore drill

Install restic and configure an encrypted **off-host** repository plus a root-readable password source, such as `RESTIC_PASSWORD_FILE`. Initialize it once with `restic init`, following [restic's documentation](https://restic.readthedocs.io/en/stable/040_backup.html). Restrict credentials and repository administration independently from analyst access.

Stop projects before backup. The backup helper refuses a volume used by a running container and acquires the same host mutation lock as the agent, preventing a concurrent Open during backup. Set `POSITRON_BACKUP_LOCK_DIR` only if it matches the configured agent lock directory. Back up both `<base>-project` and `<base>-data`; editor extensions and server binaries can be regenerated.

```bash
/opt/positron-ctl/volume-backup.sh backup positron-anna-<id>-project <approved-image@sha256:...>
restic snapshots --tag positron
restic check
/opt/positron-ctl/volume-backup.sh restore <snapshot-id> /positron-anna-<id>-project.tar positron-restore-<unique-id> <approved-image@sha256:...>
```

Use the actual archive path shown by `restic ls <snapshot-id>`. The restore target must not exist. A failed restore can leave a partial target volume; inspect/remove only that new target before retrying. A backup is successful only when the entire command returns zero. Never restore a snapshot from a failed backup job merely because a snapshot ID exists.

Inspect the restored checkout, compare file checksums, verify Git history and unpushed files, then render a representative report on a separate host. Record the time and result. Choose and document an RPO/RTO appropriate to the team; a suggested initial operational target is daily backups with a monthly restore drill, but the administrator must agree on acceptable lost work. Schedule backups with systemd/cron only after testing credentials and stopped-project behavior. No remote backup repository or schedule is configured by this source change.

## Failure recovery

- Running setup changes: save and finish jobs, explicitly stop, reopen. Open never forces an upgrade over a running job.
- Failed stopped replacement: initialization restores the previous container name when possible; project volumes are never deleted. Inspect `<container>-previous` if a process died during replacement. Do not start two containers against the same checkout volume.
- Abandoned lock: inspect `<lockDir>/host/pid`, verify the process and any helper are no longer active, then remove that exact lock directory. Do not use age alone to declare a lock stale. The client has equivalent Git/Open locks under its cache directory.
- Interrupted initial clone: `.positron-initializing` prevents treating a partial copy as complete. Back up the volume, inspect whether any user work exists, and only then reset a disposable partial clone or recover from backup. No automatic deletion of nonempty checkouts occurs.
- Incomplete shared Positron server directory: with no installation or active project using it, an administrator can move the incomplete commit directory aside and retry. Complete installations are atomically published and never overwritten in place.
- Image rollback: change the checkout manifest to the previous retained digest, stop and reopen. Image rollback does not undo changes to project files or data; restore those separately if required.

## Offboarding

Run `sudo positron-ctl admin remove-user anna`. It removes future authorization and stops labeled project containers under the host mutation lock. Existing broker streams recheck enrollment every five seconds and close on revocation. Review the command result: failure to stop a container still requires administrator follow-up. Archive retained volumes according to your data-retention policy. Revoking access cannot recall data or keys already copied elsewhere; rotate the affected project credentials when necessary.

Keep an inventory of published environment digests, approved repository URLs, host budgets, backup restore results, and supported Positron versions. Repeat the two-user access tests after gateway or OpenSSH changes.
