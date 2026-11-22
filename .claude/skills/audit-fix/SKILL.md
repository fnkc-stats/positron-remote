---
name: audit-fix
description: Work through this repo's audit fix plan — coordinate parallel audit-fixer runs on independent items, each in its own worktree, and record their statuses in the plan. Use when the user types /audit-fix or asks to work through / continue the audit plan or fix plan.
argument-hint: "[item numbers, e.g. 3 5 7] [--max N] [--plan path] [--dry-run]"
---

# /audit-fix — coordinate the fix plan

You are the coordinator. audit-fixer runs implement; you choose, launch, track and record. Do not implement items
yourself.

## Arguments ($ARGUMENTS)
- Item numbers (e.g. `3 5 7`): only these items. None: every open item that needs no user decision.
- `--max N`: parallel runs (default 3, never more than 5).
- `--plan <path>`: the plan file. Default: newest `docs/audits/*-fix-plan.md` in the **main checkout**
  (`main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`; the plan is git-excluded, so
  worktrees don't have it).
- `--dry-run`: show the waves and stop, launch nothing.

## Steps
1. **Read the plan.** List open items (Status not merged/done). Set aside items needing a user decision (marked
   "user decision" / "Q…" without a recorded answer). Ask those questions together with one AskUserQuestion, options from the
   audit, recommended first — but don't wait on them to start the rest.
2. **Usage.** Check `~/.claude/mods/glance/usage.json`; at ≥ 92 % of either limit start nothing and say so.
3. **Estimate scope.** For each item, read only its audit section and grep the code it cites; list the files it will
   likely touch.
4. **Plan waves.** Independent = no shared source file, and neither depends on the other. Always serialize items
   that change the wire protocol or `ctl/src/protocol.ts` / `ctl/src/errors.ts`, change `ctl/package.json`
   dependencies or lockfiles, change the same workflow file, or that the plan orders ("after X"). Docs-only overlap
   is fine (runs resolve it at merge). Show the user in a few lines: which run now, which wait and why.
5. **Launch** up to `--max` audit-fixer agents at once (Agent tool, `subagent_type: "audit-fixer"`,
   `isolation: "worktree"`), each prompt containing: absolute plan path, item #, branch name from the plan (or
   `fix|ops|ux|build|ci/<short-name>`), audit IDs, the files you expect it to touch, and "other runs are active in
   parallel; follow your Isolation rules".
6. **Track.** As each run reports, paste its first line into that item's Status cell in the plan (only you edit the
   plan) with today's date. When a slot frees up, launch the next item that is independent of everything still running
   (re-check usage first).
7. **Failures.** A run that reports a red check: give the run/PR to `ci-triage`; if it is the item's own bug, re-launch
   that item alone with the triage result. A run that stopped on a merge conflict: re-launch it alone after the
   conflicting PR merged. Never weaken a guard to get green.
8. **Finish.** When nothing is left to launch: short summary — merged PRs, PRs left open and why, questions still
   waiting for the user, and the plan's next phase if the plan names one.

Never ssh to or probe servers or Gitea; host-side verification steps go to the user as commands.
