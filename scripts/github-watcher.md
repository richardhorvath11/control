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
| `slackPrChannelId` | `C0BVCSA4T2P` |
| `slackPrChannelName` | `#control-e2e` |
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
| `WATCHER_FORCE_POST=1` | off | First tick posts current snapshot instead of baseline-only |

### Tick steps

1. Ensure `.control/` exists. If `.control/watch.json` is missing, copy from `watch.example.json` (strips `_comment_*`, keeps `teams: []`).
2. Via **`gh pr view`**: head SHA (`headRefOid`), CI rollup conclusion, `reviewRequests` (users + teams), `reviews` with `CHANGES_REQUESTED`.
3. Load `.control/github-watcher-state.json` (if any).
4. **First tick (no state):** write a **baseline** snapshot and **POST nothing** (avoids flooding Control). Use `--force-post` / `WATCHER_FORCE_POST=1` to post the current snapshot instead.
5. Later ticks: diff against state; build canonical `GitHubInboxEvent` payloads; `POST` only **new** events to `${CONTROL_BASE_URL}/api/github/inbox`.
6. Quiet **noop** when nothing changed — update `last_tick` only.
7. If Control is unreachable: print a warning, exit non-zero for failed posts, and **do not fully advance** snapshot markers so the next tick retries.

### Diff → events

| Diff | Event `type` | Notes |
|------|--------------|-------|
| `head_sha` changed | `pr.pushed` | |
| CI → failure-like | `ci.failed` | Any rollup check `FAILURE` / `CANCELLED` / `TIMED_OUT` / … |
| CI → `SUCCESS` (and was not) | `ci.passed` | |
| New user in `reviewRequests` | `review.requested` | `requested_via: "user"`, `requested_user` |
| New team in `reviewRequests` | `review.requested` | **Only if** `team_slug ∈ watch.teams`. With `teams: []`, **never** emit team events (`skip team review.requested …`). |
| New `CHANGES_REQUESTED` review | `review.changes_requested` | Keyed by `author:submittedAt` |

Event shapes match `src/lib/github-inbox.ts` (`GitHubInboxEvent`). Shared cap stays `NEEDS_YOU_EXTERNAL_CAP = 5` inside Control (not enforced by the watcher).

## State schema (`.control/github-watcher-state.json`)

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

Enough fields to suppress duplicate POSTs across ticks. File is under gitignored `.control/`.

## Smoke

```bash
# Two quiet ticks (Control optional with --dry-run)
./scripts/github-watcher-tick.sh --dry-run
./scripts/github-watcher-tick.sh --dry-run
# Expect: first = baseline (or noop after), second = noop: no changes; last_tick updates
```

## Slack companion

See `scripts/slack-pr-watcher.md` and `scripts/slack-pr-inbox-post.sh`. Control holds no Slack token either.

## Out of chip

Checkpoint rewrite, coalesce, multi-PR follow, Seed/Live toggle, second UI, webhooks-in-Control.
