# Slack PR-link standing watcher (V0.6)

Control holds **no Slack token**. A host agent with **Slack MCP** reads one watched channel, extracts GitHub PR URLs for `watch.repo`, and POSTs canonical `pr_link` events into Control via the helper script (plain `curl` — no Slack credentials in the repo or in Control).

## Watch fields

From `.control/watch.json` (see `watch.example.json`):

| Field | Default |
|-------|---------|
| `repo` | `richardhorvath11/battle-buddy` |
| `pr` | `32` (watched PR for GitHub ticks; Slack may surface **any** PR URL for `repo`) |
| `slackPrChannelId` | `C0BVCSA4T2P` |
| `slackPrChannelName` | `#control-e2e` |

## Agent loop (Slack MCP → helper)

1. Read `.control/watch.json` → `slackPrChannelId`, `repo`.
2. Via Slack MCP, list recent messages in that channel (and threads if desired).
3. For each message with a **new** `ts` (track locally, e.g. `.control/slack-watcher-state.json` — gitignored):
   - Parse `https://github.com/{owner}/{repo}/pull/{N}` from text / attachments.
   - Keep only URLs where `{owner}/{repo}` equals `watch.repo` (case-insensitive).
   - Resolve a permalink (MCP `chat.getPermalink` or construct from channel + ts).
4. For each new match, call the helper:

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
6. Quiet when nothing new — do not POST.

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

Matches `src/lib/slack-inbox.ts` (`SlackInboxEvent`). Provenance may be omitted — Control fills dual slack+github provenance. Channel must equal `watch.slackPrChannelId` or Control stores `applied: false` (ignored).

## Cuts

Multi-channel watch, NLP without URL, Slack app / bot token inside Next, posting outside the configured channel.
