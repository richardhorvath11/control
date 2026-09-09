# Control — V0.7 (chip 3b: Local Pro Claude worker)

Dark, desktop-width web prototype of an engineering work control plane. Seeded Monday morning so a tech lead can understand the day, resume a workstream, and make one judgment in under three minutes.

## Run

```bash
cd control
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). **Dogfood = Live + your watch** (not seed). When `.control/watch.json` has a non-empty `repo` and ≥1 Slack channel and you have no saved mode preference, UI defaults to **Live**. Monday seed is only via **Load demo** (sidebar / ⌘K) — that switches to Demo without wiping the watch channel list on disk. Configure channels under **Setup** (`/settings`) or edit `watch.json`.

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

Default fields (multi-channel):

```json
{
  "repo": "richardhorvath11/battle-buddy",
  "pr": 32,
  "workstreamId": "ws-cred",
  "teams": [],
  "slackPrChannels": [
    { "id": "C0BVCSA4T2P", "name": "#control-e2e" },
    { "id": "C0BINFRA000", "name": "#infra-prs" }
  ]
}
```

- `teams`: **intentional default `[]`**. Team/CODEOWNERS `review.requested` (`requested_via: "team"`) is a **no-op** until operators set **1–3** team slugs (e.g. in `.control/watch.json`). Do **not** seed `platform` (or any slug) in the default. **E2E/QA must configure `watch.teams` before B-1** (team-review scenarios); injects with unknown `team_slug` return `applied: false` and create no Needs-you.
- `slackPrChannels`: list of Slack channels for PR-link Needs-you (poll **every** channel). Also accept `slackPrChannelIds: string[]` (names optional).
- **Migration**: legacy scalar `slackPrChannelId` / `slackPrChannelName` still loads as a **one-element** list (`n=1`). Normalized config exposes derived `slackPrChannelId` (first channel) for back-compat.
- **Configured** (Live default rule): non-empty `repo` **and** ≥1 Slack channel. Fixtures/seed stay for internal test only — not the dogfood path.
- UI: **Setup** (`/settings`) or `GET`/`PUT` `/api/watch` to add/remove channels; persists `.control/watch.json`.

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

Rules: channel must be in `watch.slackPrChannels` (legacy scalar → n=1); PR URL must be for `watch.repo`; why uses the matched channel name; watched PR attaches `workstreamId`, else ephemeral `Review · {repo}#{N}`. Messages without a `watch.repo` PR URL stay ignored. No org-wide Slack.

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

### Offline vs live (inbox presence)

- **Offline**: empty `.control/github-inbox/` + `.control/slack-inbox/`, mocked `/source/*` for seed provenance only.
- **Live data path**: watcher POSTs events; Attention Items carry https `provenance.url` and Open source opens the real GitHub/checks page in a new tab.

### Demo vs Live mode (chip 5 + chip 2 default)

Monday seed and durable inboxes must not fight. **Not auth** — Setup + sidebar / ⌘K plus optional API.

| Mode | Boot / Now |
|------|------------|
| **Live** | Default when watch is **configured** (repo + ≥1 Slack channel) and no saved mode preference. **Apply** durable inboxes on load/poll. Banner: `Live · {repo}` + `{n} Slack channels` (+ follows). |
| **Demo** | **Load demo** only (not main install/dogfood). Zustand from Monday seed; **ignore** applying github/slack inbox into the UI (APIs still accept watcher POSTs). Banner: `Demo · seeded Monday`. Does **not** wipe `.control/watch.json` channel list. |

- Persist: `localStorage` key **`control-v0-mode`** = `demo` or `live`. If unset and watch configured → **Live**.
- Zustand persist remains **`control-v0`** (attention, applied ids, etc.).
- **Dogfood**: Live + your watch (Setup / `watch.json`) — not seed.
- Watchers keep POSTing regardless of mode. Cap `NEEDS_YOU_EXTERNAL_CAP = 5` unchanged. pr-follows / coalesce / checkpoint / auto-kick untouched.

```bash
# Optional QA echo (client still owns localStorage)
curl -sS -X POST http://localhost:3000/api/demo/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"live"}'
curl -sS http://localhost:3000/api/demo/status
```

### Live auto-kick review worker (V0.7 chip 1)

In **Live** mode, when a coalesce-class Needs-you appears (`ext-att-review-*` from Slack `pr_link` and/or GitHub `review.requested`), Control **automatically** enqueues one independent PR review worker bound to that `repo#PR` + workstream.

| | |
|--|--|
| Idempotency | `auto-review:{coalesceKey}` persisted in Zustand (`autoKickedReviewKeys`) — refresh / second Slack+GitHub merge does not double-kick |
| Agent | `Independent review · {repo}#{pr}` · Running → Complete / Failed |
| Landing | Findings → **Review only** (badge++); **no toast**; Needs-you stays open |
| Demo | Auto-kick **disabled**; Monday seed + manual Delegate unchanged |
| Demo reset | Clears `autoKickedReviewKeys` so a later Live session can kick again |
| Cap | `NEEDS_YOU_EXTERNAL_CAP = 5` unchanged |

```bash
npx tsx scripts/smoke-auto-kick-review.ts
```

### Review runner invoke hook (V0.7 chip 3) + Local Pro Claude worker (chip 3b)

**Not a skill.** Chip 3 ships a configurable invoke wrapper; chip 3b makes the **Live dogfood default** a local Gastown worker on the operator machine (Claude Pro), not server-spawned Claude or Console API keys. Control writes `control.review_job.v1`, the local worker runs `claude -p` (no `--bare`, `ANTHROPIC_API_KEY` unset), writes `control.review_result.v1`, and Control imports into Review (Analysis-not-truth). **Do not** ship a pr-review skill, plugin, or prompt library in-product.

#### Default Live dogfood path (worker)

1. Auto-kick / Delegate → `POST /api/review/run` writes `.control/review-jobs/{job_id}.json` and sets Agent **Running** with detail **“Waiting for local worker (claude Pro).”** No Review findings until a result appears.
2. On the operator machine (Claude Pro logged in):

```bash
./scripts/control-review-worker --once    # claim one pending job, exit
./scripts/control-review-worker --watch   # loop until Ctrl-C
```

3. Worker claims oldest pending job (sidecar `.claimed` + `in-progress/`), runs `env -u ANTHROPIC_API_KEY claude -p "…"`, writes `.control/review-results/{job_id}.json`.
4. Control polls `GET /api/review/result?job_id=…` (≈2s; server reads the results dir — client never imports `fs`) → same import path → Review + Agent Complete. No toast. No invented findings.

**Auth (dogfood):** same-user `claude` login **or** `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. **Never** require a Console `ANTHROPIC_API_KEY` for dogfood. If no worker claims the job within the wait window, Agent **Failed** with `start control-review-worker`.

Worker exit codes: `0` ok · `1` no pending (`--once`) · `2` retryable · `3` parse · `4` claude missing. Failures still write `status: error` results so Control can land Agent Failed.

#### Chip 3 CLI (external / advanced backends)

```bash
./scripts/control-review-run --in job.json --out result.json
# Exit: 0 ok · 2 retryable · 3 bad parse/job · 4 backend missing
```

Job → `.control/review-jobs/{job_id}.json` (and/or `--in`):

```json
{
  "schema": "control.review_job.v1",
  "job_id": "rj-…",
  "repo": "owner/name",
  "pr": 32,
  "head_sha": "optional",
  "workstream_id": "optional",
  "attention_id": "optional",
  "provenance": [],
  "snapshot_path": "optional"
}
```

Result ← `.control/review-results/{job_id}.json` (worker) or `--out` (command / control-review-run):

```json
{
  "schema": "control.review_result.v1",
  "job_id": "rj-…",
  "status": "ok",
  "summary": "…",
  "findings": [{ "title": "…", "body": "…", "evidence": [] }],
  "scope": { "notes": "…" }
}
```

#### Env knobs

| Knob | Values |
|------|--------|
| `CONTROL_REVIEW_BACKEND` | `worker` (default when unset) \| `command` \| `fake` \| `claude-cli` \| `cursor-cloud` |
| `CONTROL_REVIEW_COMMAND` | Optional when `command` — e.g. `my-pr-review --in {{in}} --out {{out}}` |

| Backend | Behavior |
|---------|----------|
| `worker` | **Live default.** Enqueue job only; do **not** server-spawn claude. Local `./scripts/control-review-worker` claims + runs Pro Claude. |
| `command` | Unchanged — spawn operator `--in`/`--out` wrapper via `control-review-run`. |
| `fake` | Templated fixture findings — **CI/smoke/Demo QA only**. **Live must not default here.** |
| `claude-cli` | Advanced/opt-in server-spawn via `control-review-run` (prefer **worker** for dogfood). Minimal glue prompt inside the wrapper only. |
| `cursor-cloud` | Stub: result `status: error` / “cursor-cloud not configured”. |

**Live default:** `CONTROL_REVIEW_BACKEND` unset → **`worker`**. Prefer worker for dogfood; use `fake` only for smoke; `claude-cli` is opt-in.

Demo keeps the local sim timer for Monday narrative; Live goes through `POST /api/review/run` (enqueue or sync invoke) + result poll for worker. Manual **Delegate** PR review uses the same `startPrReviewWorker` path as auto-kick (BUG-RR1: client-safe contracts only; enqueue/poll via API).

Job / claim / result paths live under gitignored `.control/` (`review-jobs/`, `review-jobs/in-progress/`, `review-results/`). No model / GitHub / Slack tokens added to Control. No `ANTHROPIC_API_KEY` required in `.env.example`.

```bash
npx tsx scripts/smoke-review-runner.ts
npx tsx scripts/smoke-review-worker.ts
# probe (dev server):
curl -sS http://localhost:3000/api/review/run
```

Out of chip 3b (still cut): full pr-review skill/plugin/prompt pack · requiring Console API keys · Next spawn as Live default · agent builder · free-form prompt IDE · fake-as-Live-default · live Review snapshot chrome (chip 4) · GitHub outbox (chip 5) · Team/Mac/chat-home.

### Demo / E2E reset

Persisted Zustand (`localStorage` key **`control-v0`**) can pollute UI E2E after inbox floods. Reset options:

1. **⌘K / sidebar → “Load demo”** — clears `control-v0`, clears applied inbox ids, forces **Demo** (`control-v0-mode=demo`), rehydrates Monday seed. **Does not delete** inbox files, **does not wipe** watch channel list, does not break watchers.
2. **`POST /api/demo/reset`** — returns client clear instructions; optional `clearInboxes=true` (query or JSON body) deletes `.control/github-inbox/*.json` and `.control/slack-inbox/*.json`. Prefer leaving inboxes on disk. **Does not wipe** `.control/watch.json` or `.control/pr-follows.json`.
3. **QA one-liner**: `localStorage.removeItem('control-v0')` then reload (also set `control-v0-mode` to `demo` if needed).

```bash
curl -sS -X POST 'http://localhost:3000/api/demo/reset'
# optional hard wipe of inbox JSON only:
curl -sS -X POST 'http://localhost:3000/api/demo/reset?clearInboxes=true'
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
| PR follows (chip 4) | `.control/pr-follows.json` (gitignored; Slack apply upserts) |
| Slack cursor state | `.control/slack-watcher-state.json` keyed by `channel_id` → last `ts` |
| Follow smoke | `npx tsx scripts/smoke-pr-follows.ts` |
| Auto-kick smoke | `npx tsx scripts/smoke-auto-kick-review.ts` |
| Review runner smoke | `npx tsx scripts/smoke-review-runner.ts` |
| Review worker smoke | `npx tsx scripts/smoke-review-worker.ts` |
| Multi-channel watch smoke | `npx tsx scripts/smoke-watch-multi-channel.ts` |
| Review runner CLI | `./scripts/control-review-run --in job.json --out result.json` |
| Local Pro worker CLI | `./scripts/control-review-worker --once` / `--watch` |

### One GitHub tick

```bash
./scripts/github-watcher-tick.sh
# dry-run (Control optional):
./scripts/github-watcher-tick.sh --dry-run
```

Each tick: read watch + **active follows** → `gh` each PR (primary + follows, same repo) → per-PR diff → `POST` only **new** events to `/api/github/inbox`. Quiet noop updates `last_tick` only when nothing changed across all PRs. Baseline-on-first-see per PR. `teams: []` ⇒ never emit team `review.requested`. Cap remains `NEEDS_YOU_EXTERNAL_CAP = 5` inside Control.

### Slack-discovered follows (chip 4)

When Slack inbox applies a `pr_link` for `watch.repo` with `pr_number ≠ watch.pr`, Control upserts a **follow** (48h TTL, max 5, refresh on re-link). Primary `watch.pr` is never a follow. The GitHub tick polls primary + active follows; expired rows drop off. No org-wide, no NLP without URL. See `scripts/github-watcher.md`.

### Slack MCP → helper

Agent reads **every** `watch.slackPrChannels[]` entry (cursor per `channel_id` in `.control/slack-watcher-state.json`), finds messages with PR URLs for `watch.repo`, then:

```bash
./scripts/slack-pr-inbox-post.sh <channel_id> <message_ts> <permalink> <text> <repo> <pr_number>
```

Curls `POST /api/slack/inbox`. No Slack token in repo or Control. No org-wide Slack; messages without a `watch.repo` PR URL stay ignored.

Out of chip: org-wide / multi-repo, webhooks-in-Control, fuzzy NLP, infinite follows, raising external Needs-you cap, full checkpoint rewrite, CI↔review coalesce, auth / multi-tenant, chips 3–5.

## Stack assumptions

- **Next.js App Router** + TypeScript + Tailwind CSS
- **Zustand** client store hydrated from `src/lib/seed.json`
- No auth, no live Slack ingestion, no database, **no GitHub/Slack tokens in Control**
- Agent delegation + Live auto-kick PR review via default local Pro Claude **worker** (or `control-review-run` for command/fake/claude-cli); Demo keeps 3–8s sim; completion increments the Review badge only (no toasts)
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
| `/settings` | BYO Live setup (repo, teams, multi Slack channels → `watch.json`) |
| `GET/PUT /api/watch` | Read/write normalized multi-channel watch config |
| `/source/slack/[id]` | Mocked Slack thread (+ harness link) |
| `/source/github/[id]` | Mocked PR + CI + diff |
| `/source/rfc/[id]` | Mocked RFC section |
| `/source/calendar/[id]` | Mocked calendar event |
| `GET/POST /api/slack/outbox` | Durable Slack outbox for MCP poster |
| `GET/POST /api/github/inbox` | Durable GitHub inbox (watcher → Control) |
| `GET/POST /api/slack/inbox` | Durable Slack PR-link inbox (watcher → Control) |
| `POST /api/demo/reset` | Clear demo persist instruction; optional `clearInboxes=true` (keeps watch.json / pr-follows) |
| `GET/POST /api/demo/mode` | Optional QA mode echo (`demo` or `live`); client key `control-v0-mode` |
| `GET /api/demo/status` | Watch repo + Slack channel count + follows for Live banner |
| `POST /api/slack/outbox/:id/ack` | Mark posted after MCP send |
| `POST /api/slack/outbox/:id/fail` | Mark failed |
| `POST /api/slack/post` | Soft-disabled (410) |

Command palette (⌘K) opens the launcher (not chat). Includes **Open Live setup**, **Switch to Live**, and **Load demo** (clears `control-v0`, forces Demo + Monday seed without wiping watch.json channels or inbox files).

## Click-through

1. Land on Now morning — day strip, Resume card, needs-you, collapsed FYI.
2. Delegate Priya question — agent Running; on finish Review badge increments, no toast.
3. Resume credential rotation — checkpoint + next step.
4. Start focus — Now quiets; badge may change without interrupting.
5. Open Review — RFC finding, open RFC + PR mocks, Approve/Reject.
6. Approve/edit Slack draft with explicit confirm -> outbox queue -> MCP poster -> ack.
7. Return to Now — checkpoint updated.

## Explicit cuts

Team surface, auth, org-wide GitHub / org-wide Slack, channels without PR-URL filter, webhooks-in-Control, NLP without URL, live Calendar ingestion, chat-first UI, toasts on agent complete, inbox-shaped Now / chronological feed, agent builder / free-form prompt, real LLM worker, live Review workspace, GitHub comment outbox, watch.autoReview policy, model-agnostic runner, Team/Mac/chat-home, baking seed as default dogfood, auto-merge, lorem, auto-send without confirm, Slack app / bot-token inside Next, GitHub App / PAT inside Control, raising external Needs-you cap without product call, chips 3–5.
