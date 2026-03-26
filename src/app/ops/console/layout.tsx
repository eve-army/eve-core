import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OpsConsoleLogout } from "@/app/ops/console/OpsConsoleLogout";
import { OPS_SESSION_COOKIE, getOpsSessionSecret, verifyOpsSession } from "@/lib/ops-auth/session";

export const dynamic = "force-dynamic";

export default async function OpsConsoleLayout({ children }: { children: React.ReactNode }) {
  const secret = getOpsSessionSecret();
  if (!secret) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
        <p className="text-amber-400">
          Set OPS_SESSION_SECRET (16+ chars), OPS_ADMIN_SOLANA_WALLETS, PRIVY_APP_SECRET, and
          PRIVY_JWT_VERIFICATION_KEY on the server.
        </p>
      </div>
    );
  }
  const c = await cookies();
  const tok = c.get(OPS_SESSION_COOKIE)?.value;
  const sub = verifyOpsSession(secret, tok);
  if (!sub) redirect("/ops/login");

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-white/10 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-6">
          <span className="font-bold text-cyan-400">Eve Ops</span>
          <nav className="flex gap-4 text-sm text-zinc-300">
            <Link href="/ops/console" className="hover:text-white">
              Streams
            </Link>
            <Link href="/ops/console/deploy" className="hover:text-white">
              Deploy
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500 font-mono truncate max-w-[14rem]">
          {sub}
          <OpsConsoleLogout />
        </div>
      </header>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}
