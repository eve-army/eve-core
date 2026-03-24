import type { QualityScores, TurnDecision } from "@/lib/voice-agent/types";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function scoreQuality(
  userMessage: string,
  assistantText: string,
  decision: TurnDecision,
): QualityScores {
  const u = userMessage.trim().toLowerCase();
  const a = assistantText.trim().toLowerCase();
  const overlap = u
    ? u.split(/\W+/).filter((w) => w.length > 3 && a.includes(w)).length
    : 0;
  const userTokens = u ? u.split(/\W+/).filter((w) => w.length > 3).length : 0;
  const directness = decision.requiresDirectAnswer
    ? clamp01(0.35 + overlap / Math.max(1, userTokens))
    : 0.8;
  const relevance = clamp01(0.25 + overlap / Math.max(2, userTokens || 2));
  const novelty = clamp01(a.length > 32 ? 0.75 : 0.45);
  const memoryUsefulness = /\b(as you said|you mentioned|earlier|last time)\b/i.test(assistantText)
    ? 0.9
    : 0.55;
  const safety = /\b(guaranteed|100%|all in)\b/i.test(assistantText) ? 0.3 : 0.92;
  return { directness, relevance, novelty, memoryUsefulness, safety };
}

export function needsRewrite(q: QualityScores, decision: TurnDecision): boolean {
  if (decision.requiresDirectAnswer && q.directness < 0.55) return true;
  if (q.safety < 0.5) return true;
  return false;
}
