# GitHub standing watcher (V0.6)

Control holds **no** GitHub token. This host runs `gh` (authenticated) and POSTs canonical events into Control’s durable inbox.

## Watch config

| | |
|--|--|
| Template (committed) | `watch.example.json` |
| Runtime (gitignored) | `.control/watch.json` — created from the example on first tick if missing |

| Field | Default |
|-------|---------|
| `repo` | `richardhorvath11/battle-buddy` |
| `pr` | `32` |
| `workstreamId` | `ws-cred` |
| `slackPrChannels` | multi-channel list (see `watch.example.json`); legacy scalar still loads |
| `slackPrChannelId` | derived first channel (back-compat) |
| `teams` | **`[]` (intentional).** Team/CODEOWNERS `review.requested` is never emitted until operators list 1–3 slugs. |

## One tick

```bash
./scripts/github-watcher-tick.sh
# or dry-run (no Control required):
./scripts/github-watcher-tick.sh --dry-run
```

Env:

| Var | Default | Meaning |
|-----|---------|---------|
| `CONTROL_BASE_URL` | `http://localhost:3000` | Control origin |
| `DRY_RUN=1` | off | Print `would-post` / `skip` / `noop`; do not curl |
| `WATCHER_FORCE_POST=1` | off | First see of a PR posts current snapshot instead of baseline-only |

### Tick steps

1. Ensure `.control/` exists. If `.control/watch.json` is missing, copy from `watch.example.json` (strips `_comment_*`, keeps `teams: []`).
2. Load **follows** from `.control/pr-follows.json` (chip 4). **Purge** any row with `expires_at < now`. Ignore follows whose `repo !== watch.repo`. Never treat `watch.pr` as a follow.
3. Build PR list: **`[watch.pr, ...activeFollowPrs]`** (deduped, same repo only). Empty follows → chip 1 single-PR behavior.
4. For **each** PR via **`gh pr view`**: head SHA, CI rollup, `reviewRequests`, `CHANGES_REQUESTED` reviews.
5. Per-PR snapshot:
   - **Primary** → `.control/github-watcher-state.json`
   - **Follow** → that row’s fields inside `pr-follows.json`
6. **Baseline-on-first-see** per PR: write snapshot, **POST nothing**. Use `--force-post` / `WATCHER_FORCE_POST=1` to post instead.
7. Later sees: diff → canonical `GitHubInboxEvent` payloads → `POST` only **new** events to `${CONTROL_BASE_URL}/api/github/inbox`.
8. Event `workstream_id`: primary → `watch.workstreamId`; follow → follow’s `workstreamId` (ephemeral `ws-review-…`).
9. Quiet **noop** when nothing changed **across all PRs** — update primary `last_tick` only.
10. If Control is unreachable: warn, exit non-zero for failed posts, and **do not fully advance** snapshot markers so the next tick retries.

### Diff → events

| Diff | Event `type` | Notes |
|------|--------------|-------|
| `head_sha` changed | `pr.pushed` | |
| CI → failure-like | `ci.failed` | Any rollup check `FAILURE` / `CANCELLED` / `TIMED_OUT` / … |
| CI → `SUCCESS` (and was not) | `ci.passed` | |
| New user in `reviewRequests` | `review.requested` | `requested_via: "user"`, `requested_user` |
| New team in `reviewRequests` | `review.requested` | **Only if** `team_slug ∈ watch.teams`. With `teams: []`, **never** emit team events (`skip team review.requested …`). |
| New `CHANGES_REQUESTED` review | `review.changes_requested` | Keyed by `author:submittedAt` |

Event shapes match `src/lib/github-inbox.ts` (`GitHubInboxEvent`). Shared cap stays `NEEDS_YOU_EXTERNAL_CAP = 5` inside Control (not enforced by the watcher). Routing / coalesce / checkpoint for followed PRs reuse the existing GitHub inbox path (chips 2–3).

## Primary state (`.control/github-watcher-state.json`)

```json
{
  "last_tick": "2026-09-08T01:30:00.000Z",
  "repo": "richardhorvath11/battle-buddy",
  "pr": 32,
  "workstreamId": "ws-cred",
  "slackPrChannelId": "C0BVCSA4T2P",
  "watch_teams": [],
  "head_sha": "19f610a…",
  "ci_conclusion": "SUCCESS",
  "ci_details_url": "https://github.com/…/actions/runs/…",
  "requested_users": [],
  "requested_teams": [],
  "changes_requested_ids": [],
  "posted_event_ids": ["pr-pushed-32-19f610a"]
}
```

## Follows (chip 4) — `.control/pr-follows.json`

Sibling gitignored file (keeps Slack upsert off the primary snapshot file). Slack inbox **apply** upserts server-side; the watcher only reads/updates snapshots and purges expiry.

```json
{
  "follows": [
    {
      "repo": "richardhorvath11/battle-buddy",
      "pr": 41,
      "source": "slack",
      "slack_event_id": "C0B…_123.456",
      "workstreamId": "ws-review-richardhorvath11-battle-buddy-41",
      "created_at": "ISO",
      "expires_at": "ISO",
      "head_sha": null,
      "ci_conclusion": null,
      "requested_users": [],
      "requested_teams": [],
      "changes_requested_ids": [],
      "posted_event_ids": []
    }
  ]
}
```

| Rule | Locked |
|------|--------|
| **TTL** | **48 hours** from first discover, or from last Slack re-link **refresh** |
| **Cap** | Max **5** active follows; adding a 6th drops the oldest by `expires_at` |
| **Refresh** | New Slack `pr_link` for an already-followed PR extends `expires_at` by another 48h from now |
| **Primary** | `watch.pr` is **never** stored in `follows[]` |
| **Repo** | Same repo only — follow with `repo !== watch.repo` is ignored |
| **How Slack creates** | On successful Slack inbox apply for a non-primary PR, Control upserts a follow (`src/lib/pr-follows.ts`) with the ephemeral workstream id |

Smoke (unit): `npx tsx scripts/smoke-pr-follows.ts`.

## Smoke

```bash
# Quiet ticks (Control optional with --dry-run)
./scripts/github-watcher-tick.sh --dry-run
./scripts/github-watcher-tick.sh --dry-run
# Expect: targets primary (+ follows if any); noop / baseline; last_tick updates
```

## Slack companion

See `scripts/slack-pr-watcher.md` and `scripts/slack-pr-inbox-post.sh`. Control holds no Slack token either.

## Out of chip

Org-wide / multi-repo watch, webhooks-in-Control, fuzzy NLP without URL, Seed/Live (chip 5), infinite follows, raising external Needs-you cap, full checkpoint rewrite, CI↔review coalesce.
