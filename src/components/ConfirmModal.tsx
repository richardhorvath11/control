"use client";

import { useControlStore } from "@/lib/store";

export function ConfirmModal() {
  const modal = useControlStore((s) => s.confirmModal);
  const closeConfirm = useControlStore((s) => s.closeConfirm);

  if (!modal) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg panel p-5 shadow-2xl">
        <h2 className="text-[16px] font-semibold leading-6">{modal.title}</h2>
        <p className="mt-1 text-[12px] text-muted">
          External action — nothing posts until you confirm.
        </p>
        <pre className="mt-4 whitespace-pre-wrap rounded-lg border border-border bg-bg p-3 text-[13px] leading-5 font-sans text-text">
          {modal.body}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={closeConfirm}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => modal.onConfirm()}
          >
            {modal.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
