"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useControlStore } from "@/lib/store";

export function CommandPalette() {
  const open = useControlStore((s) => s.launcherOpen);
  const setOpen = useControlStore((s) => s.setLauncherOpen);
  const workstreams = useControlStore((s) => s.workstreams);
  const startFocus = useControlStore((s) => s.startFocus);
  const endFocus = useControlStore((s) => s.endFocus);
  const resetDemoState = useControlStore((s) => s.resetDemoState);
  const seedLiveMode = useControlStore((s) => s.seedLiveMode);
  const setSeedLiveMode = useControlStore((s) => s.setSeedLiveMode);
  const mode = useControlStore((s) => s.mode);
  const router = useRouter();
  const [q, setQ] = useState("");

  const items = useMemo(() => {
    const base = [
      { id: "now", label: "Go to Now", run: () => router.push("/now") },
      {
        id: "review",
        label: "Go to Review",
        run: () => router.push("/review"),
      },
      {
        id: "agents",
        label: "Go to Agents",
        run: () => router.push("/agents"),
      },
      {
        id: "ws",
        label: "Go to Workstreams",
        run: () => router.push("/workstreams"),
      },
      {
        id: "focus",
        label: mode === "focus" ? "End focus" : "Start focus",
        run: () => (mode === "focus" ? endFocus() : startFocus()),
      },
      {
        id: "switch-mode",
        label:
          seedLiveMode === "live" ? "Switch to Demo" : "Switch to Live",
        run: () => {
          setSeedLiveMode(seedLiveMode === "live" ? "demo" : "live");
          router.push("/now");
        },
      },
      {
        id: "reset-demo",
        label: "Reset demo state",
        run: () => {
          resetDemoState();
          router.push("/now");
        },
      },
      ...workstreams.map((w) => ({
        id: w.id,
        label: `Resume · ${w.name}`,
        run: () => router.push(`/workstreams/${w.id}`),
      })),
      {
        id: "src-slack",
        label: "Open source · Slack #infra",
        run: () => router.push("/source/slack/slack-infra"),
      },
      {
        id: "src-pr",
        label: "Open source · PR fix/staging-cred-rotation",
        run: () => router.push("/source/github/pr-cred"),
      },
      {
        id: "src-rfc",
        label: "Open source · RFC Credential lifecycle",
        run: () => router.push("/source/rfc/rfc-cred"),
      },
    ];
    const query = q.trim().toLowerCase();
    if (!query) return base;
    return base.filter((i) => i.label.toLowerCase().includes(query));
  }, [q, router, workstreams, mode, startFocus, endFocus, resetDemoState, seedLiveMode, setSeedLiveMode]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[15vh] px-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl panel overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Jump, resume, open source…"
          className="w-full bg-transparent px-4 py-3 text-[14px] outline-none border-b border-border placeholder:text-muted"
        />
        <ul className="max-h-80 overflow-auto py-1">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="w-full text-left px-4 py-2.5 text-[13px] hover:bg-raised"
                onClick={() => {
                  item.run();
                  setOpen(false);
                  setQ("");
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
          {items.length === 0 && (
            <li className="px-4 py-6 text-muted text-center">No matches</li>
          )}
        </ul>
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted">
          Launcher — not chat. Esc to close.
        </div>
      </div>
    </div>
  );
}
