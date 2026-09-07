"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useControlStore } from "@/lib/store";
import { ReviewWorkspace } from "@/components/ReviewWorkspace";

export default function ReviewPage() {
  const queue = useControlStore((s) => s.reviewQueue);
  const selectedId = useControlStore((s) => s.selectedReviewId);
  const setSelected = useControlStore((s) => s.setSelectedReview);
  const pending = queue.filter((r) => r.status === "pending");
  const selected =
    queue.find((r) => r.id === selectedId && r.status === "pending") ??
    pending[0] ??
    null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) {
      setSelected(selected.id);
    }
  }, [selected, selectedId, setSelected]);

  return (
    <div className="flex h-[calc(100vh)] min-h-[640px]">
      <aside className="w-[280px] shrink-0 border-r border-border overflow-auto">
        <div className="px-4 py-4 border-b border-border">
          <h1 className="text-[16px] font-semibold">Review</h1>
          <p className="text-[11px] text-muted mt-1">
            Prepared work · judgment required
          </p>
        </div>
        {pending.length === 0 ? (
          <div className="px-4 py-8 text-[13px] text-muted leading-5">
            Nothing to review. Agents will wait here.
          </div>
        ) : (
          <ul className="p-2 space-y-1">
            {pending.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelected(item.id)}
                  className={`w-full text-left rounded-lg px-3 py-2.5 transition ${
                    selected?.id === item.id
                      ? "bg-raised border border-border"
                      : "hover:bg-raised/60"
                  }`}
                >
                  <div className="text-[13px] font-medium leading-5">
                    {item.title}
                  </div>
                  <div className="text-[11px] text-muted mt-1">{item.label}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="px-4 py-3 border-t border-border">
          <Link href="/now" className="btn-ghost w-full justify-start">
            ← Now
          </Link>
        </div>
      </aside>
      <div className="flex-1 min-w-0 overflow-auto">
        {selected ? (
          <ReviewWorkspace itemId={selected.id} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted text-[13px]">
            Nothing to review. Agents will wait here.
          </div>
        )}
      </div>
    </div>
  );
}
