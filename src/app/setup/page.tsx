import { redirect } from "next/navigation";

/** Alias for BYO Live setup — chip 2 UI lives at /settings. */
export default function SetupPage() {
  redirect("/settings");
}
