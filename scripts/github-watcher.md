# GitHub / Slack watcher stub (MCP → Control inboxes)

Control holds **no** GitHub or Slack token. A watcher agent polls a watched PR and one Slack channel, then POSTs canonical events into Control.

## Watch config

- Committed example: `watch.example.json`
- Runtime (gitignored): `.control/watch.json`

| Field | Default |
|-------|---------|
| `repo` | `richardhorvath11/battle-buddy` |
| `pr` | `32` |
| `workstreamId` | `ws-cred` |
| `slackPrChannelId` | `C0BVCSA4T2P` |
| `slackPrChannelName` | `#control-e2e` |
| `teams` | `[]` (placeholder — add team slugs to accept team `review.requested`) |

## Event types (GitHub)

- `pr.pushed`
- `ci.failed` / `ci.passed`
- `review.requested` (`requested_via: "user"|"team"`, `team_slug?`)
  - Personal/user: `action_on_user` omitted ⇒ Needs-you (default true); `false` ⇒ FYI
  - Team: Needs-you only if `team_slug` ∈ `watch.teams`
- `review.changes_requested`

## Slack

- `POST /api/slack/inbox` with `type: "pr_link"` for messages in `slackPrChannelId` that contain a PR URL for `watch.repo`.

## Flow

1. Read `.control/watch.json`.
2. Use GitHub/Slack MCP with credentials on the **agent host** (never in Control).
3. `POST /api/github/inbox` or `POST /api/slack/inbox`.
4. Control persists under `.control/github-inbox/` or `.control/slack-inbox/` and routes into Needs-you.
5. Idempotent on event `id` (+ type-specific dedupe keys).
6. External Needs-you capped at **`NEEDS_YOU_EXTERNAL_CAP = 5`**; oldest github|slack demote to FYI attention (provenance / Open source kept). Seed Monday items untouched.

No second UI — events never render as a feed. Debug: `GET /api/github/inbox`, `GET /api/slack/inbox`.
