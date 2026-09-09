# Slack standing watcher (V0.8 chip 2–3 — broad slackWatch + actionability)

Control holds **no Slack token**. A host agent with **Slack MCP** reads configured `slackWatch` surfaces (and optionally DMs/MPIMs involving `myUserId`), then POSTs into Control:

- **PR URL** on a surface with `prLinks: true` → `type: "pr_link"` (review-ask Needs-you / coalesce — unchanged)
- **Otherwise** → `type: "message"` (durable store; chip 3 deterministic Needs-you when actionable)

## Watch fields

From `.control/watch.json` (see `watch.example.json`) — **`slackWatch` only** (no `slackPrChannels`):

| Field | Notes |
|-------|-------|
| `repo` | `owner/name` — only PR URLs for this repo apply as `pr_link` |
| `pr` | Primary watched PR (GitHub ticks) |
| `slackWatch.surfaces` | `[{ id, name?, kind: channel\|im\|mpim, prLinks }]` — poll each |
| `slackWatch.includeDms` | When true, fetch IMs involving `myUserId` via Slack MCP |
| `slackWatch.includeMpims` | When true, fetch MPIMs involving `myUserId` |
| `slackWatch.myUserId` | **Required** when either `include*` is true — else **validation error** / watcher **fail-closed** |

`isWatchConfigured`: non-empty `repo` **and** (`surfaces.length >= 1` **or** `includeDms` **or** `includeMpims`).

### One-shot migrate

Loading `slackPrChannels` / `slackPrChannelIds` / scalar `slackPrChannelId`+`Name` rewrites to `slackWatch.surfaces` with `kind: "channel"`, `prLinks: true`, **deletes** old keys, and persists. **No legacy keep-alive.**

### `prLinks: false`

Surface still accepts `message` events. `pr_link` routing is **ignored** (`applied: false`, reason documents `prLinks:false`).

## Cursor state (per surface)

Track last seen message `ts` **per surface id** in `.control/slack-watcher-state.json` (gitignored, server-internal):

```json
{
  "C0BVCSA4T2P": "1788902600.900034",
  "C0BINFRA000": "1788900000.100001",
  "D0ABCDEF": "1788901000.200002"
}
```

## Agent loop (Slack MCP → helper)

1. Read `.control/watch.json` → `slackWatch`, `repo`. If `includeDms`/`includeMpims` without `myUserId` → **fail-closed** (do not poll DMs/MPIMs; log error).
2. Load `.control/slack-watcher-state.json` (default `{}`).
3. **For each** `slackWatch.surfaces[]`:
   - Via Slack MCP, list recent messages newer than `state[surface.id]`.
   - For each new `ts`:
     - If text has `https://github.com/{owner}/{repo}/pull/{N}` matching `watch.repo` **and** `surface.prLinks === true` → POST `pr_link` via helper.
     - Else → POST `message` (channel_kind = surface.kind).
   - Update cursor.
4. If `includeDms` / `includeMpims`: list IMs/MPIMs involving `myUserId` via Slack MCP; same POST rules (`pr_link` only if that conversation is also a surface with `prLinks: true`; otherwise `message`).
5. Write state atomically. Quiet when nothing new.

### PR-link helper

```bash
./scripts/slack-pr-inbox-post.sh \
  "$channel_id" \
  "$message_ts" \
  "$permalink" \
  "$text" \
  "$repo" \
  "$pr_number"
```

Curls `POST ${CONTROL_BASE_URL:-http://localhost:3000}/api/slack/inbox` with `type: "pr_link"`.

### Message POST (example)

```bash
curl -sS -X POST "${CONTROL_BASE_URL:-http://localhost:3000}/api/slack/inbox" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "C0BVCSA4T2P_1788810000.100001",
    "type": "message",
    "channel_id": "C0BVCSA4T2P",
    "channel_kind": "channel",
    "message_ts": "1788810000.100001",
    "permalink": "https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788810000100001",
    "text_excerpt": "standup notes — no PR",
    "occurred_at": "2026-09-07T22:05:00.000Z",
    "user_id": "U123",
    "mentions_me": false,
    "thread_participated": false
  }'
```

Allowed channel → **201** stored. Chip 3 rules (first match): DM/MPIM → Needs-you; `@me` / `mentions_me` → Needs-you; `thread_ts` + `thread_participated:true` → Needs-you; short IM `?` → Needs-you; else ignore (no FYI). Cap `NEEDS_YOU_EXTERNAL_CAP=5`. Unknown channel → ignored / 4xx. Dedupe `(channel_id, message_ts)`.

## Watcher status (V0.8 chip 5)

After each poll tick, PUT status (HTTP only — never open `.control/`):

```bash
curl -sS -X PUT "${CONTROL_BASE_URL:-http://localhost:3000}/api/watchers/status" \
  -H 'Content-Type: application/json' \
  -d '{"id":"slack-watch","status":"ticking","last_action":"polled surfaces"}'
```

On quiet/idle: `status: "idle"`. On error: `status: "error"`. Agents board reads `GET /api/watchers/status`.

## Mute (chip 5)

Muted thread roots skip Needs-you on `message` ingest (`POST /api/slack/mutes`). Key = `channel_id|thread_root_ts`.

## Cuts

Auto-send · urgency ML · org-wide · FYI firehose · inventing thread history · Slack token / skill pack in Control · exposing raw `.control/` to workers.
