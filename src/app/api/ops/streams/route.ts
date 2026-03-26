import { NextRequest, NextResponse } from "next/server";
import { requireOpsSession } from "@/lib/ops-api/guard";
import { listStreams } from "@/lib/ops-streams/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = requireOpsSession(req);
  if (gate instanceof NextResponse) return gate;
  const rows = await listStreams();
  return NextResponse.json({ ok: true, streams: rows });
}
