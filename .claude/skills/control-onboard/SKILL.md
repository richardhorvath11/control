---
name: control-onboard
description: Onboard a developer onto Control and prove everything works — prereqs (node, gh, claude Pro login), Control dev server, Live watch config, dogfood workers, Verify Claude, and Slack MCP. Use when someone says "set up Control", "is Control working", "onboard me", or runs /control-onboard.
---

# Control onboarding (/control-onboard)

Goal: get the user from zero to **Live** and prove each piece works. Run the steps **in order**, report **PASS/FAIL per step**, and on any FAIL give the **exact next command**. Safe to rerun.

## Rules (non-negotiable)
- Talk to Control **over HTTP only** at `CONTROL_BASE_URL` (default `http://localhost:3000`). **Never** read or write `.control/` files.
- **No tokens or secrets.** Never ask for or set `ANTHROPIC_API_KEY`; Claude uses Pro login (`claude`) or `claude setup-token`. No Slack/GitHub tokens in Control.
- **No fake success.** If a check can't run, it's FAIL (or SKIPPED with reason). Never set `CONTROL_REVIEW_BACKEND=fake`.
- **Send no Slack messages.** Don't call `slack_send_message` or claim the Slack outbox.
- Idempotent: the only write is `POST /api/review/run {kind:"verify"}`, which Control dedupes while a verify job is pending/claimed.

## Fast path
From the repo root run the doctor and relay its output:

```bash
./scripts/control-doctor            # all steps
./scripts/control-doctor --no-verify   # skip the POST verify job
./scripts/control-doctor --tick-dry-run   # also run ./scripts/github-watcher-tick.sh --dry-run
```
Exit 0 = live, 1 = something to fix. Then walk the user through each FAIL using the steps below, fix one thing, and rerun.

## Steps
1. **Prereqs** — `node -v && npm -v`; `gh auth status` (fix: `gh auth login`); `command -v claude` (fix: `npm install -g @anthropic-ai/claude-code`, then `claude` to log in with Pro, or `claude setup-token`). Login itself is proven in step 5.
2. **Control reachable** — `curl -sS $CONTROL_BASE_URL/api/watch`. Fail → `npm install && npm run dev` (keep it running in its own terminal).
3. **Live configured** — `GET /api/watch` → `watch.configured === true` (non-empty `repo` and ≥1 `slackWatch` surface, or includeDms/includeMpims). Fail → open `/get-live`, set repo + Slack surface, **Continue → Live**.
4. **Workers** — in a separate terminal `./scripts/dogfood-up` (leave running); `./scripts/dogfood-up --check` to recheck. Then `GET /api/watchers/status` → rows `review-worker`, `github-outbox`, `github-watch` have `display_status` idle/ticking/waiting **and** have reported (`updated_at` set, not `stale`).
5. **Verify Claude** — `GET /api/review/claude-status` (`ok`, `hint`); `POST /api/review/run` `{"kind":"verify"}` → `job.id`; poll `GET /api/review/jobs/:id` every 3s up to **90s** until `status: done` with result `claude ok`. Fail → follow `hint` (`claude` / `claude setup-token` / `./scripts/dogfood-up`).
6. **Slack MCP** — `claude mcp list` should include a Slack server. Missing → add one with `claude mcp add …`, then show the user the **Agent loop** section of `scripts/slack-watch.md` (Slack MCP → `POST /api/slack/inbox`; no Slack token in Control). Optional: `./scripts/github-watcher-tick.sh --dry-run`.
7. **Summary** — table of every check (PASS/FAIL + next command), then one line: **"✅ You're live."** or **"❌ Fix these N things"**.

## References
README.md → Dogfood, Reference, Verify Claude, Standing watchers, Watcher status API; `scripts/dogfood-up`, `scripts/slack-watch.md`, `scripts/github-watcher.md`.
