"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useControlStore } from "@/lib/store";

export default function ReviewIdRedirect() {
  const params = useParams();
  const id = String(params.id);
  const setSelected = useControlStore((s) => s.setSelectedReview);
  const router = useRouter();

  useEffect(() => {
    setSelected(id);
    router.replace("/review");
  }, [id, setSelected, router]);

  return (
    <div className="px-8 py-8 text-muted text-[13px]">Opening review…</div>
  );
}
