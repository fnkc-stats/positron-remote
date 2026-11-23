#!/usr/bin/env bash
# Decisions positron.yml takes about an image a positron-* tag points to. Tested locally by ctl/test/positron-tag.test.ts
# with a fake gh and docker and a throwaway git repository.
#   .github/scripts/positron-tag.sh provenance <repo>@sha256:<digest>
#     Does its provenance verify as hosts require (signer positron.yml, refs/heads/main)? Exit 0: it does; 1: it does
#     not (the proof is missing or invalid; the reason on stdout); 2: inconclusive (the attestation service kept
#     failing): the caller stops rather than rebuild an image that may be fine.
#   .github/scripts/positron-tag.sh newest <repo>@sha256:<digest>
#     May this run's commit replace it? Exit 0: yes (it was published from this commit or an ancestor, or records no
#     commit); 1: no, it was published from a newer (or unrelated) main commit, so this is an older run or a rerun of
#     one that must not move the tag back (the reason on stdout; deliberate moves back: positron-promote.yml); 2: the
#     commits could not be compared.
# Environment: GITHUB_REPOSITORY, GITHUB_SHA (newest); TRIES (default 4) and RETRY_SECONDS (default 15, doubled after
# each attempt) for calls to GitHub. Needs gh (GH_TOKEN), docker buildx and jq.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}"
TRIES="${TRIES:-4}"
RETRY_SECONDS="${RETRY_SECONDS:-15}"
what="${1:?provenance or newest}" ref="${2:?image reference}"
[[ "$ref" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || { echo "not an image pinned by digest: '$ref'" >&2; exit 2; }

# Errors worth another attempt: the service or the network, not the answer
transient() { grep -qiE 'HTTP (429|5[0-9]{2})|rate limit|timeout|timed out|connection (reset|refused)|temporary failure|no such host|TLS handshake|unexpected EOF|i/o timeout|service unavailable|bad gateway' <<< "$1"; }

# Runs "$@" up to TRIES times while it fails transiently; its stdout in $out, stderr in $err, exit status returned
attempt() {
  local n=1 wait="$RETRY_SECONDS" status errf
  errf="$(mktemp)"
  while :; do
    status=0
    out="$("$@" 2>"$errf")" || status=$?
    err="$(cat "$errf")"
    if [ "$status" = 0 ] || ! transient "$err" || [ "$n" -ge "$TRIES" ]; then break; fi
    echo "attempt $n of $TRIES failed, retrying in ${wait}s: $(tail -n 1 <<< "$err")" >&2
    sleep "$wait"
    n=$((n + 1)) wait=$((wait * 2))
  done
  rm -f "$errf"
  return "$status"
}

case "$what" in
  provenance)
    if attempt gh attestation verify "oci://$ref" --repo "$GITHUB_REPOSITORY" \
        --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/positron.yml" --source-ref refs/heads/main; then
      exit 0
    fi
    if transient "$err"; then
      echo "could not check the provenance of $ref after $TRIES attempts: $(tail -n 1 <<< "$err")" >&2
      exit 2
    fi
    # An answer: no proof, or one that does not meet the policy. Anything else is not read as a verdict.
    if grep -qiE 'no attestations found|HTTP 404|verification failed|failed to verify|does not match|no matching|expected .* (got|to be)' <<< "$err"; then
      tail -n 1 <<< "$err"
      exit 1
    fi
    echo "could not check the provenance of $ref: $(tail -n 1 <<< "$err")" >&2
    exit 2
    ;;
  newest)
    : "${GITHUB_SHA:?}"
    labels='if has("config") then .config.Labels else (to_entries | map(select(.key | startswith("linux/"))) | .[0].value.config.Labels) end'
    image="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}')" || { echo "could not read $ref" >&2; exit 2; }
    revision="$(jq -r "$labels | .\"org.opencontainers.image.revision\" // \"\"" <<< "$image")"
    # Images from before the label: nothing to compare with, the recipe decides as before
    [ -n "$revision" ] || exit 0
    [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo "$ref records revision '$revision', not a commit" >&2; exit 2; }
    [ "$revision" != "$GITHUB_SHA" ] || exit 0
    # ahead: this commit descends from the one that published it; identical: the same commit
    if ! attempt gh api "repos/$GITHUB_REPOSITORY/compare/$revision...$GITHUB_SHA" --jq .status; then
      echo "could not compare $GITHUB_SHA with ${revision} (which published $ref): $(tail -n 1 <<< "$err")" >&2
      exit 2
    fi
    case "$out" in
      ahead | identical) exit 0 ;;
      behind | diverged)
        echo "$ref was published from main commit $revision, which this run's commit $GITHUB_SHA does not include ($out): a newer recipe is published; an older run does not move the tag back (rollback: positron-promote.yml)"
        exit 1 ;;
      *) echo "unexpected comparison of $revision and $GITHUB_SHA: '$out'" >&2; exit 2 ;;
    esac
    ;;
  *) echo "unknown check: $what (provenance or newest)" >&2; exit 2 ;;
esac
