#!/usr/bin/env bash
# github-pr-snapshot.sh — thin gh helper: write one Live Review PR snapshot
#
# Control holds no GitHub token. Operator runs this (or github-watcher-tick)
# so Review can show title / CI / changed-files via GET /api/github/snapshot.
#
# Usage:
#   ./scripts/github-pr-snapshot.sh --repo owner/name --pr 32
#   ./scripts/github-pr-snapshot.sh          # uses .control/watch.json
#
# Writes: .control/pr-snapshots/{owner}-{repo}-{pr}.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO=""
PR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --pr) PR="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) shift ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}
need_cmd gh
need_cmd python3

CONTROL_DIR="$ROOT/.control"
WATCH_PATH="$CONTROL_DIR/watch.json"
SNAP_DIR="$CONTROL_DIR/pr-snapshots"
mkdir -p "$SNAP_DIR"

if [[ -z "$REPO" || -z "$PR" ]]; then
  if [[ -f "$WATCH_PATH" ]]; then
    REPO="$(python3 -c 'import json,sys; w=json.load(open(sys.argv[1])); print((w.get("repo") or "").strip())' "$WATCH_PATH")"
    PR="$(python3 -c 'import json,sys; w=json.load(open(sys.argv[1])); print(w.get("pr") or "")' "$WATCH_PATH")"
  fi
fi

if [[ -z "$REPO" || -z "$PR" ]]; then
  echo "error: need --repo owner/name --pr N (or watch.json with repo+pr)" >&2
  exit 1
fi

export ROOT REPO PR SNAP_DIR
python3 - <<'PY'
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

ROOT = os.environ["ROOT"]
REPO = os.environ["REPO"].strip()
PR = int(str(os.environ["PR"]).strip())
SNAP_DIR = os.environ["SNAP_DIR"]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def gh_json(args: list[str]) -> Any:
    cmd = ["gh", *args]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.PIPE, text=True)
    except subprocess.CalledProcessError as e:
        print(f"error: gh failed: {' '.join(cmd)}\n{e.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(out)


def aggregate_ci(rollup: list | None) -> tuple[str, str | None]:
    if not rollup:
        return "UNKNOWN", None
    fail_like = {"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}
    pending_status = {"IN_PROGRESS", "QUEUED", "PENDING", "REQUESTED", "WAITING"}
    best_fail_url = None
    best_ok_url = None
    any_pending = False
    any_fail = False
    any_success = False
    for c in rollup:
        if not isinstance(c, dict):
            continue
        status = (c.get("status") or "").upper()
        conclusion = (c.get("conclusion") or "").upper() or None
        url = c.get("detailsUrl") or c.get("details_url")
        if status in pending_status or status == "IN_PROGRESS":
            any_pending = True
            continue
        if conclusion in fail_like:
            any_fail = True
            if best_fail_url is None:
                best_fail_url = url
        elif conclusion in ("SUCCESS", "NEUTRAL", "SKIPPED"):
            any_success = True
            if best_ok_url is None:
                best_ok_url = url
        elif conclusion is None and status == "COMPLETED":
            any_success = True
            if best_ok_url is None:
                best_ok_url = url
    if any_fail:
        return "FAILURE", best_fail_url
    if any_pending:
        return "PENDING", None
    if any_success:
        return "SUCCESS", best_ok_url
    return "UNKNOWN", None


def file_status_from_rest(repo: str, pr: int) -> list[dict[str, str]]:
    try:
        out = subprocess.check_output(
            ["gh", "api", f"repos/{repo}/pulls/{pr}/files", "--paginate"],
            stderr=subprocess.PIPE,
            text=True,
        )
        files = json.loads(out)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return []
    if not isinstance(files, list):
        return []
    rows: list[dict[str, str]] = []
    for f in files:
        if not isinstance(f, dict):
            continue
        p = str(f.get("filename") or "").strip()
        if not p:
            continue
        st = str(f.get("status") or "modified").lower()
        if st == "renamed":
            st = "modified"
        elif st not in ("added", "removed", "modified"):
            st = "modified"
        rows.append({"path": p, "status": st})
    return rows


def file_status_from_view(pr_data: dict) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for f in pr_data.get("files") or []:
        if not isinstance(f, dict):
            continue
        p = str(f.get("path") or "").strip()
        if not p:
            continue
        add = int(f.get("additions") or 0)
        dele = int(f.get("deletions") or 0)
        if add > 0 and dele == 0:
            st = "added"
        elif dele > 0 and add == 0:
            st = "removed"
        else:
            st = "modified"
        rows.append({"path": p, "status": st})
    return rows


pr_data = gh_json(
    [
        "pr",
        "view",
        str(PR),
        "--repo",
        REPO,
        "--json",
        "headRefOid,title,url,statusCheckRollup,reviewRequests,files",
    ]
)

head_sha = pr_data.get("headRefOid") or ""
title = pr_data.get("title") or f"{REPO}#{PR}"
url = pr_data.get("url") or f"https://github.com/{REPO}/pull/{PR}"
ci_conclusion, ci_url = aggregate_ci(pr_data.get("statusCheckRollup") or [])
if not ci_url:
    ci_url = f"{url}/checks"

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

files = file_status_from_rest(REPO, PR)
if not files:
    files = file_status_from_view(pr_data)
files = files[:200]

owner, _, name = REPO.partition("/")
safe_owner = (owner or "owner").replace("/", "-")
safe_name = (name or "repo").replace("/", "-")
out_path = os.path.join(SNAP_DIR, f"{safe_owner}-{safe_name}-{PR}.json")

snap = {
    "repo": REPO.lower(),
    "pr": PR,
    "title": title,
    "url": url,
    "head_sha": head_sha,
    "ci": {"conclusion": ci_conclusion, "url": ci_url},
    "files": files,
    "requested_reviewers": {
        "users": list(dict.fromkeys(requested_users)),
        "teams": list(dict.fromkeys(requested_teams)),
    },
    "updated_at": now_iso(),
}

tmp = out_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(snap, f, indent=2)
    f.write("\n")
os.replace(tmp, out_path)

rel = os.path.relpath(out_path, ROOT)
print(
    f"wrote {rel} title={title!r} ci={ci_conclusion} "
    f"files={len(files)} head={head_sha[:7] or 'n/a'}"
)
PY
