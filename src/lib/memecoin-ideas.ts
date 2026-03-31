import type { DedupedTrend } from "@/lib/live-trends";

export type MemecoinIdea = {
  id: string;
  name: string;
  ticker: string;
  sourceTrends: string[];
  tagline: string;
  viabilityScore: number;
  createdAt: number;
  status: "processing" | "ready" | "selected" | "fading";
  imageUrl?: string | null;
};

export function computeViabilityScore(sourceTrends: DedupedTrend[]): number {
  if (sourceTrends.length === 0) return 30;
  let score = 0;
  for (const t of sourceTrends) {
    score += Math.min(t.maxHeat, 10) * 8; // heat contributes up to 80
    const s = (t.sentiment || "").toLowerCase();
    if (s.includes("positive")) score += 12;
    else if (s.includes("mixed")) score += 5;
    else if (s.includes("negative")) score -= 5;
  }
  return Math.max(5, Math.min(100, Math.round(score / sourceTrends.length)));
}

const MAX_MEMECOINS = 10;
const FADE_AFTER_MS = 5 * 60 * 1000;
const REMOVE_AFTER_MS = 6 * 60 * 1000;

export function addMemecoins(
  existing: MemecoinIdea[],
  incoming: MemecoinIdea[],
): MemecoinIdea[] {
  const existingNames = new Set(existing.map((m) => m.name.toLowerCase()));
  const existingTickers = new Set(existing.map((m) => m.ticker));
  const deduped = incoming.filter((m) => {
    const nk = m.name.toLowerCase();
    if (existingNames.has(nk) || existingTickers.has(m.ticker)) return false;
    existingNames.add(nk);
    existingTickers.add(m.ticker);
    return true;
  });
  return [...existing, ...deduped].slice(-MAX_MEMECOINS);
}

export function tickMemecoins(ideas: MemecoinIdea[]): MemecoinIdea[] {
  const now = Date.now();
  return ideas
    .filter((m) => now - m.createdAt < REMOVE_AFTER_MS || m.status === "selected")
    .map((m) => {
      if (m.status === "ready" && now - m.createdAt > FADE_AFTER_MS) {
        return { ...m, status: "fading" as const };
      }
      return m;
    });
}
