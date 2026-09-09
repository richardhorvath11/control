#!/usr/bin/env node
/**
 * control-review-worker — V0.7 chip 3b Local Pro Claude worker (Gastown path).
 *
 * Usage:
 *   ./scripts/control-review-worker --once    # claim one pending job, exit
 *   ./scripts/control-review-worker --watch   # loop until Ctrl-C
 *
 * Auth (dogfood): same-user `claude` login OR CLAUDE_CODE_OAUTH_TOKEN from
 * `claude setup-token`. Never require Console ANTHROPIC_API_KEY.
 * Runs: env -u ANTHROPIC_API_KEY claude -p "…"  (no --bare).
 *
 * Exit: 0 ok · 1 no pending (--once) · 2 retryable · 3 parse · 4 claude missing
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REVIEW_JOB_SCHEMA = "control.review_job.v1";
const REVIEW_RESULT_SCHEMA = "control.review_result.v1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTROL_DIR = path.join(ROOT, ".control");
const JOBS_DIR = path.join(CONTROL_DIR, "review-jobs");
const IN_PROGRESS_DIR = path.join(JOBS_DIR, "in-progress");
const RESULTS_DIR = path.join(CONTROL_DIR, "review-results");

const WATCH_INTERVAL_MS = Number(process.env.CONTROL_REVIEW_WORKER_POLL_MS || 2000);

function usage(code = 0) {
  console.error(
    "Usage: control-review-worker --once|--watch\n" +
      "  Claims oldest .control/review-jobs/*.json (no .claimed),\n" +
      "  runs env -u ANTHROPIC_API_KEY claude -p (no --bare),\n" +
      "  writes .control/review-results/{job_id}.json\n" +
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

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(IN_PROGRESS_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function safeJobId(jobId) {
  return String(jobId).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeRepo(repo) {
  return String(repo)
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .toLowerCase();
}

function validateJob(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Job must be object" };
  if (raw.schema !== REVIEW_JOB_SCHEMA) {
    return { ok: false, error: `schema must be ${REVIEW_JOB_SCHEMA}` };
  }
  if (typeof raw.job_id !== "string" || !raw.job_id.trim()) {
    return { ok: false, error: "job_id required" };
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
  return { ok: true, result: raw };
}

function writeResult(jobId, result) {
  ensureDirs();
  const out = path.join(RESULTS_DIR, `${safeJobId(jobId)}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
  return out;
}

function errorResult(jobId, summary) {
  return {
    schema: REVIEW_RESULT_SCHEMA,
    job_id: jobId,
    status: "error",
    summary,
    findings: [],
    scope: { notes: "Local Pro Claude worker failure." },
  };
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

function listPendingJobs() {
  ensureDirs();
  let names;
  try {
    names = fs.readdirSync(JOBS_DIR);
  } catch {
    return [];
  }
  const pending = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".result.json")) continue;
    if (name.endsWith(".claimed")) continue;
    const base = name.slice(0, -".json".length);
    const jobPath = path.join(JOBS_DIR, name);
    const claimPath = path.join(JOBS_DIR, `${base}.claimed`);
    const inProg = path.join(IN_PROGRESS_DIR, name);
    if (fs.existsSync(claimPath) || fs.existsSync(inProg)) continue;
    // Skip if result already exists (chip 3b dir or legacy colocated .result.json)
    const resultPath = path.join(RESULTS_DIR, `${base}.json`);
    const legacyResult = path.join(JOBS_DIR, `${base}.result.json`);
    if (fs.existsSync(resultPath) || fs.existsSync(legacyResult)) continue;
    let st;
    try {
      st = fs.statSync(jobPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    pending.push({ name, jobPath, claimPath, mtimeMs: st.mtimeMs, base });
  }
  pending.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return pending;
}

function claimJob(entry) {
  // Sidecar .claimed + copy/move into in-progress/
  const claimPayload = {
    claimed_at: new Date().toISOString(),
    pid: process.pid,
    host: process.env.HOSTNAME || "local",
  };
  try {
    fs.writeFileSync(entry.claimPath, JSON.stringify(claimPayload, null, 2), {
      flag: "wx",
    });
  } catch (e) {
    if (e && e.code === "EEXIST") return null;
    // race: another worker
    return null;
  }
  try {
    const dest = path.join(IN_PROGRESS_DIR, entry.name);
    fs.copyFileSync(entry.jobPath, dest);
  } catch {
    /* best-effort in-progress copy */
  }
  return entry;
}

function buildGluePrompt(job, jobPath) {
  const repo = normalizeRepo(job.repo);
  const locator = `${repo}#${job.pr}`;
  return [
    "You are a thin PR review invoke glue for Control (not a product skill/plugin).",
    "Read the job JSON below (and optional job file path) and reply with ONLY one JSON object matching schema control.review_result.v1:",
    '{ "schema":"control.review_result.v1", "job_id", "status":"ok"|"error", "summary", "findings":[{"title","body","evidence":[]}], "scope":{"notes":"…"} }',
    "Findings are analysis claims with evidence — not approval. Keep findings short.",
    `Target: ${locator}`,
    `Job file path: ${jobPath}`,
    "Job JSON:",
    JSON.stringify(job),
  ].join("\n");
}

function runClaude(job, jobPath) {
  const claudeBin = process.env.CONTROL_REVIEW_WORKER_CLAUDE || "claude";
  if (!claudeAvailable(claudeBin)) {
    return { missing: true };
  }

  const glue = buildGluePrompt(job, jobPath);

  // Critical: unset ANTHROPIC_API_KEY so Pro / setup-token auth is used (no --bare).
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  function once() {
    // Prefer env -u when available (POSIX); also delete from env for spawn.
    const useEnvU = process.platform !== "win32";
    const args = useEnvU
      ? ["-u", "ANTHROPIC_API_KEY", claudeBin, "-p", glue]
      : [claudeBin, "-p", glue];
    const cmd = useEnvU ? "env" : claudeBin;
    const spawnArgs = useEnvU ? args : ["-p", glue];
    const r = spawnSync(cmd, spawnArgs, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
      env,
      cwd: ROOT,
    });
    if (r.error && r.error.code === "ENOENT") {
      return { missing: true };
    }
    const parsed = extractJsonObject(r.stdout || "");
    if (!parsed) {
      return {
        ok: false,
        stdout: r.stdout,
        stderr: r.stderr,
        status: r.status,
      };
    }
    const v = validateResult(parsed);
    if (!v.ok) return { ok: false, error: v.error, raw: parsed };
    v.result.job_id = job.job_id;
    return { ok: true, result: v.result };
  }

  let attempt = once();
  if (attempt.missing) return attempt;
  if (!attempt.ok) {
    console.error("claude parse fail; retrying once…", attempt.error || "");
    attempt = once();
  }
  return attempt;
}

function processOne() {
  ensureDirs();
  const pending = listPendingJobs();
  if (pending.length === 0) return { empty: true };

  const claimed = claimJob(pending[0]);
  if (!claimed) return { empty: true }; // lost race

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(claimed.jobPath, "utf8"));
  } catch (e) {
    const jobId = claimed.base;
    const out = writeResult(
      jobId,
      errorResult(jobId, `Agent Failed — bad job JSON: ${e instanceof Error ? e.message : e}`)
    );
    console.error("bad job JSON →", out);
    return { exitCode: 3 };
  }

  const v = validateJob(raw);
  if (!v.ok) {
    const jobId = typeof raw?.job_id === "string" ? raw.job_id : claimed.base;
    writeResult(jobId, errorResult(jobId, `Agent Failed — ${v.error}`));
    console.error(v.error);
    return { exitCode: 3 };
  }
  const job = v.job;
  console.log(`claimed ${job.job_id} · ${normalizeRepo(job.repo)}#${job.pr}`);

  const run = runClaude(job, claimed.jobPath);
  if (run.missing) {
    const out = writeResult(
      job.job_id,
      errorResult(job.job_id, "Agent Failed — claude CLI not found on PATH")
    );
    console.error("claude missing →", out);
    return { exitCode: 4 };
  }
  if (!run.ok) {
    const out = writeResult(
      job.job_id,
      errorResult(
        job.job_id,
        `Agent Failed — could not parse claude output (${run.error || "invalid JSON"})`
      )
    );
    console.error("parse fail →", out);
    return { exitCode: 3 };
  }

  const out = writeResult(job.job_id, run.result);
  console.log(
    `wrote ${out} status=${run.result.status} findings=${run.result.findings?.length ?? 0}`
  );
  return { exitCode: run.result.status === "ok" ? 0 : 0 };
}

function sleep(ms) {
  const sec = Math.max(0.2, ms / 1000);
  spawnSync("sleep", [String(sec)], { stdio: "ignore" });
}

function main() {
  const { once, watch } = parseArgs(process.argv.slice(2));
  ensureDirs();

  if (once) {
    const r = processOne();
    if (r.empty) {
      console.log("no pending review jobs");
      process.exit(1);
    }
    process.exit(r.exitCode ?? 0);
  }

  console.log(
    `control-review-worker watching ${JOBS_DIR} (poll ${WATCH_INTERVAL_MS}ms). Ctrl-C to stop.`
  );
  console.log(
    "Auth: claude login or CLAUDE_CODE_OAUTH_TOKEN — ANTHROPIC_API_KEY is unset for runs."
  );

  // SIGINT handled by default (exit)
  for (;;) {
    const r = processOne();
    if (r.empty) {
      sleep(WATCH_INTERVAL_MS);
      continue;
    }
    if (r.exitCode === 4) {
      // claude missing — keep watching but back off
      sleep(Math.max(WATCH_INTERVAL_MS, 5000));
    } else if (r.exitCode === 2) {
      sleep(WATCH_INTERVAL_MS);
    }
    // after a job, immediately look for next
  }
}

main();
