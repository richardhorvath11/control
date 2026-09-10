"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { ConfirmModal } from "./ConfirmModal";
import { ModeBanner } from "./ModeBanner";
import { useControlStore } from "@/lib/store";
import { hasSeedLiveModePreference } from "@/lib/seed-live-mode";

type Gate = "pending" | "wizard" | "app";

function isGetLivePath(pathname: string | null): boolean {
  return pathname === "/get-live" || pathname === "/onboarding";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const setLauncherOpen = useControlStore((s) => s.setLauncherOpen);
  const launcherOpen = useControlStore((s) => s.launcherOpen);
  const pathname = usePathname();
  const router = useRouter();
  const [gate, setGate] = useState<Gate>("pending");
  const seedLiveMode = useControlStore((s) => s.seedLiveMode);

  // Continue / Load demo writes control-v0-mode — promote wizard → app so /now is not trapped.
  useEffect(() => {
    if (gate !== "wizard") return;
    if (!hasSeedLiveModePreference()) return;
    setGate("app");
    void useControlStore.getState().syncExternalInboxes();
  }, [gate, seedLiveMode, pathname]);

  useEffect(() => {
    const unsub = useControlStore.persist.onFinishHydration(() => {
      useControlStore.getState().hydrateSeedLiveMode();
      useControlStore.getState().setHasHydrated(true);

      void (async () => {
        const hasPref = hasSeedLiveModePreference();
        let configured = false;
        try {
          const res = await fetch("/api/watch");
          if (res.ok) {
            const data = (await res.json()) as {
              watch?: { configured?: boolean };
            };
            configured = data.watch?.configured === true;
          }
        } catch {
          /* offline — treat as unconfigured when no preference */
        }

        // First-run: no mode preference AND watch not configured → Get Live.
        // Do NOT auto-skip into Demo / Monday Now.
        if (!hasPref && !configured) {
          setGate("wizard");
          const here =
            typeof window !== "undefined"
              ? window.location.pathname
              : pathname;
          if (!isGetLivePath(here)) {
            router.replace("/get-live");
          }
          return;
        }

        // Preference exists OR watch configured → AppShell.
        // Auto-Live when configured + no pref (existing V0.8 path).
        if (!hasPref && configured) {
          useControlStore.getState().setSeedLiveMode("live");
        }

        // Live only: pull durable GitHub/Slack inbox effects after hydrate.
        // Demo: skip apply so Monday seed is not overwritten by disk inboxes.
        void useControlStore.getState().syncExternalInboxes();
        setGate("app");
      })();
    });
    void useControlStore.persist.rehydrate();
    return unsub;
    // pathname intentionally omitted — gate decision is once per hydrate;
    // redirect uses current pathname from closure at hydrate time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Poll external inboxes so watcher POSTs land in Attention when Live.
  useEffect(() => {
    const tick = () => {
      if (!useControlStore.getState()._hasHydrated) return;
      if (gate !== "app") return;
      void useControlStore.getState().syncExternalInboxes();
    };
    const id = window.setInterval(tick, 4000);
    return () => window.clearInterval(id);
  }, [gate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLauncherOpen(!launcherOpen);
      }
      if (e.key === "Escape") setLauncherOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [launcherOpen, setLauncherOpen]);

  // Gate after hydrate — avoid flash of Demo Now (null/spinner until known).
  if (gate === "pending") {
    return (
      <div
        className="flex min-h-screen min-w-desktop items-center justify-center bg-bg text-muted text-[13px]"
        data-testid="app-gate-pending"
      >
        Loading…
      </div>
    );
  }

  // Full-page Get Live wizard (no sidebar / mode banner).
  if (isGetLivePath(pathname) || gate === "wizard") {
    // Still redirecting to /get-live — keep spinner, no Demo flash.
    if (gate === "wizard" && !isGetLivePath(pathname)) {
      return (
        <div
          className="flex min-h-screen min-w-desktop items-center justify-center bg-bg text-muted text-[13px]"
          data-testid="app-gate-pending"
        >
          Loading…
        </div>
      );
    }
    return (
      <div className="min-h-screen min-w-desktop">
        {children}
        <ConfirmModal />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen min-w-desktop">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <ModeBanner />
        <main className="flex-1 min-w-0 overflow-auto">{children}</main>
      </div>
      <CommandPalette />
      <ConfirmModal />
    </div>
  );
}
