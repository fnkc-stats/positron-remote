#!/usr/bin/env bash
# Delete finished GitHub Actions runs that are no longer useful, so the Actions list stays short:
#   - runs on any branch other than main that is not the head of an open pull request (merged, closed, deleted);
#   - runs older than RETENTION_DAYS on any branch, main included.
# Runs in progress are kept. Called weekly by prune-runs.yml; can also be run locally with a gh login.
#
#   .github/scripts/prune-runs.sh             delete
#   DRY_RUN=1 .github/scripts/prune-runs.sh   only list what would be deleted
#
# Env: REPO (default: the current gh repository), RETENTION_DAYS (default 30), DRY_RUN.
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
cutoff=$(( $(date +%s) - RETENTION_DAYS * 86400 ))

open_heads=$(gh pr list -R "$REPO" --state open --limit 500 --json headRefName -q '.[].headRefName')

# Collect first, delete afterwards: deleting while paging would shift the pages and skip runs
ids=()
while IFS=$'\t' read -r id status branch created workflow; do
  [ "$status" = completed ] || continue
  reason=""
  if [ "$created" -lt "$cutoff" ]; then
    reason="older than $RETENTION_DAYS days"
  elif [ "$branch" != main ] && ! grep -qxF -- "$branch" <<<"$open_heads"; then
    reason="branch $branch has no open pull request"
  fi
  [ -n "$reason" ] || continue
  ids+=("$id")
  echo "$id	$workflow	$reason"
done < <(gh api --paginate "repos/$REPO/actions/runs?per_page=100" \
  -q '.workflow_runs[] | [.id, .status, .head_branch, (.created_at | fromdateiso8601), .name] | @tsv')

echo "${#ids[@]} runs to delete in $REPO"
[ -z "${DRY_RUN:-}" ] || exit 0

failed=0
for id in "${ids[@]}"; do
  gh api -X DELETE "repos/$REPO/actions/runs/$id" --silent || failed=$((failed + 1))
done
echo "deleted $(( ${#ids[@]} - failed )), failed $failed"
[ "$failed" -eq 0 ]
