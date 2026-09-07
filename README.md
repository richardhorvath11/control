# Control — V0.5

Dark, desktop-width web prototype of an engineering work control plane. Seeded Monday morning so a tech lead can understand the day, resume a workstream, and make one judgment in under three minutes.

## Run

```bash
cd control
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You land on **Now** in morning mode with the seeded Monday (9:12 AM).

```bash
npm run build   # production build
npm start       # serve production build
```

## Slack E2E (outbox -> Slack MCP)

Approve on **Draft Slack reply to Priya** (`rev-slack`) does **not** call Slack with a bot/user token. Confirm writes a durable outbox record under `.control/outbox/` (gitignored). Grok (or any MCP driver) reads the outbox, posts a thread reply via Slack MCP (`slack_send_message`), then acks the item. No Slack app / `SLACK_BOT_TOKEN` required.

### Defaults (hardcoded; env can override channel/thread only)

| | |
|--|--|
| Workspace | `connect-8w75152` |
| Channel | `#control-e2e` · `C0BVCSA4T2P` |
| Parent `thread_ts` | `1788808933.776429` |
| Fixture link | https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788808933776429 |
| Outbox dir | `.control/outbox/*.json` |

Optional env overrides (no tokens): `SLACK_E2E_CHANNEL_ID`, `SLACK_E2E_THREAD_TS`. See `.env.local.example`.

### E2E path

1. Open **Review** -> **Draft Slack reply to Priya**.
2. Click **Approve…** — confirm modal shows the exact draft text.
3. **Cancel / Reject** — no outbox write; item stays pending (or rejected).
4. **Post** — client `POST /api/slack/outbox` with the draft. On success, Review shows **Queued for Slack (awaiting MCP poster)** (`status: queued`). Fail closed: outbox write error keeps the modal open and Review pending.
5. **Grok / MCP driver** — `GET /api/slack/outbox` (pending) -> `slack_send_message` thread reply -> `POST /api/slack/outbox/:id/ack` with `{ reply_ts?, permalink? }`.
6. Client polls until ack -> marks Review **approved**, appends the reply to the mocked Slack UI, stores permalink. On `POST .../fail`, Review returns to pending.

Legacy `POST /api/slack/post` is soft-disabled (HTTP 410).

### Outbox API contract (Inbox Triage / MCP driver)

**Outbox record** (`.control/outbox/<id>.json`):

```json
{
  "id": "outbox-…",
  "status": "pending",
  "channel_id": "C0BVCSA4T2P",
  "thread_ts": "1788808933.776429",
  "text": "…exact draft…",
  "created_at": "2026-09-07T19:40:00.000Z",
  "review_item_id": "rev-slack",
  "provenance": [/* optional */]
}
```

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/slack/outbox` | — (`?status=pending|posted|failed|all`, default `pending`) | `{ ok, items: SlackOutboxItem[] }` |
| `GET` | `/api/slack/outbox/:id` | — | `{ ok, item }` or 404 |
| `POST` | `/api/slack/outbox` | `{ text, reviewItemId, channelId?, threadTs?, provenance? }` | `201 { ok, item }` |
| `POST` | `/api/slack/outbox/:id/ack` | `{ reply_ts?, permalink? }` | `{ ok, item }` with `status: "posted"` |
| `POST` | `/api/slack/outbox/:id/fail` | `{ error? }` | `{ ok, item }` with `status: "failed"` |

No secrets in git. Credentials (if any) live only with the Slack MCP host, not in Control.


## GitHub ingestion (V0.5 inbox)

Mirror of the Slack outbox pattern, **inverted**: a watcher/agent POSTs canonical events → Control durable inbox → routing updates Attention Items + the watched workstream. Events never render as a chronological GitHub feed.

Control holds **no GitHub token**. Live credentials stay with GitHub MCP / `gh` on the agent host. Seeded Monday still boots offline with an empty inbox.

### Watch config

| | |
|--|--|
| Template (committed) | `watch.example.json` |
| Runtime (gitignored) | `.control/watch.json` — created from the example on first API use if missing |
| Default | `{ "repo": "acme/nightingale", "pr": 1847, "workstreamId": "ws-cred" }` |

### Events in scope

`pr.pushed` · `ci.failed` · `ci.passed` · `review.requested` · `review.changes_requested`

CUT: opened/merged/closed, issues, comment floods, labels, assigns, org-wide watch, webhooks, GitHub App in Control.

### Routing (no feed UI)

| Event | Effect |
|-------|--------|
| `pr.pushed` | Workstream changed + FYI only — Needs-you count unchanged |
| `ci.passed` | Workstream state / FYI |
| `ci.failed` | Needs you (one item) + workstream blocked; Open source → `provenance.url` |
| `review.requested` | Needs you if `action_on_user`, else FYI |
| `review.changes_requested` | Needs you (prefer Now) |

Hard rules: cap GitHub-originated Needs-you at **5**; dedupe by event `id` and by `(type, pr_number, head_sha)`; no toasts; Review badge behavior unchanged.

### Inbox API

Durable files: `.control/github-inbox/<id>.json` (under gitignored `.control/`).

**Event schema** (`GitHubInboxEvent`):

```json
{
  "id": "ci-failed-1847-abc1234",
  "type": "ci.failed",
  "repo": "acme/nightingale",
  "pr_number": 1847,
  "head_sha": "abc1234",
  "summary": "integration-staging failed",
  "occurred_at": "2026-09-07T21:00:00.000Z",
  "provenance": {
    "url": "https://github.com/acme/nightingale/actions/runs/123456",
    "title": "CI · integration-staging",
    "kind": "ci"
  },
  "workstream_id": "ws-cred",
  "action_on_user": true
}
```

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/github/inbox` | — | `{ ok, watch, needsYouCap, githubNeedsYou, items }` |
| `POST` | `/api/github/inbox` | `GitHubInboxEvent` | `{ ok, event, applied, duplicate?, item }` |

Malformed POST → **4xx** and does not write inbox state. Offline seed Needs-you stays at the Monday 2 items until events arrive. Client polls the inbox and merges into the persisted Zustand store. When GitHub Needs-you would exceed 5, older GitHub Needs-you demote to FYI.

See `scripts/github-watcher.md` for the agent sync sketch.

### Smoke `ci.failed`

```bash
curl -sS -X POST http://localhost:3000/api/github/inbox \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "ci-failed-1847-abc1234",
    "type": "ci.failed",
    "repo": "acme/nightingale",
    "pr_number": 1847,
    "head_sha": "abc1234",
    "summary": "integration-staging failed on head abc1234",
    "occurred_at": "2026-09-07T21:00:00.000Z",
    "provenance": {
      "url": "https://github.com/acme/nightingale/actions/runs/123456",
      "title": "CI · integration-staging",
      "kind": "ci"
    },
    "workstream_id": "ws-cred"
  }'
```

### Offline vs live

- **Offline**: empty `.control/github-inbox/`, mocked `/source/github/*` for seed provenance only.
- **Live**: watcher POSTs events; Attention Items carry https `provenance.url` and Open source opens the real GitHub/checks page in a new tab.


## Stack assumptions

- **Next.js App Router** + TypeScript + Tailwind CSS
- **Zustand** client store hydrated from `src/lib/seed.json`
- No auth, no live Slack ingestion, no database, **no GitHub token in Control**
- Agent delegation simulated with a 3-8s timer; completion increments the Review badge only (no toasts)
- Slack write for the Priya draft only (confirm-gated outbox -> MCP)

## Seeded Monday

Clock: Monday 9:12 AM. Standup 9:30 · Focus 10:00-1:00 · Design review 2:00 · 1:1 Sam 4:00.

Workstreams: Staging credential rotation (human review), Search ranking experiment (paused), On-call runbook rewrite (draft).

## Key routes

| Route | Surface |
|-------|---------|
| `/now` | Morning / Focus / Clear |
| `/workstreams` | List |
| `/workstreams/[id]` | Detail + checkpoint |
| `/review` | Queue + workspace |
| `/agents` | Status board |
| `/source/slack/[id]` | Mocked Slack thread (+ harness link) |
| `/source/github/[id]` | Mocked PR + CI + diff |
| `/source/rfc/[id]` | Mocked RFC section |
| `/source/calendar/[id]` | Mocked calendar event |
| `GET/POST /api/slack/outbox` | Durable Slack outbox for MCP poster |
| `GET/POST /api/github/inbox` | Durable GitHub inbox (watcher → Control) |
| `POST /api/slack/outbox/:id/ack` | Mark posted after MCP send |
| `POST /api/slack/outbox/:id/fail` | Mark failed |
| `POST /api/slack/post` | Soft-disabled (410) |

Command palette opens the launcher (not chat).

## Click-through

1. Land on Now morning — day strip, Resume card, needs-you, collapsed FYI.
2. Delegate Priya question — agent Running; on finish Review badge increments, no toast.
3. Resume credential rotation — checkpoint + next step.
4. Start focus — Now quiets; badge may change without interrupting.
5. Open Review — RFC finding, open RFC + PR mocks, Approve/Reject.
6. Approve/edit Slack draft with explicit confirm -> outbox queue -> MCP poster -> ack.
7. Return to Now — checkpoint updated.

## Explicit cuts

Team, auth, live Slack/Calendar ingestion, chat-first UI, toasts on agent complete, inbox-shaped Now / chronological GitHub feed, agent builder, lorem, auto-send without confirm, posting outside #control-e2e, Slack app / bot-token chat.postMessage inside Next, GitHub App / PAT inside Control.
