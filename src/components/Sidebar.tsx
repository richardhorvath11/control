"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  GitBranch,
  ScanSearch,
  Bot,
  Focus,
  Settings,
} from "lucide-react";
import { useControlStore } from "@/lib/store";

const nav = [
  { href: "/now", label: "Now", icon: LayoutDashboard },
  { href: "/workstreams", label: "Workstreams", icon: GitBranch },
  { href: "/review", label: "Review", icon: ScanSearch, badge: true },
  { href: "/agents", label: "Agents", icon: Bot, running: true },
  { href: "/settings", label: "Setup", icon: Settings },
];

function phaseDot(phase: string) {
  if (phase === "Human review") return "bg-amber";
  if (phase === "Paused") return "bg-muted";
  if (phase === "Draft") return "bg-border";
  if (phase === "Delegated") return "bg-running";
  return "bg-running";
}

export function Sidebar() {
  const pathname = usePathname();
  const reviewQueue = useControlStore((s) => s.reviewQueue);
  const agents = useControlStore((s) => s.agents);
  const pending = useMemo(
    () => reviewQueue.filter((r) => r.status === "pending").length,
    [reviewQueue]
  );
  const running = useMemo(
    () => agents.filter((a) => a.status === "Running").length,
    [agents]
  );
  const workstreams = useControlStore((s) => s.workstreams);
  // Active: active!==false (completed ephemeral have active:false and leave list)
  const activeList = useMemo(
    () => workstreams.filter((ws) => ws.active !== false),
    [workstreams]
  );
  const mode = useControlStore((s) => s.mode);
  const startFocus = useControlStore((s) => s.startFocus);
  const endFocus = useControlStore((s) => s.endFocus);
  const setLauncherOpen = useControlStore((s) => s.setLauncherOpen);
  const seedLiveMode = useControlStore((s) => s.seedLiveMode);
  const setSeedLiveMode = useControlStore((s) => s.setSeedLiveMode);

  return (
    <aside className="w-[220px] shrink-0 border-r border-border bg-bg flex flex-col sticky top-0 h-screen">
      <div className="px-4 pt-5 pb-4">
        <div className="text-[15px] font-semibold tracking-tight">Control</div>
        <div className="text-[11px] text-muted mt-0.5">Monday 9:12 AM</div>
      </div>

      <nav className="px-2 space-y-0.5">
        {nav.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] transition ${
                active
                  ? "bg-raised text-text"
                  : "text-muted hover:text-text hover:bg-raised/60"
              }`}
            >
              <Icon size={16} strokeWidth={1.5} />
              <span className="flex-1">{item.label}</span>
              {item.badge && pending > 0 && (
                <span className="text-[11px] font-medium text-review tabular-nums">
                  {pending}
                </span>
              )}
              {item.running && running > 0 && (
                <span className="text-[11px] text-muted">{running} running</span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 px-4">
        <div className="text-[11px] uppercase tracking-wide text-muted mb-2">
          Active
        </div>
        <div className="space-y-1">
          {activeList.map((ws) => {
            const active = pathname === `/workstreams/${ws.id}`;
            return (
              <Link
                key={ws.id}
                href={`/workstreams/${ws.id}`}
                className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-[12px] leading-4 transition ${
                  active
                    ? "bg-raised text-text"
                    : "text-muted hover:text-text hover:bg-raised/60"
                }`}
              >
                <span
                  className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${phaseDot(
                    ws.phase
                  )}`}
                />
                <span className="line-clamp-2">{ws.name}</span>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="mt-auto p-3 space-y-2 border-t border-border">
        <button
          type="button"
          onClick={() =>
            setSeedLiveMode(seedLiveMode === "live" ? "demo" : "live")
          }
          className={`w-full btn-secondary justify-between text-[12px] ${
            seedLiveMode === "live"
              ? "border-running/40 text-running"
              : "border-amber/40 text-amber"
          }`}
          title="Live = your watch/inboxes. Load demo = Monday seed (does not wipe watch.json channels)."
        >
          <span>{seedLiveMode === "live" ? "Live" : "Demo"}</span>
          <span className="text-[10px] text-muted font-normal">
            {seedLiveMode === "live" ? "Load demo" : "Switch to Live"}
          </span>
        </button>
        <button
          type="button"
          onClick={() => (mode === "focus" ? endFocus() : startFocus())}
          className={`w-full btn-secondary justify-start gap-2 ${
            mode === "focus" ? "border-running/40 text-running" : ""
          }`}
        >
          <Focus size={14} strokeWidth={1.5} />
          {mode === "focus" ? "End focus" : "Start focus"}
        </button>
        <button
          type="button"
          onClick={() => setLauncherOpen(true)}
          className="w-full btn-ghost justify-between text-muted"
        >
          <span>Launcher</span>
          <kbd className="text-[10px] border border-border rounded px-1.5 py-0.5">
            ⌘K
          </kbd>
        </button>
      </div>
    </aside>
  );
}
