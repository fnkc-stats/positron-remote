# Claude Code instructions for this repo

## Project agents and skills: pick them from the request

The user does not name agents. When a request matches a row below, delegate to that agent (Agent tool,
`subagent_type` = the name) **without being asked to use a subagent** — this file is the standing request. Say in one
line which agent you are using. If a request matches several rows, run the independent ones in parallel. If none
matches, work directly.

| When the user says / the situation is… | Use |
| --- | --- |
| CI is red, a check failed, "why did the run fail", a PR can't merge because of checks, watching main after a merge | `ci-triage` |
| "is this safe to ship/merge/release", before merging changes to `ctl/src`, `ctl/server`, `ctl/container`, `env/`, `project-template/`, or image/release workflows; upgrade order, rollback, version skew | `rollout-guard` |
| add/remove/update an R package in the image, new CRAN snapshot or R version, new R series, `env/lock.sh` refused something, "image or project library?" | `r-env-curator` |
| "are the docs up to date", docs vs code drift, after changing commands/settings/config keys/scripts/workflows, before a release | `docs-sync` |
| security review; any change to the gateway / forced command / `agent connect`, ownership checks, image verification, uploads, container hardening, SSH/host keys, `install.sh`, backups | `gateway-security-reviewer` |
| "fix the next audit item", "do step N of the fix plan", work through audit findings | `audit-fixer`, one item per run; independent items in parallel — via `/audit-fix` |
| audit the repo / a module / a diff (robustness, architecture, build, CI, ops, UX) | not an agent: read `.agents/skills/audit/SKILL.md` (or `audit-<area>/SKILL.md` for one area) and follow it |

Typical combinations:
- Finishing a change in `ctl/`: `rollout-guard` + `docs-sync` (+ `gateway-security-reviewer` if it touches the trust boundary), in parallel, before the PR is merged.
- A PR's CI went red outside the audit-fix workflow: `ci-triage` first; fix in the main session or hand the fix to `audit-fixer` if it is an audit item.

## Working through a fix plan

`/audit-fix` (`.claude/skills/audit-fix/SKILL.md`) is the procedure: the main session coordinates parallel
audit-fixer runs on independent items, claims items in the plan before launching (so several chats never take the
same item), and records statuses. Prefer one chat with `/audit-fix --max N` (up to 6) over several coordinating chats. Follow it also when the user asks in
words ("work through the audit plan", "continue the fixes").

For a repeat PR review, pass the previously reviewed base and head SHAs, findings, and current head SHA.
With the same base and a new head descended from the reviewed head, review the intervening changes,
their callers, and affected findings. Review the full target if the prior scope is unclear, the base
changed, history was rewritten, or a change invalidates the earlier review's assumptions.

Agent definitions live in `.claude/agents/`. When adding one, add its row here.

## Standing rules (also in each agent)
- Never ssh to or probe the servers or Gitea; give the user the commands to run.
- One branch per change off fresh `origin/main`; run `./lint.sh` before committing.
- **Usage gate for any agent launch** (from this file's table or `/audit-fix`): read
  `~/.claude/mods/glance/usage.json` first. At 80 % of either limit, ask the user whether to continue before
  launching (once per limit window); at 95 %, launch nothing, let running agents finish their item, and schedule a
  one-shot resume at the reset time. Details in `.claude/skills/audit-fix/SKILL.md` «Usage gate».
- Agents that edit files (audit-fixer, r-env-curator, docs-sync when applying) always work in their own worktree, so
  any number of them can run alongside each other and the user's own work.
- If the main checkout is not on `main` or is dirty, another session may be using it: do your work in a separate
  worktree (`git worktree add ../positron-remote-wt-<name> -b <branch> origin/main`) instead of switching branches.
