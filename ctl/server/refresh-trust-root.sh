#!/usr/bin/env bash
# Refreshes GitHub's Sigstore trust root used for offline image provenance checks (src/provenance.ts). install.sh runs
# it weekly from a systemd timer: Sigstore rotates its keys, and a stale root would refuse new attestations.
# The current file is kept if the download fails or does not look like a trust root.
#   refresh-trust-root.sh [/etc/fnkc-ctl/trusted-root.jsonl]
#   refresh-trust-root.sh --from <file> [/etc/fnkc-ctl/trusted-root.jsonl]
# --from installs a file made elsewhere instead of downloading it: on a server without GitHub access, run
# `gh attestation trusted-root > trusted-root.jsonl` on a computer with gh, and copy the file over.
set -euo pipefail
FROM=
if [ "${1:-}" = --from ]; then
  [ -n "${2:-}" ] || { echo 'usage: refresh-trust-root.sh --from <file> [destination]' >&2; exit 2; }
  FROM="$2"; shift 2
  [ -f "$FROM" ] || { echo "no such file: $FROM" >&2; exit 1; }
fi
ROOT="${1:-/etc/fnkc-ctl/trusted-root.jsonl}"
tmp="$(mktemp "$ROOT.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if [ -n "$FROM" ]; then cat -- "$FROM" > "$tmp"; else gh attestation trusted-root > "$tmp"; fi
# One JSON object per line, at least one, each with certificate authorities or transparency logs
python3 - "$tmp" <<'PY'
import json, sys
try:
    lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except ValueError:
    lines = []
if not lines or not all(isinstance(l, dict) and (l.get('certificateAuthorities') or l.get('tlogs')) for l in lines):
    sys.exit('this does not look like a trust root; keeping the current file')
PY
chmod 0644 "$tmp"
mv -f "$tmp" "$ROOT"
trap - EXIT
echo "refreshed $ROOT"
