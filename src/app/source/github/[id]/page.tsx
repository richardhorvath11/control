"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useControlStore } from "@/lib/store";

export default function GitHubSourcePage() {
  const params = useParams();
  const id = String(params.id);
  const pr = useControlStore((s) => s.sources.github[id]);

  if (!pr) {
    return (
      <div className="px-8 py-8 text-muted">
        PR not found. <Link href="/now">Back to Now</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Mocked GitHub PR
          </div>
          <h1 className="text-[18px] font-semibold mt-1">{pr.title}</h1>
          <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
            <span className="chip font-mono">{pr.repo}</span>
            <span className="chip font-mono text-running">{pr.branch}</span>
            <span className="chip">{pr.status}</span>
          </div>
        </div>
        <Link href="/review" className="btn-ghost">
          ← Review
        </Link>
      </div>

      <p className="text-[13px] text-muted leading-5">{pr.description}</p>

      <section className="panel p-4">
        <h2 className="text-[12px] uppercase tracking-wide text-muted mb-3">
          CI
        </h2>
        <ul className="space-y-1.5">
          {pr.ci.map((c) => (
            <li
              key={c.name}
              className="flex items-center justify-between text-[13px]"
            >
              <span className="font-mono text-[12px]">{c.name}</span>
              <span
                className={
                  c.status.startsWith("passed")
                    ? "text-running"
                    : "text-blocked"
                }
              >
                {c.status}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-muted">
          policy-rfc-check passed* — heuristic only; does not assert RFC §4.2
          compliance on retry constants.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-[12px] uppercase tracking-wide text-muted">
          Diff excerpt
        </h2>
        {pr.files.map((f) => (
          <div key={f.path} className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-border font-mono text-[12px] text-muted">
              {f.path}
            </div>
            <pre className="p-3 text-[12px] leading-5 font-mono overflow-x-auto text-[#c8ccd4] whitespace-pre-wrap">
              {f.patch}
            </pre>
          </div>
        ))}
      </section>
    </div>
  );
}
