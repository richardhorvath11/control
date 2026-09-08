#!/usr/bin/env bash
# github-watcher-tick.sh — one standing-watcher tick for Control (V0.6)
#
# Reads .control/watch.json, polls the watched PR via `gh`, diffs
# .control/github-watcher-state.json, and POSTs only *new* canonical events
# to ${CONTROL_BASE_URL:-http://localhost:3000}/api/github/inbox.
#
# Control holds no GitHub token — credentials stay with `gh` on this host.
#
# Usage:
#   ./scripts/github-watcher-tick.sh
#   ./scripts/github-watcher-tick.sh --dry-run
#   DRY_RUN=1 ./scripts/github-watcher-tick.sh
#
# Env:
#   CONTROL_BASE_URL   default http://localhost:3000
#   DRY_RUN=1          print would-post / skip; do not curl Control
#   WATCHER_FORCE_POST=1  on first tick, post current snapshot (default: baseline only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTROL_BASE_URL="${CONTROL_BASE_URL:-http://localhost:3000}"
DRY_RUN="${DRY_RUN:-0}"
FORCE_POST="${WATCHER_FORCE_POST:-0}"
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --force-post) FORCE_POST=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

CONTROL_DIR="$ROOT/.control"
WATCH_PATH="$CONTROL_DIR/watch.json"
WATCH_EXAMPLE="$ROOT/watch.example.json"
STATE_PATH="$CONTROL_DIR/github-watcher-state.json"
INBOX_URL="${CONTROL_BASE_URL%/}/api/github/inbox"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}
need_cmd gh
need_cmd curl
need_cmd python3

mkdir -p "$CONTROL_DIR"

# --- ensure watch.json ---
if [[ ! -f "$WATCH_PATH" ]]; then
  if [[ -f "$WATCH_EXAMPLE" ]]; then
    # Strip _comment_* keys for a clean runtime config
    python3 - "$WATCH_EXAMPLE" "$WATCH_PATH" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as f:
    data = json.load(f)
clean = {k: v for k, v in data.items() if not str(k).startswith("_")}
# Intentional default: teams []
if "teams" not in clean or not isinstance(clean.get("teams"), list):
    clean["teams"] = []
with open(dst, "w", encoding="utf-8") as f:
    json.dump(clean, f, indent=2)
    f.write("\n")
print(f"created {dst} from watch.example.json", file=sys.stderr)
PY
  else
    echo "error: missing $WATCH_PATH and $WATCH_EXAMPLE" >&2
    exit 1
  fi
fi

# --- load watch + previous state, fetch PR, diff, post ---
# All heavy lifting in python3 for robust JSON; gh/curl invoked from python via subprocess.
export ROOT WATCH_PATH STATE_PATH INBOX_URL CONTROL_BASE_URL DRY_RUN FORCE_POST
python3 - <<'PY'
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

WATCH_PATH = os.environ["WATCH_PATH"]
STATE_PATH = os.environ["STATE_PATH"]
INBOX_URL = os.environ["INBOX_URL"]
DRY_RUN = os.environ.get("DRY_RUN", "0") in ("1", "true", "TRUE", "yes")
FORCE_POST = os.environ.get("FORCE_POST", "0") in ("1", "true", "TRUE", "yes")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def load_json(path: str, default: Any = None) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        print(f"error: invalid JSON in {path}: {e}", file=sys.stderr)
        sys.exit(1)


def write_json(path: str, data: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def gh_json(args: list[str]) -> Any:
    cmd = ["gh", *args]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.PIPE, text=True)
    except subprocess.CalledProcessError as e:
        print(f"error: gh failed: {' '.join(cmd)}\n{e.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(out)


def aggregate_ci(rollup: list[dict] | None) -> tuple[str | None, str | None, str | None]:
    """Return (conclusion, details_url, summary_name).

    conclusion: SUCCESS | FAILURE | PENDING | None
    Any completed failure-like → FAILURE; else if any incomplete → PENDING;
    else if all SUCCESS (or neutral/skipped) → SUCCESS; empty → None.
    """
    if not rollup:
        return None, None, None
    fail_like = {"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}
    pending_status = {"IN_PROGRESS", "QUEUED", "PENDING", "REQUESTED", "WAITING"}
    best_fail_url = None
    best_fail_name = None
    best_ok_url = None
    best_ok_name = None
    any_pending = False
    any_fail = False
    any_success = False
    for c in rollup:
        status = (c.get("status") or "").upper()
        conclusion = (c.get("conclusion") or "").upper() or None
        url = c.get("detailsUrl") or c.get("details_url")
        name = c.get("name") or c.get("context") or "check"
        if status in pending_status or status == "IN_PROGRESS":
            any_pending = True
            continue
        if conclusion in fail_like:
            any_fail = True
            if best_fail_url is None:
                best_fail_url, best_fail_name = url, name
        elif conclusion in ("SUCCESS", "NEUTRAL", "SKIPPED"):
            any_success = True
            if best_ok_url is None:
                best_ok_url, best_ok_name = url, name
        elif conclusion is None and status == "COMPLETED":
            # completed with null conclusion — treat as neutral success-ish
            any_success = True
            if best_ok_url is None:
                best_ok_url, best_ok_name = url, name
    if any_fail:
        return "FAILURE", best_fail_url, best_fail_name
    if any_pending:
        return "PENDING", None, None
    if any_success:
        return "SUCCESS", best_ok_url, best_ok_name
    return None, None, None


def post_event(event: dict) -> tuple[str, dict | None]:
    """Returns (status, response_json). status: posted|duplicate|dry-run|error|skipped."""
    if DRY_RUN:
        print(f"would-post {event['type']} id={event['id']}")
        return "dry-run", None
    body = json.dumps(event).encode("utf-8")
    req = urllib.request.Request(
        INBOX_URL,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw) if raw else {}
            dup = bool(data.get("duplicate"))
            label = "duplicate" if dup else "posted"
            print(f"{label} {event['type']} id={event['id']}")
            return label, data
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(
            f"error: Control HTTP {e.code} for {event['type']} id={event['id']}: {err_body}",
            file=sys.stderr,
        )
        return "error", None
    except urllib.error.URLError as e:
        print(
            f"warn: Control unreachable at {INBOX_URL} ({e.reason}); "
            f"skipping post for {event['type']} id={event['id']}",
            file=sys.stderr,
        )
        return "error", None
    except TimeoutError:
        print(
            f"warn: Control timeout at {INBOX_URL}; skipping post for {event['type']}",
            file=sys.stderr,
        )
        return "error", None


watch = load_json(WATCH_PATH)
if not isinstance(watch, dict):
    print("error: watch.json must be an object", file=sys.stderr)
    sys.exit(1)

repo = str(watch.get("repo") or "").strip()
pr = watch.get("pr")
workstream_id = str(watch.get("workstreamId") or "").strip() or None
teams_raw = watch.get("teams") if isinstance(watch.get("teams"), list) else []
watch_teams = {str(t).strip() for t in teams_raw if str(t).strip()}
slack_ch = str(watch.get("slackPrChannelId") or "").strip()

if not repo or not isinstance(pr, int):
    print("error: watch.json needs string repo and numeric pr", file=sys.stderr)
    sys.exit(1)

prev = load_json(STATE_PATH, default=None)
baseline = prev is None and not FORCE_POST

pr_data = gh_json(
    [
        "pr",
        "view",
        str(pr),
        "--repo",
        repo,
        "--json",
        "headRefOid,title,url,statusCheckRollup,reviewRequests,reviews",
    ]
)

head_sha = pr_data.get("headRefOid") or ""
pr_title = pr_data.get("title") or f"{repo}#{pr}"
pr_url = pr_data.get("url") or f"https://github.com/{repo}/pull/{pr}"
ci_conclusion, ci_url, ci_name = aggregate_ci(pr_data.get("statusCheckRollup") or [])

def uniq(seq: list[str]) -> list[str]:
    seen = set()
    out = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out

requested_users: list[str] = []
requested_teams: list[str] = []
for rr in pr_data.get("reviewRequests") or []:
    # gh JSON: User has login; Team has slug
    typename = (rr.get("__typename") or "").lower()
    login = rr.get("login")
    slug = rr.get("slug")
    if typename == "team" or (slug and not login):
        if slug:
            requested_teams.append(str(slug))
    elif login:
        requested_users.append(str(login))
    elif slug:
        requested_teams.append(str(slug))

requested_users = uniq(requested_users)
requested_teams = uniq(requested_teams)

# changes_requested: latest review per author with state CHANGES_REQUESTED
cr_ids: list[str] = []
cr_meta: dict[str, dict] = {}
for rev in pr_data.get("reviews") or []:
    state = (rev.get("state") or "").upper()
    if state != "CHANGES_REQUESTED":
        continue
    author = (rev.get("author") or {}).get("login") or "unknown"
    submitted = rev.get("submittedAt") or rev.get("commit", {}).get("oid") or ""
    rid = f"{author}:{submitted}" if submitted else f"{author}:{head_sha[:7]}"
    cr_ids.append(rid)
    cr_meta[rid] = {
        "author": author,
        "submittedAt": submitted,
        "url": rev.get("url") or pr_url,
    }
cr_ids = uniq(cr_ids)

short = head_sha[:7] if head_sha else "unknown"
tick_at = now_iso()

prev = prev or {}
prev_sha = prev.get("head_sha") or ""
prev_ci = prev.get("ci_conclusion")
prev_users = set(prev.get("requested_users") or [])
prev_teams = set(prev.get("requested_teams") or [])
prev_cr = set(prev.get("changes_requested_ids") or [])
posted_ids = list(prev.get("posted_event_ids") or [])

events: list[dict] = []

def make_id(*parts: str) -> str:
    raw = "-".join(p for p in parts if p)
    # safeId: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$
    cleaned = []
    for ch in raw:
        if ch.isalnum() or ch in "._-":
            cleaned.append(ch)
        else:
            cleaned.append("-")
    s = "".join(cleaned).strip("-") or "evt"
    if not s[0].isalnum():
        s = "e" + s
    return s[:121]


# --- diffs ---
if not baseline:
    if head_sha and head_sha != prev_sha:
        events.append(
            {
                "id": make_id("pr-pushed", str(pr), short),
                "type": "pr.pushed",
                "repo": repo,
                "pr_number": pr,
                "head_sha": head_sha,
                "summary": f"PR #{pr} pushed ({short})",
                "occurred_at": tick_at,
                "provenance": {
                    "url": pr_url,
                    "title": pr_title,
                    "kind": "pr",
                },
                **({"workstream_id": workstream_id} if workstream_id else {}),
            }
        )

    if ci_conclusion in ("FAILURE", "SUCCESS") and ci_conclusion != prev_ci:
        if ci_conclusion == "FAILURE":
            events.append(
                {
                    "id": make_id("ci-failed", str(pr), short),
                    "type": "ci.failed",
                    "repo": repo,
                    "pr_number": pr,
                    "head_sha": head_sha or None,
                    "summary": f"{ci_name or 'CI'} failed" if ci_name else "CI failed",
                    "occurred_at": tick_at,
                    "provenance": {
                        "url": ci_url or f"{pr_url}/checks",
                        "title": f"CI · {ci_name}" if ci_name else "CI",
                        "kind": "ci",
                    },
                    **({"workstream_id": workstream_id} if workstream_id else {}),
                }
            )
        else:
            events.append(
                {
                    "id": make_id("ci-passed", str(pr), short),
                    "type": "ci.passed",
                    "repo": repo,
                    "pr_number": pr,
                    "head_sha": head_sha or None,
                    "summary": f"{ci_name or 'CI'} passed" if ci_name else "CI passed",
                    "occurred_at": tick_at,
                    "provenance": {
                        "url": ci_url or f"{pr_url}/checks",
                        "title": f"CI · {ci_name}" if ci_name else "CI",
                        "kind": "ci",
                    },
                    **({"workstream_id": workstream_id} if workstream_id else {}),
                }
            )

    for user in requested_users:
        if user not in prev_users:
            events.append(
                {
                    "id": make_id("rev-req-user", user, str(pr), short),
                    "type": "review.requested",
                    "repo": repo,
                    "pr_number": pr,
                    "head_sha": head_sha or None,
                    "summary": f"Review requested of @{user}",
                    "occurred_at": tick_at,
                    "provenance": {
                        "url": pr_url,
                        "title": "Review requested",
                        "kind": "review",
                    },
                    "requested_via": "user",
                    "requested_user": user,
                    **({"workstream_id": workstream_id} if workstream_id else {}),
                }
            )

    # Team review.requested: ONLY if team_slug ∈ watch.teams; teams:[] → never
    for team in requested_teams:
        if team not in watch_teams:
            print(f"skip team review.requested team_slug={team} (not in watch.teams={sorted(watch_teams)})")
            continue
        if team not in prev_teams:
            events.append(
                {
                    "id": make_id("rev-req-team", team, str(pr), short),
                    "type": "review.requested",
                    "repo": repo,
                    "pr_number": pr,
                    "head_sha": head_sha or None,
                    "summary": f"CODEOWNERS @{team} requested review",
                    "occurred_at": tick_at,
                    "provenance": {
                        "url": pr_url,
                        "title": "Review requested",
                        "kind": "review",
                    },
                    "requested_via": "team",
                    "team_slug": team,
                    **({"workstream_id": workstream_id} if workstream_id else {}),
                }
            )

    for rid in cr_ids:
        if rid not in prev_cr:
            meta = cr_meta.get(rid, {})
            author = meta.get("author") or "reviewer"
            events.append(
                {
                    "id": make_id("rev-cr", author, str(pr), short),
                    "type": "review.changes_requested",
                    "repo": repo,
                    "pr_number": pr,
                    "head_sha": head_sha or None,
                    "summary": f"@{author} requested changes on PR #{pr}",
                    "occurred_at": tick_at,
                    "provenance": {
                        "url": meta.get("url") or pr_url,
                        "title": "Changes requested",
                        "kind": "review",
                    },
                    **({"workstream_id": workstream_id} if workstream_id else {}),
                }
            )
else:
    print("baseline: seeding state without POSTs (first tick)")
    # Still note any teams that would be skipped if they appeared
    for team in requested_teams:
        if team not in watch_teams:
            print(f"skip team review.requested team_slug={team} (not in watch.teams={sorted(watch_teams)})")

# Strip None optional fields for cleaner payloads
clean_events = []
for ev in events:
    clean_events.append({k: v for k, v in ev.items() if v is not None})
events = clean_events

posted_ok = True
new_posted: list[str] = []
if not events and not baseline:
    print("noop: no changes (last_tick only)")
elif not events and baseline:
    pass
else:
    for ev in events:
        status, _ = post_event(ev)
        if status in ("posted", "duplicate", "dry-run"):
            new_posted.append(ev["id"])
        else:
            posted_ok = False

# --- advance state ---
# Always update last_tick. Advance observed snapshot dimensions that we successfully
# handled (or baseline / dry-run). On Control error, keep previous markers for
# dimensions that had failed posts so the next tick retries.
next_state: dict[str, Any] = {
    "last_tick": tick_at,
    "repo": repo,
    "pr": pr,
    "workstreamId": workstream_id,
    "slackPrChannelId": slack_ch,
    "watch_teams": sorted(watch_teams),
    "head_sha": head_sha,
    "ci_conclusion": ci_conclusion,
    "ci_details_url": ci_url,
    "requested_users": requested_users,
    "requested_teams": requested_teams,  # observed on PR (may include non-watched)
    "changes_requested_ids": cr_ids,
    "posted_event_ids": uniq(posted_ids + new_posted)[-200:],
}

if not posted_ok and not baseline:
    # Revert dimensions that still have unposted events so we retry
    # Keep last_tick though.
    print("warn: one or more posts failed; snapshot markers not fully advanced", file=sys.stderr)
    next_state["head_sha"] = prev_sha or head_sha
    next_state["ci_conclusion"] = prev_ci if prev_ci is not None else None
    # Actually if prev was empty and we failed, keep empty so retry. Better merge:
    next_state["head_sha"] = prev.get("head_sha", "")
    next_state["ci_conclusion"] = prev.get("ci_conclusion")
    next_state["requested_users"] = list(prev.get("requested_users") or [])
    next_state["requested_teams"] = list(prev.get("requested_teams") or [])
    next_state["changes_requested_ids"] = list(prev.get("changes_requested_ids") or [])
    # But if we had successful posts mixed in, we've lost their advance.
    # Re-apply advances for successfully posted event types:
    for ev in events:
        if ev["id"] not in new_posted:
            continue
        t = ev["type"]
        if t == "pr.pushed":
            next_state["head_sha"] = head_sha
        elif t in ("ci.failed", "ci.passed"):
            next_state["ci_conclusion"] = ci_conclusion
            next_state["ci_details_url"] = ci_url
        elif t == "review.requested":
            if ev.get("requested_via") == "team":
                cur = list(next_state["requested_teams"])
                slug = ev.get("team_slug")
                if slug and slug not in cur:
                    cur.append(slug)
                next_state["requested_teams"] = cur
            else:
                cur = list(next_state["requested_users"])
                u = ev.get("requested_user")
                if u and u not in cur:
                    cur.append(u)
                next_state["requested_users"] = cur
        elif t == "review.changes_requested":
            # mark all current cr that match this event's author in id — use full set merge of succeeded
            pass
    # For CR: if any CR event posted ok, union those ids
    ok_cr = set(prev.get("changes_requested_ids") or [])
    for ev in events:
        if ev["id"] in new_posted and ev["type"] == "review.changes_requested":
            # find matching rid from cr_ids by author in summary — use all cr_ids if any CR posted
            ok_cr.update(cr_ids)
    next_state["changes_requested_ids"] = sorted(ok_cr)

write_json(STATE_PATH, next_state)

mode = "dry-run" if DRY_RUN else "live"
print(
    f"tick done mode={mode} baseline={str(baseline).lower()} "
    f"events={len(events)} last_tick={tick_at} "
    f"head={short} ci={ci_conclusion or 'none'} "
    f"users={requested_users} teams_on_pr={requested_teams} watch_teams={sorted(watch_teams)}"
)
if not posted_ok:
    sys.exit(2)
PY
