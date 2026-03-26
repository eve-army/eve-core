import { createHmac, timingSafeEqual } from "node:crypto";

export const OPS_SESSION_COOKIE = "eve_ops_session";

const TTL_SEC_DEFAULT = 60 * 60 * 24 * 7; // 7 days

export function getOpsSessionSecret(): string | null {
  const s = process.env.OPS_SESSION_SECRET?.trim();
  if (!s || s.length < 16) return null;
  return s;
}

export function signOpsSession(secret: string, walletSub: string, ttlSec = TTL_SEC_DEFAULT): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = JSON.stringify({ sub: walletSub, exp });
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig}`;
}

export function verifyOpsSession(secret: string, token: string | undefined | null): string | null {
  if (!token) return null;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payloadPart = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))) {
      return null;
    }
  } catch {
    return null;
  }
  let o: { sub?: string; exp?: number };
  try {
    o = JSON.parse(payload) as { sub?: string; exp?: number };
  } catch {
    return null;
  }
  if (!o.sub || typeof o.exp !== "number") return null;
  if (o.exp < Math.floor(Date.now() / 1000)) return null;
  return o.sub;
}
