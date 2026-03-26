import { NextRequest, NextResponse } from "next/server";
import { requireOpsSession } from "@/lib/ops-api/guard";
import { getStream, setTuningProfile } from "@/lib/ops-streams/store";
import { parseTuningProfileId } from "@/lib/ops-streams/types";

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
  return NextResponse.json({ ok: true, stream: row });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const gate = requireOpsSession(req);
  if (gate instanceof NextResponse) return gate;
  const { mint: mintRaw } = await ctx.params;
  const mint = decodeURIComponent(mintRaw || "").trim();
  if (!mint) {
    return NextResponse.json({ error: "Missing mint" }, { status: 400 });
  }

  let body: { tuningProfile?: string };
  try {
    body = (await req.json()) as { tuningProfile?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const tuning = parseTuningProfileId(body.tuningProfile);
  if (!tuning) {
    return NextResponse.json({ error: "Invalid tuningProfile" }, { status: 400 });
  }
  const ok = await setTuningProfile(mint, tuning);
  if (!ok) {
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
  const row = await getStream(mint);
  return NextResponse.json({ ok: true, stream: row });
}
