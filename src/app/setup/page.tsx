import { redirect } from "next/navigation";

/** Alias for BYO Live setup — UI lives at /settings. Get Live wizard: /get-live. */
export default function SetupPage() {
  redirect("/settings");
}
