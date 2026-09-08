# Control — V0.6 (standing watchers)

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


## Indirect review inboxes (V0.5+)

Two inbound paths into **Needs-you** (not Review): (1) GitHub team/CODEOWNERS `review.requested` via `watch.teams`; (2) Slack one-channel PR-link watch → `/api/slack/inbox`. Shared cap `NEEDS_YOU_EXTERNAL_CAP = 5`. Same-repo PR Slack ask + GitHub `review.requested` **coalesce** into one Attention Item with dual provenance.

### GitHub ingestion

Mirror of the Slack outbox pattern, **inverted**: a watcher/agent POSTs canonical events → Control durable inbox → routing updates Attention Items + the watched workstream. Events never render as a chronological GitHub feed.

Control holds **no GitHub token**. Live credentials stay with GitHub MCP / `gh` on the agent host. Seeded Monday still boots offline with an empty inbox.

### Watch config

| | |
|--|--|
| Template (committed) | `watch.example.json` |
| Runtime (gitignored) | `.control/watch.json` — created from the example on first API use if missing |

Default fields:

```json
{
  "repo": "richardhorvath11/battle-buddy",
  "pr": 32,
  "workstreamId": "ws-cred",
  "slackPrChannelId": "C0BVCSA4T2P",
  "slackPrChannelName": "#control-e2e",
  "teams": []
}
```

- `teams`: **intentional default `[]`**. Team/CODEOWNERS `review.requested` (`requested_via: "team"`) is a **no-op** until operators set **1–3** team slugs (e.g. in `.control/watch.json`). Do **not** seed `platform` (or any slug) in the default. **E2E/QA must configure `watch.teams` before B-1** (team-review scenarios); injects with unknown `team_slug` return `applied: false` and create no Needs-you.
- `slackPrChannelId` / `slackPrChannelName`: single Slack channel for PR-link Needs-you.

### Events in scope

`pr.pushed` · `ci.failed` · `ci.passed` · `review.requested` · `review.changes_requested`

CUT: opened/merged/closed, issues, comment floods, labels, assigns, org-wide watch, webhooks, GitHub App in Control.

### Routing (no feed UI)

| Event | Effect |
|-------|--------|
| `pr.pushed` | Workstream changed + FYI only — Needs-you count unchanged |
| `ci.passed` | Workstream state / FYI |
| `ci.failed` | Needs you (one item) + workstream blocked; Open source → `provenance.url` |
| `review.requested` (user) | **Default Needs-you** when `action_on_user` is omitted (`requested_via=user` / personal path ⇒ `action_on_user` defaults **true**). Explicit `action_on_user: false` → FYI |
| `review.requested` (team) | Needs you only if `team_slug` in `watch.teams`; else ignored (`applied: false`). Team path ignores `action_on_user`. |
| `review.changes_requested` | Needs you (prefer Now) |

Hard rules: shared external Needs-you cap **`NEEDS_YOU_EXTERNAL_CAP = 5`** (alias `GITHUB_NEEDS_YOU_CAP`); applies to origin `github`|`slack`|`external` — seed Monday Needs-you are not demoted. When over cap, oldest external Needs-you demote to **FYI attention** (`routing: "fyi"`) and **keep provenance / Open source** (incl. Slack dual links) — they are not collapsed to plain text. Dedupe by event `id`; `review.requested` also by `(review.requested, repo, pr_number, team_or_user)`; otherwise `(type, pr_number, head_sha)`. Team `review.requested` requires `team_slug` in `watch.teams`. No toasts; Review badge unchanged.

**coalesce dual asks:** Slack `pr_link` + GitHub `review.requested` (user or allowed team) for the same `normalize(repo)#pr` merge into **one** Needs-you (`ext-att-review-{owner}-{repo}-{pr}`, origin `external`, dual provenance). Cap counts it once. Inbox event rows stay separate. CI / `changes_requested` / FYI / seed do **not** coalesce. No fuzzy NLP.

**checkpoint merge:** templated `Latest:` line — on apply, workstream `changed` prepends (cap 8) and `mergeCheckpoint` replaces any trailing `\n\nLatest:…` with one templated line (pre-Latest seed prose preserved). Coalesce must not skip workstreamPatch. No LLM / full rewrite.

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
| `GET` | `/api/github/inbox` | — | `{ ok, watch, needsYouCap, githubNeedsYou, externalNeedsYou, items }` |
| `POST` | `/api/github/inbox` | `GitHubInboxEvent` (+ `requested_via?`, `team_slug?`, `requested_user?`, `action_on_user?`) | `{ ok, event, applied, duplicate, item }` |

`action_on_user` (personal `review.requested` only): **omitted ⇒ true (Needs-you)**; set `false` only when the ask should stay FYI. Team `review.requested` uses `watch.teams`, not this flag.

Malformed POST → **4xx** and does not write inbox state. Offline seed Needs-you stays at the Monday 2 items until events arrive. Client polls the inbox and merges into the persisted Zustand store. When external (github|slack) Needs-you would exceed 5, oldest demote to FYI **attention** (provenance / Open source kept); seed Monday items stay.



### Slack PR-link inbox

Durable files: `.control/slack-inbox/<id>.json`. No Slack token in Control.

**SlackInboxEvent** (`type: "pr_link"`): `id` (prefer `channel_ts`), `channel_id`, `message_ts`, `permalink`, `text_excerpt`, `repo`, `pr_number`, `occurred_at`, dual `provenance` (slack + github).

Rules: channel must match `watch.slackPrChannelId`; PR URL must be for `watch.repo`; why = `Review ask in #control-e2e · PR #N`; watched PR attaches `workstreamId`, else ephemeral `Review · {repo}#{N}`.

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/slack/inbox` | — | `{ ok, watch, needsYouCap, slackNeedsYou, externalNeedsYou, items }` |
| `POST` | `/api/slack/inbox` | `SlackInboxEvent` | `{ ok, event, applied, duplicate, item }` |

```bash
curl -sS -X POST http://localhost:3000/api/slack/inbox \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"C0BVCSA4T2P_1788810000.100001\",\"type\":\"pr_link\",\"channel_id\":\"C0BVCSA4T2P\",\"message_ts\":\"1788810000.100001\",\"permalink\":\"https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788810000100001\",\"text_excerpt\":\"Please review https://github.com/richardhorvath11/battle-buddy/pull/32\",\"repo\":\"richardhorvath11/battle-buddy\",\"pr_number\":32,\"occurred_at\":\"2026-09-07T22:05:00.000Z\"}"
```

Team review.requested (requires `teams` includes slug):

```bash
curl -sS -X POST http://localhost:3000/api/github/inbox \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"rev-req-team-platform-32\",\"type\":\"review.requested\",\"repo\":\"richardhorvath11/battle-buddy\",\"pr_number\":32,\"summary\":\"CODEOWNERS @platform requested review\",\"occurred_at\":\"2026-09-07T22:00:00.000Z\",\"provenance\":{\"url\":\"https://github.com/richardhorvath11/battle-buddy/pull/32\",\"title\":\"Review requested\",\"kind\":\"review\"},\"requested_via\":\"team\",\"team_slug\":\"platform\",\"workstream_id\":\"ws-cred\"}"
```

See `scripts/github-watcher.md` (V0.6 standing tick) and `scripts/slack-pr-watcher.md`.

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

- **Offline**: empty `.control/github-inbox/` + `.control/slack-inbox/`, mocked `/source/*` for seed provenance only.
- **Live**: watcher POSTs events; Attention Items carry https `provenance.url` and Open source opens the real GitHub/checks page in a new tab.


### Demo / E2E reset

Persisted Zustand (`localStorage` key **`control-v0`**) can pollute UI E2E after inbox floods. Reset options:

1. **⌘K → “Reset demo state”** — clears `control-v0` and rehydrates from seed (client).
2. **`POST /api/demo/reset`** — returns client clear instructions; optional `clearInboxes=true` (query or JSON body) deletes `.control/github-inbox/*.json` and `.control/slack-inbox/*.json`. **Does not wipe** `.control/watch.json`.
3. **QA one-liner**: `localStorage.removeItem('control-v0')` then reload.

```bash
curl -sS -X POST 'http://localhost:3000/api/demo/reset?clearInboxes=true'
# or
curl -sS -X POST http://localhost:3000/api/demo/reset \
  -H 'Content-Type: application/json' \
  -d '{"clearInboxes":true}'
```


## Standing watchers (V0.6)

Documented poll loop (scripts + docs). Control still holds **no** GitHub or Slack tokens; the host agent runs `gh` / Slack MCP and POSTs into the existing inbox APIs.

| Piece | Path |
|-------|------|
| GitHub tick | `scripts/github-watcher-tick.sh` |
| GitHub docs | `scripts/github-watcher.md` |
| Slack helper | `scripts/slack-pr-inbox-post.sh` |
| Slack docs | `scripts/slack-pr-watcher.md` |
| Watch template | `watch.example.json` → `.control/watch.json` |
| GitHub state | `.control/github-watcher-state.json` (gitignored) |

### One GitHub tick

```bash
./scripts/github-watcher-tick.sh
# dry-run (Control optional):
./scripts/github-watcher-tick.sh --dry-run
```

Each tick: read watch → `gh` PR head SHA / CI / reviewers / changes-requested → diff state → `POST` only **new** events to `/api/github/inbox`. Quiet noop updates `last_tick` only. First tick baselines state without POSTs. `teams: []` ⇒ never emit team `review.requested`. Cap remains `NEEDS_YOU_EXTERNAL_CAP = 5` inside Control.

### Slack MCP → helper

Agent reads `watch.slackPrChannelId`, finds messages with PR URLs for `watch.repo`, then:

```bash
./scripts/slack-pr-inbox-post.sh <channel_id> <message_ts> <permalink> <text> <repo> <pr_number>
```

Curls `POST /api/slack/inbox`. No Slack token in repo or Control.

Out of chip (beyond templated Latest + dual-ask coalesce): full checkpoint rewrite, CI↔review coalesce, multi-PR follow, Seed/Live toggle, second UI, webhooks-in-Control, fuzzy NLP.

## Stack assumptions

- **Next.js App Router** + TypeScript + Tailwind CSS
- **Zustand** client store hydrated from `src/lib/seed.json`
- No auth, no live Slack ingestion, no database, **no GitHub/Slack tokens in Control**
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
| `GET/POST /api/slack/inbox` | Durable Slack PR-link inbox (watcher → Control) |
| `POST /api/demo/reset` | Clear demo persist instruction; optional `clearInboxes=true` (keeps watch.json) |
| `POST /api/slack/outbox/:id/ack` | Mark posted after MCP send |
| `POST /api/slack/outbox/:id/fail` | Mark failed |
| `POST /api/slack/post` | Soft-disabled (410) |

Command palette (⌘K) opens the launcher (not chat). Includes **Reset demo state** (clears `localStorage` key `control-v0` and rehydrates from seed).

## Click-through

1. Land on Now morning — day strip, Resume card, needs-you, collapsed FYI.
2. Delegate Priya question — agent Running; on finish Review badge increments, no toast.
3. Resume credential rotation — checkpoint + next step.
4. Start focus — Now quiets; badge may change without interrupting.
5. Open Review — RFC finding, open RFC + PR mocks, Approve/Reject.
6. Approve/edit Slack draft with explicit confirm -> outbox queue -> MCP poster -> ack.
7. Return to Now — checkpoint updated.

## Explicit cuts

Team surface, auth, org-wide GitHub, multi Slack channels, webhooks-in-Control, NLP without URL, live Calendar ingestion, chat-first UI, toasts on agent complete, inbox-shaped Now / chronological feed, agent builder, lorem, auto-send without confirm, posting outside #control-e2e, Slack app / bot-token inside Next, GitHub App / PAT inside Control, raising external Needs-you cap without product call.
