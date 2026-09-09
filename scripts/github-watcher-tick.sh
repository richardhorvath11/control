#!/usr/bin/env bash
# github-watcher-tick.sh — one standing-watcher tick for Control (V0.6)
#
# Reads .control/watch.json + .control/pr-follows.json, polls primary PR and
# active Slack-discovered follows (same repo only) via `gh`, diffs per-PR
# snapshots, and POSTs only *new* canonical events to
# ${CONTROL_BASE_URL:-http://localhost:3000}/api/github/inbox.
#
# Control holds no GitHub token — credentials stay with `gh` on this host.
#
# Chip 4: follows have a hard 48h TTL (refreshed on Slack re-link), max 5
# active (oldest expires_at dropped). Primary watch.pr is never a follow.
# Empty follows → chip 1 single-PR behavior.
#
# Usage:
#   ./scripts/github-watcher-tick.sh
#   ./scripts/github-watcher-tick.sh --dry-run
#   DRY_RUN=1 ./scripts/github-watcher-tick.sh
#
# Env:
#   CONTROL_BASE_URL   default http://localhost:3000
#   DRY_RUN=1          print would-post / skip; do not curl Control
#   WATCHER_FORCE_POST=1  on first see of a PR, post current snapshot (default: baseline only)
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
      sed -n '2,24p' "$0"
      exit 0
      ;;
  esac
done

CONTROL_DIR="$ROOT/.control"
WATCH_PATH="$CONTROL_DIR/watch.json"
WATCH_EXAMPLE="$ROOT/watch.example.json"
STATE_PATH="$CONTROL_DIR/github-watcher-state.json"
FOLLOWS_PATH="$CONTROL_DIR/pr-follows.json"
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

# --- load watch + follows + previous state, fetch PRs, diff, post ---
export ROOT WATCH_PATH STATE_PATH FOLLOWS_PATH INBOX_URL CONTROL_BASE_URL DRY_RUN FORCE_POST
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
FOLLOWS_PATH = os.environ["FOLLOWS_PATH"]
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
        raise
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
        print(f"would-post {event['type']} id={event['id']} pr={event.get('pr_number')}")
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
            print(f"{label} {event['type']} id={event['id']} pr={event.get('pr_number')}")
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


def uniq(seq: list[str]) -> list[str]:
    seen = set()
    out = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def make_id(*parts: str) -> str:
    raw = "-".join(p for p in parts if p)
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


def parse_iso_ms(iso: str | None) -> float:
    if not iso:
        return 0.0
    try:
        # Support Z and +00:00
        s = iso.replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return 0.0


watch = load_json(WATCH_PATH)
if not isinstance(watch, dict):
    print("error: watch.json must be an object", file=sys.stderr)
    sys.exit(1)

repo = str(watch.get("repo") or "").strip()
primary_pr = watch.get("pr")
primary_ws = str(watch.get("workstreamId") or "").strip() or None
teams_raw = watch.get("teams") if isinstance(watch.get("teams"), list) else []
watch_teams = {str(t).strip() for t in teams_raw if str(t).strip()}
channels = watch.get("slackPrChannels") or []
slack_ch = str(watch.get("slackPrChannelId") or "").strip()
if not slack_ch and isinstance(channels, list) and channels:
    first = channels[0] if isinstance(channels[0], dict) else {}
    slack_ch = str(first.get("id") or "").strip()
slack_channel_count = len(channels) if isinstance(channels, list) and channels else (1 if slack_ch else 0)

if not repo or not isinstance(primary_pr, int):
    print("error: watch.json needs string repo and numeric pr", file=sys.stderr)
    sys.exit(1)

tick_at = now_iso()
now_ms = datetime.now(timezone.utc).timestamp()

# --- load + purge follows ---
follows_doc = load_json(FOLLOWS_PATH, default={"follows": []}) or {"follows": []}
raw_follows = follows_doc.get("follows") if isinstance(follows_doc, dict) else []
if not isinstance(raw_follows, list):
    raw_follows = []

active_follows: list[dict] = []
purged = 0
ignored_repo = 0
for f in raw_follows:
    if not isinstance(f, dict):
        continue
    frepo = str(f.get("repo") or "").strip()
    fpr = f.get("pr")
    if not isinstance(fpr, int):
        continue
    if frepo.lower() != repo.lower():
        ignored_repo += 1
        print(f"ignore follow repo={frepo} pr={fpr} (watch.repo={repo})")
        continue
    if fpr == primary_pr:
        print(f"ignore follow pr={fpr} (primary watch.pr; never poll as follow)")
        continue
    exp = parse_iso_ms(f.get("expires_at"))
    if exp < now_ms:
        purged += 1
        print(f"purge expired follow pr={fpr} expires_at={f.get('expires_at')}")
        continue
    active_follows.append(f)

if purged or ignored_repo or len(active_follows) != len(raw_follows):
    # Persist purged/filtered list (watcher owns snapshot updates too)
    write_json(FOLLOWS_PATH, {"follows": active_follows})

# Build PR list: [watch.pr, ...activeFollowPrs] deduped, same repo only
pr_jobs: list[dict[str, Any]] = [
    {
        "pr": primary_pr,
        "kind": "primary",
        "workstream_id": primary_ws,
        "follow": None,
    }
]
seen_prs = {primary_pr}
for f in active_follows:
    fpr = int(f["pr"])
    if fpr in seen_prs:
        continue
    seen_prs.add(fpr)
    pr_jobs.append(
        {
            "pr": fpr,
            "kind": "follow",
            "workstream_id": str(f.get("workstreamId") or "").strip() or None,
            "follow": f,
        }
    )

print(
    f"tick targets repo={repo} prs={[j['pr'] for j in pr_jobs]} "
    f"(primary={primary_pr}, follows={len(active_follows)})"
)

_loaded_primary = load_json(STATE_PATH, default=None)
prev_primary: dict = _loaded_primary if isinstance(_loaded_primary, dict) else {}

total_events = 0
any_posted_fail = False
any_activity = False  # any non-baseline event across all PRs
follow_updates: dict[int, dict] = {}  # pr -> updated follow snapshot
primary_next_state: dict[str, Any] = {
    "last_tick": tick_at,
    "repo": repo,
    "pr": primary_pr,
    "workstreamId": primary_ws,
    "slackPrChannelId": slack_ch,
    "watch_teams": sorted(watch_teams),
    "head_sha": (prev_primary or {}).get("head_sha", ""),
    "ci_conclusion": (prev_primary or {}).get("ci_conclusion"),
    "ci_details_url": (prev_primary or {}).get("ci_details_url"),
    "requested_users": list((prev_primary or {}).get("requested_users") or []),
    "requested_teams": list((prev_primary or {}).get("requested_teams") or []),
    "changes_requested_ids": list((prev_primary or {}).get("changes_requested_ids") or []),
    "posted_event_ids": list((prev_primary or {}).get("posted_event_ids") or []),
}
primary_short = "n/a"
primary_ci = (prev_primary or {}).get("ci_conclusion")
primary_users: list[str] = list((prev_primary or {}).get("requested_users") or [])
primary_teams: list[str] = list((prev_primary or {}).get("requested_teams") or [])

for job in pr_jobs:
    pr = int(job["pr"])
    workstream_id = job["workstream_id"]
    is_primary = job["kind"] == "primary"
    follow = job["follow"]

    # Per-PR previous snapshot + baseline-on-first-see
    if is_primary:
        # Chip 1: first tick with no state file → baseline (POST nothing)
        state_exists = os.path.isfile(STATE_PATH)
        prev = prev_primary if state_exists else {}
        baseline = (not state_exists) and not FORCE_POST
    else:
        assert follow is not None
        has_seen = bool(
            follow.get("head_sha")
            or follow.get("ci_conclusion")
            or follow.get("posted_event_ids")
            or follow.get("requested_users")
            or follow.get("requested_teams")
            or follow.get("changes_requested_ids")
        )
        baseline = (not has_seen) and not FORCE_POST
        prev = {
            "head_sha": follow.get("head_sha") or "",
            "ci_conclusion": follow.get("ci_conclusion"),
            "requested_users": list(follow.get("requested_users") or []),
            "requested_teams": list(follow.get("requested_teams") or []),
            "changes_requested_ids": list(follow.get("changes_requested_ids") or []),
            "posted_event_ids": list(follow.get("posted_event_ids") or []),
        }

    try:
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
    except subprocess.CalledProcessError:
        print(f"warn: skip pr={pr} (gh failed); continuing other targets", file=sys.stderr)
        if is_primary:
            sys.exit(1)
        continue

    head_sha = pr_data.get("headRefOid") or ""
    pr_title = pr_data.get("title") or f"{repo}#{pr}"
    pr_url = pr_data.get("url") or f"https://github.com/{repo}/pull/{pr}"
    ci_conclusion, ci_url, ci_name = aggregate_ci(pr_data.get("statusCheckRollup") or [])

    requested_users: list[str] = []
    requested_teams: list[str] = []
    for rr in pr_data.get("reviewRequests") or []:
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

    prev_sha = prev.get("head_sha") or ""
    prev_ci = prev.get("ci_conclusion")
    prev_users = set(prev.get("requested_users") or [])
    prev_teams = set(prev.get("requested_teams") or [])
    prev_cr = set(prev.get("changes_requested_ids") or [])
    posted_ids = list(prev.get("posted_event_ids") or [])

    events: list[dict] = []

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

        for team in requested_teams:
            if team not in watch_teams:
                print(
                    f"skip team review.requested team_slug={team} pr={pr} "
                    f"(not in watch.teams={sorted(watch_teams)})"
                )
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
        print(f"baseline: seeding state without POSTs (first see) pr={pr} kind={job['kind']}")
        for team in requested_teams:
            if team not in watch_teams:
                print(
                    f"skip team review.requested team_slug={team} pr={pr} "
                    f"(not in watch.teams={sorted(watch_teams)})"
                )

    clean_events = [{k: v for k, v in ev.items() if v is not None} for ev in events]
    events = clean_events
    total_events += len(events)
    if events:
        any_activity = True

    posted_ok = True
    new_posted: list[str] = []
    if not events and not baseline:
        print(f"noop: no changes pr={pr}")
    else:
        for ev in events:
            status, _ = post_event(ev)
            if status in ("posted", "duplicate", "dry-run"):
                new_posted.append(ev["id"])
            else:
                posted_ok = False
                any_posted_fail = True

    # Snapshot advance for this PR
    next_snap = {
        "head_sha": head_sha,
        "ci_conclusion": ci_conclusion,
        "ci_details_url": ci_url,
        "requested_users": requested_users,
        "requested_teams": requested_teams,
        "changes_requested_ids": cr_ids,
        "posted_event_ids": uniq(posted_ids + new_posted)[-200:],
    }

    if not posted_ok and not baseline:
        print(
            f"warn: one or more posts failed for pr={pr}; snapshot markers not fully advanced",
            file=sys.stderr,
        )
        next_snap["head_sha"] = prev.get("head_sha", "")
        next_snap["ci_conclusion"] = prev.get("ci_conclusion")
        next_snap["requested_users"] = list(prev.get("requested_users") or [])
        next_snap["requested_teams"] = list(prev.get("requested_teams") or [])
        next_snap["changes_requested_ids"] = list(prev.get("changes_requested_ids") or [])
        for ev in events:
            if ev["id"] not in new_posted:
                continue
            t = ev["type"]
            if t == "pr.pushed":
                next_snap["head_sha"] = head_sha
            elif t in ("ci.failed", "ci.passed"):
                next_snap["ci_conclusion"] = ci_conclusion
                next_snap["ci_details_url"] = ci_url
            elif t == "review.requested":
                if ev.get("requested_via") == "team":
                    cur = list(next_snap["requested_teams"])
                    slug = ev.get("team_slug")
                    if slug and slug not in cur:
                        cur.append(slug)
                    next_snap["requested_teams"] = cur
                else:
                    cur = list(next_snap["requested_users"])
                    u = ev.get("requested_user")
                    if u and u not in cur:
                        cur.append(u)
                    next_snap["requested_users"] = cur
        ok_cr = set(prev.get("changes_requested_ids") or [])
        for ev in events:
            if ev["id"] in new_posted and ev["type"] == "review.changes_requested":
                ok_cr.update(cr_ids)
        next_snap["changes_requested_ids"] = sorted(ok_cr)

    if is_primary:
        next_state: dict[str, Any] = {
            "last_tick": tick_at,
            "repo": repo,
            "pr": primary_pr,
            "workstreamId": primary_ws,
            "slackPrChannelId": slack_ch,
            "watch_teams": sorted(watch_teams),
            **next_snap,
        }
        # Defer write until end so last_tick is always set even for follow-only activity
        primary_next_state = next_state
        primary_short = short
        primary_ci = ci_conclusion
        primary_users = requested_users
        primary_teams = requested_teams
    else:
        assert follow is not None
        updated = dict(follow)
        updated["head_sha"] = next_snap["head_sha"] or None
        updated["ci_conclusion"] = next_snap["ci_conclusion"]
        updated["requested_users"] = next_snap["requested_users"]
        updated["requested_teams"] = next_snap["requested_teams"]
        updated["changes_requested_ids"] = next_snap["changes_requested_ids"]
        updated["posted_event_ids"] = next_snap["posted_event_ids"]
        follow_updates[pr] = updated

# --- write primary state (always update last_tick) ---
# Quiet noop still updates last_tick only when nothing new across all PRs
if not any_activity:
    print("noop: no changes across all PRs (last_tick only)")

write_json(STATE_PATH, primary_next_state)

# Persist follow snapshots (purged list + updated markers)
out_follows = []
for f in active_follows:
    fpr = int(f["pr"])
    if fpr in follow_updates:
        out_follows.append(follow_updates[fpr])
    else:
        out_follows.append(f)
write_json(FOLLOWS_PATH, {"follows": out_follows})

mode = "dry-run" if DRY_RUN else "live"
print(
    f"tick done mode={mode} events={total_events} last_tick={tick_at} "
    f"primary_head={primary_short} primary_ci={primary_ci or 'none'} "
    f"follows_active={len(active_follows)} "
    f"users={primary_users} teams_on_pr={primary_teams} watch_teams={sorted(watch_teams)}"
)
if any_posted_fail:
    sys.exit(2)
PY
