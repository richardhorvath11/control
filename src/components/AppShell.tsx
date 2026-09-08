"use client";

import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { ConfirmModal } from "./ConfirmModal";
import { ModeBanner } from "./ModeBanner";
import { useControlStore } from "@/lib/store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const setLauncherOpen = useControlStore((s) => s.setLauncherOpen);
  const launcherOpen = useControlStore((s) => s.launcherOpen);

  useEffect(() => {
    const unsub = useControlStore.persist.onFinishHydration(() => {
      useControlStore.getState().hydrateSeedLiveMode();
      useControlStore.getState().setHasHydrated(true);
      // Live only: pull durable GitHub/Slack inbox effects after hydrate.
      // Demo: skip apply so Monday seed is not overwritten by disk inboxes.
      void useControlStore.getState().syncExternalInboxes();
    });
    void useControlStore.persist.rehydrate();
    return unsub;
  }, []);

  // Poll external inboxes so watcher POSTs land in Attention when Live.
  useEffect(() => {
    const tick = () => {
      if (!useControlStore.getState()._hasHydrated) return;
      void useControlStore.getState().syncExternalInboxes();
    };
    const id = window.setInterval(tick, 4000);
    return () => window.clearInterval(id);
  }, []);

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
