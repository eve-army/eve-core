import { normalizeTrendKey } from "@/lib/live-trends";

/** High-contrast HSL colors for dark bg + video compression; 12-step wheel. */
const HUE_STEPS = [18, 48, 98, 148, 178, 208, 238, 268, 298, 328, 8, 118];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Stable per-trend color for stream overlay (distinct from sentiment-only buckets).
 */
export function streamTrendColor(trendKey: string, index: number): string {
  const key = normalizeTrendKey(trendKey) || trendKey.trim().toLowerCase();
  const h = hashString(key);
  const hue = HUE_STEPS[(h + index * 7) % HUE_STEPS.length] ?? HUE_STEPS[0];
  const sat = 72 + (h % 12);
  const light = 58 + (h % 8);
  return `hsl(${hue} ${sat}% ${light}%)`;
}
