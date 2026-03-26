import { normalizeTrendKey } from "@/lib/live-trends";

export type VoiceHighlightSegment = {
  trendName: string;
  startSec: number;
  endSec: number;
};

export type CharacterAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

/** Seconds to keep the dot glowing after the last spoken character of the mention. */
export const VOICE_HIGHLIGHT_LINGER_SEC = 2.6;

/**
 * Longest word-aligned substring of `trendName` that appears in `text` (case-insensitive).
 * Used when the host shortens a trend (“choose financial mentors”) vs the full leaderboard label.
 */
export function findWordAlignedSubphraseSpan(
  text: string,
  trendName: string,
): { start: number; end: number } | null {
  const lower = text.toLowerCase();
  const tn = trendName.trim();
  if (tn.length < 3) return null;
  const words = tn.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;

  let best: { start: number; end: number; len: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    for (let j = words.length; j > i; j--) {
      const phrase = words.slice(i, j).join(" ");
      const wordCount = j - i;
      if (phrase.length < 6) continue;
      if (phrase.length < 10 && wordCount < 2) continue;
      const idx = lower.indexOf(phrase.toLowerCase());
      if (idx !== -1 && (!best || phrase.length > best.len)) {
        best = { start: idx, end: idx + phrase.length, len: phrase.length };
      }
    }
  }
  return best ? { start: best.start, end: best.end } : null;
}

/**
 * Single highlight window from when a named trend is spoken (partial phrase ok), for fallback paths.
 */
export function buildTimelineForTrendMention(
  text: string,
  trendName: string,
  durationSec: number,
  lingerSec: number,
  resolveCanonical: (raw: string) => string | null,
): VoiceHighlightSegment[] {
  if (durationSec <= 0 || !text.trim() || !trendName.trim()) return [];
  const canon = resolveCanonical(trendName.trim()) ?? trendName.trim();
  const span =
    findWordAlignedSubphraseSpan(text, canon) ??
    findWordAlignedSubphraseSpan(text, trendName.trim());
  if (!span) return [];
  const textLen = Math.max(1, text.length);
  return mergeAdjacentSameTrend([
    {
      trendName: canon,
      startSec: (span.start / textLen) * durationSec,
      endSec: (span.end / textLen) * durationSec + lingerSec,
    },
  ]);
}

/**
 * Find non-overlapping mentions of allowed trend names in spoken text (longest names first).
 */
export function collectNonOverlappingTrendSpans(
  text: string,
  allowedCanonicalNames: string[],
): { name: string; start: number; end: number }[] {
  const lower = text.toLowerCase();
  const sorted = [...new Set(allowedCanonicalNames.map((n) => n.trim()).filter(Boolean))]
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);

  const candidates: { name: string; start: number; end: number }[] = [];
  for (const name of sorted) {
    const tl = name.toLowerCase();
    let from = 0;
    let idx: number;
    let gotFull = false;
    while ((idx = lower.indexOf(tl, from)) !== -1) {
      gotFull = true;
      candidates.push({ name, start: idx, end: idx + name.length });
      from = idx + 1;
    }
    if (!gotFull) {
      const partial = findWordAlignedSubphraseSpan(text, name);
      if (partial) {
        candidates.push({ name, start: partial.start, end: partial.end });
      }
    }
  }

  candidates.sort(
    (a, b) => a.start - b.start || b.end - a.end - (b.start - b.start),
  );

  const picked: typeof candidates = [];
  for (const c of candidates) {
    const overlaps = picked.some((p) => c.start < p.end && p.start < c.end);
    if (overlaps) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.start - b.start);
}

function audioEndFromAlignment(a: CharacterAlignment): number {
  const ends = a.character_end_times_seconds;
  if (!ends?.length) return 0;
  return ends[ends.length - 1] ?? 0;
}

/**
 * Map character spans to wall-clock seconds using ElevenLabs alignment; proportional fallback if lengths diverge.
 */
export function spansToVoiceHighlightSegments(
  text: string,
  spans: { name: string; start: number; end: number }[],
  alignment: CharacterAlignment | null | undefined,
  lingerSec: number,
  resolveCanonical: (raw: string) => string | null,
): VoiceHighlightSegment[] {
  if (spans.length === 0) return [];

  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  const chars = alignment?.characters;
  const alignLen = starts?.length ?? 0;
  const textLen = Math.max(1, text.length);
  const endAudio = alignment ? audioEndFromAlignment(alignment) : 0;
  const useAlign =
    alignment &&
    starts &&
    ends &&
    chars &&
    alignLen > 0 &&
    Math.abs(alignLen - text.length) <= 4;

  const out: VoiceHighlightSegment[] = [];

  for (const sp of spans) {
    const canonical = resolveCanonical(sp.name) ?? sp.name;
    const lastChar = Math.max(sp.start, sp.end - 1);

    let startSec: number;
    let endSec: number;

    if (
      useAlign &&
      sp.start < starts!.length &&
      lastChar < ends!.length
    ) {
      startSec = starts![sp.start] ?? 0;
      endSec = (ends![lastChar] ?? startSec) + lingerSec;
    } else if (endAudio > 0) {
      startSec = (sp.start / textLen) * endAudio;
      endSec = (sp.end / textLen) * endAudio + lingerSec;
    } else {
      const scale = 8;
      startSec = (sp.start / textLen) * scale;
      endSec = (sp.end / textLen) * scale + lingerSec;
    }

    if (Number.isFinite(startSec) && Number.isFinite(endSec)) {
      out.push({ trendName: canonical, startSec, endSec });
    }
  }

  return mergeAdjacentSameTrend(out);
}

/** Merge back-to-back segments for the same trend so highlight doesn’t flicker. */
function mergeAdjacentSameTrend(
  segments: VoiceHighlightSegment[],
): VoiceHighlightSegment[] {
  if (segments.length <= 1) return segments;
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  const merged: VoiceHighlightSegment[] = [];
  for (const seg of sorted) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      normalizeTrendKey(prev.trendName) === normalizeTrendKey(seg.trendName) &&
      seg.startSec <= prev.endSec + 0.05
    ) {
      prev.endSec = Math.max(prev.endSec, seg.endSec);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Proportional timeline when we only know audio duration (e.g. HF / no alignment).
 */
export function buildProportionalHighlightTimeline(
  text: string,
  allowedNames: string[],
  durationSec: number,
  lingerSec: number,
  resolveCanonical: (raw: string) => string | null,
): VoiceHighlightSegment[] {
  if (durationSec <= 0 || !text.trim()) return [];
  const spans = collectNonOverlappingTrendSpans(text, allowedNames);
  const textLen = Math.max(1, text.length);
  const raw: VoiceHighlightSegment[] = [];
  for (const sp of spans) {
    const canonical = resolveCanonical(sp.name) ?? sp.name;
    const startSec = (sp.start / textLen) * durationSec;
    const endSec = (sp.end / textLen) * durationSec + lingerSec;
    raw.push({ trendName: canonical, startSec, endSec });
  }
  return mergeAdjacentSameTrend(raw);
}
