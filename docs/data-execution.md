# Agent and sensitive-data execution

An AI author does not need to see data to produce code that discloses it later. Treat code review and output access as part of the data boundary. Git-crypt protects tracked repository contents at rest in Git; unlocked workspaces, exports, logs, and reports need separate protection.

Use three execution roles:

| Role | Code/data | Credentials | Outputs |
| --- | --- | --- | --- |
| Human analyst | Persistent checkout; explicitly authorized decrypted data | Human/project access | Team-controlled workspace |
| Coding agent / ordinary PR checks | Disposable clone and synthetic fixtures only | Scoped repository credential; no human SSH agent | PR and synthetic test results |
| Reviewed real-data report | Exact approved commit; read-only immutable data snapshot | Host-only operator credentials; none exposed to the workload | Private log/report pending output review |

No secrets-bearing Gitea PR workflow is enabled here. Do not give a PR job a decryption key or mount a human project's volume. Use synthetic-data checks automatically. For real-data execution, install `ctl/server/render-reviewed.py` on a dedicated Linux Docker runner, owned by root. The runner itself is privileged infrastructure; the renderer container has no Docker socket, no network, no capabilities, a non-root user, a read-only root filesystem, and bounded memory/CPU/PIDs/runtime. Its disposable workspace and private output still require disk-capacity monitoring and filesystem quotas where appropriate.

An operator creates `/etc/positron-ctl/approvals` as root, not writable by the CI/agent identity. Keep `/etc/positron-ctl/agent.json` root-owned with exact allowed image repositories. After reviewing the **specific commit**, write an approval such as:

```json
{
  "repository": "/srv/reviewed-mirrors/study.git",
  "commit": "<40-lowercase-hex-commit>",
  "image": "ghcr.io/fnkc-stats/r-env@sha256:<64-lowercase-hex-digest>",
  "data": "/srv/data-snapshots/study/2026-11-17",
  "dataVersion": "<immutable-data-snapshot-id-or-content-manifest-hash>",
  "document": "report.qmd"
}
```

The repository is an operator-maintained local mirror. The data directory must be an immutable snapshot readable by UID 1000. Decrypt or prepare it through your separate authorized data-ingestion process; the workload receives no git-crypt key. Code reads `/data`. The renderer verifies that the approved commit's `container.json` contains the approved image digest and exports the code through `git archive`, excluding `.git` credentials.

Run `sudo /opt/positron-ctl/render-reviewed.py <approval-id>`. The command rejects non-root execution and approvals writable by other users. Each run gets a new workspace. Its logs, artifacts, and provenance remain in a private directory under `/var/lib/positron-reports`. The script records the declared data version, not a newly computed checksum of every data byte: the snapshot process must establish that identifier and immutability. If a new commit is proposed, it requires a new reviewed approval.

Inspect the report and logs for unintended disclosure before granting broader access. No automatic report publication or messaging is performed. If notifications are added later, send an authenticated private report link. Restrict report access to the same data audience unless output review explicitly authorizes broader distribution. Decide retention and cleanup rules for private outputs, including failed-job logs.

Review should cover file reads, package installs, external processes, output-generating code, and changes to data protection rules. Network denial does not prevent sensitive information from being written into the report itself. The output review step is therefore necessary even when the container restrictions work correctly.
