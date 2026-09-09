#!/usr/bin/env bash
# slack-pr-inbox-post.sh — POST a Slack PR-link event into Control inbox.
#
# Control holds NO Slack token. An agent with Slack MCP polls slackWatch.surfaces
# (+ optional DMs/MPIMs; see scripts/slack-watch.md). Cursor per surface id in
# .control/slack-watcher-state.json. For PR URLs on prLinks:true surfaces, call
# this helper (type pr_link). Plain messages POST type "message" instead.
#
# Usage:
#   ./scripts/slack-pr-inbox-post.sh \
#     <channel_id> <message_ts> <permalink> <text> <repo> <pr_number>
#
# Env:
#   CONTROL_BASE_URL  default http://localhost:3000
#   DRY_RUN=1         print payload; do not curl
set -euo pipefail

CONTROL_BASE_URL="${CONTROL_BASE_URL:-http://localhost:3000}"
DRY_RUN="${DRY_RUN:-0}"

if [[ $# -lt 6 ]]; then
  cat >&2 <<'USAGE'
Usage: slack-pr-inbox-post.sh <channel_id> <message_ts> <permalink> <text> <repo> <pr_number>

Example:
  ./scripts/slack-pr-inbox-post.sh \
    C0BVCSA4T2P 1788810000.100001 \
    'https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788810000100001' \
    'Please review https://github.com/richardhorvath11/battle-buddy/pull/32' \
    richardhorvath11/battle-buddy 32
USAGE
  exit 1
fi

CHANNEL_ID="$1"
MESSAGE_TS="$2"
PERMALINK="$3"
TEXT="$4"
REPO="$5"
PR_NUMBER="$6"

# occurred_at: derive from Slack ts (seconds.micros) when possible
OCCURRED_AT="$(python3 - "$MESSAGE_TS" <<'PY'
import sys, datetime
ts = sys.argv[1]
try:
    sec = float(ts)
    print(datetime.datetime.fromtimestamp(sec, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")
except Exception:
    print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z")
PY
)"

ID="${CHANNEL_ID}_${MESSAGE_TS}"
# filesystem-safe-ish id (Control also sanitizes)
ID_SAFE="$(python3 -c 'import sys; print(sys.argv[1].replace(" ","_"))' "$ID")"

PAYLOAD="$(python3 - "$ID_SAFE" "$CHANNEL_ID" "$MESSAGE_TS" "$PERMALINK" "$TEXT" "$REPO" "$PR_NUMBER" "$OCCURRED_AT" <<'PY'
import json, sys
id_, channel_id, message_ts, permalink, text, repo, pr_number, occurred_at = sys.argv[1:9]
payload = {
    "id": id_,
    "type": "pr_link",
    "channel_id": channel_id,
    "message_ts": message_ts,
    "permalink": permalink,
    "text_excerpt": text[:500],
    "repo": repo,
    "pr_number": int(pr_number),
    "occurred_at": occurred_at,
}
print(json.dumps(payload))
PY
)"

INBOX_URL="${CONTROL_BASE_URL%/}/api/slack/inbox"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "would-post $INBOX_URL"
  echo "$PAYLOAD"
  exit 0
fi

HTTP_CODE=0
RESP_FILE="$(mktemp)"
set +e
HTTP_CODE="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' \
  -X POST "$INBOX_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --connect-timeout 3 \
  --max-time 8 \
  -d "$PAYLOAD")"
CURL_RC=$?
set -e

if [[ $CURL_RC -ne 0 ]]; then
  echo "warn: Control unreachable at $INBOX_URL (curl exit $CURL_RC); payload not delivered" >&2
  echo "$PAYLOAD" >&2
  rm -f "$RESP_FILE"
  exit 2
fi

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  DUP="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print("true" if d.get("duplicate") else "false")' <"$RESP_FILE" 2>/dev/null || echo unknown)"
  echo "ok http=$HTTP_CODE duplicate=$DUP id=$ID_SAFE"
  cat "$RESP_FILE"
  echo
  rm -f "$RESP_FILE"
  exit 0
fi

echo "error: Control HTTP $HTTP_CODE from $INBOX_URL" >&2
cat "$RESP_FILE" >&2 || true
echo >&2
rm -f "$RESP_FILE"
exit 1
