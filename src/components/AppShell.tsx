"use client";

import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { ConfirmModal } from "./ConfirmModal";
import { useControlStore } from "@/lib/store";

export function AppShell({ children }: { children: React.ReactNode }) {
  const setLauncherOpen = useControlStore((s) => s.setLauncherOpen);
  const launcherOpen = useControlStore((s) => s.launcherOpen);

  useEffect(() => {
    const unsub = useControlStore.persist.onFinishHydration(() => {
      useControlStore.getState().setHasHydrated(true);
      // Pull any durable GitHub inbox effects after hydrate (no-op if empty).
      void useControlStore.getState().syncGithubInbox();
    });
    void useControlStore.persist.rehydrate();
    return unsub;
  }, []);

  // Poll GitHub inbox so watcher POSTs land in Attention without a feed UI.
  useEffect(() => {
    const tick = () => {
      if (!useControlStore.getState()._hasHydrated) return;
      void useControlStore.getState().syncGithubInbox();
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
      <main className="flex-1 min-w-0 overflow-auto">{children}</main>
      <CommandPalette />
      <ConfirmModal />
    </div>
  );
}
