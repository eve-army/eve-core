import { NextRequest, NextResponse } from "next/server";
import { upsertStreamMeta } from "@/lib/ops-streams/store";
import type { AgentRole } from "@/lib/ops-streams/types";

export const dynamic = "force-dynamic";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

export async function POST(req: NextRequest) {
  let body: { mint?: string; displayName?: string; ticker?: string; agentRole?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mint = typeof body.mint === "string" ? body.mint.trim() : "";
  if (!mint || !MINT_RE.test(mint)) {
    return NextResponse.json({ error: "Invalid mint" }, { status: 400 });
  }
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim().slice(0, 120) || null : null;
  const ticker =
    typeof body.ticker === "string" ? body.ticker.trim().toUpperCase().slice(0, 16) || null : null;
  const agentRole: AgentRole | undefined =
    body.agentRole === "bonding_assistant" ? "bonding_assistant" : undefined;

  await upsertStreamMeta(mint, {
    displayName: displayName ?? undefined,
    ticker: ticker ?? undefined,
    agentRole,
  });

  return NextResponse.json({ ok: true });
}
