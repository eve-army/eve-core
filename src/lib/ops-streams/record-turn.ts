import { setTelemetry, upsertStreamMeta } from "@/lib/ops-streams/store";
import type { TurnRequest } from "@/lib/voice-agent/types";
import type { TurnResponse } from "@/lib/voice-agent/types";

/**
 * After a successful agent turn: persist telemetry and touch stream registry (for dashboard).
 */
export async function recordOpsAfterTurn(req: TurnRequest, out: TurnResponse): Promise<void> {
  const mint = req.roomId?.trim();
  if (!mint) return;

  try {
    const name = req.streamName?.trim();
    if (name) await upsertStreamMeta(mint, { displayName: name });
    await setTelemetry(mint, out.decision, out.memory, out.quality, out.latencyMs);
  } catch {
    // non-fatal
  }
}
