import { z } from "zod";

export const DEFAULT_LIVE_TRENDS_URL =
  "https://songjamspace-leaderboard.logesh-063.workers.dev/live-trending";

const TrendRowSchema = z.object({
  trend_name: z.string(),
  summary: z.string().optional(),
  heat_score: z.coerce.number(),
  sentiment: z.string().optional(),
  cluster_id: z.coerce.number().optional(),
  cycle_start: z.string().optional(),
  updated_at: z.string().optional(),
  tweet_count: z.coerce.number().optional(),
  top_tweet_ids: z.array(z.string()).optional(),
  trend_direction: z.string().optional(),
  image_url: z.string().nullable().optional(),
});

export type LiveTrendRow = z.infer<typeof TrendRowSchema>;

export function parseLiveTrendsJson(json: unknown): LiveTrendRow[] {
  // Support both raw arrays and {trends: [...]} wrapper format.
  const arr = Array.isArray(json)
    ? json
    : json != null && typeof json === "object" && Array.isArray((json as Record<string, unknown>).trends)
      ? (json as Record<string, unknown>).trends as unknown[]
      : null;
  if (!arr) return [];
  const out: LiveTrendRow[] = [];
  for (const item of arr) {
    const r = TrendRowSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** One row per theme: latest updated_at row as base, max heat, summary from hottest row. */
export type DedupedTrend = {
  trend_name: string;
  summary: string;
  heat_score: number;
  maxHeat: number;
  sentiment: string;
  updated_at: string;
  tweet_count?: number;
  /** From API when present; used to spread trends angularly by theme cluster. */
  cluster_id?: number;
  /** Thumbnail image for the trend (from source). */
  image_url?: string | null;
  /** Tweet IDs from source — preserved for future tweet content fetching. */
  top_tweet_ids?: string[];
};

/** Normalize for comparing radar trend labels (case, whitespace). */
export function normalizeTrendKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when two display names refer to the same trend (e.g. API vs polar point). */
export function trendDisplayNamesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  return normalizeTrendKey(a) === normalizeTrendKey(b);
}

export function dedupeTrendsByName(rows: LiveTrendRow[]): DedupedTrend[] {
  const byName = new Map<string, LiveTrendRow[]>();
  for (const r of rows) {
    const k = r.trend_name.trim();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(r);
  }
  const out: DedupedTrend[] = [];
  for (const [name, group] of byName) {
    let maxHeat = 0;
    let bestSummary = "";
    let hottest: LiveTrendRow | null = null;
    for (const r of group) {
      const hs = r.heat_score;
      if (Number.isFinite(hs) && hs > maxHeat) {
        maxHeat = hs;
        bestSummary = (r.summary || "").slice(0, 280);
        hottest = r;
      }
    }
    let latest = group[0];
    let latestTs = parseTrendTime(latest.updated_at || latest.cycle_start);
    for (const r of group) {
      const t = parseTrendTime(r.updated_at || r.cycle_start);
      if (t >= latestTs) {
        latestTs = t;
        latest = r;
      }
    }
    const sentiment = (hottest?.sentiment || latest.sentiment || "Unknown").trim();
    const tc = group.reduce((m, r) => Math.max(m, r.tweet_count ?? 0), 0);
    const rawCluster = hottest?.cluster_id ?? latest.cluster_id;
    const cluster_id =
      typeof rawCluster === "number" && Number.isFinite(rawCluster)
        ? rawCluster
        : undefined;
    const image_url = (hottest?.image_url || latest.image_url) ?? null;
    // Merge top_tweet_ids from all rows in the group (union, deduplicated)
    const tweetIdSet = new Set<string>();
    for (const r of group) {
      for (const id of r.top_tweet_ids ?? []) {
        if (id) tweetIdSet.add(id);
      }
    }
    out.push({
      trend_name: name,
      summary: bestSummary || (latest.summary || "").slice(0, 280),
      heat_score: Number.isFinite(latest.heat_score) ? latest.heat_score : 0,
      maxHeat: Number.isFinite(maxHeat) ? maxHeat : 0,
      sentiment,
      updated_at: latest.updated_at || latest.cycle_start || new Date().toISOString(),
      tweet_count: tc || undefined,
      cluster_id,
      image_url: image_url || undefined,
      top_tweet_ids: tweetIdSet.size > 0 ? [...tweetIdSet] : undefined,
    });
  }
  return out.sort((a, b) => b.maxHeat - a.maxHeat);
}

function parseTrendTime(s?: string): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

const BLOCK_SUBSTRINGS = [
  "abuse",
  "beating",
  "assault",
  "domestic violence",
  "killed",
  "murder",
  "suicide",
];

export function isTrendContentBlocked(name: string, summary: string): boolean {
  const blob = `${name} ${summary}`.toLowerCase();
  return BLOCK_SUBSTRINGS.some((w) => blob.includes(w));
}

const MEME_RE = /\b(meme|coin|pump|solana|sol\b|crypto|token|airdrop|degen)\b/i;

export function launchScore(t: DedupedTrend): number {
  let s = t.maxHeat * (1 + 0.02 * Math.min(t.tweet_count ?? 0, 50));
  const sent = t.sentiment.toLowerCase();
  if (sent.includes("positive")) s *= 1.12;
  else if (sent.includes("negative")) s *= 0.82;
  else if (sent.includes("mixed")) s *= 0.95;
  const text = `${t.trend_name} ${t.summary}`;
  if (MEME_RE.test(text)) s += 0.6;
  if (isTrendContentBlocked(t.trend_name, t.summary)) s *= 0.15;
  return s;
}

export type LaunchCandidate = DedupedTrend & { launchScore: number };

export function topLaunchCandidates(deduped: DedupedTrend[], n = 3): LaunchCandidate[] {
  return deduped
    .filter((t) => !isTrendContentBlocked(t.trend_name, t.summary))
    .map((t) => ({ ...t, launchScore: launchScore(t) }))
    .sort((a, b) => b.launchScore - a.launchScore)
    .slice(0, n);
}

export type HeatmapBuild = {
  xLabels: string[];
  yLabels: string[];
  /** ECharts heatmap data: [xIndex, yIndex, value][] */
  seriesData: [number, number, number][];
  /** trend key per Y row (full name) */
  yTrendKeys: string[];
};

/** One dot per trend on a polar grid: radius = heat, angle = stable layout (not “one axis per trend”). */
export type TrendChangeKind = "new" | "heat_up" | "heat_down" | "stable";

export type TrendPolarPoint = {
  trend_name: string;
  maxHeat: number;
  sentiment: string;
  /** Short blurb from live-trends API (deduped). */
  summary: string;
  angleDeg: number;
  change: TrendChangeKind;
  /** Thumbnail image for the trend (from source). */
  image_url?: string | null;
};

export type TrendPolarBuild = {
  points: TrendPolarPoint[];
  /** Radius axis max (slightly above top heat in view). */
  radiusMax: number;
  trendKeys: string[];
  /** Count of deduped (unique-name) trends plotted. */
  totalAvailable: number;
};

/** Deterministic [0, 1) from string — stable across server/client for the same name. */
export function hashStringTo01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Polar angle (degrees, 0–360) so dots use the **full circle**.
 *
 * 1. **Base** — `hashStringTo01(name) * 360`: same trend name → same direction every refresh
 *    (stable, no randomness).
 * 2. **Spread** — add `rankIndex * GOLDEN_ANGLE_DEG` (mod 360). Consecutive ranks in the
 *    heat-sorted list step by ~137.5°, an irrational fraction of the circle (phyllotaxis-style),
 *    so many points don’t pile on the same few degrees when hashes collide or names are similar.
 *
 * We intentionally do **not** use API `cluster_id` for angle anymore: it often repeats across
 * rows and locked everyone into one narrow wedge (~22°), which looked “bunched on one side.”
 */
const GOLDEN_ANGLE_DEG = 360 / (1 + (1 + Math.sqrt(5)) / 2); // ≈ 137.508°

export function trendPolarAngleDeg(name: string, rankIndex: number): number {
  const h = hashStringTo01(name);
  const safeRank = Number.isFinite(rankIndex) ? Math.max(0, Math.floor(rankIndex)) : 0;
  const baseDeg = h * 360;
  const ang = (baseDeg + safeRank * GOLDEN_ANGLE_DEG) % 360;
  return Number.isFinite(ang) ? ang : (baseDeg % 360);
}

function classifyTrendChange(
  name: string,
  maxHeat: number,
  prev: Map<string, { maxHeat: number }> | undefined,
  absEpsilon: number,
): TrendChangeKind {
  if (!prev || prev.size === 0 || !prev.has(name)) return "new";
  const p = prev.get(name);
  if (!p) return "new";
  const oldH = p.maxHeat;
  if (!Number.isFinite(oldH)) return "new";
  if (maxHeat > oldH + absEpsilon) return "heat_up";
  if (maxHeat < oldH - absEpsilon) return "heat_down";
  return "stable";
}

/**
 * Every deduped trend as a polar scatter point (one dot per unique `trend_name`), sorted by maxHeat
 * descending. No cap on how many dots are drawn.
 */
export function buildTrendPolarScatterData(
  deduped: DedupedTrend[],
  opts?: {
    /** Prior snapshot (by trend name). If empty/missing, all points are `stable`. */
    previousByName?: Map<string, { maxHeat: number }>;
    /** Minimum heat delta to count as heat_up / heat_down (default 0.35). */
    heatChangeEpsilon?: number;
  },
): TrendPolarBuild {
  const prevMap = opts?.previousByName;
  const heatEps = opts?.heatChangeEpsilon ?? 0.35;
  const hasPrev = prevMap !== undefined && prevMap.size > 0;
  const totalAvailable = deduped.length;
  const sorted = [...deduped].sort((a, b) => {
    const ah = Number.isFinite(a.maxHeat) ? a.maxHeat : 0;
    const bh = Number.isFinite(b.maxHeat) ? b.maxHeat : 0;
    return bh - ah;
  });
  const slice = sorted;

  if (slice.length === 0) {
    return { points: [], radiusMax: 1, trendKeys: [], totalAvailable };
  }
  const heats = slice.map((d) =>
    Number.isFinite(d.maxHeat) ? Math.max(0, d.maxHeat) : 0,
  );
  const maxHeat = Math.max(...heats, 1e-6);
  const radiusMax = Number.isFinite(maxHeat * 1.08) ? maxHeat * 1.08 : 1;
  const points: TrendPolarPoint[] = slice.map((d, i) => {
    const mh = Number.isFinite(d.maxHeat) ? Math.max(0, d.maxHeat) : 0;
    let angleDeg = trendPolarAngleDeg(d.trend_name, i);
    if (!Number.isFinite(angleDeg)) {
      angleDeg = (hashStringTo01(d.trend_name) * 360) % 360;
    }
    const change = hasPrev
      ? classifyTrendChange(d.trend_name, mh, prevMap, heatEps)
      : "stable";
    return {
      trend_name: d.trend_name,
      maxHeat: mh,
      sentiment: d.sentiment || "Unknown",
      summary: (d.summary || "").trim().slice(0, 400),
      angleDeg,
      change,
      image_url: d.image_url,
    };
  });
  return {
    points,
    radiusMax,
    trendKeys: points.map((p) => p.trend_name),
    totalAvailable,
  };
}

export function sentimentPalette(sentiment: string): {
  line: string;
  area: string;
  symbol: string;
} {
  const x = sentiment.toLowerCase();
  if (x.includes("positive")) {
    return {
      line: "#22d3ee",
      area: "rgba(34,211,238,0.28)",
      symbol: "#22d3ee",
    };
  }
  if (x.includes("negative")) {
    return {
      line: "#e879f9",
      area: "rgba(232,121,249,0.26)",
      symbol: "#e879f9",
    };
  }
  if (x.includes("mixed")) {
    return {
      line: "#fbbf24",
      area: "rgba(251,191,36,0.24)",
      symbol: "#fbbf24",
    };
  }
  return {
    line: "#94a3b8",
    area: "rgba(148,163,184,0.2)",
    symbol: "#a1a1aa",
  };
}

const BUCKET_MS = 15 * 60 * 1000;

/**
 * Rows: full raw list. Y = top N names by maxHeat. X = M buckets ending at now.
 */
export function buildHeatmapData(
  rows: LiveTrendRow[],
  topN = 16,
  numBuckets = 8
): HeatmapBuild {
  const deduped = dedupeTrendsByName(rows);
  const topNames = deduped.slice(0, topN).map((d) => d.trend_name);
  if (topNames.length === 0) {
    return { xLabels: [], yLabels: [], seriesData: [], yTrendKeys: [] };
  }
  const now = Date.now();
  const xLabels: string[] = [];
  for (let i = numBuckets - 1; i >= 0; i--) {
    const end = now - i * BUCKET_MS;
    const label = new Date(end).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    xLabels.push(label);
  }
  const yLabels = topNames.map((n) => (n.length > 42 ? `${n.slice(0, 40)}…` : n));
  const yTrendKeys = [...topNames];
  const seriesData: [number, number, number][] = [];
  for (let yi = 0; yi < topNames.length; yi++) {
    const name = topNames[yi];
    for (let xi = 0; xi < numBuckets; xi++) {
      const bucketStart = now - (numBuckets - xi) * BUCKET_MS;
      const bucketEnd = bucketStart + BUCKET_MS;
      let cellMax = 0;
      for (const r of rows) {
        if (r.trend_name.trim() !== name) continue;
        const ts = parseTrendTime(r.updated_at || r.cycle_start);
        if (ts >= bucketStart && ts < bucketEnd && r.heat_score > cellMax) {
          cellMax = r.heat_score;
        }
      }
      seriesData.push([xi, yi, cellMax]);
    }
  }
  return { xLabels, yLabels, seriesData, yTrendKeys };
}

/** Normalized one-line brief for LLM prompts (whitespace collapsed, capped length). */
function briefForAgentPrompt(t: DedupedTrend, maxLen: number): string {
  return (t.summary || "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/**
 * Numbered line for the agent system prompt: name, heat, sentiment, optional brief from live-trends API.
 */
export function formatDedupedTrendPromptLine(t: DedupedTrend, index: number): string {
  const heat = Number.isFinite(t.maxHeat) ? t.maxHeat.toFixed(1) : "?";
  const sent = t.sentiment || "mixed";
  const brief = briefForAgentPrompt(t, 220);
  const briefPart = brief.length > 0 ? ` · brief: ${brief}` : "";
  return `${index + 1}. "${t.trend_name}" — heat ${heat} · ${sent}${briefPart}`;
}

export function trimTrendForPrompt(t: DedupedTrend): string {
  const sum = briefForAgentPrompt(t, 200);
  return `${t.trend_name} [heat ${t.maxHeat}, ${t.sentiment}] ${sum}`;
}
