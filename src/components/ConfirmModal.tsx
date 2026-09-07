"use client";

import { useControlStore } from "@/lib/store";

export function ConfirmModal() {
  const modal = useControlStore((s) => s.confirmModal);
  const closeConfirm = useControlStore((s) => s.closeConfirm);

  if (!modal) return null;

  const busy = Boolean(modal.loading);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg panel p-5 shadow-2xl">
        <h2 className="text-[16px] font-semibold leading-6">{modal.title}</h2>
        <p className="mt-1 text-[12px] text-muted">
          {modal.subtitle ??
            "External action — nothing posts until you confirm."}
        </p>
        <pre className="mt-4 whitespace-pre-wrap rounded-lg border border-border bg-bg p-3 text-[13px] leading-5 font-sans text-text">
          {modal.body}
        </pre>
        {modal.error ? (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-blocked/40 bg-[#2a1816] px-3 py-2 text-[12px] leading-5 text-blocked"
          >
            {modal.error}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={closeConfirm}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary disabled:opacity-60"
            disabled={busy}
            onClick={() => {
              void Promise.resolve(modal.onConfirm());
            }}
          >
            {busy ? "Posting…" : modal.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
