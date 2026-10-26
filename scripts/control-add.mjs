#!/usr/bin/env node
/**
 * control-add — add a manual workstream to Control from the terminal (used by the /control-add skill).
 *
 *   node scripts/control-add.mjs --title "Fix flaky login test" [--note …] [--link URL] [--people "Sam, Priya"]
 *                                [--when "Fri"] [--cwd DIR] [--no-git] [--dry-run] [--json]
 *
 * Infers repo (owner/name from the origin remote) + branch + cwd from --cwd (default: the current directory).
 * POSTs to $CONTROL_BASE_URL/api/workstreams (default http://localhost:3000). Local only: the endpoint never
 * creates drafts, review jobs or outbox items. Exit: 0 ok · 1 Control unreachable/HTTP error · 2 bad args.
 */
import { execFileSync } from "child_process";
import path from "path";

export function parseArgs(argv) {
  const o = { dryRun: false, json: false, git: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--title" || a === "-t") o.title = val();
    else if (a === "--note") o.note = val();
    else if (a === "--link") o.link = val();
    else if (a === "--people") o.people = val();
    else if (a === "--when") o.when = val();
    else if (a === "--cwd") o.cwd = val();
    else if (a === "--no-git") o.git = false;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (!a.startsWith("-") && !o.title) o.title = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    return "";
  }
}

export function slugFromRemote(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** { cwd, repo?, branch? } for a directory; repo only for GitHub remotes. */
export function inferGit(dir) {
  const cwd = path.resolve(dir);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return { cwd };
  const branch = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]); // works on unborn branches; empty when detached
  const repo = slugFromRemote(git(cwd, ["remote", "get-url", "origin"]));
  return { cwd: top, ...(repo ? { repo } : {}), ...(branch ? { branch } : {}) };
}

export function buildBody(o) {
  const body = { title: (o.title || "").trim(), source: "skill" };
  for (const k of ["note", "link", "people", "when"]) if (o[k] && String(o[k]).trim()) body[k] = String(o[k]).trim();
  if (o.git) Object.assign(body, inferGit(o.cwd || process.cwd()));
  else if (o.cwd) body.cwd = path.resolve(o.cwd);
  return body;
}

function baseUrl() {
  let b = (process.env.CONTROL_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  if (/^:?\d+$/.test(b)) b = `http://localhost:${b.replace(":", "")}`;
  if (!/^https?:\/\//.test(b)) b = `http://${b}`;
  return b;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`control-add: ${e.message}`);
    process.exit(2);
  }
  if (o.help) {
    console.log("usage: control-add --title TEXT [--note TEXT] [--link URL] [--people 'A, B'] [--when TEXT] [--cwd DIR] [--no-git] [--dry-run] [--json]");
    return;
  }
  if (!o.title || !o.title.trim()) {
    console.error("control-add: --title is required");
    process.exit(2);
  }
  const body = buildBody(o);
  const url = `${baseUrl()}/api/workstreams`;
  if (o.dryRun) {
    console.log(o.json ? JSON.stringify({ dry_run: true, url, body }) : `dry-run: would POST ${url}\n${JSON.stringify(body, null, 2)}`);
    return;
  }
  let res, data;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`control-add: Control not reachable at ${baseUrl()} (${e.cause?.code || e.message}). Start it (npm run dev) and retry. Nothing was saved.`);
    process.exit(1);
  }
  if (!res.ok || !data.ok) {
    console.error(`control-add: HTTP ${res.status} — ${data.error || "request failed"}. Nothing was saved.`);
    process.exit(1);
  }
  const it = data.item;
  if (o.json) console.log(JSON.stringify(data));
  else console.log(`Added manual workstream ${it.id}: "${it.title}"${it.repo ? ` · ${it.repo}` : ""}${it.branch ? ` · ${it.branch}` : ""} — shows on ${baseUrl()}/now`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("control-add.mjs")) await main();
