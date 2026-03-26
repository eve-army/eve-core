import { NextRequest, NextResponse } from "next/server";
import { getOpsAdminAllowlistFromEnv, isOpsAdminSolanaAddress } from "@/lib/ops-auth/allowlist";
import {
  collectSolanaAddressesFromPrivyUser,
  getPrivyServerConfig,
  getPrivyServerEnvMissing,
  verifyPrivyAccessTokenAndLoadUser,
} from "@/lib/ops-auth/privy-server";
import { getOpsSessionSecret, OPS_SESSION_COOKIE, signOpsSession } from "@/lib/ops-auth/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sessionSecret = getOpsSessionSecret();
  if (!sessionSecret) {
    return NextResponse.json(
      { ok: false, error: "OPS_SESSION_SECRET not configured" },
      { status: 503 },
    );
  }
  if (!getPrivyServerConfig()) {
    const missing = getPrivyServerEnvMissing();
    return NextResponse.json(
      {
        ok: false,
        error:
          missing.length > 0
            ? `Privy server env incomplete. Missing: ${missing.join(", ")}. In .env.local use one-line PEM with \\n for newlines if needed.`
            : "Privy server configuration invalid.",
        missing,
      },
      { status: 503 },
    );
  }

  const allow = getOpsAdminAllowlistFromEnv();
  if (allow.size === 0) {
    return NextResponse.json(
      { ok: false, error: "OPS_ADMIN_SOLANA_WALLETS (or OPS_ADMIN_WALLETS) not configured" },
      { status: 503 },
    );
  }

  let body: { accessToken?: string };
  try {
    body = (await req.json()) as { accessToken?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "accessToken required" }, { status: 400 });
  }

  const loaded = await verifyPrivyAccessTokenAndLoadUser(accessToken);
  if (!loaded.ok) {
    const isDev = process.env.NODE_ENV === "development";
    const jwtHint =
      "Privy token could not be verified. Use the same app in the dashboard for: NEXT_PUBLIC_PRIVY_APP_ID, PRIVY_APP_SECRET, and PRIVY_JWT_VERIFICATION_KEY (full PEM). Restart the dev server after changing .env.local.";
    const userHint =
      "Privy token was valid but loading the user failed. Check PRIVY_APP_SECRET and that your Privy app id matches the client.";
    const body: {
      ok: false;
      error: string;
      phase?: string;
      detail?: string;
    } = {
      ok: false,
      error: loaded.phase === "jwt" ? jwtHint : userHint,
      phase: loaded.phase,
    };
    if (isDev && loaded.detail) body.detail = loaded.detail;
    return NextResponse.json(body, { status: 401 });
  }

  const solanaAddrs = collectSolanaAddressesFromPrivyUser(loaded.user);
  if (!isOpsAdminSolanaAddress(solanaAddrs, allow)) {
    return NextResponse.json(
      { ok: false, error: "No allowlisted Solana wallet linked to this Privy user" },
      { status: 403 },
    );
  }

  const matched = solanaAddrs.find((a) => allow.has(a.trim())) ?? solanaAddrs[0]!;
  const token = signOpsSession(sessionSecret, matched);
  const res = NextResponse.json({ ok: true, wallet: matched });
  res.cookies.set(OPS_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
