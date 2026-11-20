#!/usr/bin/env bash
# Refreshes GitHub's Sigstore trust root used for offline image provenance checks (src/provenance.ts). install.sh runs
# it weekly from a systemd timer: Sigstore rotates its keys, and a stale root would refuse new attestations.
# The current file is kept if the download fails or does not look like a trust root.
#   refresh-trust-root.sh [/etc/fnkc-ctl/trusted-root.jsonl]
set -euo pipefail
ROOT="${1:-/etc/fnkc-ctl/trusted-root.jsonl}"
tmp="$(mktemp "$ROOT.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
gh attestation trusted-root > "$tmp"
# One JSON object per line, at least one, each with certificate authorities or transparency logs
python3 - "$tmp" <<'PY'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
if not lines or not all(isinstance(l, dict) and (l.get('certificateAuthorities') or l.get('tlogs')) for l in lines):
    sys.exit('the downloaded trust root does not look like one; keeping the current file')
PY
chmod 0644 "$tmp"
mv -f "$tmp" "$ROOT"
trap - EXIT
echo "refreshed $ROOT"
