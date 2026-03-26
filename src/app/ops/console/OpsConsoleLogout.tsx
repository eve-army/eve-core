"use client";

import { usePrivy } from "@privy-io/react-auth";

export function OpsConsoleLogout() {
  const { logout: privyLogout } = usePrivy();

  return (
    <button
      type="button"
      className="text-zinc-400 hover:text-white underline shrink-0"
      onClick={async () => {
        await fetch("/api/ops/auth/logout", { method: "POST" });
        try {
          await privyLogout();
        } catch {
          /* ignore */
        }
        window.location.href = "/ops/login";
      }}
    >
      Log out
    </button>
  );
}
