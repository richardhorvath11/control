"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useControlStore } from "@/lib/store";

export default function CalendarSourcePage() {
  const params = useParams();
  const id = String(params.id);
  const event = useControlStore((s) => s.sources.calendar[id]);

  if (!event) {
    return (
      <div className="px-8 py-8 text-muted">
        Event not found. <Link href="/now">Back to Now</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-8 py-8 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Mocked Calendar
          </div>
          <h1 className="text-[18px] font-semibold mt-1">{event.title}</h1>
        </div>
        <Link href="/now" className="btn-ghost">
          ← Now
        </Link>
      </div>
      <div className="panel p-5 space-y-3 text-[13px]">
        <div>
          <div className="text-[11px] text-muted uppercase">When</div>
          <div className="font-mono mt-0.5">
            {event.start} – {event.end}
          </div>
        </div>
        {event.location && (
          <div>
            <div className="text-[11px] text-muted uppercase">Where</div>
            <div className="mt-0.5">{event.location}</div>
          </div>
        )}
        {event.attendees && (
          <div>
            <div className="text-[11px] text-muted uppercase">Who</div>
            <div className="mt-0.5">{event.attendees.join(", ")}</div>
          </div>
        )}
        {event.notes && (
          <div>
            <div className="text-[11px] text-muted uppercase">Notes</div>
            <div className="mt-0.5 text-muted">{event.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}
