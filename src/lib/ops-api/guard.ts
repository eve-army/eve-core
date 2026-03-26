import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getOpsSessionAddress } from "@/lib/ops-auth/request-session";

export function requireOpsSession(req: NextRequest): string | NextResponse {
  const addr = getOpsSessionAddress(req);
  if (!addr) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return addr;
}
