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
- `--max N`: parallel runs (default 2, never more than 6). Prefer one chat with a higher `--max` over several
  chats: chats cannot see each other's running files, only their claims.
- `--plan <path>`: the plan file. Default: newest `docs/audits/*-fix-plan.md` in the **main checkout**
  (`main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`; the plan is git-excluded, so
  worktrees don't have it).
- `--dry-run`: show the waves and stop, launch nothing.

## Usage gate (before every launch)
Read `~/.claude/mods/glance/usage.json`: `limits[]` with `kind` (`five_hour`, `seven_day`), `percentUsed`, `resetsAt`
(UTC; show it to the user in local time). Judge by the highest limit. If `at` is older than 30 minutes, the
numbers are unknown: say so and ask before launching.
- **< 80 %**: launch.
- **80–94 % (soft)**: launch nothing until the user answers one AskUserQuestion naming the limit, its % and reset time:
  "Continue" / "Pause until reset" / "Stop here". Continue → don't ask again for that limit until its `resetsAt` changes or
  it reaches 95 %. Pause → do as for the hard limit. Stop → release claims of unlaunched items and finish (step 8).
- **≥ 95 % (hard)**: launch nothing. Runs already going finish their item (stopping one mid-item loses its work);
  don't re-launch failed ones. Release claims of unlaunched items. Schedule the resume: CronCreate one-shot
  (`recurring: false`) at that limit's `resetsAt` + 3 minutes in local time, prompt `/audit-fix <the same arguments>`
  — claims make the resume safe. Tell the user the resume time, and that it fires only while this chat stays open;
  for a `seven_day` reset more than a day away, say how far away it is.
Subagents cannot ask the user, so this gate is yours alone; check it before each launch, not only once per wave.

## Claims (several chats may coordinate the same plan)
- At start pick a chat tag: `tag=$(openssl rand -hex 3)`; use it in every claim you write.
- **Lock every plan edit**: `lock="$main/docs/audits/.plan.lock"`; acquire with
  `mkdir "$lock"` — if it fails, another chat is editing: retry the command shortly (no `sleep` loops); if the lock
  dir is older than 10 minutes (`find "$lock" -maxdepth 0 -mmin +10`), it is stale: `rmdir` it and retry, then **re-read the plan**, edit, and `rmdir "$lock"`. Never hold it while waiting on a run.
- **Claim before launch**: under the lock, set the item's Status to `in progress (<tag>, <ISO time>)`. Only then
  launch its run. An item is **taken** if its Status says `in progress` with another tag and a time less than 6 hours
  ago, or if its branch already exists (`git ls-remote --heads origin <branch>`, `git branch --list <branch>`) or has an
  open PR (`gh pr list --head <branch>`). Never launch a taken item. Older claims with no branch and no PR are
  abandoned: you may reclaim them (say so).
- **Release**: when a run reports, replace your claim with its result line. If you stop before launching a claimed item,
  or the user interrupts, restore those items' previous Status under the lock.

## Steps
1. **Read the plan.** List open items (Status not merged/done). Set aside items needing a user decision (marked
   "user decision" / "Q…" without a recorded answer). Ask those questions together with one AskUserQuestion, options from the
   audit, recommended first — but don't wait on them to start the rest.
2. **Usage.** Apply the Usage gate.
3. **Estimate scope.** For each item, read only its plan text (and a cited audit report section, if one exists) and grep the code it cites; list the files it will
   likely touch.
4. **Plan waves.** Also estimate the files of items **taken by other chats** and treat them as busy.
   Independent = no shared source file (with your items and theirs), and neither depends on the other. Always serialize items
   that change the wire protocol or `ctl/src/protocol.ts` / `ctl/src/errors.ts`, change `ctl/package.json`
   dependencies or lockfiles, change the same workflow file, or that the plan orders ("after X"). Docs-only overlap
   is fine (runs resolve it at merge). Show the user in a few lines: which run now, which wait and why.
5. **Claim, then launch** (see Claims) up to `--max` audit-fixer agents at once (Agent tool, `subagent_type: "audit-fixer"`,
   `isolation: "worktree"`), each prompt containing: absolute plan path, item #, branch name from the plan (or
   `fix|ops|ux|build|ci/<short-name>`), audit IDs, the files you expect it to touch, and "other runs are active in
   parallel; follow your Isolation rules".
6. **Track.** As each run reports, replace your claim with its first line and today's date (under the lock). When a slot frees up, re-read the plan and launch the next item that is untaken and independent of everything still running,
   in any chat (Usage gate first).
7. **Failures.** A run that reports a red check: give the run/PR to `ci-triage`; if it is the item's own bug, re-launch
   that item alone with the triage result. A run that stopped on a merge conflict: re-launch it alone after the
   conflicting PR merged. Never weaken a guard to get green.
8. **Finish.** When nothing is left to launch: short summary — merged PRs, PRs left open and why, questions still
   waiting for the user, and the plan's next phase if the plan names one.

Never ssh to or probe servers or Gitea; host-side verification steps go to the user as commands.
