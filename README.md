# Control — V0.9 (chip 1: First-run Get Live wizard)

Dark, desktop-width web prototype of an engineering work control plane. Seeded Monday morning so a tech lead can understand the day, resume a workstream, and make one judgment in under three minutes.

**`.control/` is private to the Next server.** Agents and worker scripts must not read or write storage JSON (no `review-results/`, no `.claimed`, no outbox dir scans). Workers talk **HTTP only** (`CONTROL_BASE_URL`, default `http://localhost:3000`).

## Run

```bash
cd control
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). **Dogfood = Live + your watch** (not seed).

### First-run Get Live (V0.9 chip 1)

- **No** `control-v0-mode` **and** watch `configured:false` → full-page **Get Live** wizard (`/get-live`, alias `/onboarding`) — not Monday Demo Now. Gate waits until watch + mode are known (no Demo flash).
- **Continue → Live** validates via `PUT /api/watch` / `isWatchConfigured`, then switches to **Live** in one step (empty Live Now — seed Needs-you like Priya are wiped). Fail closed: no partial save.
- **Load Monday demo** → Demo + Monday seed; **does not** wipe `.control/watch.json`.
- Preference exists **or** watch configured → existing AppShell (auto-Live if configured + no pref).
- After Live once, wizard does not trap you; reopen via Setup → **Open Get Live wizard** or ⌘K.
- Copy: reviews use **Claude CLI + Pro** (Gastown) — no Console API keys / no Slack·GitHub·Anthropic tokens in the wizard. Worker launch / Claude verify = later chips (optional “Next: start workers” link only).

When `.control/watch.json` has a non-empty `repo` and ≥1 Slack surface (or include DMs/MPIMs) and you have no saved mode preference, UI defaults to **Live**. Monday seed is only via **Load demo** (sidebar / ⌘K / Get Live secondary) — that switches to Demo without wiping the watch channel list on disk. Configure under **Setup** (`/settings`), **Get Live** (`/get-live`), or edit `watch.json`.

```bash
npm run build   # production build
npm start       # serve production build
```

## Slack E2E (outbox -> Slack MCP)

Approve on **Draft Slack reply to Priya** (`rev-slack`) does **not** call Slack with a bot/user token. Confirm `POST /api/slack/outbox`. The MCP poster uses **HTTP only** (list/claim → `slack_send_message` → ack). Never open Control storage dirs. No Slack app / `SLACK_BOT_TOKEN` required.

### Defaults (hardcoded; env can override channel/thread only)

| | |
|--|--|
| Workspace | `connect-8w75152` |
| Channel | `#control-e2e` · `C0BVCSA4T2P` |
| Parent `thread_ts` | `1788808933.776429` |
| Fixture link | https://connect-8w75152.slack.com/archives/C0BVCSA4T2P/p1788808933776429 |
| Poster | HTTP `/api/slack/outbox` only — never scan storage dirs |

Optional env overrides (no tokens): `SLACK_E2E_CHANNEL_ID`, `SLACK_E2E_THREAD_TS`. See `.env.local.example`.

### E2E path

1. Open **Review** -> **Draft Slack reply to Priya**.
2. Click **Approve…** — confirm modal shows the exact draft text.
3. **Cancel / Reject** — no outbox write; item stays pending (or rejected).
4. **Post** — client `POST /api/slack/outbox` with the draft. On success, Review shows **Queued for Slack (awaiting MCP poster)** (`status: queued`). Fail closed: outbox write error keeps the modal open and Review pending.
5. **MCP poster (API-only)** — `GET /api/slack/outbox?status=pending` (or `POST /api/slack/outbox/claim`) → `slack_send_message` thread reply → `POST /api/slack/outbox/:id/ack` with `{ reply_ts?, permalink? }`. Never open storage dirs.
6. Client polls until ack -> marks Review **approved**, appends the reply to the mocked Slack UI, stores permalink. On `POST .../fail`, Review returns to pending.

Legacy `POST /api/slack/post` is soft-disabled (HTTP 410).

### Outbox API contract (Inbox Triage / MCP driver)

**Outbox record** (API body; server storage is private):

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
| `POST` | `/api/slack/outbox/claim` | `{ worker_id? }` | `200 { ok, item }` or `204` |
| `POST` | `/api/slack/outbox/:id/ack` | `{ reply_ts?, permalink? }` | `{ ok, item }` with `status: "posted"` |
| `POST` | `/api/slack/outbox/:id/fail` | `{ error? }` | `{ ok, item }` with `status: "failed"` |

No secrets in git. Credentials (if any) live only with the Slack MCP host, not in Control.

Slack MCP poster (API-only — never open storage dirs):

```bash
# optional claim (prevents double-send); or GET /api/slack/outbox?status=pending
curl -sS -X POST http://localhost:3000/api/slack/outbox/claim \
  -H 'Content-Type: application/json' -d '{}'
# post via Slack MCP (slack_send_message) using item.channel_id / thread_ts / text
curl -sS -X POST http://localhost:3000/api/slack/outbox/$ID/ack \
  -H 'Content-Type: application/json' -d '{"reply_ts":"…","permalink":"…"}'
```


## GitHub comment outbox (V0.7 chip 5)

Mirror of the Slack outbox for **PR comments**. From a Live **pr_review** item: **Draft comment** -> edit -> **Post comment...** confirm modal (exact body) -> `POST /api/github/outbox` -> local operator poster (`./scripts/github-outbox-worker`) posts a **comment-only** PR conversation comment via `gh` -> ack. Control holds **no** GitHub credentials. Workers never scan storage dirs.

v1 is **comment-only**: the worker posts an issue comment on the PR (operator `gh` CLI). It does **not** submit review-approve events or merge.

### Outbox record

API body (server storage is private):

```json
{
  "id": "gh-outbox-...",
  "status": "pending",
  "repo": "owner/name",
  "pr": 32,
  "body": "...exact markdown...",
  "review_item_id": "rev-...",
  "created_at": "2026-09-09T12:00:00.000Z"
}
```

After ack: `status: "posted"` plus `comment_url` / `comment_id`. After fail: `status: "failed"` plus `error` (Review returns to pending).

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/github/outbox` | -- (`?status=pending|posted|failed|all`, default `pending`) | `{ ok, items }` |
| `GET` | `/api/github/outbox/:id` | -- | `{ ok, item }` or 404 |
| `POST` | `/api/github/outbox` | `{ body, repo, pr, reviewItemId }` | `201 { ok, item }` |
| `POST` | `/api/github/outbox/claim` | `{ worker_id? }` | `200 { ok, item }` or `204` |
| `POST` | `/api/github/outbox/:id/ack` | `{ comment_url?, comment_id? }` | `{ ok, item }` with `status: "posted"` |
| `POST` | `/api/github/outbox/:id/fail` | `{ error? }` | `{ ok, item }` with `status: "failed"` |

### Dogfood

See scripts/github-outbox-worker and scripts/smoke-github-outbox.ts.

```bash
./scripts/github-outbox-worker
./scripts/github-outbox-worker --watch
./scripts/github-outbox-worker --dry-run
npx tsx scripts/smoke-github-outbox.ts
```

UI: Review shows **Queued for GitHub (awaiting poster)** until ack -> approved + comment link. Cancel writes nothing. Fail -> pending + error. Cap `NEEDS_YOU_EXTERNAL_CAP = 5` unchanged.


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

Default fields (`slackWatch` — V0.8 chip 2):

```json
{
  "repo": "richardhorvath11/battle-buddy",
  "pr": 32,
  "workstreamId": "ws-cred",
  "teams": [],
  "slackWatch": {
    "surfaces": [
      { "id": "C0BVCSA4T2P", "name": "#control-e2e", "kind": "channel", "prLinks": true },
      { "id": "C0BINFRA000", "name": "#infra-prs", "kind": "channel", "prLinks": true }
    ],
    "includeDms": false,
    "includeMpims": false
  }
}
```

- `teams`: **intentional default `[]`**. Team/CODEOWNERS `review.requested` (`requested_via: "team"`) is a **no-op** until operators set **1–3** team slugs (e.g. in `.control/watch.json`). Do **not** seed `platform` (or any slug) in the default. **E2E/QA must configure `watch.teams` before B-1** (team-review scenarios); injects with unknown `team_slug` return `applied: false` and create no Needs-you.
- `slackWatch`: surfaces (`kind`: channel|im|mpim, `prLinks`) plus optional `includeDms` / `includeMpims` (require `myUserId`). **No** `slackPrChannels` on disk after migrate.
- **Migration** (one-shot): `slackPrChannels` / scalars → `slackWatch.surfaces` with `prLinks: true`, **delete** old keys, persist. No legacy keep-alive.
- **Configured** (Live default rule): non-empty `repo` **and** (`surfaces.length >= 1` **or** `includeDms` **or** `includeMpims`). Fixtures/seed stay for internal test only — not the dogfood path.
- UI: **Setup** (`/settings`) or `GET`/`PUT` `/api/watch`; persists `.control/watch.json`.

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



### Slack inbox (pr_link + message)

Durable files: `.control/slack-inbox/<id>.json`. No Slack token in Control.

**`type: "pr_link"`**: `id` (prefer `channel_ts`), `channel_id`, `message_ts`, `permalink`, `text_excerpt`, `repo`, `pr_number`, `occurred_at`, dual `provenance` (slack + github). Only surfaces with `prLinks: true`; PR URL must be for `watch.repo`; why uses the matched surface name; watched PR attaches `workstreamId`, else ephemeral `Review · {repo}#{N}`. `prLinks: false` → ignore `pr_link` routing (document reason).

**`type: "message"`**: `id`, `channel_id`, `channel_kind`, `message_ts`, `thread_ts?`, `thread_participated?`, `permalink`, `text_excerpt` (~2k), `user_id?`, `occurred_at`, `mentions_me?`. Allowlist: `channel_id ∈ surfaces` **or** (im/mpim && include flags + `myUserId`). **V0.8 chip 3/4**: deterministic rules (no LLM) → **Needs-you** when actionable-for-me, else store + **ignore** (no FYI firehose). First match (**chip 4 reorder**): (1) im + `?` + ≤280 → `Question in DM`; (2) im|mpim → `DM to you`; (3) `mentions_me` or text `<@myUserId>` → `Mentioned you`; (4) `thread_ts` + `thread_participated:true` → `Thread you're in`. Choice: prefer `Question in DM` why for short DM questions (auto-draft + clearer labels); DM/short-DM-? still Needs-you. Missing `myUserId` fail-closes mention text scan; absent `thread_participated` skips rule 4. Attention id `slack-msg-{channel}-{ts}`, origin `slack`, `suggestedAction: "open"`, Slack permalink provenance + chip 4 channel/thread fields; shared `NEEDS_YOU_EXTERNAL_CAP=5`; no workstream checkpoint spam. Dedupe `(channel_id, message_ts)`. Allowed → **201**. Reject unknown types / malformed → **4xx**.

No org-wide Slack. No Slack token in Control. **Chip 4**: Draft reply on origin:slack Needs-you → `slack_draft` review job (local worker) → Confirm → `POST /api/slack/outbox`. Auto-draft once for DM questions (`auto-draft:{attentionId}`); channel @mention does not auto-draft. Prep ≠ done (Needs-you stays until Approve/Dismiss). Live fails closed without worker — no fake draft. Demo: manual only; no auto; seed Priya `rev-slack` unchanged.

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/slack/inbox` | — | `{ ok, watch, needsYouCap, slackNeedsYou, externalNeedsYou, items }` |
| `POST` | `/api/slack/inbox` | `SlackInboxEvent` (`pr_link` \| `message`) | `{ ok, event, applied, duplicate, item }` |

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

See `scripts/github-watcher.md` (V0.6 standing tick) and `scripts/slack-watch.md`.

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
| **Live** | Default when watch is **configured** (repo + ≥1 surface or include DMs/MPIMs) and no saved mode preference. **Apply** durable inboxes on load/poll. Banner: `Live · {repo} · {n} channels` (+ optional `· DMs` / `· MPIMs`) (+ follows). |
| **Demo** | **Load demo** only (not main install/dogfood). Zustand from Monday seed; **ignore** applying github/slack inbox into the UI (APIs still accept watcher POSTs). Banner: `Demo · seeded Monday`. Does **not** wipe `.control/watch.json` channel list. |

- Persist: `localStorage` key **`control-v0-mode`** = `demo` or `live`. If unset and watch configured → **Live**.
- Zustand persist remains **`control-v0`** (attention, applied ids, etc.). Does **not** persist `agents` / `reviewQueue` / `autoKickedReviewKeys` (Demo Surface checks must not poison Live; Live enter also wipes those).
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
| Idempotency | `auto-review:{coalesceKey}` in-memory (`autoKickedReviewKeys`; not persisted across refresh) — Running wait or real landed review blocks double-kick; Demo→Live wipes stale keys |
| Agent | `Independent review · {repo}#{pr}` · Running → Complete / Failed |
| Landing | Findings → **Review only** (badge++); **no toast**; Needs-you stays open |
| Demo | Auto-kick **disabled**; Monday seed + manual Delegate unchanged |
| Demo reset / Live enter | Clears `autoKickedReviewKeys` + Demo Surface-checks agents/reviews so Live never shows stale Complete sim |
| Cap | `NEEDS_YOU_EXTERNAL_CAP = 5` unchanged |

```bash
npx tsx scripts/smoke-auto-kick-review.ts
```

### Review runner invoke hook (V0.7 chip 3) + Local Pro Claude worker (chip 3b)

**Not a skill.** Chip 3 ships a configurable invoke wrapper; chip 3b made the **Live dogfood default** a local Gastown worker; V0.8 chip 1 makes that worker **HTTP-only**. Control enqueues `control.review_job.v1`, the local worker runs `claude -p` (no `--bare`, `ANTHROPIC_API_KEY` unset), posts `control.review_result.v1`, and Control imports into Review (Analysis-not-truth). **Do not** ship a pr-review skill, plugin, or prompt library in-product.

#### Default Live dogfood path (worker)

Workers talk **only HTTP** to Control. Job/result schemas are API bodies (`control.review_job.v1` / `control.review_result.v1`). Do **not** write `review-results/`, `.claimed`, or any `.control/**` JSON from agents.

1. Auto-kick / Delegate → `POST /api/review/run` enqueues a job and sets Agent **Running** with detail **“Waiting for local worker (claude Pro).”** No Review findings until a result is posted.
2. On the operator machine (Claude Pro logged in):

```bash
CONTROL_BASE_URL=http://localhost:3000 ./scripts/control-review-worker --once
CONTROL_BASE_URL=http://localhost:3000 ./scripts/control-review-worker --watch
```

(`CONTROL_BASE_URL` defaults to `http://localhost:3000`.)

3. Worker `POST /api/review/jobs/claim` (optional `{ worker_id }`) → `200 { ok, job }` or `204`. Runs `env -u ANTHROPIC_API_KEY claude -p "…"`. Then `POST /api/review/jobs/:id/result` (`control.review_result.v1`) or `POST /api/review/jobs/:id/fail` `{ error }` (Agent Failed; no invented findings). Heartbeat: `POST /api/review/jobs/:id/heartbeat`.
4. UI polls `GET /api/review/jobs/:id` (≈2s) → same import path → Review + Agent Complete. No toast. No invented findings.

```bash
curl -sS -X POST http://localhost:3000/api/review/jobs/claim \
  -H 'Content-Type: application/json' -d '{"worker_id":"local-1"}'
curl -sS http://localhost:3000/api/review/jobs/$JOB_ID
curl -sS -X POST http://localhost:3000/api/review/jobs/$JOB_ID/result \
  -H 'Content-Type: application/json' -d @- <<'JSON'
{"schema":"control.review_result.v1","job_id":"rj-…","status":"ok","summary":"…","findings":[{"title":"…","body":"…","evidence":[]}]}
JSON
curl -sS -X POST http://localhost:3000/api/review/jobs/$JOB_ID/fail \
  -H 'Content-Type: application/json' -d '{"error":"claude missing"}'
```

**Auth (dogfood):** same-user `claude` login **or** `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. **Never** require a Console `ANTHROPIC_API_KEY` for dogfood. If no worker claims the job within the wait window, Agent **Failed/Blocked** with `Waiting timed out — run ./scripts/control-review-worker` (no invented Review findings).

Worker exit codes: `0` ok · `1` no pending (`--once`) · `2` retryable · `3` parse · `4` claude missing. Operational failures `POST /fail` (no fake findings).

#### Chip 3 CLI (external / advanced backends)

```bash
./scripts/control-review-run --in job.json --out result.json
# Exit: 0 ok · 2 retryable · 3 bad parse/job · 4 backend missing
```

Job (API body / `control-review-run --in` for command backends only):

```json
{
  "schema": "control.review_job.v1",
  "job_id": "rj-…",
  "kind": "pr_review",
  "repo": "owner/name",
  "pr": 32,
  "head_sha": "optional",
  "workstream_id": "optional",
  "attention_id": "optional",
  "provenance": [],
  "snapshot_path": "optional"
}
```

`kind` defaults to `pr_review` when `repo`+`pr` present (back-compat). **Chip 4 `slack_draft`:**

```json
{
  "schema": "control.review_job.v1",
  "job_id": "rj-…",
  "kind": "slack_draft",
  "attention_id": "slack-msg-…",
  "channel_id": "C…|D…",
  "thread_ts": "…",
  "message_ts": "…",
  "permalink": "https://…",
  "text_excerpt": "…",
  "provenance": []
}
```

Result (API body `POST /api/review/jobs/:id/result`, or `--out` for command / control-review-run):

```json
{
  "schema": "control.review_result.v1",
  "job_id": "rj-…",
  "status": "ok",
  "summary": "…",
  "draft_text": "…optional; required for ok slack_draft…",
  "findings": [{ "title": "…", "body": "…", "evidence": [] }],
  "scope": { "notes": "…" }
}
```

`draft_text` maps to `ReviewItem.draftText` for `slack_draft`. Live never invents a templated reply when the worker is missing — Agent Failed / timeout with `./scripts/control-review-worker` copy.

#### Env knobs

| Knob | Values |
|------|--------|
| `CONTROL_REVIEW_BACKEND` | `worker` (default when unset) \| `command` \| `fake` \| `claude-cli` \| `cursor-cloud` |
| `CONTROL_REVIEW_COMMAND` | Optional when `command` — e.g. `my-pr-review --in {{in}} --out {{out}}` |

| Backend | Behavior |
|---------|----------|
| `worker` | **Live default.** Enqueue job only; do **not** server-spawn claude. Local `./scripts/control-review-worker` claims via HTTP + runs Pro Claude. |
| `command` | Unchanged — spawn operator `--in`/`--out` wrapper via `control-review-run`. |
| `fake` | Templated fixture findings — **CI/smoke/Demo QA only**. **Live must not default here.** |
| `claude-cli` | Advanced/opt-in server-spawn via `control-review-run` (prefer **worker** for dogfood). Minimal glue prompt inside the wrapper only. |
| `cursor-cloud` | Stub: result `status: error` / “cursor-cloud not configured”. |

**Live default:** `CONTROL_REVIEW_BACKEND` unset → **`worker`**. Prefer worker for dogfood; use `fake` only for smoke; `claude-cli` is opt-in.

Demo keeps the local sim timer for Monday narrative; Live goes through `POST /api/review/run` (enqueue or sync invoke) + `GET /api/review/jobs/:id` poll for worker. Manual **Delegate** PR review uses the same `startPrReviewWorker` path as auto-kick (BUG-RR1: client-safe contracts only; enqueue/poll via API).

`.control/` stays private server storage (gitignored). Agents must not write storage JSON. No model / GitHub / Slack tokens added to Control. No `ANTHROPIC_API_KEY` required in `.env.example`.

```bash
npx tsx scripts/smoke-review-runner.ts
npx tsx scripts/smoke-review-worker.ts
# probe (dev server):
curl -sS http://localhost:3000/api/review/run
```

Out of chip 3b (still cut at the time): full pr-review skill/plugin/prompt pack · requiring Console API keys · Next spawn as Live default · agent builder · free-form prompt IDE · fake-as-Live-default · Team/Mac/chat-home. **Chip 4 (Live Review snapshot chrome) and chip 5 (GitHub comment outbox) shipped.**


### Live Review workspace (V0.7 chip 4)

For **pr_review** items (esp. Live / worker results), Review is a **workspace over the real PR** — not a full IDE diff. Header shows the PR title (from snapshot when present), **Analysis, not truth**, and **Open PR** (real `github.com` URL). Findings remain runner Analysis labeled as claims, not approval. CI SUCCESS is a status chip — **not** a green-check-as-approved.

#### PR snapshots (operator `gh`; no PAT in Control)

Watcher tick or thin helper writes gitignored:

`.control/pr-snapshots/{owner}-{repo}-{pr}.json`

```json
{
  "repo": "owner/name",
  "pr": 32,
  "title": "…",
  "url": "https://github.com/owner/name/pull/32",
  "head_sha": "abc…",
  "ci": { "conclusion": "SUCCESS|FAILURE|PENDING|…", "url": "…" },
  "files": [{ "path": "…", "status": "modified|added|removed" }],
  "requested_reviewers": { "users": [], "teams": [] },
  "updated_at": "ISO"
}
```

```bash
# Refresh one PR (uses watch.json when args omitted)
./scripts/github-pr-snapshot.sh --repo owner/name --pr 32
# Or let the standing watcher refresh snapshots on each tick:
./scripts/github-watcher-tick.sh
```

| | |
|--|--|
| API | `GET /api/github/snapshot?repo=&pr=` → snapshot JSON; **404** `{ error: "Snapshot missing — run watcher" }` |
| Enqueue | `review_job.v1.snapshot_path` preferred when the file exists on disk |
| UI | Snapshot panel: CI chip+link, head SHA, file list (path+status, cap ~20, **no hunks**) |
| Empty | Clear CTA to run watcher/script; **findings still render**; no crash |
| Draft comment | **Enabled (chip 5)** — confirm -> `POST /api/github/outbox` -> local gh worker |
| Stay cut | Full IDE / Monaco / patch hunks · merge button · auto-merge · credentials-in-Control |

```bash
npx tsx scripts/smoke-pr-snapshot.ts
```

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
| Slack docs | `scripts/slack-watch.md` |
| Watch template | `watch.example.json` → `.control/watch.json` |
| GitHub state | `.control/github-watcher-state.json` (gitignored) |
| PR follows (V0.6 chip 4) | `.control/pr-follows.json` (gitignored; Slack apply upserts) |
| PR snapshots (V0.7 chip 4) | `.control/pr-snapshots/{owner}-{repo}-{pr}.json` (gitignored; gh/watcher writes) |
| GitHub comment outbox (V0.7 chip 5) | HTTP `/api/github/outbox` (Confirm enqueues; local gh worker claims/posts/acks) |
| GitHub outbox worker | `./scripts/github-outbox-worker` (HTTP claim/list/ack/fail only) |
| GitHub outbox smoke | `npx tsx scripts/smoke-github-outbox.ts` |
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

Agent reads `watch.slackWatch` surfaces (+ optional DMs/MPIMs; cursor per surface id in `.control/slack-watcher-state.json`). PR URL + `prLinks: true` → `pr_link` helper; else POST `message`. `includeDms`/`includeMpims` without `myUserId` → fail-closed.

```bash
./scripts/slack-pr-inbox-post.sh <channel_id> <message_ts> <permalink> <text> <repo> <pr_number>
```

Curls `POST /api/slack/inbox`. No Slack token in repo or Control. No org-wide Slack. See `scripts/slack-watch.md`.

Out of chip: org-wide / multi-repo, webhooks-in-Control, fuzzy NLP, infinite follows, raising external Needs-you cap, full checkpoint rewrite, CI↔review coalesce, auth / multi-tenant. **V0.8 chip 5 shipped:** BYO surfaces UI, mute, Agents watcher board.

## Stack assumptions

- **Next.js App Router** + TypeScript + Tailwind CSS
- **Zustand** client store hydrated from `src/lib/seed.json`
- No auth, no live Slack ingestion, no database, **no GitHub/Slack tokens in Control**
- Agent delegation + Live auto-kick PR review via default local Pro Claude **worker** (or `control-review-run` for command/fake/claude-cli); Demo keeps 3–8s sim; completion increments the Review badge only (no toasts)
- Slack write for the Priya draft only (confirm-gated outbox -> MCP)
- GitHub PR comment write (confirm-gated `/api/github/outbox` -> local gh / MCP; comment-only)

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
| `/settings` · `/setup` | BYO Live setup (repo, optional pr, teams, slackWatch surfaces → via `PUT /api/watch`) |
| `GET/PUT /api/watch` | Read/write normalized slackWatch config (no restart) |
| `GET/POST/DELETE /api/slack/mutes` | Mute / snooze Slack threads (server `.control/slack-mutes.json`; opaque) |
| `GET/PUT /api/watchers/status` | Agents watcher board (server `.control/watcher-status.json`; opaque) |
| `/source/slack/[id]` | Mocked Slack thread (+ harness link) |
| `/source/github/[id]` | Mocked PR + CI + diff |
| `/source/rfc/[id]` | Mocked RFC section |
| `/source/calendar/[id]` | Mocked calendar event |
| `GET/POST /api/slack/outbox` | Durable Slack outbox for MCP poster (HTTP only) |
| `POST /api/slack/outbox/claim` | Atomic Slack outbox claim (`200` item / `204`) |
| `GET/POST /api/github/outbox` | Durable GitHub comment outbox for local gh/MCP poster (HTTP only) |
| `POST /api/github/outbox/claim` | Atomic GitHub outbox claim (`200` item / `204`) |
| `POST /api/review/run` | Enqueue Live review job (worker default) |
| `POST /api/review/jobs/claim` | Atomic review job claim (`200 { ok, job }` / `204`) |
| `GET /api/review/jobs/:id` | Job status pending / claimed / done / failed |
| `POST /api/review/jobs/:id/heartbeat` | Refresh claim lease |
| `POST /api/review/jobs/:id/result` | Import `control.review_result.v1` |
| `POST /api/review/jobs/:id/fail` | Agent Failed; no invented findings |
| `GET/POST /api/github/inbox` | Durable GitHub inbox (watcher → Control) |
| `GET/POST /api/slack/inbox` | Durable Slack PR-link inbox (watcher → Control) |
| `POST /api/demo/reset` | Clear demo persist instruction; optional `clearInboxes=true` (keeps watch.json / pr-follows) |
| `GET/POST /api/demo/mode` | Optional QA mode echo (`demo` or `live`); client key `control-v0-mode` |
| `GET /api/demo/status` | Watch repo + surface count + DMs/MPIMs + follows for Live banner |
| `POST /api/slack/outbox/:id/ack` | Mark posted after MCP send |
| `POST /api/slack/outbox/:id/fail` | Mark failed |
| `POST /api/github/outbox/:id/ack` | Mark posted after gh comment |
| `POST /api/github/outbox/:id/fail` | Mark failed |
| `POST /api/slack/post` | Soft-disabled (410) |

Command palette (⌘K) opens the launcher (not chat). Includes **Open Live setup**, **Switch to Live**, and **Load demo** (clears `control-v0`, forces Demo + Monday seed without wiping watch.json channels or inbox files).

## Click-through

1. Land on Now morning — day strip, Resume card, needs-you, collapsed FYI.
2. Delegate Priya question — agent Running; on finish Review badge increments, no toast.
3. Resume credential rotation — checkpoint + next step.
4. Start focus — Now quiets; badge may change without interrupting.
5. Open Review — RFC finding, open RFC + PR mocks, Approve/Reject.
6. Approve/edit Slack draft with explicit confirm -> outbox queue -> MCP poster -> ack.
7. On a Live PR Review: Draft comment -> confirm -> `POST /api/github/outbox` -> `./scripts/github-outbox-worker` -> ack.
8. Return to Now — checkpoint updated.
9. Setup → add/remove a Slack surface → Live banner count updates.
10. Mute a Slack Needs-you thread → re-POST same thread → no new Needs-you.
11. Agents → watchers board reflects `PUT /api/watchers/status`.


## V0.8 chip 5 — BYO UX + mute + Agents board

### Dogfood path

1. **Setup UI** (`/settings` or `/setup`) — edit `repo`, optional `pr`, `teams`, `slackWatch.surfaces` (add/remove id+name+kind+prLinks), `includeDms` / `includeMpims` / `myUserId`. **Save watch** → `PUT /api/watch`. No restart. `GET /api/watch` reflects immediately.
2. **Live banner** — `Live · {repo} · {n} channels` (+ `· DMs` / `· MPIMs` when enabled).
3. **MCP Slack watcher** + **`./scripts/control-review-worker`** + Slack/GitHub **outbox posters** (HTTP only) — dogfood as before. Each should **`PUT /api/watchers/status`** on tick:
   ```bash
   curl -sS -X PUT "$CONTROL_BASE_URL/api/watchers/status" \
     -H 'Content-Type: application/json' \
     -d '{"id":"slack-watch","status":"ticking","last_action":"polled 2 surfaces"}'
   ```
   Known ids: `slack-watch` · `github-watch` · `review-worker` · `slack-outbox` · `github-outbox`. Status: `idle|ticking|waiting|error`. Stale if `updated_at` > ~3 min → board shows idle/stale.
4. **Mute thread** on a Slack message Needs-you → `POST /api/slack/mutes` (default 7d snooze). Re-POSTs in that thread root create **no** new Needs-you (event may still store). Unmute (`DELETE /api/slack/mutes`) or expiry restores Needs-you.
5. **Agents** (`/agents`) — Watchers table (Name · Status · Last tick · Last action) from `GET /api/watchers/status`. Empty seed OK (known ids show idle).

**Locked:** `NEEDS_YOU_EXTERNAL_CAP=5` · no tokens in Control · `.control/` paths never in client bundles · no CloudAgent · chips 1–4 unchanged (opaque worker APIs, slackWatch, actionability, slack_draft).

### Mute API

| | |
|--|--|
| `GET /api/slack/mutes` | Active mutes |
| `POST /api/slack/mutes` | `{ channel_id, thread_ts?, message_ts?, expires_at? }` → 201 |
| `DELETE /api/slack/mutes` | `?key=` or `{ key }` where key = `channel_id\|thread_root_ts` |

Mute key = `channel_id` + (`thread_ts` \|\| `message_ts`) so thread replies share one mute.

### Watcher status API

| | |
|--|--|
| `GET /api/watchers/status` | Board rows (known ids seeded idle) |
| `PUT /api/watchers/status` | `{ id, status, last_action, detail? }` |

Never tell clients/workers to open `.control/watcher-status.json`.

## Explicit cuts

Auto-send · urgency ML · org-wide · prompt library / skill pack · fake drafts on Live · FYI firehose for non-actionable Slack · inventing thread history · exposing raw `.control/` to workers.

Team surface, auth, org-wide GitHub / org-wide Slack, channels without PR-URL filter, webhooks-in-Control, NLP without URL, live Calendar ingestion, chat-first UI, toasts on agent complete, inbox-shaped Now / chronological feed, agent builder / free-form prompt, watch.autoReview policy, model-agnostic runner, Team/Mac/chat-home, baking seed as default dogfood, auto-merge, lorem, auto-send without confirm, Slack app / bot-token inside Next, GitHub App / PAT inside Control, raising external Needs-you cap without product call, multi-repo outbox UI, full IDE diff / Monaco / merge button, APPROVE/REQUEST_CHANGES review events from outbox (v1 comment-only).
