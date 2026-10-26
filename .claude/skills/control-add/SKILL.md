---
name: control-add
description: Add a manual workstream to Control (something Control can't see on its own, e.g. a task, a thread you owe someone, a branch you're mid-way through). Use when the user runs /control-add, or says "add this to Control", "track this in Control", "remind me in Control".
---

# /control-add

Adds one **Manual** workstream to Control. It shows on /now, can become the Resume card, and can be edited,
marked done or deleted there. It is saved locally in Control (`POST /api/workstreams`). It **never** creates
Slack/GitHub drafts, review jobs or outbox items.

## How to run

1. Work out the fields from what the user said (don't invent any):
   - **title** (required): a short imperative, e.g. "Finish retry backoff in uploader".
   - **note** (optional): where they left off or what's blocking.
   - **link** (optional): a repo/PR/issue URL, only if the user gave one or it's unambiguous from context.
   - **people** (optional): comma-separated names.
   - **when** (optional): free text exactly as the user said it ("Fri", "after standup").
   If there's no title, ask for one. Ask nothing else.
2. From the user's current directory, run (quote every value):
   ```bash
   node <control-repo>/scripts/control-add.mjs --title "…" [--note "…"] [--link "…"] [--people "…"] [--when "…"]
   ```
   Inside the Control repo that's `node scripts/control-add.mjs …`. It infers **repo** (owner/name from the
   `origin` remote), **branch** and the repo root from the current directory. Pass `--cwd DIR` for another directory
   and `--no-git` to skip inference. `--dry-run` prints the request without sending it.
   `CONTROL_BASE_URL` defaults to `http://localhost:3000`.
3. Report the printed result (id, title, repo/branch) and that it's on /now. If it exits 1 (Control down or
   HTTP error), say nothing was saved and give the printed fix. Don't retry in a loop, and don't write `.control/` yourself.

## Rules

- HTTP to Control only. Never read or write `.control/` directly.
- Never post to Slack/GitHub. This skill only creates a local Control item.
- Edits, done and delete happen on /now (or `PATCH`/`DELETE /api/workstreams/:id`), not with this skill.
