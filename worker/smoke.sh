#!/usr/bin/env bash
# Post-deploy smoke test.  Exits non-zero if the Worker is not serving.
#
# Usage:  ./smoke.sh [base-url]
#
# Checks the routes a reader actually hits, not just that the Worker booted —
# a deploy can succeed and still break a route.  Each check requires HTTP 200
# and a plausible response size, since several failure modes here return 200
# with an error body or an empty payload.
set -uo pipefail

BASE="${1:-https://krengbible.pauljkim22.workers.dev}"
FAILED=0

check () {
  local label="$1" path="$2" min="$3"
  local out code size
  out=$(curl -sS -o /tmp/smoke.body -w '%{http_code} %{size_download}' \
        --max-time 45 "$BASE$path" 2>/dev/null) || { printf 'FAIL  %-28s (request failed)\n' "$label"; FAILED=1; return; }
  code=${out%% *}; size=${out##* }
  if [ "$code" != "200" ]; then
    printf 'FAIL  %-28s HTTP %s\n' "$label" "$code"
    head -c 200 /tmp/smoke.body; echo
    FAILED=1
  elif [ "$size" -lt "$min" ]; then
    printf 'FAIL  %-28s 200 but only %s bytes (expected >= %s)\n' "$label" "$size" "$min"
    head -c 200 /tmp/smoke.body; echo
    FAILED=1
  else
    printf 'ok    %-28s %s bytes\n' "$label" "$size"
  fi
}

echo "Smoke testing $BASE"
check "Korean chapter"   "/nkrv/1/1"                                 1000
check "Korean search"    "/search/ko?q=%EC%82%AC%EB%9E%91"           500
check "English passage"  "/esv/?q=John+3:16"                         200
check "English search"   "/search/en?q=lamp"                         500
check "Verse of the day" "/votd"                                     100
check "Book intro"       "/intro/1"                                  500

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "Smoke test FAILED.  The deploy is live and serving badly — roll back:"
  echo "    cd worker && npx wrangler rollback"
  echo "Note: /search/ko returning 503 means the KV search index is missing,"
  echo "which is a data problem, not a bad deploy.  See README."
  exit 1
fi

echo
echo "All checks passed."
