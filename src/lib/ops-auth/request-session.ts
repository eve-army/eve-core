import type { NextRequest } from "next/server";
import { OPS_SESSION_COOKIE, getOpsSessionSecret, verifyOpsSession } from "@/lib/ops-auth/session";

export function getOpsSessionAddress(req: NextRequest): string | null {
  const secret = getOpsSessionSecret();
  if (!secret) return null;
  const raw = req.cookies.get(OPS_SESSION_COOKIE)?.value;
  return verifyOpsSession(secret, raw);
}
