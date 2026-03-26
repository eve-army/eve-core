import { PrivyClient, verifyAccessToken, type User } from "@privy-io/node";

function getAppId(): string | null {
  return (
    process.env.PRIVY_APP_ID?.trim() ||
    process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ||
    null
  );
}

function getAppSecret(): string | null {
  const s = process.env.PRIVY_APP_SECRET?.trim();
  return s || null;
}

function getJwtVerificationKey(): string | null {
  const k = process.env.PRIVY_JWT_VERIFICATION_KEY?.trim();
  if (!k) return null;
  // Allow single-line .env PEM with literal \n sequences
  return k.includes("\\n") ? k.replace(/\\n/g, "\n") : k;
}

/** Which server env vars are still unset (for clearer 503 responses). */
export function getPrivyServerEnvMissing(): string[] {
  const missing: string[] = [];
  if (!getAppId()) missing.push("PRIVY_APP_ID or NEXT_PUBLIC_PRIVY_APP_ID");
  if (!getAppSecret()) missing.push("PRIVY_APP_SECRET");
  if (!process.env.PRIVY_JWT_VERIFICATION_KEY?.trim()) {
    missing.push("PRIVY_JWT_VERIFICATION_KEY");
  }
  return missing;
}

export function getPrivyServerConfig(): {
  appId: string;
  appSecret: string;
  jwtVerificationKey: string;
} | null {
  const appId = getAppId();
  const appSecret = getAppSecret();
  const jwtVerificationKey = getJwtVerificationKey();
  if (!appId || !appSecret || !jwtVerificationKey) return null;
  return { appId, appSecret, jwtVerificationKey };
}

export function collectSolanaAddressesFromPrivyUser(user: User): string[] {
  const out: string[] = [];
  for (const acc of user.linked_accounts) {
    if (
      acc.type === "wallet" &&
      "chain_type" in acc &&
      acc.chain_type === "solana" &&
      "address" in acc &&
      typeof acc.address === "string"
    ) {
      out.push(acc.address);
    }
  }
  return out;
}

export type VerifyPrivyTokenResult =
  | { ok: true; user: User }
  | { ok: false; phase: "jwt" | "user"; detail?: string };

function errMessage(e: unknown): string | undefined {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return undefined;
}

/**
 * Verifies the browser access token and loads the Privy user.
 * Failures are split so the API can return actionable hints (401).
 */
export async function verifyPrivyAccessTokenAndLoadUser(
  accessToken: string,
): Promise<VerifyPrivyTokenResult> {
  const cfg = getPrivyServerConfig();
  if (!cfg) return { ok: false, phase: "jwt", detail: "missing server config" };

  let claims: { user_id: string };
  try {
    claims = await verifyAccessToken({
      access_token: accessToken,
      app_id: cfg.appId,
      verification_key: cfg.jwtVerificationKey,
    });
  } catch (e) {
    return { ok: false, phase: "jwt", detail: errMessage(e) };
  }

  const client = new PrivyClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    jwtVerificationKey: cfg.jwtVerificationKey,
  });

  try {
    const user = await client.users()._get(claims.user_id);
    return { ok: true, user };
  } catch (e) {
    return { ok: false, phase: "user", detail: errMessage(e) };
  }
}
