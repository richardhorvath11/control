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

## Slack E2E harness (real thread reply)

Approve on **Draft Slack reply to Priya** (`rev-slack`) can post a **real** reply into the Control E2E Slack thread via `POST /api/slack/post` using the Slack Web API message-create method.

### Defaults (hardcoded; env can override)

| | |
|--|--|
| Workspace | `connect-8w75152` |
| Channel | `#control-e2e` · `C0BVCSA4T2P` |
| Parent `thread_ts` | `1788808933.776429` |
| Fixture link | https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788808933776429 |

Optional env overrides: `SLACK_E2E_CHANNEL_ID`, `SLACK_E2E_THREAD_TS`.

### Setup

See `.env.local.example` for required keys. File `.env.local` is gitignored.
Restart the Next.js dev server after changing env files.

### Approve path

1. Open **Review** then **Draft Slack reply to Priya**.
2. Click **Approve…** — confirm modal shows the exact draft text.
3. **Cancel / Reject** — no Slack write; item stays pending (or rejected).
4. **Post** — client calls `/api/slack/post` with `{ text, channelId, threadTs }`. On success, Control marks the item approved, appends the reply to the mocked Slack UI, and stores reply ts / permalink on the review item. On missing credential or API error, the modal shows a clear error and does not mark approved.

Successful confirm creates a real thread reply on the Priya fixture message above.

Credentials stay server-side only (API route). No secrets in git.

## Stack assumptions

- **Next.js App Router** + TypeScript + Tailwind CSS
- **Zustand** client store hydrated from `src/lib/seed.json`
- No auth, no live Slack ingestion, no database
- Agent delegation simulated with a 3-8s timer; completion increments the Review badge only (no toasts)
- Slack write for the Priya draft only (confirm-gated E2E harness)

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
| `POST /api/slack/post` | Server-side Slack message create for E2E |

Command palette opens the launcher (not chat).

## Click-through

1. Land on Now morning — day strip, Resume card, needs-you, collapsed FYI.
2. Delegate Priya question — agent Running; on finish Review badge increments, no toast.
3. Resume credential rotation — checkpoint + next step.
4. Start focus — Now quiets; badge may change without interrupting.
5. Open Review — RFC finding, open RFC + PR mocks, Approve/Reject.
6. Approve/edit Slack draft with explicit confirm before posting to the E2E harness.
7. Return to Now — checkpoint updated.

## Explicit cuts

Team, auth, live Slack/GitHub/Calendar ingestion, chat-first UI, toasts on agent complete, inbox-shaped Now, agent builder, lorem, auto-send without confirm, posting outside #control-e2e.
