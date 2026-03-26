import { NextRequest, NextResponse } from "next/server";
import { requireOpsSession } from "@/lib/ops-api/guard";
import { getStream } from "@/lib/ops-streams/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ mint: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const gate = requireOpsSession(req);
  if (gate instanceof NextResponse) return gate;
  const { mint: mintRaw } = await ctx.params;
  const mint = decodeURIComponent(mintRaw || "").trim();
  if (!mint) {
    return NextResponse.json({ error: "Missing mint" }, { status: 400 });
  }
  const row = await getStream(mint);
  if (!row) {
    return NextResponse.json({ error: "Stream not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    telemetry: row.lastTelemetry,
    telemetryAt: row.telemetryAt,
    tuningProfile: row.tuningProfile,
  });
}
