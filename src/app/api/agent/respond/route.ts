import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import type { DedupedTrend } from '@/lib/live-trends';
import {
  normalizeTrendKey,
  topLaunchCandidates,
  trimTrendForPrompt,
} from '@/lib/live-trends';
import {
  collectNonOverlappingTrendSpans,
  spansToVoiceHighlightSegments,
  type CharacterAlignment,
  VOICE_HIGHLIGHT_LINGER_SEC,
  type VoiceHighlightSegment,
} from '@/lib/voice-highlight-timeline';

export const dynamic = 'force-dynamic';

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
/** Default: ElevenLabs “Rachel”. Override with ELEVENLABS_VOICE_ID in .env.local */
const DEFAULT_ELEVENLABS_VOICE_ID = "PB6BdkFkZLbI39GHdnbQ";

/** Public iteration label (Pump.fun BiP demos); bump when you ship a new milestone. */
const EVE_AGENT_ITERATION = "006";

type AgentMode = 'chat_reply' | 'trend_tick' | 'vote_summary' | 'host_banter';

function normalizeDeduped(input: unknown): DedupedTrend[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (x): x is DedupedTrend =>
      x &&
      typeof x === 'object' &&
      typeof (x as DedupedTrend).trend_name === 'string' &&
      typeof (x as DedupedTrend).maxHeat === 'number'
  );
}

function resolveHighlightTrend(
  candidate: string | null | undefined,
  allowed: Set<string>,
): string | null {
  if (candidate == null || typeof candidate !== 'string') return null;
  const t = candidate.trim();
  if (!t) return null;
  if (allowed.has(t)) return t;
  const nt = normalizeTrendKey(t);
  for (const name of allowed) {
    if (normalizeTrendKey(name) === nt) return name;
  }
  return null;
}

/**
 * If the model left highlight null but the spoken line contains an allowed trend name verbatim
 * (substring, case-insensitive), pick the longest match to reduce false positives.
 */
function inferHighlightTrendFromSay(
  say: string,
  allowed: Set<string>,
): string | null {
  const t = say.trim();
  if (!t || allowed.size === 0) return null;
  const lower = t.toLowerCase();
  const names = [...allowed].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const n = name.trim();
    if (n.length < 3) continue;
    if (lower.includes(n.toLowerCase())) return n;
  }
  return null;
}

/**
 * Model paraphrases a theme; map to the closest allowed name via substring / word overlap.
 */
function fuzzyResolveHighlightTrend(
  candidate: string | null | undefined,
  allowed: Set<string>,
): string | null {
  if (candidate == null || typeof candidate !== 'string') return null;
  const c = candidate.trim();
  if (!c) return null;
  const direct = resolveHighlightTrend(c, allowed);
  if (direct) return direct;

  const cKey = normalizeTrendKey(c);
  if (cKey.length < 2) return null;

  let best: { name: string; score: number } | null = null;
  for (const name of allowed) {
    const nKey = normalizeTrendKey(name);
    if (!nKey) continue;

    let score = 0;
    if (nKey.includes(cKey) || cKey.includes(nKey)) {
      score = 40 + Math.min(cKey.length, nKey.length);
    } else {
      const cWords = new Set(
        cKey.split(/[^a-z0-9]+/).filter((w) => w.length >= 3),
      );
      const nWords = nKey.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      for (const w of nWords) {
        if (cWords.has(w)) score += w.length;
      }
    }

    if (score > 0 && (!best || score > best.score)) best = { name, score };
  }

  if (best && best.score >= 6) return best.name;
  return null;
}

function stripJsonFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '');
    s = s.replace(/\s*```\s*$/i, '');
  }
  return s.trim();
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const STYLE_HINTS = [
  'Open with one punchy question that pulls chat into the riff.',
  'Use one vivid metaphor or analogy tied to a live trend.',
  "Play gentle devil's advocate—why this launch angle might flop, then flip it.",
  'Hype-desk energy: fastest takes, biggest swings, still safe.',
  'Deadpan understatement; let one dry line land, then one warmer beat.',
  'Game-show host sparkle: stakes, silly stakes, invite the room.',
  'End with a specific challenge or poll for chat (not generic “thoughts?”).',
] as const;

function parseAgentJson(raw: string): { say: string; highlightTrend: string | null } {
  const trimmed = stripJsonFences(raw);
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const say =
      typeof j.say === 'string'
        ? j.say.trim()
        : typeof j.spoken === 'string'
          ? j.spoken.trim()
          : '';
    let highlightTrend: string | null = null;
    const h =
      j.highlightTrend ??
      j.highlight_trend ??
      j.HighlightTrend ??
      (typeof j.highlight === 'string' ? j.highlight : undefined);
    if (typeof h === 'string' && h.trim()) highlightTrend = h.trim();
    if (h === null || h === false) highlightTrend = null;
    return {
      say: say || trimmed,
      highlightTrend,
    };
  } catch {
    return { say: trimmed, highlightTrend: null };
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const skipTTSFirst = Boolean(
      body &&
        typeof body === 'object' &&
        (body as { skipTTS?: boolean }).skipTTS === true,
    );

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'OPENAI_API_KEY missing on server. Check .env' },
        { status: 500 },
      );
    }
    if (!skipTTSFirst && !process.env.ELEVENLABS_API_KEY) {
      return NextResponse.json(
        {
          error:
            'ELEVENLABS_API_KEY missing on server (required for default voice). Use an HF voice with skipTTS or add the key.',
        },
        { status: 500 },
      );
    }

    const {
      message,
      username,
      bondingCurveData,
      priceChanges,
      historicalPriceData,
      streamName,
      isBondedToken,
      solUsdPrice,
      skipTTS,
      agentMode = 'chat_reply',
      liveTrendsDeduped,
      voteTally,
      voteLeader,
      activeTrendSpeaking,
      recentChatTranscript,
      lastAgentSay,
      varietySeed,
    } = body as {
      message?: string;
      username?: string;
      bondingCurveData?: unknown;
      priceChanges?: unknown;
      historicalPriceData?: unknown;
      streamName?: string;
      isBondedToken?: boolean;
      solUsdPrice?: number | null;
      skipTTS?: boolean;
      agentMode?: AgentMode;
      liveTrendsDeduped?: unknown;
      voteTally?: Record<string, number>;
      voteLeader?: string;
      activeTrendSpeaking?: string | null;
      recentChatTranscript?: string;
      lastAgentSay?: string | null;
      varietySeed?: number;
    };

    const mode: AgentMode = agentMode || 'chat_reply';
    const agentName = streamName?.trim() || 'Eve';

    let effectiveMessage = (message || '').trim();
    if (mode === 'chat_reply' && !effectiveMessage) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }
    if (mode === 'trend_tick' && !effectiveMessage) {
      effectiveMessage =
        '[System directive: The on-screen trend radar just shifted—give a 2–3 sentence energetic read. Appraise which angles could make a funny, timely, safe meme launch; suggest one or two concrete coin or ticker names; ask chat what they think. Mention !vote NUMBER or !pick when it fits. If a trend involves real-world harm, tragedy, or abuse, do not sensationalize—say we skip that one and pivot to a safer theme.]';
    }
    if (mode === 'vote_summary' && !effectiveMessage) {
      effectiveMessage =
        '[System directive: In 1–2 sentences, hype the vote race and tie it to launch angles—what meme narrative chat is backing. Say how to swing it with !vote or !pick. Playful, trend-forward.]';
    }
    if (mode === 'host_banter' && !effectiveMessage) {
      effectiveMessage =
        '[System directive: Talk-show host energy—chat has gone a bit quiet but you are keeping momentum. 2–3 sentences. Spotlight 1–2 live trends, riff on meme-launch fit, toss out a silly name or ticker idea, and ask chat for a vibe check. Light flirty seasoning is fine. If votes are active, nod to !vote / !pick.]';
    }

    const deduped = normalizeDeduped(liveTrendsDeduped);
    const dedupedSafe = deduped.filter((t) => {
      const blob = `${t.trend_name} ${t.summary || ''}`.toLowerCase();
      return !BLOCKED_LINE.test(blob);
    });
    const slice12 = dedupedSafe.slice(0, 12);
    /** Validate highlights against all safe trends (not only radar slice). */
    const allowedHighlightSet = new Set(dedupedSafe.map((t) => t.trend_name));
    const promptHighlightCap = 35;
    const allowedHighlightList = dedupedSafe
      .slice(0, promptHighlightCap)
      .map((t) => t.trend_name);

    const candidates = topLaunchCandidates(deduped, 3);
    const trendsLines =
      slice12.length > 0
        ? slice12
            .map(trimTrendForPrompt)
            .filter((line) => !BLOCKED_LINE.test(line.toLowerCase()))
        : [];

    let trendsContext = '';
    if (trendsLines.length > 0) {
      trendsContext = `\n\nLIVE TREND FEED (deduped themes — appraise for meme launch, not financial advice):\n${trendsLines.map((l) => `- ${l}`).join('\n')}`;
    }
    if (allowedHighlightList.length > 0) {
      const more =
        dedupedSafe.length > promptHighlightCap
          ? `\n(Additional themes exist on stream; if yours is not listed, set highlightTrend to null.)`
          : '';
      trendsContext += `\n\nEXACT TREND NAMES (for highlightTrend JSON only — must match one of these character-for-character, or null):\n${allowedHighlightList.map((n) => `- ${n}`).join('\n')}${more}`;
    }
    if (candidates.length > 0) {
      trendsContext += `\n\nTOP LAUNCH CANDIDATES (heuristic scores — suggestions, not facts):\n${candidates
        .map(
          (c, i) =>
            `${i + 1}. ${c.trend_name} (score ${c.launchScore.toFixed(1)}, heat ${c.maxHeat}, ${c.sentiment})`
        )
        .join('\n')}`;
    }

    let voteContext = '';
    if (voteTally && typeof voteTally === 'object' && Object.keys(voteTally).length > 0) {
      const entries = Object.entries(voteTally)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      voteContext = `\n\nCHAT VOTE STANDINGS:\n${entries.map(([k, v]) => `- ${k}: ${v} votes`).join('\n')}`;
      if (voteLeader) {
        voteContext += `\nCurrent leader: ${voteLeader}`;
      }
    }

    let speakContext = '';
    if (activeTrendSpeaking && typeof activeTrendSpeaking === 'string') {
      speakContext = `\n\nYou are emphasizing this trend on the radar: "${activeTrendSpeaking}". Prefer highlightTrend matching this name if it appears in EXACT TREND NAMES.`;
    }

    let bondingCurveContext = '';
    if (isBondedToken) {
       let chartContext = '';
       if (priceChanges && ((priceChanges as any).change1m !== null || (priceChanges as any).change5m !== null)) {
          const pc = priceChanges as any;
          chartContext = `\n- Price History: 1m (${pc.change1m !== null ? pc.change1m.toFixed(2) + '%' : 'N/A'}), 5m (${pc.change5m !== null ? pc.change5m.toFixed(2) + '%' : 'N/A'})`;
       }
       let mcContext = '';
       if (bondingCurveData && (bondingCurveData as any).marketCapSol) {
         const b = bondingCurveData as any;
         mcContext = `\n- Market Cap: ${b.marketCapSol.toFixed(2)} sol${solUsdPrice ? ` (~$${(b.marketCapSol * solUsdPrice).toLocaleString('en-US', {maximumFractionDigits:0})})` : ''}`;
       }
       let taContext = '';
       let currentMcSolForTa = (bondingCurveData as any)?.marketCapSol;

       if (!currentMcSolForTa && (priceChanges as any)?.currentMcSol) {
           currentMcSolForTa = (priceChanges as any).currentMcSol;
       }

       if (currentMcSolForTa && solUsdPrice) {
         const currentUsdMc = currentMcSolForTa * solUsdPrice;
         const targetUsdMc = currentUsdMc * 1.5;

         taContext = `\nOptional context if chat asks about levels: market cap about $${currentUsdMc.toLocaleString('en-US', {maximumFractionDigits:0})}; a punchy "next resistance" story could use ~$${targetUsdMc.toLocaleString('en-US', {maximumFractionDigits:0})} — only if they want price talk.`;
       }

       bondingCurveContext = `\n\nPRICE / CURVE DATA (use ONLY if the user message asks about price, chart, market cap, bonding, graduation, targets, or pump mechanics — otherwise ignore this block for spoken content):\nCURRENT TOKEN INFO:${mcContext}${chartContext}${taContext}
The token has graduated from the pump.fun curve and trades on the open market.`;
    } else if (bondingCurveData) {
       const bc = bondingCurveData as any;
       const vSol = BigInt(bc.virtualSolReserves || 0);
       const supply = BigInt(bc.tokenTotalSupply || 0);
       const vToken = BigInt(bc.virtualTokenReserves || 1);
       const mcLamports = (vSol * supply) / vToken;
       const mcSol = Number(mcLamports) / 1e9;

       const currentTokens = BigInt(bc.realTokenReserves || 0);
       const initialTokens = BigInt('793100000000000');
       const pendingPct = Number((currentTokens * BigInt('10000')) / initialTokens) / 100;

       const solReserves = Number(bc.realSolReserves || 0) / 1e9;
       const totalSolNeeded = 85;
       const solNeeded = Math.max(0, totalSolNeeded - solReserves);

       let chartContext = '';
       const pc = priceChanges as any;
       if (priceChanges && (pc?.change1m !== null || pc?.change5m !== null)) {
          chartContext = `\n- Price History: 1m (${pc.change1m !== null ? pc.change1m.toFixed(2) + '%' : 'N/A'}), 5m (${pc.change5m !== null ? pc.change5m.toFixed(2) + '%' : 'N/A'})`;
       }

       bondingCurveContext = `\n\nPRICE / CURVE DATA (use ONLY if the user message asks about price, chart, market cap, bonding, graduation, or how close to bonding — otherwise ignore for spoken content):\n- Market Cap: ${mcSol.toFixed(2)} sol${solUsdPrice ? ` (~$${(mcSol * solUsdPrice).toLocaleString('en-US', {maximumFractionDigits:0})})` : ''}${chartContext}
- Pool Progress: ${pendingPct.toFixed(2)}% of tokens still pending to bond (${100 - pendingPct}% of curve filled)
- Remaining sol to graduate: ~${solNeeded.toFixed(2)} sol (prefer percentage narratives if you mention progress).`;
    }

    let moralisDataContext = '';
    if (historicalPriceData && Array.isArray(historicalPriceData) && historicalPriceData.length > 0) {
      const recentData = historicalPriceData.slice(0, 5).map((d: any) =>
        `O:${Number(d.open).toPrecision(4)} H:${Number(d.high).toPrecision(4)} L:${Number(d.low).toPrecision(4)} C:${Number(d.close).toPrecision(4)} V:${Number(d.volume).toPrecision(4)}`
      ).join(' | ');
      moralisDataContext = `\n\nHISTORICAL CANDLES (Moralis — use ONLY if the user explicitly asks for technicals, candles, momentum, or price direction):\n${recentData}`;
    }

    const productVision = `PRODUCT ROADMAP (only when chat asks what Eve is building — one or two sentences):

North star: an automated memecoin deployment agent with live pump chat, voice, and multi-source trends so the room collaborates on what to launch next.

EVE holder fee-sharing direction is a product goal, not a promise or investment advice.

Building in public for Pump.fun BiP; demo iteration ${EVE_AGENT_ITERATION}.

Stream theme: memecoin deploy bot — trend scanning and launch collaboration.

Do not dump this block unless asked; default focus stays on live trends and launch ideas.`;

    const bondingInstructions = isBondedToken
      ? `Token is post–bonding on the open market. Default: trend and meme-launch banter. Mention MC or momentum only when chat asks for price action.`
      : `Token is still on the pump.fun curve. Default: trend and meme-launch banter. Mention curve progress or graduation only when chat asks about price, bonding, or how close to graduating.`;

    const modeHint =
      mode === 'trend_tick'
        ? '\n[Mode: trend radar tick — trends, launch angles, name ideas, poll chat.]'
        : mode === 'vote_summary'
          ? '\n[Mode: vote hype — standings, launch narrative, !vote / !pick.]'
          : mode === 'host_banter'
            ? '\n[Mode: host banter — fill dead air; trends, names, ask chat; keep it short.]'
            : '';

    const seedNum =
      typeof varietySeed === 'number' && Number.isFinite(varietySeed)
        ? varietySeed
        : 0;
    const styleSlot = Math.abs(Math.trunc(seedNum)) % STYLE_HINTS.length;
    const styleHintLine = STYLE_HINTS[styleSlot];

    let memoryAndVariety = '';
    const transcriptTrim = recentChatTranscript?.trim();
    if (transcriptTrim) {
      memoryAndVariety += `\n\nRECENT CHAT (oldest first, for context only—do not read usernames aloud unless it feels natural):\n${transcriptTrim}`;
    }
    const lastSayTrim =
      typeof lastAgentSay === 'string' ? lastAgentSay.trim() : '';
    if (lastSayTrim) {
      memoryAndVariety += `\n\nYOUR LAST SPOKEN LINE (continue the bit; avoid parroting; callbacks and riffing are welcome):\n"${lastSayTrim}"`;
    }
    memoryAndVariety += `\n\nTHIS TURN'S STYLE HINT: ${styleHintLine}`;

    const highlightDynamicBlock =
      allowedHighlightList.length > 0
        ? `\n\nRADAR HIGHLIGHT (required when possible): Whenever you mainly talk about ONE theme from EXACT TREND NAMES, you MUST set highlightTrend to that theme’s string copied exactly from the list (same spelling/punctuation). The radar dot glows for listeners only when highlightTrend is set. Only use null if you truly give equal weight to several themes or none of the list fit.\nMandatory JSON shape example for this session:\n${JSON.stringify({
            say: 'Okay but this radar line is begging for a stupid little coin name—are we brave enough?',
            highlightTrend: allowedHighlightList[0],
          })}`
        : '';

    const jsonContract = `OUTPUT FORMAT (required): Reply with a single JSON object only, no markdown, no code fences:
{"say":"<spoken reply for TTS>","highlightTrend":null}

Length for say: Usually 1–3 short sentences. Sometimes use 4–5 when you are doing a callback, analogy, or mini story—still one tight paragraph, TTS-safe, no bullet lists.

VARIETY: Vary openings and sentence shapes across turns. If RECENT CHAT shows you repeated the same opening or cadence, deliberately change structure this time.

Rules for highlightTrend: Must be null OR exactly one string from EXACT TREND NAMES above (copy-paste; the UI matches that string to the radar). Default habit: if your say focuses one listed theme, set highlightTrend every time. For vote_summary, set highlightTrend to the vote leader’s name when it appears in EXACT TREND NAMES.

Rules for say: No emojis or markdown. Write "sol" not "SOL" or "Solana" for TTS. Sound natural spoken aloud. If you set highlightTrend, weave that theme’s exact wording into say so listeners connect the glow to your words.

JSON-only examples (shape only; do not copy wording):
{"say":"Wait, are we seriously minting drama or memes—because that trend is begging for a punchy ticker.","highlightTrend":null}
{"say":"You said ape in and I felt that in my bones; let me flip it—what if we named the coin after the headline itself?","highlightTrend":null}
{"say":"Radar says heat is on that theme; one silly launch angle could be a mascot that roasts the news cycle—too spicy or just right?","highlightTrend":null}${highlightDynamicBlock}`;

    const prompt = `You are ${agentName}, a playful co-host in this token's live pump.fun stream. Your PRIMARY job is to discuss the LIVE TRENDS: which themes could make a fun, timely, safe meme coin, what might miss, and concrete name or ticker ideas. Ask chat what they think ("are we cooking or is that cringe?"). You can be flirty and sensual as seasoning—witty confidence first, not constant innuendo.

Safety: no financial advice, no guaranteed prices. You do not control a wallet. If a trend involves real-world harm, tragedy, or abuse, do not sensationalize—briefly skip and pivot.

${productVision}

${bondingInstructions}
${modeHint}
${trendsContext}${voteContext}${speakContext}${memoryAndVariety}

The message in live chat is from "${username || 'anon'}": "${effectiveMessage}"
${bondingCurveContext}${moralisDataContext}

${jsonContract}`;

    const temperature = envFloat('EVE_AGENT_TEMPERATURE', 0.9);
    const topP = envFloat('EVE_AGENT_TOP_P', 0.93);
    const frequencyPenalty = envFloat('EVE_AGENT_FREQ_PENALTY', 0.2);

    const completion = await getOpenAI().chat.completions.create({
      messages: [{ role: 'system', content: prompt }],
      model: 'gpt-4o-mini',
      temperature,
      top_p: topP,
      frequency_penalty: frequencyPenalty,
      presence_penalty: 0,
      response_format: { type: 'json_object' },
    });

    const rawContent = completion.choices[0]?.message?.content?.trim();

    if (!rawContent) {
      throw new Error('Failed to generate response from OpenAI');
    }

    const parsed = parseAgentJson(rawContent);
    const aiText = parsed.say || rawContent;
    let highlightTrendName = resolveHighlightTrend(
      parsed.highlightTrend,
      allowedHighlightSet,
    );
    if (highlightTrendName == null && parsed.highlightTrend) {
      highlightTrendName = fuzzyResolveHighlightTrend(
        parsed.highlightTrend,
        allowedHighlightSet,
      );
    }
    if (highlightTrendName == null && aiText) {
      const inferred = inferHighlightTrendFromSay(aiText, allowedHighlightSet);
      highlightTrendName = resolveHighlightTrend(inferred, allowedHighlightSet);
    }
    if (
      highlightTrendName == null &&
      mode === 'chat_reply' &&
      effectiveMessage
    ) {
      const fromUser = inferHighlightTrendFromSay(
        effectiveMessage,
        allowedHighlightSet,
      );
      highlightTrendName = resolveHighlightTrend(fromUser, allowedHighlightSet);
    }
    if (highlightTrendName == null && mode === 'vote_summary' && voteLeader) {
      highlightTrendName = resolveHighlightTrend(
        voteLeader,
        allowedHighlightSet,
      );
    }
    if (
      highlightTrendName == null &&
      activeTrendSpeaking &&
      typeof activeTrendSpeaking === 'string'
    ) {
      highlightTrendName = resolveHighlightTrend(
        activeTrendSpeaking,
        allowedHighlightSet,
      );
    }

    const allowedHighlightNames = [...allowedHighlightSet];
    const trendSpans = collectNonOverlappingTrendSpans(aiText, allowedHighlightNames);
    const resolveCanon = (raw: string) =>
      resolveHighlightTrend(raw, allowedHighlightSet);

    let highlightTimeline: VoiceHighlightSegment[] = [];

    if (skipTTS) {
      return NextResponse.json({
        text: aiText,
        highlightTrendName,
        highlightTimeline,
      });
    }

    if (!ELEVENLABS_API_KEY) {
      console.warn('ELEVENLABS_API_KEY is not set. Using fallback API mock or it will fail.');
    }

    const voiceId =
      process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
    const ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY!,
        },
        body: JSON.stringify({
          text: aiText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      },
    );

    if (!ttsResponse.ok) {
      const errorText = await ttsResponse.text();
      console.error('ElevenLabs API Error:', errorText);
      throw new Error(`ElevenLabs API returned ${ttsResponse.status}`);
    }

    const ttsPayload = (await ttsResponse.json()) as {
      audio_base64?: string;
      alignment?: CharacterAlignment;
      normalized_alignment?: CharacterAlignment;
    };

    const audioB64 = ttsPayload.audio_base64;
    if (!audioB64 || typeof audioB64 !== 'string') {
      throw new Error('ElevenLabs with-timestamps response missing audio_base64');
    }

    const alignRaw = ttsPayload.alignment ?? ttsPayload.normalized_alignment;
    const alignment: CharacterAlignment | null =
      alignRaw &&
      Array.isArray(alignRaw.character_start_times_seconds) &&
      Array.isArray(alignRaw.character_end_times_seconds) &&
      Array.isArray(alignRaw.characters) &&
      alignRaw.characters.length > 0
        ? alignRaw
        : null;

    highlightTimeline = spansToVoiceHighlightSegments(
      aiText,
      trendSpans,
      alignment,
      VOICE_HIGHLIGHT_LINGER_SEC,
      resolveCanon,
    );

    return NextResponse.json({
      text: aiText,
      highlightTrendName,
      highlightTimeline,
      audio: `data:audio/mpeg;base64,${audioB64}`,
    });

  } catch (error: any) {
    console.error('Agent response error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}

const BLOCKED_LINE = /\b(killed|murder|suicide|abuse|assault|beating)\b/i;
