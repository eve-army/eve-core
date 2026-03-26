import { NextRequest, NextResponse } from "next/server";
import { getOpsSessionAddress } from "@/lib/ops-auth/request-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const addr = getOpsSessionAddress(req);
  if (!addr) {
    return NextResponse.json({ ok: false, authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true, authenticated: true, address: addr });
}
