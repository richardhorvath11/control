#!/usr/bin/env node
/**
 * control-hook-install — add/remove Control's Claude Code hook in ~/.claude/settings.json.
 *
 *   node scripts/control-hook-install.mjs [--install|--uninstall|--check] [--dry-run] [--json]
 *
 * install:   copy control-session-hook + control-session-collect.mjs to ~/.control-hook/bin/,
 *            back up settings.json (settings.json.control-backup-<ts>), then MERGE one command handler
 *            under hooks.Stop and hooks.SessionEnd. Every other key / hook is kept byte-for-byte
 *            semantically. Idempotent: a second run changes nothing (and writes no backup).
 * uninstall: remove only handlers whose command is our hook path (any …/control-session-hook);
 *            drops groups/events/"hooks" that become empty because of that. Backup first.
 * check:     exit 0 when installed (both events point at an existing executable hook).
 * --dry-run: print the planned settings.json and file copies; write nothing.
 * Env: HOME (tests use a temp HOME), CONTROL_BASE_URL (stored in ~/.control-hook/config.json).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_EVENTS = ["Stop", "SessionEnd"];
export const HOOK_MARK = "control-session-hook";
/** SessionEnd hooks share a 1.5 s budget by default; ours exits in ms, 5 s is headroom only. */
export const HOOK_TIMEOUT_S = 5;

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export function paths(home = os.homedir()) {
  const hookHome = path.join(home, ".control-hook");
  return {
    settings: path.join(home, ".claude", "settings.json"),
    hookHome,
    bin: path.join(hookHome, "bin"),
    hook: path.join(hookHome, "bin", "control-session-hook"),
    collector: path.join(hookHome, "bin", "control-session-collect.mjs"),
    config: path.join(hookHome, "config.json"),
  };
}

export const isOurs = (h) => !!h && h.type === "command" && typeof h.command === "string" && h.command.includes(HOOK_MARK);

/** Pure: settings object + hook path → merged settings (new object). */
export function mergeHook(settings, hookPath) {
  const s = JSON.parse(JSON.stringify(settings ?? {}));
  if (!s.hooks || typeof s.hooks !== "object" || Array.isArray(s.hooks)) s.hooks = {};
  for (const ev of HOOK_EVENTS) {
    const groups = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
    // Drop stale copies of ours (e.g. an older path), keep everything else as-is.
    const cleaned = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h) || h.command === hookPath) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    const present = cleaned.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h) && h.command === hookPath));
    if (!present) cleaned.push({ hooks: [{ type: "command", command: hookPath, timeout: HOOK_TIMEOUT_S }] });
    s.hooks[ev] = cleaned;
  }
  return s;
}

/** Pure: remove only our handlers. */
export function removeHook(settings) {
  const s = JSON.parse(JSON.stringify(settings ?? {}));
  if (!s.hooks || typeof s.hooks !== "object") return s;
  for (const ev of Object.keys(s.hooks)) {
    const groups = s.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const touched = groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs));
    if (!touched) continue;
    const next = groups
      .map((g) => (g && Array.isArray(g.hooks) && g.hooks.some(isOurs) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (next.length) s.hooks[ev] = next;
    else delete s.hooks[ev];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  return s;
}

export function hookStatus(settings, hookPath) {
  const ev = {};
  for (const e of HOOK_EVENTS) {
    const groups = settings?.hooks?.[e];
    ev[e] = Array.isArray(groups) && groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h) && h.command === hookPath));
  }
  return ev;
}

function readSettings(p) {
  if (!fs.existsSync(p)) return { exists: false, value: {} };
  const raw = fs.readFileSync(p, "utf8");
  if (!raw.trim()) return { exists: true, value: {}, raw };
  // Fail closed on unparseable settings: never overwrite a file we can't read.
  return { exists: true, value: JSON.parse(raw), raw };
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function writeAtomic(p, text, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.control-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, p);
}

export function run({ action = "install", dryRun = false, home = os.homedir(), now = new Date(), log = console.log } = {}) {
  const P = paths(home);
  const cur = readSettings(P.settings);
  const out = { action, dry_run: dryRun, settings: P.settings, hook: P.hook, changed: false, backup: null, files: [] };

  if (action === "check") {
    const st = hookStatus(cur.value, P.hook);
    const exec = fs.existsSync(P.hook) && (fs.statSync(P.hook).mode & 0o111) !== 0 && fs.existsSync(P.collector);
    Object.assign(out, { events: st, hook_executable: exec, installed: exec && HOOK_EVENTS.every((e) => st[e]) });
    return out;
  }

  const next = action === "uninstall" ? removeHook(cur.value) : mergeHook(cur.value, P.hook);
  const before = JSON.stringify(cur.value);
  const after = JSON.stringify(next);
  out.changed = before !== after;
  const text = JSON.stringify(next, null, 2) + "\n";

  if (action === "install") {
    const node = process.execPath;
    const hookSrc = fs.readFileSync(path.join(SRC_DIR, "control-session-hook"), "utf8").replace("__CONTROL_HOOK_NODE__", node);
    const collSrc = fs.readFileSync(path.join(SRC_DIR, "control-session-collect.mjs"), "utf8");
    const cfg = JSON.stringify({ control_base_url: process.env.CONTROL_BASE_URL || "http://localhost:3000", node }, null, 2) + "\n";
    const plan = [
      [P.hook, hookSrc, 0o755],
      [P.collector, collSrc, 0o644],
      [P.config, cfg, 0o644],
    ];
    for (const [p, body, mode] of plan) {
      const same = fs.existsSync(p) && fs.readFileSync(p, "utf8") === body;
      out.files.push({ path: p, change: same ? "unchanged" : fs.existsSync(p) ? "update" : "create" });
      if (!dryRun && !same) writeAtomic(p, body, mode);
    }
    if (!dryRun) for (const d of ["queue", "spool"]) fs.mkdirSync(path.join(P.hookHome, d), { recursive: true });
  }

  if (out.changed) {
    if (cur.exists) out.backup = `${P.settings}.control-backup-${stamp(now)}`;
    if (dryRun) {
      log(`--dry-run: would ${cur.exists ? `back up to ${out.backup} and ` : "create "}write ${P.settings}:`);
      log(text);
    } else {
      if (cur.exists) fs.copyFileSync(P.settings, out.backup);
      writeAtomic(P.settings, text);
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const action = a.includes("--uninstall") ? "uninstall" : a.includes("--check") ? "check" : "install";
  const dryRun = a.includes("--dry-run");
  try {
    const r = run({ action, dryRun });
    if (a.includes("--json")) console.log(JSON.stringify(r));
    else if (action === "check") console.log(r.installed ? `installed: ${r.hook} on ${HOOK_EVENTS.join(" + ")}` : `not installed (${JSON.stringify(r.events)}, executable=${r.hook_executable})`);
    else {
      for (const f of r.files) console.log(`${dryRun ? "would " : ""}${f.change === "unchanged" ? "keep" : f.change} ${f.path}`);
      console.log(r.changed ? `${dryRun ? "would update" : "updated"} ${r.settings}${r.backup ? ` (backup ${r.backup})` : ""}` : `${r.settings} already ${action === "uninstall" ? "has no Control hook" : "up to date"} — nothing to change`);
    }
    process.exit(action === "check" && !r.installed ? 1 : 0);
  } catch (e) {
    console.error(`control-hook-install: ${e instanceof Error ? e.message : e} — settings left untouched`);
    process.exit(3);
  }
}
