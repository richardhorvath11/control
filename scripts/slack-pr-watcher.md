# Slack PR-link standing watcher (V0.7 chip 2 — multi-channel)

Control holds **no Slack token**. A host agent with **Slack MCP** reads **every** configured Slack PR channel, extracts GitHub PR URLs for `watch.repo`, and POSTs canonical `pr_link` events into Control via the helper script (plain `curl` — no Slack credentials in the repo or in Control).

## Watch fields

From `.control/watch.json` (see `watch.example.json`):

| Field | Notes |
|-------|-------|
| `repo` | `owner/name` — only PR URLs for this repo apply |
| `pr` | Primary watched PR (GitHub ticks); Slack may surface **any** PR URL for `repo` |
| `slackPrChannels` | **Required list** `[{ "id": "C…", "name": "#pr-reviews" }, …]` — poll **every** entry |
| `slackPrChannelIds` | Alternate write form: `string[]` (names optional) |
| Legacy `slackPrChannelId` / `slackPrChannelName` | Migrates to a **one-element** `slackPrChannels` list on read |

`slackPrChannelId` / `slackPrChannelName` on the normalized WatchConfig are **derived** (first channel) for back-compat.

## Cursor state (per channel)

Track last seen message `ts` **per channel id** in `.control/slack-watcher-state.json` (gitignored) — **not** one global cursor:

```json
{
  "C0BVCSA4T2P": "1788902600.900034",
  "C0BINFRA000": "1788900000.100001"
}
```

On each tick, for each `watch.slackPrChannels[].id`, read that channel’s cursor, fetch newer messages, then write back that channel’s latest `ts`.

## Agent loop (Slack MCP → helper)

1. Read `.control/watch.json` → `slackPrChannels` (or migrate legacy scalar), `repo`.
2. Load `.control/slack-watcher-state.json` (default `{}`).
3. **For each** channel in `slackPrChannels`:
   - Via Slack MCP, list recent messages (and threads if desired) newer than `state[channel.id]`.
   - For each message with a **new** `ts`:
     - Parse `https://github.com/{owner}/{repo}/pull/{N}` from text / attachments.
     - Keep only URLs where `{owner}/{repo}` equals `watch.repo` (case-insensitive).
     - Resolve a permalink (MCP `chat.getPermalink` or construct from channel + ts).
     - Call the helper (below).
   - Update `state[channel.id]` to the newest processed `ts`.
4. Write state atomically. Quiet when nothing new — do not POST.

```bash
./scripts/slack-pr-inbox-post.sh \
  "$channel_id" \
  "$message_ts" \
  "$permalink" \
  "$text" \
  "$repo" \
  "$pr_number"
```

5. Helper curls `POST ${CONTROL_BASE_URL:-http://localhost:3000}/api/slack/inbox` with a `SlackInboxEvent` (`type: "pr_link"`). Idempotent on `id` = `{channel_id}_{message_ts}`.

### Dry-run

```bash
DRY_RUN=1 ./scripts/slack-pr-inbox-post.sh \
  C0BVCSA4T2P 1788810000.100001 \
  'https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788810000100001' \
  'Please review https://github.com/richardhorvath11/battle-buddy/pull/32' \
  richardhorvath11/battle-buddy 32
```

### Missing Control

If Control is down, the helper prints a warning, echoes the payload, and exits `2` — safe to retry later. No Slack token is ever written to disk by these scripts.

## Event shape

Matches `src/lib/slack-inbox.ts` (`SlackInboxEvent`). Provenance may be omitted — Control fills dual slack+github provenance. Channel must be in `watch.slackPrChannels` or Control stores `applied: false` (ignored). Messages **without** a `watch.repo` PR URL stay ignored. **No org-wide Slack.**

## Chip 4 — follows from Slack apply

When Slack inbox **applies** a `pr_link` for `watch.repo` with `pr_number ≠ watch.pr`:

1. Control creates/updates the **ephemeral** workstream (`ws-review-{repo}-{N}`) as before.
2. **Server-side**, Control also **upserts** a follow into `.control/pr-follows.json` (see `src/lib/pr-follows.ts` + `scripts/github-watcher.md`):
   - **TTL 48h** from now (new or refresh).
   - **Cap 5** active follows (oldest `expires_at` dropped when adding a 6th).
   - **Primary `watch.pr` is never** stored as a follow.
3. The GitHub watcher tick then polls **primary + active follows** (same repo only) and POSTs CI/review signals into `/api/github/inbox` with the follow’s ephemeral `workstreamId`.

No NLP without a URL. No org-wide. Wrong-repo URLs stay ignored (`applied: false`).

## Cuts

Org-wide Slack, channels without PR-URL filter, NLP without URL, Slack app / bot token inside Next, webhooks-in-Control.
