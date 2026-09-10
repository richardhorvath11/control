#!/usr/bin/env node
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BASE = (process.env.CONTROL_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
process.env.CONTROL_BASE_URL = BASE;
delete process.env.CONTROL_REVIEW_BACKEND;
const CONTROL_DIR = path.join(ROOT, ".control");
const PID_FILE = path.join(CONTROL_DIR, "dogfood-up.pids");
const TICK_SEC = Number(process.env.GITHUB_TICK_INTERVAL_SEC || 30);
const children = [];
const argv = process.argv.slice(2);
const mode = argv.includes("--check") ? "check" : argv.includes("--stop") ? "stop" : argv.includes("--help") || argv.includes("-h") ? "help" : "run";
function usage() {
  console.log("Usage: ./scripts/dogfood-up [--check|--stop]");
  console.log("CONTROL_BASE_URL default http://localhost:3000");
  console.log("Starts review-worker + github-outbox-worker; github tick loop when present.");
  console.log("Slack MCP stays copy-paste/out-of-band. Ctrl-C or --stop cleans children.");
}

async function checkControlUp() {
  const paths = ["/api/watch", "/api/demo/status"];
  for (const p of paths) {
    try {
      const res = await fetch(BASE + p, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      /* try next */
    }
  }
  console.error("Control unavailable at " + BASE);
  return false;
}

function stopTracked() {
  if (!fs.existsSync(PID_FILE)) {
    console.log("No pid file at " + PID_FILE + " — nothing to stop.");
    return;
  }
  const raw = fs.readFileSync(PID_FILE, "utf8");
  const pids = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log("Stopping pid " + pid);
    } catch {
      /* already gone */
    }
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  console.log("Stopped dogfood workers.");
}

function track(child) {
  if (child.pid) {
    children.push(child);
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    fs.appendFileSync(PID_FILE, String(child.pid) + "\n");
  }
}

function spawnScript(rel, args) {
  const file = path.join(ROOT, rel);
  const child = spawn(file, args, {
    cwd: ROOT,
    env: { ...process.env, CONTROL_BASE_URL: BASE },
    stdio: "inherit",
  });
  track(child);
  child.on("exit", (code, signal) => {
    console.error(path.basename(rel) + " exited code=" + code + " signal=" + (signal || ""));
  });
  return child;
}

function onInterrupt() {
  console.log("\nStopping dogfood children (Ctrl-C)…");
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  console.log("All dogfood workers stopped. Re-run ./scripts/dogfood-up to start again.");
  console.log("(Or use: ./scripts/dogfood-up --stop)");
  process.exit(0);
}

function printSlackCopy() {
  console.log("");
  console.log("=== Slack MCP (out-of-band — copy-paste; no Slack token in Control) ===");
  const md = path.join(ROOT, "scripts/slack-watch.md");
  if (fs.existsSync(md)) {
    console.log("--- from scripts/slack-watch.md ---");
    const text = fs.readFileSync(md, "utf8");
    let show = false;
    for (const line of text.split("\n")) {
      if (/^## Agent loop/.test(line) || /^## Watcher status/.test(line)) show = true;
      if (/^## Mute/.test(line) || /^## Cuts/.test(line)) show = false;
      if (show) console.log(line);
    }
    console.log("--- end slack-watch.md excerpt ---");
  } else {
    console.log("See scripts/slack-watch.md for Slack MCP POST /api/slack/inbox loop.");
  }
  console.log("");
  console.log("Slack outbox poster (HTTP only — MCP host, not this script):");
  console.log("  curl -sS -X POST " + BASE + "/api/slack/outbox/claim -H 'Content-Type: application/json' -d '{}'");
  console.log("  # slack_send_message via Slack MCP using item.channel_id / thread_ts / text");
  console.log("  curl -sS -X POST " + BASE + "/api/slack/outbox/$ID/ack -H 'Content-Type: application/json' -d '{\"reply_ts\":\"…\"}'");
  console.log("  # Heartbeat (optional): PUT /api/watchers/status id=slack-outbox");
  console.log("");
  console.log("Checklist: open Get Live Workers (/get-live/workers) or Agents — local rows");
  console.log("  review-worker · github-outbox · github-watch should green within ~30s.");
  console.log("  slack-watch / slack-outbox are informational and never block Continue to Now.");
  console.log("");
  console.log("Ctrl-C stops children. Or: ./scripts/dogfood-up --stop");
}

async function main() {
  if (mode === "help") { usage(); process.exit(0); }
  if (mode === "check") {
    const ok = await checkControlUp();
    if (!ok) process.exit(1);
    console.log("Control up at " + BASE);
    process.exit(0);
  }
  if (mode === "stop") { stopTracked(); process.exit(0); }

  const ok = await checkControlUp();
  if (!ok) process.exit(1);

  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  if (fs.existsSync(PID_FILE)) stopTracked();
  fs.writeFileSync(PID_FILE, "");

  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  console.log("=== dogfood-up ===");
  console.log("CONTROL_BASE_URL=" + BASE);
  console.log("Starting opaque local workers (no API keys, no fake Live)…");
  console.log("");

  spawnScript("scripts/control-review-worker", ["--watch"]);
  console.log("started control-review-worker --watch");

  spawnScript("scripts/github-outbox-worker", ["--watch"]);
  console.log("started github-outbox-worker --watch");

  const tick = path.join(ROOT, "scripts/github-watcher-tick.sh");
  let canTick = false;
  try { canTick = fs.existsSync(tick) && !!(fs.statSync(tick).mode & 0o111); } catch { canTick = false; }
  if (canTick) {
    const loop = spawn("bash", ["-c", "while true; do \"" + tick + "\" || true; sleep " + TICK_SEC + "; done"], {
      cwd: ROOT,
      env: { ...process.env, CONTROL_BASE_URL: BASE },
      stdio: "inherit",
    });
    track(loop);
    console.log("started github-watcher-tick.sh loop every " + TICK_SEC + "s → status id github-watch");
  } else {
    console.log("NOTE: scripts/github-watcher-tick.sh missing — start GitHub watch manually so checklist id github-watch can green.");
    console.log("  Example: while true; do ./scripts/github-watcher-tick.sh; sleep 30; done");
  }

  printSlackCopy();
  console.log("Waiting (workers running)…");

  setInterval(() => {
    const alive = children.some((c) => c.exitCode === null && !c.killed);
    if (!alive) {
      console.error("All child workers exited.");
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      process.exit(1);
    }
  }, 2000);
}

main().catch((err) => { console.error(err); process.exit(1); });

