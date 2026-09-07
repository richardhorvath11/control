# Control — V0

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

## Stack assumptions

- **Next.js App Router** + TypeScript + Tailwind CSS
- **Zustand** client store hydrated from `src/lib/seed.json`
- No auth, no live Slack ingestion, no database
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

Team, auth, live Slack/GitHub/Calendar ingestion, chat-first UI, toasts on agent complete, inbox-shaped Now, agent builder, lorem, auto-send without confirm, posting outside #control-e2e, Slack app / bot-token chat.postMessage inside Next.
