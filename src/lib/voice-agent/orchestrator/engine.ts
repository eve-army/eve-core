import OpenAI from "openai";
import { collectNonOverlappingTrendSpans, spansToVoiceHighlightSegments, VOICE_HIGHLIGHT_LINGER_SEC } from "@/lib/voice-highlight-timeline";
import { buildTurnDecision } from "@/lib/voice-agent/policy/decision";
import { buildPrompt, PROMPT_VERSION } from "@/lib/voice-agent/prompt/templates";
import { parseAgentJson } from "@/lib/voice-agent/prompt/parser";
import { getMemoryBundle, recordTurn } from "@/lib/voice-agent/memory/store";
import { needsRewrite, scoreQuality } from "@/lib/voice-agent/critic/quality";
import { incCounter } from "@/lib/voice-agent/observability/metrics";
import type { CharacterAlignment, TurnRequest, TurnResponse, VoiceTimelineEvent } from "@/lib/voice-agent/types";
import { normalizeTrendKey } from "@/lib/live-trends";

const DEFAULT_VOICE_ID = "PB6BdkFkZLbI39GHdnbQ";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

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

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing on server. Check .env");
  }
  if (!req.skipTTS && !process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY missing on server.");
  }

  const completion = await getOpenAI().chat.completions.create({
    messages: [{ role: "system", content: prompt }],
    model: "gpt-4o-mini",
    temperature: 0.85,
    top_p: 0.93,
    frequency_penalty: 0.2,
    presence_penalty: 0,
    response_format: { type: "json_object" },
  });
  const raw = completion.choices[0]?.message?.content?.trim() || "";
  const parsed = parseAgentJson(raw);
  let say = parsed.say || raw;

  const quality = scoreQuality(req.message || "", say, decision);
  if (needsRewrite(quality, decision)) {
    say = softRewrite(req.message || "", say);
    incCounter("turn_rewrite_total");
  }

  const allowed = (req.liveTrendsDeduped || []).map((t) => t.trend_name);
  const highlightTrendName =
    resolveHighlight(parsed.highlightTrend, allowed) ??
    resolveHighlight(decision.focusTrend, allowed) ??
    null;

  const trendSpans = collectNonOverlappingTrendSpans(say, allowed);
  let audio: string | undefined;
  let highlightTimeline = [] as TurnResponse["highlightTimeline"];

  if (!req.skipTTS) {
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
  };
}
