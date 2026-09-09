#!/usr/bin/env node
/**
 * control-review-run — V0.7 chip 3 invoke hook (NOT a skill).
 *
 * Usage: ./scripts/control-review-run --in job.json --out result.json
 *
 * Env:
 *   CONTROL_REVIEW_BACKEND = claude-cli | cursor-cloud | fake | command
 *   CONTROL_REVIEW_COMMAND  = optional when command — e.g. `my-pr-review --in {{in}} --out {{out}}`
 *
 * Exit: 0 ok, 2 retryable, 3 bad parse/job, 4 backend missing.
 *
 * Minimal glue prompt for claude-cli lives here only — not a product skill pack.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REVIEW_JOB_SCHEMA = "control.review_job.v1";
const REVIEW_RESULT_SCHEMA = "control.review_result.v1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage(code = 3) {
  console.error(
    "Usage: control-review-run --in <job.json> --out <result.json>\n" +
      "  CONTROL_REVIEW_BACKEND=claude-cli|cursor-cloud|fake|command\n" +
      "  CONTROL_REVIEW_COMMAND='cmd --in {{in}} --out {{out}}'  # when command"
  );
  process.exit(code);
}

function parseArgs(argv) {
  let inn = null;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in" || a === "-i") {
      inn = argv[++i];
    } else if (a === "--out" || a === "-o") {
      out = argv[++i];
    } else if (a === "--help" || a === "-h") {
      usage(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      usage(3);
    }
  }
  if (!inn || !out) usage(3);
  return { inn, out };
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

function writeResult(outPath, result) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
}

function fakeResult(job) {
  const repo = normalizeRepo(job.repo);
  const pr = job.pr;
  const locator = `${repo}#${pr}`;
  const url = `https://github.com/${repo}/pull/${pr}`;
  return {
    schema: REVIEW_RESULT_SCHEMA,
    job_id: job.job_id,
    status: "ok",
    summary: `Fake backend surface checks on ${locator} (test-only).`,
    findings: [
      {
        title: `Surface checks on ${locator}`,
        body: `Fake independent review of ${locator}. Confirm CI status, outstanding review threads, and whether the ask still needs a human judgment. Findings are claims with evidence — not an approval. (CONTROL_REVIEW_BACKEND=fake — CI/smoke only.)`,
        evidence: [
          {
            kind: "github",
            title: locator,
            locator,
            excerpt: `Fake pass over ${locator}. Analysis, not truth.`,
            sourceId: `fake-pr-${repo.replace(/[^a-z0-9]+/gi, "-")}-${pr}`,
            url,
          },
        ],
      },
    ],
    scope: {
      notes: `Examined ${locator} · fake backend (test-only). Absence of findings is not approval.`,
    },
  };
}

function cursorCloudStub(job) {
  return {
    schema: REVIEW_RESULT_SCHEMA,
    job_id: job.job_id,
    status: "error",
    summary: "Agent Failed — cursor-cloud not configured",
    findings: [],
    scope: {
      notes: "cursor-cloud backend stub; configure a real cloud agent later.",
    },
  };
}

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
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

function runClaudeCli(job, outPath) {
  if (!which("claude")) {
    console.error("claude CLI not found on PATH");
    process.exit(4);
  }
  const glue = [
    "You are a thin PR review invoke glue (not a product skill).",
    "Read the job JSON and reply with ONLY one JSON object matching schema control.review_result.v1:",
    '{ "schema":"control.review_result.v1", "job_id", "status":"ok"|"error", "summary", "findings":[{"title","body","evidence":[]}], "scope":{"notes":"…"} }',
    "Findings are analysis claims with evidence — not approval. Keep findings short.",
    "Job JSON:",
    JSON.stringify(job),
  ].join("\n");

  function once() {
    const r = spawnSync("claude", ["-p", glue], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
    if (r.error && r.error.code === "ENOENT") {
      console.error("claude CLI missing");
      process.exit(4);
    }
    const parsed = extractJsonObject(r.stdout || "");
    if (!parsed) return { ok: false, stdout: r.stdout, stderr: r.stderr, status: r.status };
    const v = validateResult(parsed);
    if (!v.ok) return { ok: false, error: v.error, raw: parsed };
    // Ensure job_id matches
    v.result.job_id = job.job_id;
    return { ok: true, result: v.result };
  }

  let attempt = once();
  if (!attempt.ok) {
    console.error("claude-cli parse fail; retrying once…", attempt.error || "");
    attempt = once();
  }
  if (!attempt.ok) {
    console.error("claude-cli failed to produce valid result");
    process.exit(3);
  }
  writeResult(outPath, attempt.result);
  process.exit(attempt.result.status === "ok" ? 0 : 0);
}

function runCommand(job, inPath, outPath) {
  const tmpl = (process.env.CONTROL_REVIEW_COMMAND || "").trim();
  if (!tmpl) {
    console.error("CONTROL_REVIEW_COMMAND required when backend=command");
    process.exit(4);
  }
  const cmd = tmpl
    .replaceAll("{{in}}", inPath)
    .replaceAll("{{out}}", outPath)
    .replaceAll("{{job_id}}", job.job_id);
  const r = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
    env: process.env,
  });
  if (r.status === 4 || (r.error && r.error.code === "ENOENT")) {
    console.error(r.stderr || r.error?.message || "command backend missing");
    process.exit(4);
  }
  if (r.status === 2) process.exit(2);
  if (r.status === 3) process.exit(3);
  if (!fs.existsSync(outPath)) {
    console.error("command backend did not write --out result");
    process.exit(3);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    console.error("command backend wrote invalid JSON");
    process.exit(3);
  }
  const v = validateResult(raw);
  if (!v.ok) {
    console.error(v.error);
    process.exit(3);
  }
  process.exit(r.status === 0 ? 0 : r.status ?? 2);
}

function main() {
  const { inn, out } = parseArgs(process.argv.slice(2));
  const inPath = path.resolve(inn);
  const outPath = path.resolve(out);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
  } catch (e) {
    console.error("Bad job JSON:", e instanceof Error ? e.message : e);
    process.exit(3);
  }
  const v = validateJob(raw);
  if (!v.ok) {
    console.error(v.error);
    process.exit(3);
  }
  const job = v.job;

  const backend = (process.env.CONTROL_REVIEW_BACKEND || "").trim().toLowerCase();
  if (!backend) {
    console.error(
      "CONTROL_REVIEW_BACKEND unset — set claude-cli | cursor-cloud | fake | command"
    );
    process.exit(4);
  }

  if (backend === "fake") {
    writeResult(outPath, fakeResult(job));
    process.exit(0);
  }
  if (backend === "cursor-cloud") {
    writeResult(outPath, cursorCloudStub(job));
    process.exit(0);
  }
  if (backend === "claude-cli") {
    runClaudeCli(job, outPath);
    return;
  }
  if (backend === "command") {
    runCommand(job, inPath, outPath);
    return;
  }

  console.error(
    `Unknown CONTROL_REVIEW_BACKEND=${backend} (expected claude-cli|cursor-cloud|fake|command)`
  );
  process.exit(4);
}

main();
