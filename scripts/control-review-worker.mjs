#!/usr/bin/env node
/**
 * control-review-worker — V0.8 opaque HTTP worker (Gastown / Live default).
 *
 * Usage:
 *   ./scripts/control-review-worker --once    # claim one pending job, exit
 *   ./scripts/control-review-worker --watch   # loop until Ctrl-C
 *
 * Talks ONLY HTTP to Control (CONTROL_BASE_URL, default http://localhost:3000).
 * Never reads or writes Control private storage. HTTP claim/result/fail only.
 *
 * Auth (dogfood): same-user `claude` login OR CLAUDE_CODE_OAUTH_TOKEN from
 * `claude setup-token`. Never require Console ANTHROPIC_API_KEY.
 * Runs: env -u ANTHROPIC_API_KEY claude -p "…"  (no --bare).
 *
 * Exit: 0 ok · 1 no pending (--once) · 2 retryable · 3 parse · 4 claude missing
 *
 * V0.8 chip 5: optionally PUT /api/watchers/status with id=review-worker on
 * claim/tick (Agents board). HTTP only — never open .control/.
 */


import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REVIEW_JOB_SCHEMA = "control.review_job.v1";
const REVIEW_RESULT_SCHEMA = "control.review_result.v1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BASE = (process.env.CONTROL_BASE_URL || "http://localhost:3000").replace(
  /\/+$/,
  ""
);
const WORKER_ID =
  (process.env.CONTROL_REVIEW_WORKER_ID || "").trim() ||
  `worker-${process.pid}`;
const WATCH_INTERVAL_MS = Number(process.env.CONTROL_REVIEW_WORKER_POLL_MS || 2000);
const HEARTBEAT_MS = Number(process.env.CONTROL_REVIEW_WORKER_HEARTBEAT_MS || 20000);

function usage(code = 0) {
  console.error(
    "Usage: control-review-worker --once|--watch\n" +
      "  POST /api/review/jobs/claim → claude -p → POST result|fail\n" +
      "  CONTROL_BASE_URL default http://localhost:3000\n" +
      "  Auth: claude login OR CLAUDE_CODE_OAUTH_TOKEN — no API key required."
  );
  process.exit(code);
}

function parseArgs(argv) {
  let once = false;
  let watch = false;
  for (const a of argv) {
    if (a === "--once") once = true;
    else if (a === "--watch") watch = true;
    else if (a === "--help" || a === "-h") usage(0);
    else {
      console.error(`Unknown arg: ${a}`);
      usage(3);
    }
  }
  if (once === watch) {
    console.error("Specify exactly one of --once or --watch");
    usage(3);
  }
  return { once, watch };
}

function normalizeRepo(repo) {
  return String(repo)
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .toLowerCase();
}

function resolveKind(raw) {
  if (raw.kind === "slack_draft") return "slack_draft";
  if (raw.kind === "pr_review") return "pr_review";
  if (typeof raw.channel_id === "string" && raw.channel_id.trim()) {
    const hasRepo = typeof raw.repo === "string" && raw.repo.trim();
    const pr =
      typeof raw.pr === "number"
        ? raw.pr
        : typeof raw.pr === "string"
          ? parseInt(raw.pr, 10)
          : NaN;
    if (!(hasRepo && Number.isFinite(pr) && pr > 0)) return "slack_draft";
  }
  return "pr_review";
}

function validateJob(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Job must be object" };
  if (raw.schema !== REVIEW_JOB_SCHEMA) {
    return { ok: false, error: `schema must be ${REVIEW_JOB_SCHEMA}` };
  }
  if (typeof raw.job_id !== "string" || !raw.job_id.trim()) {
    return { ok: false, error: "job_id required" };
  }
  const kind = resolveKind(raw);
  if (kind === "slack_draft") {
    if (typeof raw.channel_id !== "string" || !raw.channel_id.trim()) {
      return { ok: false, error: "channel_id required for slack_draft" };
    }
    if (typeof raw.message_ts !== "string" || !raw.message_ts.trim()) {
      return { ok: false, error: "message_ts required for slack_draft" };
    }
    const message_ts = raw.message_ts.trim();
    const thread_ts =
      typeof raw.thread_ts === "string" && raw.thread_ts.trim()
        ? raw.thread_ts.trim()
        : message_ts;
    return {
      ok: true,
      job: {
        schema: REVIEW_JOB_SCHEMA,
        job_id: raw.job_id.trim(),
        kind: "slack_draft",
        channel_id: raw.channel_id.trim(),
        message_ts,
        thread_ts,
        permalink:
          typeof raw.permalink === "string" ? raw.permalink : undefined,
        text_excerpt:
          typeof raw.text_excerpt === "string" ? raw.text_excerpt : undefined,
        workstream_id:
          typeof raw.workstream_id === "string" ? raw.workstream_id : undefined,
        attention_id:
          typeof raw.attention_id === "string" ? raw.attention_id : undefined,
        provenance: Array.isArray(raw.provenance) ? raw.provenance : [],
      },
    };
  }
  if (typeof raw.repo !== "string" || !raw.repo.trim()) {
    return { ok: false, error: "repo required" };
  }
  const pr =
    typeof raw.pr === "number"
      ? raw.pr
      : typeof raw.pr === "string"
        ? parseInt(raw.pr, 10)
        : NaN;
  if (!Number.isFinite(pr) || pr <= 0) {
    return { ok: false, error: "pr must be positive number" };
  }
  return {
    ok: true,
    job: {
      schema: REVIEW_JOB_SCHEMA,
      job_id: raw.job_id.trim(),
      kind: "pr_review",
      repo: raw.repo.trim(),
      pr: Math.trunc(pr),
      head_sha: typeof raw.head_sha === "string" ? raw.head_sha : undefined,
      workstream_id:
        typeof raw.workstream_id === "string" ? raw.workstream_id : undefined,
      attention_id:
        typeof raw.attention_id === "string" ? raw.attention_id : undefined,
      provenance: Array.isArray(raw.provenance) ? raw.provenance : [],
      snapshot_path:
        typeof raw.snapshot_path === "string" ? raw.snapshot_path : undefined,
    },
  };
}

function validateResult(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Result must be object" };
  if (raw.schema !== REVIEW_RESULT_SCHEMA) {
    return { ok: false, error: `schema must be ${REVIEW_RESULT_SCHEMA}` };
  }
  if (typeof raw.job_id !== "string") return { ok: false, error: "job_id required" };
  if (raw.status !== "ok" && raw.status !== "error") {
    return { ok: false, error: "status must be ok|error" };
  }
  if (typeof raw.summary !== "string") return { ok: false, error: "summary required" };
  if (!Array.isArray(raw.findings)) return { ok: false, error: "findings array required" };
  for (let i = 0; i < raw.findings.length; i++) {
    const f = raw.findings[i];
    if (!f || typeof f.title !== "string" || typeof f.body !== "string") {
      return { ok: false, error: `findings[${i}] needs title+body` };
    }
  }
  // draft_text optional (slack_draft); pass through when present
  return { ok: true, result: raw };
}

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function claudeAvailable(bin) {
  if (!bin) return false;
  if (bin.includes("/") || bin.startsWith(".")) {
    try {
      return fs.existsSync(bin) && fs.statSync(bin).isFile();
    } catch {
      return false;
    }
  }
  return !!which(bin);
}

function extractJsonObject(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function api(method, pathname, body) {
  const url = `${BASE}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}


async function reportWatcherStatus(status, last_action, detail) {
  try {
    await api("PUT", "/api/watchers/status", {
      id: "review-worker",
      status,
      last_action,
      ...(detail ? { detail } : {}),
    });
  } catch {
    /* board is best-effort */
  }
}

async function claimJob() {
  const res = await api("POST", "/api/review/jobs/claim", {
    worker_id: WORKER_ID,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`claim HTTP ${res.status} ${text}`.trim());
  }
  const data = await res.json().catch(() => ({}));
  if (!data || !data.job) return null;
  return data.job;
}

async function postResult(jobId, result) {
  const res = await api("POST", `/api/review/jobs/${encodeURIComponent(jobId)}/result`, {
    ...result,
    job_id: jobId,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`result HTTP ${res.status} ${text}`.trim());
  }
}

async function postFail(jobId, error) {
  const res = await api("POST", `/api/review/jobs/${encodeURIComponent(jobId)}/fail`, {
    error,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fail HTTP ${res.status} ${text}`.trim());
  }
}

function heartbeatLoop(jobId) {
  const tick = () => {
    api("POST", `/api/review/jobs/${encodeURIComponent(jobId)}/heartbeat`, {
      worker_id: WORKER_ID,
    }).catch(() => {});
  };
  const id = setInterval(tick, Math.max(5000, HEARTBEAT_MS));
  return () => clearInterval(id);
}

function buildGluePrompt(job) {
  if (job.kind === "slack_draft") {
    return [
      "You are a thin Slack draft-reply glue for Control (not a product skill/plugin).",
      "Read the inbound Slack message job JSON and reply with ONLY one JSON object matching schema control.review_result.v1:",
      '{ "schema":"control.review_result.v1", "job_id", "status":"ok"|"error", "summary", "draft_text":"…exact reply draft…", "findings":[], "scope":{"notes":"…"} }',
      "Write draft_text as a concise, professional Slack reply to the inbound message. Do not invent facts. findings must be [].",
      `Channel: ${job.channel_id} · thread_ts: ${job.thread_ts} · message_ts: ${job.message_ts}`,
      "Job JSON:",
      JSON.stringify(job),
    ].join("\n");
  }
  const repo = normalizeRepo(job.repo);
  const locator = `${repo}#${job.pr}`;
  return [
    "You are a thin PR review invoke glue for Control (not a product skill/plugin).",
    "Read the job JSON below and reply with ONLY one JSON object matching schema control.review_result.v1:",
    '{ "schema":"control.review_result.v1", "job_id", "status":"ok"|"error", "summary", "findings":[{"title","body","evidence":[]}], "scope":{"notes":"…"} }',
    "Findings are analysis claims with evidence — not approval. Keep findings short.",
    `Target: ${locator}`,
    "Job JSON:",
    JSON.stringify(job),
  ].join("\n");
}

function runClaudeOnce(job) {
  const claudeBin = process.env.CONTROL_REVIEW_WORKER_CLAUDE || "claude";
  if (!claudeAvailable(claudeBin)) {
    return Promise.resolve({ missing: true });
  }

  const glue = buildGluePrompt(job);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve) => {
    const useEnvU = process.platform !== "win32";
    const cmd = useEnvU ? "env" : claudeBin;
    const spawnArgs = useEnvU
      ? ["-u", "ANTHROPIC_API_KEY", claudeBin, "-p", glue]
      : ["-p", glue];
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, spawnArgs, {
      env,
      cwd: ROOT,
    });
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 300_000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 8 * 1024 * 1024) {
        stdout = stdout.slice(-8 * 1024 * 1024);
      }
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      if (e && e.code === "ENOENT") resolve({ missing: true });
      else resolve({ ok: false, error: e.message, stdout, stderr });
    });
    child.on("close", (status) => {
      clearTimeout(killer);
      const parsed = extractJsonObject(stdout);
      if (!parsed) {
        resolve({ ok: false, stdout, stderr, status });
        return;
      }
      const v = validateResult(parsed);
      if (!v.ok) {
        resolve({ ok: false, error: v.error, raw: parsed });
        return;
      }
      v.result.job_id = job.job_id;
      resolve({ ok: true, result: v.result });
    });
  });
}

async function runClaude(job) {
  let attempt = await runClaudeOnce(job);
  if (attempt.missing) return attempt;
  if (!attempt.ok) {
    console.error("claude parse fail; retrying once…", attempt.error || "");
    attempt = await runClaudeOnce(job);
  }
  return attempt;
}

async function processOne() {
  let rawJob;
  try {
    rawJob = await claimJob();
  } catch (e) {
    console.error("claim failed:", e instanceof Error ? e.message : e);
    return { exitCode: 2 };
  }
  if (!rawJob) {
    await reportWatcherStatus("idle", "polled — no pending jobs");
    return { empty: true };
  }

  const v = validateJob(rawJob);
  if (!v.ok) {
    const jobId =
      typeof rawJob?.job_id === "string" && rawJob.job_id.trim()
        ? rawJob.job_id.trim()
        : "";
    if (jobId) {
      try {
        await postFail(jobId, `Agent Failed — ${v.error}`);
      } catch (e) {
        console.error("fail POST failed:", e instanceof Error ? e.message : e);
        return { exitCode: 2 };
      }
    }
    console.error(v.error);
    return { exitCode: 3 };
  }
  const job = v.job;
  console.log(
    job.kind === "slack_draft"
      ? `claimed ${job.job_id} · slack_draft ${job.channel_id} ${job.message_ts}`
      : `claimed ${job.job_id} · ${normalizeRepo(job.repo)}#${job.pr}`
  );
  await reportWatcherStatus(
    "ticking",
    job.kind === "slack_draft"
      ? `claimed slack_draft ${job.job_id}`
      : `claimed ${normalizeRepo(job.repo)}#${job.pr}`
  );

  const stopBeat = heartbeatLoop(job.job_id);
  let run;
  try {
    run = await runClaude(job);
  } finally {
    stopBeat();
  }

  if (run.missing) {
    try {
      await postFail(job.job_id, "Agent Failed — claude CLI not found on PATH");
    } catch (e) {
      console.error("fail POST failed:", e instanceof Error ? e.message : e);
      return { exitCode: 2 };
    }
    console.error("claude missing");
    return { exitCode: 4 };
  }
  if (!run.ok) {
    try {
      await postFail(
        job.job_id,
        `Agent Failed — could not parse claude output (${run.error || "invalid JSON"})`
      );
    } catch (e) {
      console.error("fail POST failed:", e instanceof Error ? e.message : e);
      return { exitCode: 2 };
    }
    console.error("parse fail");
    return { exitCode: 3 };
  }

  // slack_draft: require draft_text on ok — never invent a templated reply
  if (
    job.kind === "slack_draft" &&
    run.result.status === "ok" &&
    typeof run.result.draft_text !== "string"
  ) {
    try {
      await postFail(
        job.job_id,
        "Agent Failed — slack_draft result missing draft_text"
      );
    } catch (e) {
      console.error("fail POST failed:", e instanceof Error ? e.message : e);
      return { exitCode: 2 };
    }
    console.error("missing draft_text");
    return { exitCode: 3 };
  }

  try {
    await postResult(job.job_id, run.result);
  } catch (e) {
    console.error("result POST failed:", e instanceof Error ? e.message : e);
    return { exitCode: 2 };
  }
  console.log(
    `posted result ${job.job_id} status=${run.result.status} findings=${run.result.findings?.length ?? 0}`
  );
  return { exitCode: run.result.status === "ok" ? 0 : 0 };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(200, ms)));
}

async function main() {
  const { once, watch } = parseArgs(process.argv.slice(2));

  if (once) {
    const r = await processOne();
    if (r.empty) {
      console.log("no pending review jobs");
      process.exit(1);
    }
    process.exit(r.exitCode ?? 0);
  }

  console.log(
    `control-review-worker watching ${BASE}/api/review/jobs (poll ${WATCH_INTERVAL_MS}ms). Ctrl-C to stop.`
  );
  console.log(
    "Auth: claude login or CLAUDE_CODE_OAUTH_TOKEN — ANTHROPIC_API_KEY is unset for runs."
  );
  await reportWatcherStatus("idle", "worker started — watching for jobs");

  for (;;) {
    const r = await processOne();
    if (r.empty) {
      await sleep(WATCH_INTERVAL_MS);
      continue;
    }
    if (r.exitCode === 4) {
      await sleep(Math.max(WATCH_INTERVAL_MS, 5000));
    } else if (r.exitCode === 2) {
      await sleep(WATCH_INTERVAL_MS);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
