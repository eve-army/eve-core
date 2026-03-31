import type { MemecoinIdea } from "@/lib/memecoin-ideas";
import type { DedupedTrend } from "@/lib/live-trends";
import { normalizeTrendKey } from "@/lib/live-trends";

// ── Constants ────────────────────────────────────────────────
export const LAUNCH_CYCLE_MS = 4 * 60_000;
export const LAUNCH_RETRY_MS = 2 * 60_000;
export const MIN_IDEAS_BEFORE_LAUNCH = 3;
export const SELECTION_DISPLAY_MS = 5_000;
export const COUNTDOWN_SEC = 10;
export const POST_LAUNCH_DISPLAY_MS = 30_000;

// ── Types ────────────────────────────────────────────────────
export type LaunchPhase = "idle" | "selecting" | "countdown" | "deploying" | "success" | "failed";

export type LaunchState = {
  phase: LaunchPhase;
  selectedIdea: MemecoinIdea | null;
  countdownSec: number;
  phaseStartedAt: number;
  deployResult: { mint: string; signature: string } | null;
  error: string | null;
};

export const INITIAL_LAUNCH_STATE: LaunchState = {
  phase: "idle",
  selectedIdea: null,
  countdownSec: 0,
  phaseStartedAt: 0,
  deployResult: null,
  error: null,
};

// ── Selection Algorithm ──────────────────────────────────────
export function selectBestMemecoin(
  ideas: MemecoinIdea[],
  trends: DedupedTrend[],
): MemecoinIdea | null {
  const eligible = ideas.filter(
    (m) => (m.status === "ready" || m.status === "processing") && m.imageUrl,
  );
  if (eligible.length === 0) return null;

  const now = Date.now();
  const FADE_MS = 5 * 60_000;

  let best: MemecoinIdea | null = null;
  let bestScore = -1;

  for (const idea of eligible) {
    // Viability component (0-100) — 60% weight
    const viability = idea.viabilityScore;

    // Age bonus: older ideas that haven't faded yet show staying power (0-100) — 20% weight
    const ageFrac = Math.min(1, (now - idea.createdAt) / FADE_MS);
    const ageBonus = ageFrac * 100;

    // Trend heat bonus: current heat of the source trend (0-100) — 20% weight
    let trendHeat = 0;
    if (idea.sourceTrends.length > 0) {
      const srcKey = normalizeTrendKey(idea.sourceTrends[0]);
      const srcTrend = trends.find((t) => normalizeTrendKey(t.trend_name) === srcKey);
      if (srcTrend) {
        trendHeat = Math.min(100, srcTrend.maxHeat * 10);
      }
    }

    const score = viability * 0.6 + ageBonus * 0.2 + trendHeat * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = idea;
    }
  }

  return best;
}
