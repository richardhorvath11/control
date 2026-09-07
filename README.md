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

## Stack assumptions

- **Next.js App Router** + TypeScript + Tailwind CSS
- **Zustand** client store hydrated from `src/lib/seed.json`
- No auth, no live integrations, no database
- Agent delegation simulated with a 3–8s timer; completion increments the Review badge only (no toasts)

## Seeded Monday

Clock: Monday 9:12 AM. Standup 9:30 · Focus 10:00–1:00 · Design review 2:00 · 1:1 Sam 4:00.

Workstreams: Staging credential rotation (human review), Search ranking experiment (paused), On-call runbook rewrite (draft).

## Key routes

| Route | Surface |
|-------|---------|
| `/now` | Morning / Focus / Clear |
| `/workstreams` | List |
| `/workstreams/[id]` | Detail + checkpoint |
| `/review` | Queue + workspace |
| `/agents` | Status board |
| `/source/slack/[id]` | Mocked Slack thread |
| `/source/github/[id]` | Mocked PR + CI + diff |
| `/source/rfc/[id]` | Mocked RFC section |
| `/source/calendar/[id]` | Mocked calendar event |

⌘K opens the launcher (not chat).

## Click-through

1. Land on Now morning — day strip, Resume card, ≤3 needs-you, collapsed FYI.
2. Delegate Priya's question — agent Running, stay on Now; on finish Review badge 2→3, no toast.
3. Resume credential rotation — checkpoint + next step.
4. Start focus — Now quiets; badge may change without interrupting.
5. Open Review — RFC finding, open RFC + PR mocks, Approve/Reject.
6. Approve/edit Slack draft with explicit confirm before "posting".
7. Return to Now — checkpoint updated.

## Explicit cuts

Team, auth, live Slack/GitHub/Calendar, chat-first UI, toasts on agent complete, inbox-shaped Now, agent builder, lorem.
