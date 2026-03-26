import type { TurnDecision, TurnRequest, TurnKind } from "@/lib/voice-agent/types";
import { classifyIntent } from "@/lib/voice-agent/planner/intent";
import { normalizeTrendKey } from "@/lib/live-trends";

function resolveFocusTrend(req: TurnRequest): string | null {
  const recentSet = new Set(
    (req.recentlyMentionedTrendNames ?? []).map((n) => normalizeTrendKey(n)),
  );
  const active = req.activeTrendSpeaking?.trim();
  if (active && !recentSet.has(normalizeTrendKey(active))) return active;
  const leader = req.voteLeader?.trim();
  if (leader && req.agentMode === "vote_summary") return leader;
  const pickFirstNotRecent = (names: string[]): string | null => {
    for (const raw of names) {
      const t = raw.trim();
      if (!t) continue;
      if (!recentSet.has(normalizeTrendKey(t))) return t;
    }
    return null;
  };
  const fresh = (req.newTrendNamesFromRadar ?? [])
    .map((n) => n.trim())
    .filter(Boolean);
  if (fresh.length > 0) {
    return pickFirstNotRecent(fresh) ?? fresh[0];
  }
  const deduped = req.liveTrendsDeduped ?? [];
  for (const d of deduped) {
    const n = d.trend_name.trim();
    if (n && !recentSet.has(normalizeTrendKey(n))) return n;
  }
  return deduped[0]?.trend_name?.trim() || null;
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
