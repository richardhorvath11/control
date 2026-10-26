"use client";

import { deleteManual, dismissWorkstream, removeConfirmCopy } from "@/lib/manual-client";
import { useControlStore } from "@/lib/store";

export interface RemovableRow {
  key: string;
  kind: "pr" | "slack" | "session" | "manual";
  title: string;
  manual_id?: string;
}

/** Delete (manual) / Dismiss (derived) with a confirm step. Calls onDone after success. */
export function RemoveWorkstreamButton({ row, onDone, className = "btn-ghost" }: { row: RemovableRow; onDone?: () => void; className?: string }) {
  const openConfirm = useControlStore((s) => s.openConfirm);
  const closeConfirm = useControlStore((s) => s.closeConfirm);
  const manual = row.kind === "manual";
  return (
    <button
      type="button"
      className={className}
      data-testid={manual ? "ws-delete" : "ws-dismiss"}
      data-ws-key={row.key}
      onClick={() => {
        const copy = removeConfirmCopy(row);
        const run = async () => {
          useControlStore.setState((s) => ({ confirmModal: s.confirmModal ? { ...s.confirmModal, loading: true, error: undefined } : null }));
          const r = manual && row.manual_id ? await deleteManual(row.manual_id) : await dismissWorkstream(row.key);
          if (!r.ok) {
            useControlStore.setState((s) => ({ confirmModal: s.confirmModal ? { ...s.confirmModal, loading: false, error: r.error } : null }));
            return;
          }
          closeConfirm();
          onDone?.();
        };
        openConfirm({ ...copy, onConfirm: run });
      }}
    >
      {manual ? "Delete" : "Dismiss"}
    </button>
  );
}
