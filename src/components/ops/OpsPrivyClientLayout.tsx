"use client";

import dynamic from "next/dynamic";

/** `ssr: false` is only valid inside a Client Component; `app/ops/layout` is a Server Component. */
const OpsPrivyShell = dynamic(
  () => import("@/components/ops/OpsPrivyShell").then((m) => m.OpsPrivyShell),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-zinc-950 text-zinc-300 flex flex-col items-center justify-center gap-2 text-sm px-4">
        <p>Loading sign-in…</p>
        <p className="text-[11px] text-zinc-600 max-w-md text-center">
          If this never finishes, check the terminal running <code className="text-zinc-500">next dev</code> and
          confirm nothing else is bound to the same port (Next may switch to 3001).
        </p>
      </div>
    ),
  },
);

export function OpsPrivyClientLayout({ children }: { children: React.ReactNode }) {
  return <OpsPrivyShell>{children}</OpsPrivyShell>;
}
