# GitHub watcher stub (MCP → Control inbox)

Control holds **no** GitHub token. A watcher agent (Grok + GitHub MCP / `gh`) polls a single watched PR and POSTs canonical events into Control.

## Watch config

- Committed example: `watch.example.json`
- Runtime (gitignored): `.control/watch.json` — created from the example/defaults on first inbox API use

Default fields:

| Field | Default |
|-------|---------|
| `repo` | `acme/nightingale` |
| `pr` | `1847` |
| `workstreamId` | `ws-cred` |

## Event types (only)

- `pr.pushed`
- `ci.failed` / `ci.passed`
- `review.requested`
- `review.changes_requested`

## Flow

1. Read `.control/watch.json` (or `watch.example.json`).
2. Use GitHub MCP / `gh` with credentials on the **agent host** (never in Control).
3. For each state change, `POST /api/github/inbox` with a `GitHubInboxEvent`.
4. Control persists under `.control/github-inbox/<id>.json` and routes into Attention Items + workstream.
5. Idempotent: same `id` or same `(type, pr_number, head_sha)` does not duplicate Attention Items.
6. GitHub Needs-you capped at **5**; older GitHub Needs-you drop to FYI. Ingest stays unlimited.

## Example `ci.failed`

```bash
curl -sS -X POST http://localhost:3000/api/github/inbox \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "evt-ci-fail-001",
    "type": "ci.failed",
    "repo": "acme/nightingale",
    "pr_number": 1847,
    "head_sha": "abc1234",
    "summary": "integration-staging failed on retry budget check",
    "occurred_at": "2026-09-07T14:00:00.000Z",
    "provenance": {
      "url": "https://github.com/acme/nightingale/pull/1847/checks",
      "title": "CI · integration-staging",
      "kind": "ci"
    },
    "workstream_id": "ws-cred"
  }'
```

No second UI — events never render as a feed. Debug: `GET /api/github/inbox`.
