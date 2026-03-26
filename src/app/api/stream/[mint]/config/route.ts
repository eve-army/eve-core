import { NextRequest, NextResponse } from "next/server";
import { getTuningProfile } from "@/lib/ops-streams/store";

export const dynamic = "force-dynamic";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

type Ctx = { params: Promise<{ mint: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { mint: mintRaw } = await ctx.params;
  const mint = decodeURIComponent(mintRaw || "").trim();
  if (!mint || !MINT_RE.test(mint)) {
    return NextResponse.json({ error: "Invalid mint" }, { status: 400 });
  }
  const tuningProfileId = await getTuningProfile(mint);
  return NextResponse.json({ ok: true, tuningProfileId });
}
