# Analyst workflow

Ask the administrator for your approved server address, its verified SSH host fingerprint, the canonical Git repository URL, and the extension VSIX. Add your public key to Gitea and have the administrator enroll it on the analysis server. Never send your private key.

Install the extension in Positron. Configure personal **Positron Projects** settings or `~/.config/positron-ctl/config.json` using the example in `ctl/examples/config.json`. Verify the gateway and Gitea host keys against fingerprints supplied by their administrators before trusting them in `~/.ssh/known_hosts`. Load your Git key with `ssh-add`. Run **Positron Projects: Check Setup**.

Use **Open Project…**, enter the repository name or full canonical SSH URL, and select its approved host. Initial clone is pinned to the resolved commit. Reopening preserves your branch, edits, and local commits. **Sync** fetches remote changes; choose merges and branch switches deliberately. Reopen after changing the environment manifest. If an upgrade is pending while the container is running, finish jobs, save, stop, and reopen.

The first Open of an environment image or a Positron version on a host takes longer: your computer downloads it (about 1 GB for `r-env`) and sends it to the host, which checks it and keeps it for everyone. Keep the window open until Open finishes; if it is interrupted, the next Open reuses what your computer already downloaded. R packages come only from the image: `install.packages()` in a container does not last. Ask the administrator to add a package to the team image or to a derived image for your project ([r-packages.md](r-packages.md)).

Your checkout is in a named Docker volume on the selected host. It is not a normal folder on your laptop. Keep code, results, and notes inside that checkout; other home-directory files may be lost on container replacement. Commit and push regularly. Backups are managed separately by the administrator. Before changing hosts, push your work; an unreachable host cannot be checked for unpushed changes.

Use **Open Project with Decrypted Data…** only on a host approved in your personal `decryptionHosts` configuration. A successful unlock persists in that volume. An ordinary Open or Stop does not encrypt it again. The log reports unlock state. Run `positron-projects lock` in a clean checkout when finished, and separately handle plaintext reports, caches, temporary files, and exported data. Never reuse this human workspace as an AI-agent workspace.

Run long calculations as:

```bash
positron-projects run Rscript analysis.R
positron-projects run quarto render report.qmd
```

Automatic idle shutdown is disabled by default. If enabled, this wrapper prevents an I/O wait from being mistaken for completed work. It does not survive an explicit Stop, server restart, or memory exhaustion. Use checkpointed analyses for long jobs.

**Stop This Project and Close the Window** saves files first and targets the host of that window. Do not use Stop until running analyses have finished. Closing the window without Stop is different: jobs may continue. A memory limit can kill R; save/checkpoint frequently and ask the administrator before increasing allocations.

Git credentials are not forwarded for the entire IDE session. For a deliberate short Git session, use `ssh -A <the exact host-specific alias shown by Open>` and run Git there, then exit. Forward only a suitably scoped key. Never forward a human agent to code you do not trust.

When something fails, open **Show Log** and **Check Setup**. First-clone and requested-decryption failures are errors; do not assume a partial Open succeeded. Report the host, project ID, exact error, and whether work is running. Do not include decrypted data or keys in support logs.
