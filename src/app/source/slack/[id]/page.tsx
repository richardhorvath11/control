"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useControlStore } from "@/lib/store";

export default function SlackSourcePage() {
  const params = useParams();
  const id = String(params.id);
  const thread = useControlStore((s) => s.sources.slack[id]);

  if (!thread) {
    return (
      <div className="px-8 py-8 text-muted">
        Slack thread not found. <Link href="/now">Back to Now</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-8 py-8 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Mocked Slack
          </div>
          <h1 className="text-[18px] font-semibold mt-1">
            {thread.channel} · {thread.title}
          </h1>
        </div>
        <Link href="/now" className="btn-ghost">
          ← Back
        </Link>
      </div>
      {thread.harness ? (
        <div className="row px-4 py-3 text-[12px] leading-5 text-muted space-y-1">
          <div>
            Real E2E post target:{" "}
            <span className="font-mono text-text">
              {thread.harness.channelId}
            </span>{" "}
            · thread_ts{" "}
            <span className="font-mono text-text">
              {thread.harness.threadTs}
            </span>
          </div>
          <a
            href={thread.harness.permalink}
            target="_blank"
            rel="noreferrer"
            className="text-review hover:underline"
          >
            Open #control-e2e fixture thread
          </a>
          <div className="italic">“{thread.harness.fixtureText}”</div>
        </div>
      ) : null}
      <div className="panel divide-y divide-border">
        {thread.messages.map((m, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold">{m.author}</span>
              <span className="text-[11px] text-muted font-mono">{m.time}</span>
            </div>
            <p className="mt-1 text-[13px] leading-5 whitespace-pre-wrap">
              {m.body}
            </p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted">
        Mocked source of truth for the prototype UI. Approve on the Priya draft
        queues an outbox item; Grok posts via Slack MCP and acks — then this
        mock thread mirrors the reply.
      </p>
    </div>
  );
}
