"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useControlStore } from "@/lib/store";

export default function RfcSourcePage() {
  const params = useParams();
  const id = String(params.id);
  const rfc = useControlStore((s) => s.sources.rfc[id]);

  if (!rfc) {
    return (
      <div className="px-8 py-8 text-muted">
        RFC not found. <Link href="/now">Back to Now</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-8 py-8 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Mocked RFC / Doc
          </div>
          <h1 className="text-[18px] font-semibold mt-1">{rfc.title}</h1>
          <div className="chip mt-2">{rfc.section}</div>
        </div>
        <Link href="/review" className="btn-ghost">
          ← Review
        </Link>
      </div>
      <article className="panel p-5 prose-invert">
        {rfc.body.split("\n").map((line, i) => {
          if (line.startsWith("## ")) {
            return (
              <h2
                key={i}
                className="text-[16px] font-semibold mt-4 mb-2 first:mt-0"
              >
                {line.replace(/^## /, "")}
              </h2>
            );
          }
          if (line.startsWith("- ")) {
            return (
              <li key={i} className="text-[13px] leading-5 ml-4 list-disc">
                {line.replace(/^- /, "")}
              </li>
            );
          }
          if (!line.trim()) return <div key={i} className="h-2" />;
          return (
            <p key={i} className="text-[13px] leading-5">
              {line}
            </p>
          );
        })}
      </article>
    </div>
  );
}
