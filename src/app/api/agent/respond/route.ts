import { NextRequest, NextResponse } from "next/server";
import { runTurn } from "@/lib/voice-agent/orchestrator/engine";
import { recordOpsAfterTurn } from "@/lib/ops-streams/record-turn";
import type { TurnRequest } from "@/lib/voice-agent/types";

export const dynamic = "force-dynamic";

/**
 * Legacy compatibility endpoint.
 * The new architecture lives behind /api/agent/turn; this keeps older clients functional.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TurnRequest;
    const out = await runTurn(body);
    void recordOpsAfterTurn(body, out);
    return NextResponse.json({
      text: out.text,
      audio: out.audio,
      highlightTrendName: out.highlightTrendName,
      highlightTimeline: out.highlightTimeline,
      events: out.events,
      decision: out.decision,
      memory: out.memory,
      quality: out.quality,
      promptVersion: out.promptVersion,
      latencyMs: out.latencyMs,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
