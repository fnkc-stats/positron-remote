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
| "fix the next audit item", "do step N of the fix plan", work through audit findings | `audit-fixer`, one item per run; independent items in parallel — see «Working through a fix plan» |
| audit the repo / a module / a diff (robustness, architecture, build, CI, ops, UX) | not an agent: read `.agents/skills/audit/SKILL.md` (or `audit-<area>/SKILL.md` for one area) and follow it |

Typical combinations:
- Finishing a change in `ctl/`: `rollout-guard` + `docs-sync` (+ `gateway-security-reviewer` if it touches the trust boundary), in parallel, before the PR is merged.
- A PR's CI went red: `ci-triage` first; fix in the main session or hand the fix to `audit-fixer` if it is an audit item.

## Working through a fix plan (parallel audit-fixer runs)

The main session is the coordinator; audit-fixer runs only implement.
1. **Pick a wave**: the open items of the plan that need no user decision. For each, read its audit section and
   estimate the files it will touch (grep the code it cites).
2. **Independent** = no shared source file, and neither item depends on the other's result. Always serialize items
   that: change the wire protocol or `ctl/src/protocol.ts` / `errors.ts`; change `ctl/package.json` dependencies or
   lockfiles; change the same workflow file; or that the plan orders ("after X"). Docs-only overlap (e.g. both add a
   row to `docs/reference.md`) is fine — runs resolve such conflicts at merge.
3. **Launch** up to 3 runs at once (CI runners and usage limits), each with `isolation: "worktree"` and a prompt
   naming the plan file (absolute path in the main checkout), the item #, its branch name, and the audit IDs. Tell
   the user which items run now and which wait, and why, in a few lines.
4. **Record**: as each run reports, paste its first line into the item's Status cell of the plan (only the
   coordinator edits the plan). Start the next independent item when a slot frees up.
5. A run that reports a conflict or a red check: hand the failure to `ci-triage`, then fix or re-run that item alone.
6. Check `~/.claude/mods/glance/usage.json` before each wave; start no new runs at ≥ 92 % of either limit.

Agent definitions live in `.claude/agents/`. When adding one, add its row here.

## Standing rules (also in each agent)
- Never ssh to or probe the servers or Gitea; give the user the commands to run.
- One branch per change off fresh `origin/main`; run `./lint.sh` before committing.
- If the main checkout is not on `main` or is dirty, another session may be using it: do your work in a separate
  worktree (`git worktree add ../positron-remote-wt-<name> -b <branch> origin/main`) instead of switching branches.
