import { NextRequest, NextResponse } from "next/server";
import { runTurn } from "@/lib/voice-agent/orchestrator/engine";
import type { TurnRequest } from "@/lib/voice-agent/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TurnRequest;
    const out = await runTurn(body);
    return NextResponse.json(out);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
