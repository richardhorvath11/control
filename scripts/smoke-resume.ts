/**
 * Smoke: Live Resume on /now — selection, "what changed" diff, context, primary action, Next job.
 * Hermetic: pure resume-core + the worker's resume_next path against a mock jobs HTTP API with
 * stub `gh`/`claude` on PATH. Touches no real server, .control, GitHub or Slack; posts nothing.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  activityHash,
  buildResumeContext,
  changesSince,
  deriveWorkstreams,
  groupChanges,
  primaryAction,
  prContextEvents,
  selectResume,
  type ActivityStore,
  type ResumeJobSummary,
} from "../src/lib/resume-core";
import { validateReviewJob, validateReviewResult, REVIEW_RESULT_SCHEMA } from "../src/lib/review-contracts";

let failed = 0;
function assert(c: unknown, m: string) { if (c) console.log(`ok  ${m}`); else { failed++; console.error(`FAIL ${m}`); } }

const REPO = "acme/app";
const t = (m: number) => new Date(Date.UTC(2026, 9, 24, 12, m)).toISOString();
const gh = [
  { id: "g1", applied: true, event: { id: "e1", type: "review.requested", repo: REPO, pr_number: 7, summary: "Review requested from you", occurred_at: t(1) }, effects: {} },
  { id: "g2", applied: true, event: { id: "e2", type: "ci.failed", repo: REPO, pr_number: 9, summary: "CI failed", occurred_at: t(2) }, effects: { ignored: true } },
];
const slack = [
  { id: "s1", applied: true, event: { id: "m1", type: "pr_link", channel_id: "C1", message_ts: "100.1", permalink: "https://real.slack.com/archives/C1/p1001", text_excerpt: "please review acme/app#7", occurred_at: t(3), repo: REPO, pr_number: 7 } },
  { id: "s2", applied: true, event: { id: "m2", type: "message", channel_id: "C2", message_ts: "200.1", permalink: "https://real.slack.com/archives/C2/p2001", text_excerpt: "can you ship the fix today?", occurred_at: t(4) }, effects: { attention: { why: "question to you" } } },
  { id: "s3", applied: true, event: { id: "m3", type: "message", channel_id: "C2", message_ts: "200.5", thread_ts: "200.1", permalink: "https://real.slack.com/archives/C2/p2005", text_excerpt: "ping — any update?", occurred_at: t(20) } },
  { id: "s4", applied: true, event: { id: "m4", type: "message", channel_id: "D0QA", message_ts: "300.1", permalink: "https://example.slack.com/archives/D0QA/p1", text_excerpt: "fixture?", occurred_at: t(30) }, effects: { attention: { why: "x" } } },
  { id: "s5", applied: true, event: { id: "m5", type: "message", channel_id: "C3", message_ts: "400.1", permalink: "https://real.slack.com/x", text_excerpt: "muted chatter?", occurred_at: t(31) }, effects: { muted: true, attention: { why: "x" } } },
];
const jobs: ResumeJobSummary[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ job_id: `rj-d${i}`, kind: "slack_draft", status: "done" as const, channel_id: "C2", thread_ts: "200.1", message_ts: "200.1", created_at: t(5), finished_at: t(6 + i), result_status: "ok" as const, draft_text: `draft ${i}` })),
  { job_id: "rj-rev", kind: "pr_review", status: "done", repo: REPO, pr: 7, created_at: t(5), finished_at: t(10), result_status: "ok", summary: "2 findings", findings: [{ title: "Null deref", body: "x may be null", evidence: ["src/a.ts:12"] }, { title: "Typo", body: "t", evidence: ["README.md:3"] }], draft_text: "notes" },
  { job_id: "rj-res", kind: "resume_next", status: "done", repo: REPO, pr: 7, created_at: t(40), finished_at: t(41) },
];
const snaps = [{ repo: REPO, pr: 7, title: "Fix login", url: "https://github.com/acme/app/pull/7", head_sha: "abcdef1234", ci: { conclusion: "FAILURE", url: "https://ci/1" }, files: [{ path: "src/a.ts", status: "modified" }], requested_reviewers: { users: ["bob"], teams: [] }, updated_at: t(8) }];

async function main() {
  const ws = deriveWorkstreams({ githubItems: gh as any, slackItems: slack as any, jobs, snapshots: snaps });
  const keys = ws.map((w) => w.key).sort();
  assert(keys.join() === ["pr:acme/app#7", "slack:C2:200.1"].join(), `derives PR + Slack thread workstreams (got ${keys})`);
  assert(!keys.some((k) => k.includes("D0QA") || k.includes("C3") || k.includes("#9")), "fixture / muted / ignored items create no workstream");
  assert(!ws.some((w) => w.jobs.some((j) => j.kind === "resume_next")), "resume_next jobs are not activity");
  const pr = ws.find((w) => w.kind === "pr")!;
  const th = ws.find((w) => w.kind === "slack")!;
  assert(pr.title.startsWith("Fix login") && pr.events.some((e) => e.kind === "review_request" && /Slack/.test(e.label)), "PR takes snapshot title + Slack review ask");
  assert(th.events.some((e) => e.kind === "slack_reply"), "thread reply joins its thread");

  // Rule 2: nothing touched → most distinct activity; 12 re-run drafts don't outweigh real events
  const s0 = selectResume(ws, {})!;
  assert(s0.rule === "most_new_activity" && s0.workstream.key === pr.key, `untouched → most distinct activity wins (PR; got ${s0.workstream.key})`);
  assert(s0.others.some((o) => o.key === th.key), "others lists the thread");

  // Rule 1: most recently touched wins regardless of activity
  const act: ActivityStore = {
    [pr.key]: { key: pr.key, last_action: { kind: "opened", label: "Opened review", at: t(11) }, history: [{ kind: "opened", label: "Opened review", at: t(11) }] },
    [th.key]: { key: th.key, last_action: { kind: "edited_draft", label: "Edited draft", at: t(15), detail: { draft: "my words" } }, history: [{ kind: "edited_draft", label: "Edited draft", at: t(15), detail: { draft: "my words" } }] },
  };
  const s1 = selectResume(ws, act)!;
  assert(s1.rule === "most_recently_touched" && s1.workstream.key === th.key, "touched → most recent last action wins");

  // What changed since last active
  const ch = changesSince(th, act[th.key].last_action.at);
  assert(ch.length > 0 && ch.every((e) => e.at > t(15)), "changesSince only returns events after last active");
  assert(ch.some((e) => /any update/.test(e.label)), "new Slack reply is a change");
  const g = groupChanges(ch);
  assert(g.find((x) => x.kind === "job_done")?.count === ch.filter((e) => e.kind === "job_done").length, "groupChanges collapses repeats per kind");
  const extra = prContextEvents({ comments: [{ author: "bob", body: "please rename", created_at: t(50), url: "u" }], reviews: [{ author: "bob", state: "CHANGES_REQUESTED", submitted_at: t(51) }] });
  const chPr = changesSince(pr, act[pr.key].last_action.at, extra);
  assert(chPr.some((e) => e.kind === "pr_comment") && chPr.some((e) => e.kind === "pr_review"), "worker gh comments/reviews feed what changed");
  assert(!changesSince(pr, t(59)).length, "nothing after now → no changes");

  // Hash: stable, changes with activity or last action
  const h1 = activityHash(pr, act[pr.key].last_action);
  assert(h1 === activityHash(pr, act[pr.key].last_action), "activity hash stable");
  assert(h1 !== activityHash(pr, { kind: "approved", label: "a", at: t(55) }), "hash changes when the user acts");
  const pr2 = { ...pr, events: [...pr.events, { id: "new", at: t(56), kind: "pr_event" as const, label: "pushed" }] };
  assert(h1 !== activityHash(pr2, act[pr.key].last_action), "hash changes on new activity");

  // Context + primary action
  const ctx = buildResumeContext(pr, act[pr.key], snaps[0]);
  assert(ctx.what.url === snaps[0].url && ctx.what.head_sha === "abcdef1234", "context: what (link, head)");
  assert(ctx.open.some((o) => o.severity === "blocking" && /CI FAILURE/.test(o.label)), "context: failed CI is blocking");
  assert(ctx.open.some((o) => /bob/.test(o.label)), "context: requested reviewers");
  assert(ctx.left_off.latest_review?.findings.length === 2, "context: left off with review findings");
  assert(primaryAction(pr, ctx, act[pr.key]).kind === "open_review", "un-triaged findings → Resume opens the review");
  const acted = { ...act[pr.key], history: [{ kind: "approved", label: "Approved", at: t(12) }, ...act[pr.key].history] };
  assert(primaryAction(pr, buildResumeContext(pr, acted, snaps[0]), acted).kind === "focus", "after approve → Focus");
  const tctx = buildResumeContext(th, act[th.key]);
  assert(tctx.left_off.user_draft === "my words", "context: user's last edited draft");
  assert(primaryAction(th, tctx, act[th.key]).kind === "open_draft", "pending draft reply → Resume opens it");
  assert(tctx.open.some((o) => /Unanswered question/.test(o.label)), "context: unanswered Slack question");
  assert(selectResume([], {}) === null, "no workstreams → empty state (null)");

  // Contracts accept resume_next + pass resume through
  const vj = validateReviewJob({ schema: "control.review_job.v1", job_id: "rj-x", kind: "resume_next", workstream_key: pr.key, activity_hash: h1, repo: REPO, pr: 7, resume_context: { a: 1 } });
  assert(vj.ok && vj.job.kind === "resume_next" && !!vj.job.resume_context, "contracts: resume_next job validates (not coerced to pr_review)");
  const vr = validateReviewResult({ schema: REVIEW_RESULT_SCHEMA, job_id: "rj-x", status: "ok", summary: "n", findings: [], resume: { next: "Do X", why: "y", pr_context: { state: "OPEN" } } });
  assert(vr.ok && vr.result.resume?.next === "Do X", "contracts: result keeps resume.next");

  // Worker: deterministic hunks + no-tools claude + fail closed
  const { parseLocations, extractHunks } = await import("./control-review-worker.mjs" as string);
  const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -8,6 +8,7 @@ fn\n l8\n l9\n l10\n l11\n+const y = x.z; // 12\n l13\n l14\n";
  const hunks = extractHunks(diff, parseLocations(["src/a.ts:12 x.z"]).map((l: any) => ({ ...l, finding: "Null deref" })));
  assert(hunks.length === 1 && hunks[0].line === 12 && /\b12 \+const y = x\.z/.test(hunks[0].text), "worker extracts the diff hunk at the finding location");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-resume-smoke-"));
  const argvLog = path.join(dir, "argv"), stdinLog = path.join(dir, "stdin");
  fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash
if [ "$2" = view ]; then echo '{"number":7,"title":"Fix login","url":"u","state":"OPEN","isDraft":false,"reviewDecision":"CHANGES_REQUESTED","reviewRequests":[{"login":"bob"}],"latestReviews":[],"comments":[{"author":{"login":"bob"},"body":"rename pls","createdAt":"${t(50)}","url":"cu"}],"statusCheckRollup":[{"name":"ci","conclusion":"FAILURE","detailsUrl":"d"}],"headRefOid":"abcdef1234"}'; exit 0; fi
if [ "$2" = diff ]; then printf '${diff.replace(/\n/g, "\\n")}'; exit 0; fi
exit 9
`, { mode: 0o755 });
  const claudeBody = (out: string) => `#!/usr/bin/env bash
for a in "$@"; do printf '[%s]\\n' "$a"; done > "${argvLog}"
cat > "${stdinLog}"
${out}
`;
  async function run(out: string) {
    fs.writeFileSync(path.join(dir, "claude"), claudeBody(out), { mode: 0o755 });
    const posted: any[] = [];
    let served = false;
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        if (req.url === "/api/review/jobs/claim") {
          if (served) { res.statusCode = 204; return res.end(); }
          served = true;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ job: { schema: "control.review_job.v1", job_id: "rj-smk-res", kind: "resume_next", workstream_key: pr.key, activity_hash: h1, repo: REPO, pr: 7, resume_context: { workstream: { key: pr.key }, context: ctx } } }));
        }
        const m = (req.url || "").match(/\/(result|fail)$/);
        if (m) posted.push({ kind: m[1], body: JSON.parse(b || "{}") });
        res.setHeader("content-type", "application/json"); res.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    await new Promise<void>((resolve) => {
      const ch = spawn("node", ["scripts/control-review-worker.mjs", "--once"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONTROL_BASE_URL: `http://127.0.0.1:${port}`, CONTROL_REVIEW_WORKER_CLAUDE: path.join(dir, "claude") },
        stdio: "ignore",
      });
      ch.on("exit", () => resolve());
    });
    srv.close();
    return posted;
  }
  const ok = await run(`echo '{"next":"Fix the null deref in src/a.ts:12, then answer bob.","why":"CI failing; bob requested changes"}'`);
  const r = ok.find((p) => p.kind === "result")?.body;
  const argv = fs.readFileSync(argvLog, "utf8"), stdin = fs.readFileSync(stdinLog, "utf8");
  assert(r?.status === "ok" && r.resume.next.startsWith("Fix the null deref"), "worker posts Claude's Next");
  assert(argv.includes("[--tools]\n[]\n") && argv.includes("[--permission-prompts]\n[none]") && !/skip-permissions/.test(argv), "claude spawned with tools disabled, no skip-permissions");
  assert(/rename pls/.test(stdin) && /Null deref/.test(stdin), "prompt carries gh comments + review findings");
  assert(r?.resume.pr_context.hunks?.[0]?.line === 12 && r.resume.pr_context.comments?.[0]?.created_at === t(50), "result carries hunks + comments for the card");
  const bad = await run(`echo 'I think you should probably just keep going'`);
  const rb = bad.find((p) => p.kind === "result")?.body;
  assert(rb?.status === "error" && rb.resume.next === "" && /^Next unavailable — could not parse/.test(rb.summary), "unparseable Claude → Next unavailable + reason (no fake text)");
  assert(!!rb?.resume.pr_context?.comments, "fail closed still returns gh context");
  fs.rmSync(dir, { recursive: true, force: true });

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nsmoke-resume: all passed");
}
main();
