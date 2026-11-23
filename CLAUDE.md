# Claude Code instructions for this repo

## Project agents and skills: inline first

Subagents start cold and re-read everything the main session already has, so they cost several times more than
doing the work here. Default: **work inline**. For a matching request, read the agent's file in `.claude/agents/`
and apply its checklist and output format yourself, on the diff you already have.

Spawn a subagent only when:
- the user asks for one, or for `/audit-fix` (one `audit-fixer` per independent item; follow
  `.claude/skills/audit-fix/SKILL.md`, including claims and status updates);
- the user wants a fully independent review of a large diff (more than about 400 changed lines in `ctl/`). Then use one
  reviewer, the most relevant one, not several in parallel.

| Request or change | Checklist (`.claude/agents/`) |
| --- | --- |
| Failed or flaky GitHub Actions check | `ci-triage.md` |
| Release safety, client/server compatibility, running containers, install/rollback, image pins, release workflows | `rollout-guard.md` |
| Team R image packages, lock failures, package placement | `r-env-curator.md` |
| Docs drift after changes to commands, settings, messages, scripts, workflows | `docs-sync.md` |
| Gateway, ownership, uploads, image verification, container isolation, keys, secrets, backups, install.sh | `gateway-security-reviewer.md` |
| Audit a repo, module or diff | `.agents/skills/audit/SKILL.md` or `audit-<area>/SKILL.md` |

Apply only the checklist sections that the diff touches. Read the docs they cite one section at a time (`grep -n` for
the heading, then read that range), never whole files. For a repeat review, review only the commits since the
reviewed head.

Token hygiene for long commands: redirect `./lint.sh`, test runs and `gh pr checks --watch` to a log file and show
only the result or `tail -40` on failure; use `gh run view --job <id> --log-failed | tail -80`, never full logs.

Agent definitions live in `.claude/agents/`. When adding one, add its row here.

## Standing rules (also in each agent)
- Never ssh to or probe the servers or Gitea; give the user the commands to run.
- One branch per change off fresh `origin/main`; run `./lint.sh` before committing.
- **Usage gate for any agent launch**: read
  `~/.claude/mods/glance/usage.json` first. At 80 % of either limit, ask the user whether to continue before
  launching (once per limit window); at 95 %, launch nothing, let running agents finish their item, and schedule a
  one-shot resume at the reset time. Details in `.claude/skills/audit-fix/SKILL.md` «Usage gate».
- Agents that edit files (audit-fixer, r-env-curator, docs-sync when applying) always work in their own worktree, so
  any number of them can run alongside each other and the user's own work.
- If the main checkout is not on `main` or is dirty, another session may be using it: do your work in a separate
  worktree (`git worktree add ../positron-remote-wt-<name> -b <branch> origin/main`) instead of switching branches.
