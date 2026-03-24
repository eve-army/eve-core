import type { TurnDecision, TurnRequest, TurnKind } from "@/lib/voice-agent/types";
import { classifyIntent } from "@/lib/voice-agent/planner/intent";
import { normalizeTrendKey } from "@/lib/live-trends";

function resolveFocusTrend(req: TurnRequest): string | null {
  const active = req.activeTrendSpeaking?.trim();
  if (active) return active;
  const leader = req.voteLeader?.trim();
  if (leader && req.agentMode === "vote_summary") return leader;
  const top = req.liveTrendsDeduped?.[0]?.trend_name?.trim();
  return top || null;
}

function chooseTurnKind(req: TurnRequest): TurnKind {
  const mode = req.agentMode ?? "chat_reply";
  if (mode === "trend_tick") return "trend_commentary";
  if (mode === "host_banter") return "host_fill";
  if (mode === "vote_summary") return "vote_summary";
  return "direct_reply";
}

export function buildTurnDecision(req: TurnRequest): TurnDecision {
  const intent = classifyIntent(req);
  const turnKind = chooseTurnKind(req);
  const focusTrend = resolveFocusTrend(req);
  const requiresDirectAnswer =
    turnKind === "direct_reply" &&
    (intent === "direct_question" || intent === "feedback_or_critique");
  const shouldSpeak = !!(req.message || turnKind !== "direct_reply");

  return {
    turnKind,
    intent,
    shouldSpeak,
    requiresDirectAnswer,
    focusTrend: focusTrend ? normalizeTrendKey(focusTrend) ? focusTrend : null : null,
    reason: `${turnKind}:${intent}`,
  };
}
