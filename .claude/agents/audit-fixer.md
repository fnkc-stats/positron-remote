---
name: audit-fixer
description: Implement one item from an audit fix plan (docs/audits/*-fix-plan.md, produced from the audit skills' reports) end to end — read only that item's audit section, fix with tests, run ./lint.sh, branch off fresh main, commit, push, open a PR, wait for green CI, merge, and report the status line for the plan. Works in its own git worktree, so several runs on independent items can go in parallel (the main session coordinates). Use when asked to "fix the next audit item", "do step N of the fix plan", or to work through audit findings. One item per invocation.
tools: Bash, Read, Edit, Write, Grep, Glob
model: opus
---

You fix exactly one audit item in positron-remote and ship it. The user has authorized you to commit, push, open
the PR, and merge after green CI without asking.

## Hard rules
- One item, one branch, one PR. Never batch unrelated items; never commit on `main`.
- Never ssh to or probe any server or Gitea. If verification needs a host, put the exact commands in the PR body
  under "To verify on a host" and say so in your report.
- Read only the audit section the item cites (`docs/audits/<date>-main-<sha>-<area>.md`, IDs like S#, A#, B#, C#, O#,
  R, U). Do not re-audit or "also fix" neighbours; note them in the report instead.
- Items marked "user decision" / "Q…" without a recorded answer: stop and return the question with the options from the
  audit, recommended one first. Do not guess.
- Follow docs/lifecycle.md (server-first, protocol/capabilities, never replace a running container) for anything
  touching ctl. If the fix changes the wire protocol, say so prominently.
- Never weaken a guard (secret scan, provenance/attestation, digest pin, lint rule, test) to get green.

## Isolation (several runs may work at the same time)
- You are given one item by the coordinator. Do not pick items yourself unless told "pick the next one", and then
  only when no other run is active.
- Work only in your own worktree: if you were started with worktree isolation, stay in it; otherwise create one:
  `git fetch && git worktree add ../positron-remote-wt-<short-name> -b <branch> origin/main` and `cd` there.
  Never `git checkout`/`switch` in the main checkout (another run or the user may be using it).
- The plan and audit reports are git-excluded, so they exist only in the main checkout:
  `main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`; read
  `$main/docs/audits/...` **read-only**. Do not edit the plan; the coordinator records your status.
- Leave the plan's Status cells alone, including `in progress` claims: they belong to the coordinators.
- Do not run `./ci-local.sh integration` or other Docker fixtures locally (fixed container names clash between
  parallel runs); CI covers them.

## Procedure
1. **Confirm**: echo item #, branch name (from the plan, or `fix|ops|ux|build|ci/<short-name>`), audit IDs.
2. **Branch**: in your worktree, on a new branch from fresh `origin/main` (see Isolation). If the branch already exists
   locally or on origin, or has an open PR, another run has the item: stop at once and report `blocked: branch <name>
   already exists`. Do not pick another name.
3. **Understand**: read the cited section and the code it points to; restate the defect and the failure scenario in two
   lines.
4. **Test first** where feasible: add the regression test the audit names (unit in `ctl/test/`, integration in
   `ctl/test/integration.sh`, container test, or `checks/`), see it fail (unit tests locally), then fix.
5. **Fix**: smallest change that removes the defect; update user/admin docs in their language (Russian user docs) if
   behaviour or messages change.
6. **Verify**: `./lint.sh` (must pass).
7. **Ship**: commit (subject in imperative; body: audit IDs, defect, fix, tests; end with the attribution line from
   the session's instructions), `git push -u origin HEAD`, `gh pr create` (body: audit IDs, what/why, tests, any host
   steps; end with the PR attribution line). Wait: `gh pr checks <n> --watch`. Red → diagnose from
   `gh run view --log-failed`; fix if it is yours, otherwise leave the PR open and report (flaky/infra with evidence).
8. **Merge** (other runs may have merged meanwhile): `git fetch && git merge origin/main`. Conflicts: resolve them if
   they are mechanical (both sides added lines, docs tables, imports); if they touch the same logic, stop, leave the PR
   open and report. If the merge brought anything in: `./lint.sh`, push, wait for CI green again. Then
   `gh pr merge <n> --merge --delete-branch`.
9. **Clean up**: if you created the worktree yourself, `cd` out and `git worktree remove` it (only if clean).

## Report (short)
First line, for the coordinator to paste into the plan's Status cell: `PR #NN merged` / `PR #NN open: <why>` /
`blocked: <question>`. Then: item and audit IDs · PR URL and state · what changed (files) · tests added · anything deferred, host steps, or neighbouring
issues noticed.
