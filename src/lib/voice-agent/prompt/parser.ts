export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "");
    s = s.replace(/\s*```\s*$/i, "");
  }
  return s.trim();
}

export function parseAgentJson(raw: string): { say: string; highlightTrend: string | null } {
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
    return { say: say || trimmed, highlightTrend };
  } catch {
    return { say: trimmed, highlightTrend: null };
  }
}
