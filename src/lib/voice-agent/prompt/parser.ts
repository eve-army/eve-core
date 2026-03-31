export type ParsedMemecoin = {
  name: string;
  ticker: string;
  trend: string;
  tagline: string;
};

export type ParsedAgentOutput = {
  say: string;
  highlightTrend: string | null;
  memecoins: ParsedMemecoin[];
};

export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "");
    s = s.replace(/\s*```\s*$/i, "");
  }
  return s.trim();
}

function parseMemecoinArray(val: unknown): ParsedMemecoin[] {
  if (!Array.isArray(val)) return [];
  const out: ParsedMemecoin[] = [];
  for (const item of val) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const ticker = typeof o.ticker === "string" ? o.ticker.trim().replace(/^\$/, "").toUpperCase() : "";
    const trend = typeof o.trend === "string" ? o.trend.trim() : "";
    const tagline = typeof o.tagline === "string" ? o.tagline.trim() : "";
    if (name && ticker) {
      out.push({ name, ticker: ticker.slice(0, 6), trend, tagline });
    }
  }
  return out.slice(0, 3);
}

/** Regex fallback: scan `say` for $TICKER patterns and quoted names near coin keywords. */
function extractMemecoinsFallback(say: string): ParsedMemecoin[] {
  const out: ParsedMemecoin[] = [];
  // Match $TICKER (3-6 uppercase letters)
  const tickerRe = /\$([A-Z]{3,6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = tickerRe.exec(say)) !== null) {
    const ticker = m[1];
    // Try to find a name nearby — look for quoted text or capitalized phrase before the ticker
    const before = say.slice(Math.max(0, m.index - 60), m.index);
    const nameMatch = before.match(/"([^"]{2,30})"/) ?? before.match(/\b([A-Z][A-Z\s]{2,20}[A-Z])\b/);
    out.push({
      name: nameMatch?.[1]?.trim() || ticker,
      ticker,
      trend: "",
      tagline: "",
    });
  }
  return out.slice(0, 3);
}

export function parseAgentJson(raw: string): ParsedAgentOutput {
  const trimmed = stripJsonFences(raw);
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const say =
      typeof j.say === "string"
        ? j.say.trim()
        : typeof j.spoken === "string"
          ? j.spoken.trim()
          : trimmed;
    const h = j.highlightTrend ?? j.highlight_trend ?? j.highlight ?? null;
    const highlightTrend = typeof h === "string" && h.trim() ? h.trim() : null;
    let memecoins = parseMemecoinArray(j.memecoins);
    // Fallback: if model omitted structured array, try regex extraction
    if (memecoins.length === 0 && say) {
      memecoins = extractMemecoinsFallback(say);
    }
    return { say: say || trimmed, highlightTrend, memecoins };
  } catch {
    const memecoins = extractMemecoinsFallback(trimmed);
    return { say: trimmed, highlightTrend: null, memecoins };
  }
}
