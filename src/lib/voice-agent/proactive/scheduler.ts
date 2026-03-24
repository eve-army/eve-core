import type { DedupedTrend } from "@/lib/live-trends";

export type ProactiveInputs = {
  nowMs: number;
  lastRealChatAtMs: number;
  lastSpokenAtMs: number;
  lastReactiveSpokenAtMs?: number;
  starvationMs?: number;
  reactiveGraceMs?: number;
  minNovelty?: number;
  allowLowNoveltyOnStarvation?: boolean;
  liveTrends: DedupedTrend[];
};

export type ProactiveDecision = {
  shouldFire: boolean;
  minGapMs: number;
  noveltyScore: number;
  priority: number;
  reason:
    | "cooldown"
    | "no_trends"
    | "low_novelty"
    | "reactive_recent"
    | "ready"
    | "starvation_override";
  expiryMs: number;
};

export function decideProactiveTurn(input: ProactiveInputs): ProactiveDecision {
  const silenceMs = input.nowMs - input.lastRealChatAtMs;
  let minGap = 50_000;
  if (silenceMs > 5 * 60_000) minGap = 90_000;
  if (silenceMs > 12 * 60_000) minGap = 4 * 60_000;

  const topHeat = input.liveTrends[0]?.maxHeat ?? 0;
  const secondHeat = input.liveTrends[1]?.maxHeat ?? topHeat;
  const heatGap = Math.max(0, topHeat - secondHeat);
  const novelty = Math.max(0, Math.min(1, topHeat / 30 + heatGap / 20));
  const starvationMs = input.starvationMs ?? 4 * 60_000;
  const reactiveGraceMs = input.reactiveGraceMs ?? 25_000;
  const minNovelty = input.minNovelty ?? 0.15;
  const allowLowNoveltyOnStarvation = input.allowLowNoveltyOnStarvation ?? false;
  const sinceReactive = input.lastReactiveSpokenAtMs
    ? input.nowMs - input.lastReactiveSpokenAtMs
    : Number.POSITIVE_INFINITY;
  const sinceProactive = input.nowMs - input.lastSpokenAtMs;

  const baseExpiry = input.nowMs + Math.max(minGap, 90_000);

  if (input.liveTrends.length === 0) {
    return {
      shouldFire: false,
      minGapMs: minGap,
      noveltyScore: novelty,
      priority: 0,
      reason: "no_trends",
      expiryMs: baseExpiry,
    };
  }

  if (
    sinceProactive >= starvationMs &&
    (allowLowNoveltyOnStarvation || novelty >= Math.max(0.1, minNovelty))
  ) {
    return {
      shouldFire: true,
      minGapMs: minGap,
      noveltyScore: novelty,
      priority: 10,
      reason: "starvation_override",
      expiryMs: baseExpiry,
    };
  }

  if (input.nowMs - input.lastSpokenAtMs < minGap) {
    return {
      shouldFire: false,
      minGapMs: minGap,
      noveltyScore: novelty,
      priority: 1,
      reason: "cooldown",
      expiryMs: baseExpiry,
    };
  }

  if (sinceReactive < reactiveGraceMs) {
    return {
      shouldFire: false,
      minGapMs: minGap,
      noveltyScore: novelty,
      priority: 2,
      reason: "reactive_recent",
      expiryMs: baseExpiry,
    };
  }

  if (novelty < minNovelty) {
    return {
      shouldFire: false,
      minGapMs: minGap,
      noveltyScore: novelty,
      priority: 2,
      reason: "low_novelty",
      expiryMs: baseExpiry,
    };
  }
  return {
    shouldFire: true,
    minGapMs: minGap,
    noveltyScore: novelty,
    priority: Math.max(3, Math.min(9, Math.round(3 + novelty * 6))),
    reason: "ready",
    expiryMs: baseExpiry,
  };
}
