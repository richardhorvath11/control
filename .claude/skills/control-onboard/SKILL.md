---
name: control-onboard
description: Onboard and health-check Control end to end (prereqs, dev server, Live config, workers, Claude verify, Slack MCP, GitHub watcher). Use when the user runs /control-onboard, is setting up Control, or says Control "isn't working".
---

# /control-onboard

Goal: get the user to "you're live" with Control, or to an exact, short list of fixes.

## How to run

1. From the repo root, run `./scripts/control-doctor` (add `--json` if you want to parse results).
   It takes ~10–20s because step 5 runs a real `claude -p` verify job; `--fast` (= `--no-verify`) skips
   that and takes ~5s. Use the full run for the final check.
   `CONTROL_BASE_URL` defaults to `http://localhost:3000`; shorthand like `:3000` is normalized.
   The doctor prepends `~/.local/bin` (Claude Code's install dir) to PATH. The **dev server and
   `./scripts/dogfood-up` must also be started with that PATH**, or "server sees claude" fails and the
   review-worker can't run Claude. Restart them from a shell where `which claude` works.
2. Report every step as **PASS / FAIL / WARN / SKIP**, in this order, and for every FAIL give the
   exact `fix:` command the doctor printed. Do not invent success: a SKIP (blocked) is not a pass.
3. Offer to run safe fixes yourself (`npm install && npm run dev` in the background, `./scripts/dogfood-up`
   in the background and left running),
   then re-run `./scripts/control-doctor` and report again. Ask before anything that needs the user's login.

## Steps (what the doctor checks)

1. **Prereqs** — `node`/`npm` versions, `gh auth status`, `claude` on PATH and logged in
   (Pro/Max login via `claude` → `/login`, or headless `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`).
   Never require or suggest `ANTHROPIC_API_KEY`; if it is set, warn: it overrides the Pro login (`unset ANTHROPIC_API_KEY`).
2. **Control reachable** at `CONTROL_BASE_URL`. Fix: `npm install && npm run dev`.
3. **Live configured** — `GET /api/watch` has `repo` and ≥1 `slackWatch` surface. Fix: open `$CONTROL_BASE_URL/get-live`.
4. **Workers** — `./scripts/dogfood-up --check`, and `GET /api/watchers/status` shows `review-worker`,
   `github-outbox`, `github-watch` fresh (reported, not stale, not error). Fix: `./scripts/dogfood-up`.
5. **Verify Claude** — `GET /api/review/claude-status`, then `POST /api/review/run {"kind":"verify"}`,
   poll `GET /api/review/jobs/:id` up to 90s. Timeout = FAIL (fail closed).
6. **Slack MCP** — `claude mcp list` shows a *connected* Slack server. Fix (needs the user, browser OAuth):
   `claude plugin marketplace update anthropic-plugin-directory && claude plugin install slack@anthropic-plugin-directory`
   (shows in `claude mcp list` as `plugin:slack:slack … Connected`; `slack@claude-plugins-official` does not exist
   on CLI 2.1.x), then `/mcp` → slack → Authenticate and **click Allow immediately** — the localhost:3118
   OAuth callback times out fast; just retry if it does.
   Don't suggest bare `claude mcp add … https://mcp.slack.com/mcp` (fails: no dynamic client registration).
   Never add tokens yourself. Also print the agent-loop block from
   `scripts/slack-watch.md`. Plus `./scripts/github-watcher-tick.sh --dry-run` (existing mode: prints
   would-post, does not curl Control at all — no inbox POST, no status PUT).
6b. **Claude Code session hook** — checks that `~/.claude/settings.json` has Control's command hook on
   `Stop` + `SessionEnd`, then pipes a `Test` event through the installed hook and confirms it reaches
   `GET /api/sessions/activity` within 10s. Not installed = WARN. Fix (ask the user first, since it edits their
   global Claude settings): preview with `./scripts/control-doctor --install-hook --dry-run`, then
   `./scripts/control-doctor --install-hook`. It's an idempotent merge that writes a timestamped backup
   `settings.json.control-backup-<UTC>` first and refuses to touch unparseable JSON. Remove with
   `./scripts/control-doctor --uninstall-hook`, which removes only Control's entries. Once it's installed, every Claude Code
   session reports repo/branch/HEAD/diff stat to Control, and a newer session becomes the **Resume** card on
   /now (summary, uncommitted changes, Next, copyable `cd <repo> && claude --resume <id>`).
   If Control is down, events queue in `~/.control-hook/queue/` and replay on the next successful hook run
   (or `node ~/.control-hook/bin/control-session-collect.mjs --replay`).
7. **Summary** — table ending in "you're live" or "fix these N". Exit code is nonzero when anything fails.

## Notes

- The doctor never reads stdin (`exec </dev/null`), so it behaves the same in a terminal, a pty, CI, or `claude -p`.
- Live PR reviews: the review-worker fetches `gh pr view`/`gh pr diff` itself and passes the diff to
  `claude -p`, so headless Claude never needs Bash permission. If gh can't fetch the diff, the job fails
  closed ("could not fetch PR diff via gh"). There's no fake review. Review page → **Review PR #N** kicks the primary PR.

## If the doctor itself won't run

Run it as `bash scripts/control-doctor`. If it reports `script exec bits` FAIL (checkout lost +x — zip
download, copied tree, `core.fileMode=false`), run the printed `chmod +x …`; dogfood-up's workers need it.

## Rules

- Talk to Control over HTTP only. Never read or write `.control/`.
- Never collect, ask for, or print tokens/keys. Never post to Slack.
- If Control is down, steps 3–6 are SKIP (blocked), not pass.
