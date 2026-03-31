import { buildProportionalHighlightTimeline, collectNonOverlappingTrendSpans, spansToVoiceHighlightSegments, VOICE_HIGHLIGHT_LINGER_SEC } from "@/lib/voice-highlight-timeline";
import { buildTurnDecision } from "@/lib/voice-agent/policy/decision";
import { buildPrompt, PROMPT_VERSION } from "@/lib/voice-agent/prompt/templates";
import { parseAgentJson } from "@/lib/voice-agent/prompt/parser";
import { getMemoryBundle, recordTurn } from "@/lib/voice-agent/memory/store";
import { needsRewrite, scoreQuality } from "@/lib/voice-agent/critic/quality";
import { incCounter } from "@/lib/voice-agent/observability/metrics";
import type { CharacterAlignment, TurnRequest, TurnResponse, VoiceTimelineEvent } from "@/lib/voice-agent/types";
import { normalizeTrendKey } from "@/lib/live-trends";

import { qwenChat } from "@/lib/qwen-client";

const DEFAULT_VOICE_ID = "PB6BdkFkZLbI39GHdnbQ";

function resolveHighlight(candidate: string | null, allowed: string[]): string | null {
  if (!candidate) return null;
  const n = normalizeTrendKey(candidate);
  for (const a of allowed) {
    if (normalizeTrendKey(a) === n) return a;
  }
  return null;
}

function buildSubtitleEvents(text: string): VoiceTimelineEvent[] {
  const chunks = text.split(/([.!?])\s+/).filter((x) => x.trim().length > 0);
  let t = 0;
  return chunks.map((c) => {
    const dur = Math.max(0.45, Math.min(3.2, c.length * 0.035));
    const ev: VoiceTimelineEvent = {
      type: "subtitle_chunk",
      text: c.trim(),
      startSec: t,
      endSec: t + dur,
    };
    t += dur;
    return ev;
  });
}

function softRewrite(userMessage: string, text: string): string {
  if (!userMessage.trim()) return text;
  return `You asked: ${userMessage.trim()} — ${text}`;
}

export async function runTurn(req: TurnRequest): Promise<TurnResponse> {
  const started = Date.now();
  incCounter("turn_requests_total");

  const decision = buildTurnDecision(req);
  const memory = await getMemoryBundle(req);
  const prompt = buildPrompt(req, decision, memory);

  if (!req.skipTTS && !req.xttsVoice && !process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY missing on server.");
  }

  const messages: { role: string; content: string }[] = [{ role: "system", content: prompt }];
  if (req.lastAgentSay?.trim()) {
    messages.push({
      role: "assistant",
      content: JSON.stringify({ say: req.lastAgentSay.trim(), highlightTrend: null }),
    });
  }
  messages.push({ role: "user", content: req.message?.trim() || "(no message)" });

  const raw = await qwenChat(messages);
  const parsed = parseAgentJson(raw);
  // Keep the original agent reply for span/highlight detection — softRewrite may prepend the
  // user's message which would pollute span positions with trends from the question, not the answer.
  const agentReply = parsed.say || raw;
  let say = agentReply;

  const quality = scoreQuality(req.message || "", say, decision);
  if (needsRewrite(quality, decision)) {
    say = softRewrite(req.message || "", say);
    incCounter("turn_rewrite_total");
  }

  const allowed = (req.liveTrendsDeduped || []).map((t) => t.trend_name);

  // Detect trend spans from the original reply, not the soft-rewritten version.
  const trendSpans = collectNonOverlappingTrendSpans(agentReply, allowed);

  // Only trust highlightTrend if that trend is actually mentioned in the reply text.
  // Qwen 3B often sets highlightTrend to a random list entry it never says — discard those.
  const resolvedHighlight = resolveHighlight(parsed.highlightTrend, allowed);
  const highlightIsInReply =
    resolvedHighlight != null &&
    trendSpans.some(
      (s) => normalizeTrendKey(s.name) === normalizeTrendKey(resolvedHighlight),
    );

  const highlightTrendName =
    (highlightIsInReply ? resolvedHighlight : null) ??
    (trendSpans.length > 0 ? resolveHighlight(trendSpans[0].name, allowed) : null) ??
    null;
  let audio: string | undefined;
  let highlightTimeline = [] as TurnResponse["highlightTimeline"];

  if (req.xttsVoice) {
    const xttsUrl = process.env.XTTS_BASE_URL;
    if (!xttsUrl) throw new Error("XTTS_BASE_URL missing on server. Check .env");
    const tts = await fetch(`${xttsUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: say, speaker_name: req.xttsVoice, language: "en" }),
    });
    if (!tts.ok) {
      const err = await tts.text();
      throw new Error(`XTTS server returned ${tts.status}: ${err}`);
    }
    const payload = (await tts.json()) as { audio_base64?: string };
    if (!payload.audio_base64) throw new Error("XTTS: missing audio_base64");
    audio = `data:audio/wav;base64,${payload.audio_base64}`;
    // WAV duration from header: bytes 28-31 = byteRate, bytes 40-43 = dataChunkSize
    const buf = Buffer.from(payload.audio_base64, "base64");
    const byteRate = buf.readUInt32LE(28);
    const dataSize = buf.readUInt32LE(40);
    const durationSec = byteRate > 0 ? dataSize / byteRate : agentReply.length * 0.06;
    // Use agentReply (not say) so softRewrite prefix doesn't distort proportional positions.
    highlightTimeline = buildProportionalHighlightTimeline(
      agentReply,
      allowed,
      durationSec,
      VOICE_HIGHLIGHT_LINGER_SEC,
      (rawTrend) => resolveHighlight(rawTrend, allowed),
    );
  } else if (!req.skipTTS) {
    const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      },
      body: JSON.stringify({
        text: say,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!tts.ok) {
      const err = await tts.text();
      throw new Error(`ElevenLabs API returned ${tts.status}: ${err}`);
    }
    const payload = (await tts.json()) as {
      audio_base64?: string;
      alignment?: CharacterAlignment;
      normalized_alignment?: CharacterAlignment;
    };
    if (!payload.audio_base64) throw new Error("Missing audio_base64");
    audio = `data:audio/mpeg;base64,${payload.audio_base64}`;
    const alignment = payload.alignment ?? payload.normalized_alignment ?? null;
    highlightTimeline = spansToVoiceHighlightSegments(
      say,
      trendSpans,
      alignment,
      VOICE_HIGHLIGHT_LINGER_SEC,
      (rawTrend) => resolveHighlight(rawTrend, allowed),
    );
  }

  const events: VoiceTimelineEvent[] = [
    ...highlightTimeline.map((h) => ({
      type: "highlight_segment" as const,
      trendName: h.trendName,
      startSec: h.startSec,
      endSec: h.endSec,
    })),
    ...buildSubtitleEvents(say),
  ];

  await recordTurn(req, "user", req.message || "", {
    intent: decision.intent,
    turnKind: decision.turnKind,
  });
  await recordTurn(req, "assistant", say, {
    intent: decision.intent,
    turnKind: decision.turnKind,
    quality,
  });
  incCounter("turn_success_total");

  // Validate memecoins: resolve trend names against allowed list
  const validatedMemecoins = (parsed.memecoins ?? [])
    .map((mc) => ({
      name: mc.name,
      ticker: mc.ticker,
      sourceTrend: resolveHighlight(mc.trend, allowed) ?? mc.trend,
      tagline: mc.tagline,
    }))
    .filter((mc) => mc.name && mc.ticker);

  return {
    text: say,
    audio,
    highlightTrendName,
    highlightTimeline,
    events,
    decision,
    memory,
    quality,
    promptVersion: PROMPT_VERSION,
    latencyMs: Date.now() - started,
    memecoins: validatedMemecoins,
  };
}
