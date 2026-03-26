"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useSyncExternalStore,
} from "react";
import type { EveStreamPublicConfig } from "./stream-config";
import { IMessage } from '@/lib/pumpChatClient';
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Play,
  Square,
  MessageSquare,
  User,
  Link as LinkIcon,
  Radio,
  Volume2,
  Mic,
  Settings,
  Plus,
  X,
  Loader2
} from "lucide-react";

import { generateHuggingFaceTts, downloadAndProcessVoiceModel, testHFSpace } from '@/lib/hf-voice';
import SiteFooter from '@/components/SiteFooter';
import dynamic from "next/dynamic";
import type { DedupedTrend, LiveTrendRow } from "@/lib/live-trends";
import {
  dedupeTrendsByName,
  buildTrendPolarScatterData,
  normalizeTrendKey,
  trendDisplayNamesMatch,
} from "@/lib/live-trends";
import {
  buildProportionalHighlightTimeline,
  buildTimelineForTrendMention,
  VOICE_HIGHLIGHT_LINGER_SEC,
  type VoiceHighlightSegment,
} from "@/lib/voice-highlight-timeline";
import type { VoiceTimelineEvent } from "@/lib/voice-agent/types";
import { isPumpSpamScamMessage } from "@/lib/pump-chat-filters";
import { buildRecentChatTranscript } from "@/lib/agent-chat-context";
import TrendHeatLeaderboard from "@/components/TrendHeatLeaderboard";
import { streamTrendColor } from "@/lib/trend-stream-palette";
import { decideProactiveTurn } from "@/lib/voice-agent/proactive/scheduler";

/** Plan Option B: auto-enable stream UI when viewport fits pump-style embed (no env required). */
const STREAM_EMBED_MQ = "(max-width: 640px) and (max-height: 480px)";

function subscribeStreamEmbedViewport(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia(STREAM_EMBED_MQ);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function getStreamEmbedViewportSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(STREAM_EMBED_MQ).matches;
}

const TrendRadarChart = dynamic(() => import("@/components/TrendRadarChart"), {
  ssr: false,
  loading: () => (
    <div className="w-full min-h-[220px] rounded-xl border border-[color:var(--eve-border)] bg-[var(--eve-surface)] animate-pulse" />
  ),
});

/** Min 5s; default poll 15s when env unset (was 45s). Align with `NEXT_PUBLIC_LIVE_TRENDS_POLL_MS`. */
const LIVE_POLL_MS = Math.max(
  5_000,
  Number(
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_LIVE_TRENDS_POLL_MS
      : undefined,
  ) || 15_000,
);
const TREND_TICK_MIN_MS = 4 * 60 * 1000;
const TREND_TICK_CHECK_MS = 30_000;
const TREND_TICK_JUMP_RATIO = Math.max(
  1.1,
  Number(
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_EVE_TREND_JUMP_RATIO
      : undefined,
  ) || 1.3,
);
const PROACTIVE_STARVATION_MS = Math.max(
  90_000,
  Number(
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_EVE_PROACTIVE_STARVATION_MS
      : undefined,
  ) || 4 * 60 * 1000,
);
/** Host banter check interval; actual spacing uses silence decay inside handler. */
const HOST_BANTER_CHECK_MS = 30_000;
/** Abort agent API fetch if the server or network hangs. */
const AGENT_FETCH_TIMEOUT_MS = 90_000;
/** HF Gradio TTS can stall indefinitely; fall back to text-only after this. */
const HF_TTS_TIMEOUT_MS = 180_000;
/** If playback never finishes, reset so the poller can run again. */
const TTS_STUCK_WATCHDOG_MS = 4 * 60 * 1000;
/** After TTS ends, keep radar/card highlight this long so the summary stays readable. */
const TREND_HIGHLIGHT_READ_LINGER_MS = 6_000;
/** No-audio fallback: show highlight after this delay (no waveform to sync to). */
const NO_AUDIO_TREND_HIGHLIGHT_DELAY_MS = 1_200;
/** Proactive speech when radar shows new trends (heat order); max names per cue. */
const NEW_RADAR_SPEECH_MAX_NAMES = 2;
/** Min gap between NEW ON RADAR speeches so we don’t stack with trend tick / host. */
const NEW_RADAR_SPEECH_MIN_GAP_MS = 35_000;

/**
 * Create/resume Web Audio on a real user gesture so TTS can play later.
 * Browsers block AudioContext started only from timers (e.g. chat poll).
 * Returns true if the context is running after this call (valid for TTS / visualizer).
 */
async function primeWebAudioContext(
  audioContextRef: React.MutableRefObject<AudioContext | null>,
): Promise<boolean> {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!audioContextRef.current) {
      audioContextRef.current = new AC();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (ctx.state !== "running") {
      return false;
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.00001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
    return ctx.state === "running";
  } catch (e) {
    console.warn("Web Audio prime failed:", e);
    return false;
  }
}

type AgentCallOptions = {
  agentMode?: "chat_reply" | "trend_tick" | "vote_summary" | "host_banter";
  activeTrendSpeaking?: string | null;
};

type ProactiveQueueItem = {
  msg: IMessage;
  opts: AgentCallOptions;
  createdAt: number;
  expiresAt: number;
  priority: number;
  reason: string;
};

type TuningProfileId = "quiet" | "normal" | "high_traffic";

type TuningProfile = {
  id: TuningProfileId;
  label: string;
  trendTickCheckMs: number;
  trendTickMinMs: number;
  trendJumpRatio: number;
  forceTrendRotateMs: number;
  hostCheckMs: number;
  proactiveStarvationMs: number;
  reactiveGraceMs: number;
  minNovelty: number;
  allowLowNoveltyOnStarvation: boolean;
};

const TUNING_MATRIX: Record<TuningProfileId, TuningProfile> = {
  quiet: {
    id: "quiet",
    label: "Quiet Room",
    trendTickCheckMs: 20_000,
    trendTickMinMs: 90_000,
    trendJumpRatio: 1.15,
    forceTrendRotateMs: 90_000,
    hostCheckMs: 20_000,
    proactiveStarvationMs: 120_000,
    reactiveGraceMs: 10_000,
    minNovelty: 0.08,
    allowLowNoveltyOnStarvation: true,
  },
  normal: {
    id: "normal",
    label: "Normal Room",
    trendTickCheckMs: TREND_TICK_CHECK_MS,
    trendTickMinMs: TREND_TICK_MIN_MS,
    trendJumpRatio: TREND_TICK_JUMP_RATIO,
    forceTrendRotateMs: 120_000,
    hostCheckMs: HOST_BANTER_CHECK_MS,
    proactiveStarvationMs: PROACTIVE_STARVATION_MS,
    reactiveGraceMs: 18_000,
    minNovelty: 0.12,
    allowLowNoveltyOnStarvation: true,
  },
  high_traffic: {
    id: "high_traffic",
    label: "High Traffic",
    trendTickCheckMs: 45_000,
    trendTickMinMs: 4 * 60_000,
    trendJumpRatio: Math.max(1.2, TREND_TICK_JUMP_RATIO),
    forceTrendRotateMs: 5 * 60_000,
    hostCheckMs: 45_000,
    proactiveStarvationMs: 5 * 60_000,
    reactiveGraceMs: 35_000,
    minNovelty: 0.22,
    allowLowNoveltyOnStarvation: false,
  },
};

function syntheticAgentMessage(
  partial: Partial<IMessage> & { message: string },
): IMessage {
  return {
    id: partial.id ?? `sys-${Date.now()}`,
    roomId: partial.roomId ?? "eve",
    username: partial.username ?? "Eve",
    userAddress: partial.userAddress ?? "",
    message: partial.message,
    profile_image: partial.profile_image ?? "",
    timestamp: partial.timestamp ?? new Date().toISOString(),
    messageType: partial.messageType ?? "system",
    expiresAt: partial.expiresAt ?? 0,
  };
}

const SYNTHETIC_AGENT_USERNAMES = new Set(
  ["trendradar", "hostfill"].map((s) => s.toLowerCase()),
);

/** Rows that trigger the agent but are not in the live pump feed — shown ephemerally during TTS. */
function isSyntheticChatAgentRow(msg: IMessage): boolean {
  const u = (msg.username || "").trim().toLowerCase();
  if (SYNTHETIC_AGENT_USERNAMES.has(u)) return true;
  const id = msg.id || "";
  return (
    id.startsWith("trend-tick-") ||
    id.startsWith("host-banter-") ||
    id.startsWith("new-radar-")
  );
}

/**
 * One-shot after connect: scan back through history for the latest real line (spam often clogs the tail).
 * After that pass we only consider the last 2 messages so we don’t auto-reply backward through old chat.
 */
const AGENT_CATCH_UP_LOOKBACK = 100;
const AGENT_POLL_TAIL = 2;
const TREND_ROTATION_POOL = 6;
const TREND_RECENT_MEMORY = 2;
const USE_TURN_ENDPOINT =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_USE_AGENT_TURN_API === "1";

const SOLANA_MINT_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

function findLatestUnansweredChatMessage(
  messages: IMessage[],
  messageStatuses: Record<string, "processing" | "answered" | "history">,
  lookback: number,
): IMessage | null {
  const start = Math.max(0, messages.length - lookback);
  for (let i = messages.length - 1; i >= start; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (messageStatuses[msg.id]) continue;
    if (isSyntheticChatAgentRow(msg)) continue;

    const trimmed = (msg.message || "").trim();
    if (trimmed.length <= 3) continue;
    if (isVoteOnlyMessage(msg.message)) continue;
    if (isPumpSpamScamMessage(trimmed)) continue;
    if (/^(lfg|gm|gn|wow|lol|lmao)$/i.test(trimmed)) continue;

    return msg;
  }
  return null;
}

/** If the API omitted highlightTrendName, match spoken text to a live trend name (substring). */
function inferVoiceHighlightFromReply(
  reply: string,
  trends: DedupedTrend[],
): string | null {
  const t = reply.trim();
  if (!t || trends.length === 0) return null;
  const lower = t.toLowerCase();
  const names = [...trends]
    .map((x) => x.trend_name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const n = name.trim();
    if (n.length < 3) continue;
    if (lower.includes(n.toLowerCase())) return n;
  }
  return null;
}

/** Every LIVE MINDSHARE trend whose title appears as substring in the agent reply (longest names first). */
function collectMentionedTrendsFromReply(
  reply: string,
  trends: DedupedTrend[],
): string[] {
  const t = reply.trim();
  if (!t || trends.length === 0) return [];
  const lower = t.toLowerCase();
  const sorted = [...trends].sort(
    (a, b) => b.trend_name.length - a.trend_name.length,
  );
  const out: string[] = [];
  for (const row of sorted) {
    const n = row.trend_name.trim();
    if (n.length < 2) continue;
    if (lower.includes(n.toLowerCase())) out.push(row.trend_name);
  }
  return out;
}

function selectRotatingTrend(
  trends: DedupedTrend[],
  recent: string[],
  cursor: number,
): { trend: DedupedTrend | null; nextCursor: number } {
  if (!trends.length) return { trend: null, nextCursor: cursor };
  const pool = trends.slice(0, TREND_ROTATION_POOL);
  if (!pool.length) return { trend: trends[0] ?? null, nextCursor: cursor };
  for (let i = 0; i < pool.length; i++) {
    const idx = (cursor + i) % pool.length;
    const cand = pool[idx];
    if (!cand) continue;
    const recentlyUsed = recent.some((r) => trendDisplayNamesMatch(r, cand.trend_name));
    if (!recentlyUsed) {
      return { trend: cand, nextCursor: (idx + 1) % pool.length };
    }
  }
  const idx = cursor % pool.length;
  return {
    trend: pool[idx] ?? pool[0] ?? trends[0] ?? null,
    nextCursor: (idx + 1) % pool.length,
  };
}

function pushProactiveQueue(
  queueRef: React.MutableRefObject<ProactiveQueueItem[]>,
  item: ProactiveQueueItem,
) {
  const q = queueRef.current.filter(
    (x) =>
      x.expiresAt > Date.now() &&
      !trendDisplayNamesMatch(x.opts.activeTrendSpeaking ?? "", item.opts.activeTrendSpeaking ?? ""),
  );
  q.push(item);
  q.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  queueRef.current = q.slice(0, 6);
}

function metric(key: string) {
  void fetch("/api/agent/metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  }).catch(() => {});
}

/** Poll resume until the context runs or timeout (needed after timer-driven TTS). */
async function ensureAudioContextRunning(
  ctx: AudioContext,
  maxWaitMs = 2800,
): Promise<boolean> {
  const running = () => String(ctx.state) === "running";
  const t0 = performance.now();
  while (performance.now() - t0 < maxWaitMs) {
    if (ctx.state === "closed") return false;
    if (running()) return true;
    await ctx.resume().catch(() => {});
    if (running()) return true;
    await new Promise((r) => window.setTimeout(r, 50));
  }
  return running();
}

/** Route HTMLAudioElement through Web Audio so the rim visualizer sees frequency data. */
function tryAttachMediaElementVisualizer(
  audio: HTMLAudioElement,
  ctx: AudioContext,
  audioAnalyzerRef: React.MutableRefObject<{
    analyser: AnalyserNode;
    data: Uint8Array;
  } | null>,
): void {
  if (ctx.state !== "running") return;
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.45;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -20;
    const src = ctx.createMediaElementSource(audio);
    src.connect(analyser);
    analyser.connect(ctx.destination);
    audioAnalyzerRef.current = {
      analyser,
      data: new Uint8Array(analyser.frequencyBinCount),
    };
  } catch {
    /* e.g. CORS or second createMediaElementSource on same element */
  }
}

function isVoteOnlyMessage(text: string): boolean {
  return /^!(?:vote|v|pick)\b/i.test(text.trim());
}

import { Connection, PublicKey } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { AreaChart, Area, YAxis, ResponsiveContainer, Tooltip } from 'recharts';

// Helper to serialize the bonding curve data for the AI context since it contains BigInt/BNs and PublicKeys
function serializeBondingCurve(bc: any): any {
  if (bc === null || bc === undefined) return bc;
  if (typeof bc !== "object") return bc;
  
  if (typeof bc === "bigint") {
    return bc.toString();
  }
  
  if (bc.toBase58 && typeof bc.toBase58 === "function") {
    return bc.toBase58();
  }
  
  if (bc.toString && typeof bc.toString === "function" && (bc.constructor?.name === "BN" || typeof bc.toNumber === "function")) {
    return bc.toString();
  }

  if (Array.isArray(bc)) {
    return bc.map(serializeBondingCurve);
  }

  const serialized: any = {};
  for (const [key, value] of Object.entries(bc)) {
    serialized[key] = serializeBondingCurve(value);
  }
  return serialized;
}

// Interface is imported from pumpChatClient

const BONDING_TARGET_SOL = 85;

/** Progress (0–100) towards bonding curve graduation (85 SOL). Uses virtualSolReserves. */
function getBondingProgressPercent(bondingCurveData: any): number | null {
  if (!bondingCurveData?.virtualSolReserves) return null;
  try {
    const vSol = BigInt(bondingCurveData.virtualSolReserves);
    const solInCurve = Number(vSol) / 1e9;
    if (bondingCurveData.complete) return 100;
    return Math.min(100, (solInCurve / BONDING_TARGET_SOL) * 100);
  } catch {
    return null;
  }
}

function getSolInCurve(bondingCurveData: any): number | null {
  if (!bondingCurveData?.virtualSolReserves) return null;
  try {
    const vSol = BigInt(bondingCurveData.virtualSolReserves);
    return Number(vSol) / 1e9;
  } catch {
    return null;
  }
}

export default function PumpfunChatPage({
  defaultRoom,
  streamUsername,
  streamName: initialStreamName,
  streamTicker: initialStreamTicker,
  autoConnect,
  kiosk: isEveKiosk,
  streamLayout: isStreamLayoutProp,
}: EveStreamPublicConfig) {
  const streamLayoutForced =
    isStreamLayoutProp ||
    (typeof process !== "undefined" &&
      (() => {
        const v = process.env.NEXT_PUBLIC_EVE_STREAM_LAYOUT;
        return v === "1" || v?.toLowerCase() === "true";
      })());

  const streamLayoutAuto = useSyncExternalStore(
    subscribeStreamEmbedViewport,
    getStreamEmbedViewportSnapshot,
    () => false,
  );

  const streamLayoutAutoDisabled =
    typeof process !== "undefined" &&
    (process.env.NEXT_PUBLIC_EVE_STREAM_LAYOUT_AUTO === "0" ||
      process.env.NEXT_PUBLIC_EVE_STREAM_LAYOUT_AUTO?.toLowerCase() === "false");

  const isStreamLayout =
    streamLayoutForced || (!streamLayoutAutoDisabled && streamLayoutAuto);
  const reduceMotion = useReducedMotion() === true;
  const [addressInput, setAddressInput] = useState(() => defaultRoom.trim());
  const [username, setUsername] = useState(() => streamUsername.trim());
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Reconnect / SSE status; shown inline with stream name so layout height stays stable. */
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);

  // AI Agent state
  const [isPlayingTTS, setIsPlayingTTS] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [hfStatus, setHfStatus] = useState<{stage: string, position?: number, eta?: number} | null>(null);
  const [bondingCurveData, setBondingCurveData] = useState<any>(null);
  const [isBondedToken, setIsBondedToken] = useState<boolean>(false);
  const [solUsdPrice, setSolUsdPrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<{ timestamp: number; mcSol: number }[]>([]);
  const latestMcSol = useMemo(() => {
    if (priceHistory.length === 0) return null;
    const v = priceHistory[priceHistory.length - 1].mcSol;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }, [priceHistory]);
  const [historicalPriceData, setHistoricalPriceData] = useState<any>(null);
  /** Recharts ResponsiveContainer measures DOM; defer chart until mounted (hydration-safe). */
  const [mcChartMounted, setMcChartMounted] = useState(false);

  // Stream Info State (manual entry or from EVE_STREAM_NAME / EVE_STREAM_TICKER)
  const [streamName, setStreamName] = useState(() => initialStreamName.trim());
  const [streamSymbol, setStreamSymbol] = useState(() =>
    initialStreamTicker.trim().toUpperCase()
  );
  
  // Voice Models State
  const [customVoices, setCustomVoices] = useState<{name: string, id: string}[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("elevenlabs_default");
  const [isLoadingVoices, setIsLoadingVoices] = useState<boolean>(true);

  const [showAddVoice, setShowAddVoice] = useState(false);
  const [newVoiceName, setNewVoiceName] = useState("");
  const [newVoiceUrl, setNewVoiceUrl] = useState("");
  const [isAddingVoice, setIsAddingVoice] = useState(false);

  const [liveTrendRows, setLiveTrendRows] = useState<LiveTrendRow[]>([]);
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const [speechPulse, setSpeechPulse] = useState(0);
  const [activeTrendHighlight, setActiveTrendHighlight] = useState<
    string | null
  >(null);
  const [tuningProfileId, setTuningProfileId] = useState<TuningProfileId>("normal");
  const tuningProfile = useMemo(
    () => TUNING_MATRIX[tuningProfileId] ?? TUNING_MATRIX.normal,
    [tuningProfileId],
  );

  /** Sync radar highlight to spoken mentions (ElevenLabs alignment or proportional fallback). */
  const ttsHighlightScheduleRef = useRef<{
    segments: VoiceHighlightSegment[];
    mode: "buffer" | "html";
    bufferCtxStartTime: number | null;
    htmlAudio: HTMLAudioElement | null;
  } | null>(null);
  const lastSyncedHighlightRef = useRef<string | null>(null);
  const trendHighlightLingerTimeoutRef = useRef<number | null>(null);

  const clearTrendHighlightLinger = () => {
    const t = trendHighlightLingerTimeoutRef.current;
    if (t != null) {
      clearTimeout(t);
      trendHighlightLingerTimeoutRef.current = null;
    }
  };

  const dedupedRef = useRef<DedupedTrend[]>([]);
  const trendTickGuardRef = useRef({
    lastTop: null as string | null,
    lastHeat: 0,
    lastTickAt: 0,
    pendingTop: null as string | null,
    pendingHeat: 0,
    seeded: false,
  });
  const lastTrendCommentaryAtRef = useRef(0);
  const rotatingTrendCursorRef = useRef(0);
  const recentTrendFocusRef = useRef<string[]>([]);
  /** Last time a real chatter sent a non-spam, non-vote message (for host banter decay). */
  const lastRealChatAtRef = useRef(Date.now());
  const hostBanterGuardRef = useRef({ lastAt: Date.now() });
  const lastReactiveSpokenAtRef = useRef(0);
  const lastProactiveSpokenAtRef = useRef(0);
  const proactiveQueueRef = useRef<ProactiveQueueItem[]>([]);
  /** Last successful agent TTS line (say) for continuity. */
  const lastAgentSpokenRef = useRef<string | null>(null);
  /** Last radar highlight trend from API — server avoids repeating the same spotlight. */
  const lastAgentHighlightTrendRef = useRef<string | null>(null);
  /** Increments each agent call for server-side style rotation. */
  const varietySeedRef = useRef(0);
  /**
   * After a fresh connect (e.g. page refresh), run one poller pass with a wide lookback
   * so spam at the chat tail doesn’t hide the latest real message.
   */
  const catchUpPollAfterConnectRef = useRef(false);
  const triggerAgentRef = useRef<
    (msg: IMessage, opts?: AgentCallOptions) => Promise<boolean>
  >(async () => false);

  /** Prior deduped maxHeat by trend name — for polar diff (new / heat up / down). */
  const prevTrendHeatRef = useRef<Map<string, { maxHeat: number }>>(new Map());
  /** Dev-only: log client spacing between successful polls. */
  const lastTrendPullMsRef = useRef<number | null>(null);

  const liveTrendsDeduped = useMemo(
    () => dedupeTrendsByName(liveTrendRows),
    [liveTrendRows],
  );
  /** Polar scatter from deduped trends. */
  const trendPolarData = useMemo(
    () =>
      buildTrendPolarScatterData(liveTrendsDeduped, {
        previousByName: prevTrendHeatRef.current,
      }),
    [liveTrendsDeduped],
  );

  /** Same as radar “new” styling — diff vs prior poll; agent prioritizes these. */
  const newTrendNamesFromRadar = useMemo(() => {
    const pts = trendPolarData?.points;
    if (!pts?.length) return [];
    return pts
      .filter((p) => p.change === "new")
      .map((p) => p.trend_name);
  }, [trendPolarData]);

  const newTrendNamesRef = useRef<string[]>([]);
  useEffect(() => {
    newTrendNamesRef.current = newTrendNamesFromRadar;
  }, [newTrendNamesFromRadar]);

  const lastNewRadarSpeechFingerprintRef = useRef<string>("");
  const lastNewRadarSpeechAtRef = useRef<number>(0);
  /** LIVE MINDSHARE trend names already referenced in Eve replies this session (substring match). */
  const mentionedTrendsRef = useRef<string[]>([]);

  const streamHeroTrend = useMemo(() => {
    const pts = trendPolarData?.points;
    if (!pts?.length) return null;
    const sorted = [...pts].sort((a, b) => b.maxHeat - a.maxHeat);
    const top = sorted[0];
    if (!top) return null;
    const origIdx = pts.findIndex((p) => p.trend_name === top.trend_name);
    return {
      name: top.trend_name,
      color: streamTrendColor(top.trend_name, Math.max(0, origIdx)),
    };
  }, [trendPolarData]);

  const radarVoiceBonding = useMemo(() => {
    const progress = isBondedToken
      ? 100
      : getBondingProgressPercent(bondingCurveData);
    const solInCurveBond = getSolInCurve(bondingCurveData);
    const bondingHasData =
      isBondedToken ||
      (progress !== null && solInCurveBond !== null);
    const progressNorm =
      bondingHasData && progress !== null ? progress / 100 : 0;
    return { progress, bondingHasData, progressNorm };
  }, [isBondedToken, bondingCurveData]);

  const handleAddVoice = async () => {
    if (!newVoiceName || !newVoiceUrl) return;
    setIsAddingVoice(true);
    try {
      await downloadAndProcessVoiceModel(newVoiceUrl, newVoiceName);
      setCustomVoices(prev => [...prev, { name: newVoiceName, id: newVoiceName }]);
      setSelectedVoice(newVoiceName);
      setShowAddVoice(false);
      setNewVoiceName("");
      setNewVoiceUrl("");
    } catch (err) {
      console.error("Failed to add voice model", err);
      alert("Failed to add voice model: " + (err as Error).message);
    } finally {
      setIsAddingVoice(false);
    }
  };

  // Message Status State
  const [messageStatuses, setMessageStatuses] = useState<Record<string, 'processing' | 'answered' | 'history'>>({});
  const [aiReplies, setAiReplies] = useState<Record<string, string>>({});
  /** Synthetic agent triggers (radar / host) appended to chat UI while Eve speaks. */
  const [agentEphemeralRow, setAgentEphemeralRow] = useState<IMessage | null>(
    null,
  );

  const chatListMessages = useMemo(() => {
    const list = [...messages];
    if (
      agentEphemeralRow &&
      !list.some((m) => m.id === agentEphemeralRow.id)
    ) {
      list.push(agentEphemeralRow);
    }
    return list;
  }, [messages, agentEphemeralRow]);
  
  // Track last played timestamp to avoid replaying the same broadcast
  const lastPlayedTimestampRef = useRef<number>(0);

  // Web Audio API: analyser + frequency data for speech-synced visualizer
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnalyzerRef = useRef<{ analyser: AnalyserNode; data: Uint8Array } | null>(null);

  const clientRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectHandshakeTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const autoConnectRanRef = useRef(false);

  useEffect(() => {
    setMcChartMounted(true);
  }, []);

  useEffect(() => {
    dedupedRef.current = liveTrendsDeduped;
  }, [liveTrendsDeduped]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    const u = (last.username || "").trim().toLowerCase();
    if (["trendradar", "hostfill", "eve"].includes(u)) return;
    const text = last.message.trim();
    if (text.length <= 3) return;
    if (isVoteOnlyMessage(text)) return;
    if (isPumpSpamScamMessage(text)) return;
    if (/^(lfg|gm|gn|wow|lol|lmao)$/i.test(text)) return;
    lastRealChatAtRef.current = Date.now();
  }, [messages]);

  useEffect(() => {
    const m = new Map<string, { maxHeat: number }>();
    for (const d of liveTrendsDeduped) {
      const mh = Number.isFinite(d.maxHeat) ? d.maxHeat : 0;
      m.set(d.trend_name, { maxHeat: mh });
    }
    prevTrendHeatRef.current = m;
  }, [liveTrendsDeduped]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetch("/api/live-trends", { cache: "no-store" });
        const j = (await res.json()) as {
          trends?: LiveTrendRow[];
          fetchedAt?: string;
          error?: string;
        };
        if (cancelled) return;
        if (Array.isArray(j.trends)) {
          if (process.env.NODE_ENV === "development") {
            const t = Date.now();
            const prevMs = lastTrendPullMsRef.current;
            lastTrendPullMsRef.current = t;
            if (prevMs != null) {
              console.debug("[live-trends poll]", {
                clientIntervalMs: t - prevMs,
                fetchedAt: j.fetchedAt,
                count: j.trends.length,
              });
            }
          }
          setLiveTrendRows(j.trends);
          setTrendsError(null);
        } else {
          setTrendsError(
            typeof j.error === "string" ? j.error : "Invalid trends payload",
          );
        }
      } catch (e) {
        if (!cancelled) {
          setTrendsError(
            e instanceof Error ? e.message : "Live trends request failed",
          );
        }
      }
    };
    void pull();
    const id = window.setInterval(pull, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audioAnalyzerRef.current;
      if (a && isPlayingTTS) {
        const n = a.analyser.frequencyBinCount;
        const tmp = new Uint8Array(n);
        a.analyser.getByteFrequencyData(tmp);
        let s = 0;
        for (let i = 0; i < n; i++) s += tmp[i];
        let level = Math.min(1, (s / (n * 255)) * 2.2);
        if (s < n * 3) {
          const td = new Uint8Array(a.analyser.fftSize);
          a.analyser.getByteTimeDomainData(td);
          let pk = 0;
          for (let i = 0; i < td.length; i++) {
            const v = Math.abs(td[i]! - 128);
            if (v > pk) pk = v;
          }
          level = Math.max(level, Math.min(1, (pk / 128) * 1.3));
        }
        setSpeechPulse((prev) => prev * 0.55 + level * 0.45);
      } else {
        setSpeechPulse((p) => p * 0.88);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlayingTTS]);

  useEffect(() => {
    if (!isPlayingTTS) return;
    let raf = 0;
    const tick = () => {
      const sch = ttsHighlightScheduleRef.current;
      let elapsed = -1;
      if (sch?.mode === "html" && sch.htmlAudio) {
        elapsed = sch.htmlAudio.currentTime;
      } else if (
        sch?.mode === "buffer" &&
        audioContextRef.current &&
        sch.bufferCtxStartTime != null
      ) {
        elapsed =
          audioContextRef.current.currentTime - sch.bufferCtxStartTime;
      }
      let next: string | null = null;
      if (elapsed >= 0 && sch?.segments?.length) {
        for (const seg of sch.segments) {
          if (elapsed >= seg.startSec && elapsed <= seg.endSec) {
            next = seg.trendName;
            break;
          }
        }
      }
      /* Keep last trend during gaps between segments — do not clear to null mid-utterance. */
      if (
        next != null &&
        next !== lastSyncedHighlightRef.current
      ) {
        lastSyncedHighlightRef.current = next;
        setActiveTrendHighlight(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlayingTTS]);

  // Auto-fetch HF Voice Models on load
  useEffect(() => {
    let isMounted = true;
    const fetchHFModels = async () => {
      try {
        const res: any = await testHFSpace();
        if (isMounted && res.data && Array.isArray(res.data) && Array.isArray(res.data[0]?.choices)) {
          const choices = res.data[0].choices;
          const fetchedVoices = choices.map((choice: [string, string]) => ({ name: choice[0], id: choice[1] }));
          
          setCustomVoices(prev => {
            const existingIds = new Set(prev.map(v => v.id));
            const newVoices = fetchedVoices.filter((v: any) => !existingIds.has(v.id));
            return [...prev, ...newVoices];
          });
          console.log(`Auto-loaded ${fetchedVoices.length} models from HF Space`);
        }
      } catch (e: any) {
        console.error("Failed to auto-load HF models:", e);
      } finally {
        if (isMounted) setIsLoadingVoices(false);
      }
    };
    
    fetchHFModels();
    return () => { isMounted = false; };
  }, []);

  // Assume generic parsed room ID for DB
  const currentTokenAddress = React.useMemo(() => {
    let roomId = addressInput.trim();
    if (roomId.includes("pump.fun/")) {
      const parts = roomId.split("/");
      roomId = parts[parts.length - 1].split("?")[0];
    }
    return roomId || "unknown";
  }, [addressInput]);

  useEffect(() => {
    if (
      !isConnected ||
      !currentTokenAddress ||
      currentTokenAddress === "unknown" ||
      !SOLANA_MINT_ADDRESS_RE.test(currentTokenAddress)
    ) {
      return;
    }
    void fetch("/api/stream/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint: currentTokenAddress,
        displayName: streamName.trim() || undefined,
        ticker: streamSymbol.trim() || undefined,
      }),
    }).catch(() => {});
  }, [isConnected, currentTokenAddress, streamName, streamSymbol]);

  useEffect(() => {
    if (
      !isConnected ||
      !currentTokenAddress ||
      currentTokenAddress === "unknown" ||
      !SOLANA_MINT_ADDRESS_RE.test(currentTokenAddress)
    ) {
      return;
    }
    let cancelled = false;
    const pull = async () => {
      try {
        const r = await fetch(
          `/api/stream/${encodeURIComponent(currentTokenAddress)}/config`,
        );
        const d = (await r.json()) as { tuningProfileId?: string };
        if (cancelled || !d.tuningProfileId) return;
        if (
          d.tuningProfileId === "quiet" ||
          d.tuningProfileId === "normal" ||
          d.tuningProfileId === "high_traffic"
        ) {
          setTuningProfileId(d.tuningProfileId);
        }
      } catch {
        /* ignore */
      }
    };
    void pull();
    const id = window.setInterval(pull, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [isConnected, currentTokenAddress]);

  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Auto-fetch removed as pump.fun API is unavailable via proxy/CORS.

  // --- LOCAL AI ENGINE LOGIC ---
  const stateRefs = useRef({
    messages,
    messageStatuses,
    isPlayingTTS,
    bondingCurveData,
    priceHistory,
    streamName,
    isBondedToken,
    solUsdPrice,
    historicalPriceData,
    liveTrendsDeduped,
    newTrendNamesFromRadar,
    aiReplies,
  });
  useEffect(() => {
    stateRefs.current = {
      messages,
      messageStatuses,
      isPlayingTTS,
      bondingCurveData,
      priceHistory,
      streamName,
      isBondedToken,
      solUsdPrice,
      historicalPriceData,
      liveTrendsDeduped,
      newTrendNamesFromRadar,
      aiReplies,
    };
  }, [
    messages,
    messageStatuses,
    isPlayingTTS,
    bondingCurveData,
    priceHistory,
    streamName,
    isBondedToken,
    solUsdPrice,
    historicalPriceData,
    liveTrendsDeduped,
    newTrendNamesFromRadar,
    aiReplies,
  ]);

  // Fetch Sol USD Price
  useEffect(() => {
    const fetchSolPrice = async () => {
      try {
        const res = await fetch("/api/price/sol");
        if (res.ok) {
          const data = (await res.json()) as { ok?: boolean; usd?: number };
          if (data.ok && typeof data.usd === "number" && Number.isFinite(data.usd)) {
            setSolUsdPrice(data.usd);
          }
        }
      } catch (err) {
        console.error("Failed to fetch SOL price", err);
      }
    };
    fetchSolPrice();
    const interval = setInterval(fetchSolPrice, 60000); // 1 minute
    return () => clearInterval(interval);
  }, []);

  // Fetch recent price history from Moralis API for bonded tokens
  useEffect(() => {
    let isMounted = true;
    const fetchMoralisHistory = async () => {
      if (!isBondedToken || !currentTokenAddress || currentTokenAddress === "unknown") return;
      try {
        const url = `/api/agent/moralis?tokenAddress=${encodeURIComponent(currentTokenAddress)}`;
        // Note: I will create the proxy endpoint /api/agent/moralis because Moralis blocks direct client-side requests due to CORS
        const response = await fetch(url);
        if (response.ok) {
           const result = await response.json();
           if (isMounted) setHistoricalPriceData(result.data);
        }
      } catch (err) {
        console.error("Failed to fetch historical Moralis data:", err);
      }
    };
    
    // Only fetch once when it's marked as bonded or loaded initially
    if (isBondedToken) {
      fetchMoralisHistory();
      // Optional: Update history every 3 minutes
      const interval = setInterval(fetchMoralisHistory, 3 * 60 * 1000);
      return () => {
        isMounted = false;
        clearInterval(interval);
      }
    }
  }, [isBondedToken, currentTokenAddress]);

  // Fetch bonding curve info periodically directly from the client
  useEffect(() => {
    if (!isConnected || !currentTokenAddress || currentTokenAddress === "unknown") return;

    let isMounted = true;
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const sdk = new OnlinePumpSdk(connection);

    const fetchBondingCurve = async () => {
      try {
        const mint = new PublicKey(currentTokenAddress);
        let bondingCurve = null;
        try {
          bondingCurve = await sdk.fetchBondingCurve(mint);
        } catch (e) {
          // might fail if token bonded and curve account is closed
        }

        let isBonded = false;
        let serialized = null;

        if (bondingCurve) {
           serialized = serializeBondingCurve(bondingCurve);
           isBonded = serialized.complete || (serialized.virtualTokenReserves && BigInt(serialized.virtualTokenReserves) === BigInt(0));
        } else {
           isBonded = true; // assume bonded if SDK fails to find the curve account
        }

        if (isMounted) {
           setBondingCurveData(serialized);
           setIsBondedToken(isBonded);

           try {
             let mcSol = 0;
             if (!isBonded && serialized && serialized.virtualSolReserves && serialized.tokenTotalSupply && serialized.virtualTokenReserves) {
               const vSol = BigInt(serialized.virtualSolReserves);
               const supply = BigInt(serialized.tokenTotalSupply);
               const vToken = BigInt(serialized.virtualTokenReserves);
               if (vToken > BigInt(0)) {
                 const mcLamports = (vSol * supply) / vToken;
                 mcSol = Number(mcLamports) / 1e9;
               } else {
                 isBonded = true;
               }
             }
             
             if (isBonded) {
               // Prefer Moralis (server uses MORALIS_API_KEY) for fresher MC; DexScreener as fallback.
               let moralisOk = false;
               try {
                 const mRes = await fetch(
                   `/api/token/metrics?mint=${encodeURIComponent(currentTokenAddress)}`,
                 );
                 const mJson = (await mRes.json()) as {
                   ok?: boolean;
                   mcSol?: number;
                 };
                 if (mJson.ok && typeof mJson.mcSol === "number" && mJson.mcSol > 0) {
                   mcSol = mJson.mcSol;
                   moralisOk = true;
                 }
               } catch (e) {
                 console.warn("Moralis token metrics fetch failed:", e);
               }

               if (!moralisOk) {
                 try {
                   const dexRes = await fetch(
                     `https://api.dexscreener.com/latest/dex/tokens/${currentTokenAddress}`,
                   );
                   if (dexRes.ok) {
                     const dexData = await dexRes.json();
                     if (dexData.pairs && dexData.pairs.length > 0) {
                       const pair =
                         dexData.pairs.find((p: { dexId?: string }) => p.dexId === "raydium") ||
                         dexData.pairs[0];
                       const solUsd = stateRefs.current.solUsdPrice;
                       const num = (v: unknown) =>
                         typeof v === "number" && Number.isFinite(v)
                           ? v
                           : typeof v === "string"
                             ? parseFloat(v)
                             : NaN;
                       const mcapUsd = num(pair.marketCap);
                       const fdvUsd = num(pair.fdv);
                       const usdVal =
                         Number.isFinite(mcapUsd) && mcapUsd > 0
                           ? mcapUsd
                           : Number.isFinite(fdvUsd) && fdvUsd > 0
                             ? fdvUsd
                             : null;
                       if (usdVal != null && solUsd != null && solUsd > 0) {
                         mcSol = usdVal / solUsd;
                       } else if (solUsd != null && solUsd > 0 && pair.priceUsd) {
                         const pUsd = num(pair.priceUsd);
                         if (Number.isFinite(pUsd) && pUsd > 0) {
                           const pSol = pUsd / solUsd;
                           const typicalPumpSupply = 1e9;
                           mcSol = pSol * typicalPumpSupply;
                         }
                       }
                     }
                   }
                 } catch (e) {
                   console.error("Dexscreener fetch error:", e);
                 }
               }
               setIsBondedToken(true);
             }

             // Pre-bond: if on-chain MC is missing, try Moralis (same key as OHLCV).
             if (!isBonded && mcSol <= 0) {
               try {
                 const mRes = await fetch(
                   `/api/token/metrics?mint=${encodeURIComponent(currentTokenAddress)}`,
                 );
                 const mJson = (await mRes.json()) as {
                   ok?: boolean;
                   mcSol?: number;
                 };
                 if (mJson.ok && typeof mJson.mcSol === "number" && mJson.mcSol > 0) {
                   mcSol = mJson.mcSol;
                 }
               } catch {
                 /* ignore */
               }
             }

             if (mcSol > 0) {
               setPriceHistory(prev => {
                 const now = Date.now();
                 // keep last 10 minutes of history max
                 const tenMinsAgo = now - 10 * 60 * 1000;
                 const filtered = prev.filter(p => p.timestamp >= tenMinsAgo);
                 return [...filtered, { timestamp: now, mcSol }];
               });
             }
           } catch(e) {
             console.error("Local price history error:", e);
           }
        }
      } catch (err) {
        console.error("General error in fetchBondingCurve routine:", err);
      }
    };

    fetchBondingCurve();
    const intervalId = setInterval(fetchBondingCurve, 5000); // 5 seconds interval
    return () => {
       isMounted = false;
       clearInterval(intervalId);
    };
  }, [isConnected, currentTokenAddress]);

  const triggerAgent = useCallback(
    async (msgToProcess: IMessage, options?: AgentCallOptions) => {
    if (stateRefs.current.isPlayingTTS) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "[Eve] triggerAgent skipped: isPlayingTTS already true (stuck run or overlapping call)",
        );
      }
      return false;
    }

    varietySeedRef.current += 1;
    const varietySeed = varietySeedRef.current;
    const recentChatTranscript = buildRecentChatTranscript(
      stateRefs.current.messages,
      stateRefs.current.aiReplies,
    );
    const lastAgentSay = lastAgentSpokenRef.current;
    const lastAgentHighlightTrend = lastAgentHighlightTrendRef.current;

    setActiveMessageId(msgToProcess.id);
    setIsPlayingTTS(true);
    setHfStatus(null);
    if (isSyntheticChatAgentRow(msgToProcess)) {
      setAgentEphemeralRow(msgToProcess);
    } else {
      setAgentEphemeralRow(null);
    }

    const agentMode = options?.agentMode ?? "chat_reply";
    const activeSpeak = options?.activeTrendSpeaking ?? null;

    try {
      setError(null);
      setMessageStatuses((prev) => ({ ...prev, [msgToProcess.id]: "processing" }));

      let change1m = null;
      let change5m = null;
      const history = stateRefs.current.priceHistory;
      if (history && history.length > 0) {
        const currentPrice = history[history.length - 1].mcSol;
        const now = Date.now();

        const oneMinAgo = now - 60 * 1000;
        const price1mRaw = history.reduce((prev, curr) =>
          Math.abs(curr.timestamp - oneMinAgo) < Math.abs(prev.timestamp - oneMinAgo)
            ? curr
            : prev,
        );
        if (now - price1mRaw.timestamp > 30 * 1000) {
          change1m =
            ((currentPrice - price1mRaw.mcSol) / price1mRaw.mcSol) * 100;
        }

        const fiveMinAgo = now - 5 * 60 * 1000;
        const price5mRaw = history.reduce((prev, curr) =>
          Math.abs(curr.timestamp - fiveMinAgo) < Math.abs(prev.timestamp - fiveMinAgo)
            ? curr
            : prev,
        );
        if (now - price5mRaw.timestamp > 3 * 60 * 1000) {
          change5m =
            ((currentPrice - price5mRaw.mcSol) / price5mRaw.mcSol) * 100;
        }
      }

      const useHF = selectedVoice !== "elevenlabs_default";

      const ac = new AbortController();
      const fetchTimeoutId = window.setTimeout(
        () => ac.abort(),
        AGENT_FETCH_TIMEOUT_MS,
      );
      let res: Response;
      try {
        res = await fetch(USE_TURN_ENDPOINT ? "/api/agent/turn" : "/api/agent/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            roomId: currentTokenAddress,
            message: msgToProcess.message,
            username: msgToProcess.username,
            bondingCurveData: stateRefs.current.bondingCurveData,
            priceChanges: {
              change1m,
              change5m,
              currentMcSol:
                history && history.length > 0
                  ? history[history.length - 1].mcSol
                  : null,
            },
            historicalPriceData: stateRefs.current.historicalPriceData,
            streamName: stateRefs.current.streamName,
            isBondedToken: stateRefs.current.isBondedToken,
            solUsdPrice: stateRefs.current.solUsdPrice,
            skipTTS: useHF,
            agentMode,
            liveTrendsDeduped: stateRefs.current.liveTrendsDeduped,
            newTrendNamesFromRadar: stateRefs.current.newTrendNamesFromRadar,
            recentlyMentionedTrendNames: mentionedTrendsRef.current,
            activeTrendSpeaking: activeSpeak,
            recentChatTranscript: recentChatTranscript ?? undefined,
            lastAgentSay: lastAgentSay ?? undefined,
            lastAgentHighlightTrend: lastAgentHighlightTrend ?? undefined,
            varietySeed,
          }),
        });
      } finally {
        window.clearTimeout(fetchTimeoutId);
      }

      let data: {
        text?: string;
        audio?: string;
        error?: string;
        highlightTrendName?: string | null;
        highlightTimeline?: unknown;
        events?: VoiceTimelineEvent[];
      };
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `API returned ${res.status}`,
        );
      }

      const replyText = data.text ?? "";
      if (replyText.trim()) lastAgentSpokenRef.current = replyText.trim();
      setAiReplies((prev) => ({ ...prev, [msgToProcess.id]: replyText }));

      const fromReply = collectMentionedTrendsFromReply(
        replyText,
        stateRefs.current.liveTrendsDeduped,
      );
      if (fromReply.length) {
        const seen = new Set<string>();
        const merged: string[] = [];
        for (const name of [...fromReply, ...mentionedTrendsRef.current]) {
          const k = normalizeTrendKey(name);
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(name);
        }
        mentionedTrendsRef.current = merged.slice(0, 20);
      }

      const apiHighlight =
        typeof data.highlightTrendName === "string" &&
        data.highlightTrendName.trim()
          ? data.highlightTrendName.trim()
          : null;
      let highlightForSpeech = apiHighlight ?? activeSpeak;
      if (!highlightForSpeech && replyText.trim()) {
        highlightForSpeech = inferVoiceHighlightFromReply(
          replyText,
          stateRefs.current.liveTrendsDeduped,
        );
      }
      if (!highlightForSpeech && msgToProcess.message?.trim()) {
        highlightForSpeech = inferVoiceHighlightFromReply(
          msgToProcess.message,
          stateRefs.current.liveTrendsDeduped,
        );
      }
      lastAgentHighlightTrendRef.current = highlightForSpeech ?? null;

      let voiceHighlightTimeline: VoiceHighlightSegment[] = [];
      const tlRaw = data.highlightTimeline;
      if (Array.isArray(tlRaw)) {
        for (const x of tlRaw) {
          if (
            x &&
            typeof x === "object" &&
            typeof (x as VoiceHighlightSegment).trendName === "string" &&
            typeof (x as VoiceHighlightSegment).startSec === "number" &&
            typeof (x as VoiceHighlightSegment).endSec === "number"
          ) {
            voiceHighlightTimeline.push({
              trendName: (x as VoiceHighlightSegment).trendName.trim(),
              startSec: (x as VoiceHighlightSegment).startSec,
              endSec: (x as VoiceHighlightSegment).endSec,
            });
          }
        }
      }

      clearTrendHighlightLinger();
      ttsHighlightScheduleRef.current = null;
      /* UI highlight follows voice timeline only — RAF sets this when the playhead hits a segment. */
      setActiveTrendHighlight(null);
      lastSyncedHighlightRef.current = null;

      let audioUrl = data.audio;
      if (useHF && replyText) {
        try {
          const hfResult = await Promise.race([
            generateHuggingFaceTts(
              replyText,
              selectedVoice,
              "en-US-ChristopherNeural",
              (status) => {
                setHfStatus(status);
              },
            ),
            new Promise<undefined>((resolve) =>
              window.setTimeout(() => resolve(undefined), HF_TTS_TIMEOUT_MS),
            ),
          ]);
          audioUrl = hfResult;
          if (!audioUrl) {
            setError(
              "Hugging Face voice timed out. Try Eve (ElevenLabs) or try again.",
            );
          }
        } catch (err) {
          console.error("HF TTS Error", err);
        } finally {
          setHfStatus(null);
        }
      }

      const finishSpeechUi = () => {
        clearTrendHighlightLinger();
        audioAnalyzerRef.current = null;
        ttsHighlightScheduleRef.current = null;
        lastSyncedHighlightRef.current = null;
        setIsPlayingTTS(false);
        setActiveMessageId(null);
        setHfStatus(null);
        setAgentEphemeralRow(null);
        trendHighlightLingerTimeoutRef.current = window.setTimeout(() => {
          trendHighlightLingerTimeoutRef.current = null;
          setActiveTrendHighlight(null);
        }, TREND_HIGHLIGHT_READ_LINGER_MS);
      };

      const markAnswered = () =>
        setMessageStatuses((prev) => ({
          ...prev,
          [msgToProcess.id]: "answered",
        }));

      if (audioUrl) {
        const trends = stateRefs.current.liveTrendsDeduped;
        const resolveTrendCanon = (raw: string) => {
          const r = raw.trim();
          for (const t of trends) {
            if (trendDisplayNamesMatch(r, t.trend_name)) return t.trend_name;
          }
          return null;
        };

        const AC =
          window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!audioContextRef.current) {
          audioContextRef.current = new AC();
        }
        const ctx = audioContextRef.current;
        await ctx.resume().catch(() => {});

        let safetyId: number | null = null;
        const disarmSafety = () => {
          if (safetyId != null) {
            window.clearTimeout(safetyId);
            safetyId = null;
          }
        };
        const armSafety = (ms: number) => {
          disarmSafety();
          safetyId = window.setTimeout(() => {
            safetyId = null;
            finishSpeechUi();
          }, ms);
        };

        /** HTML audio: resume context after `play()` + retry binding — MediaElementSource often only works once ctx is running. */
        const bindHtmlAudioForVisualizer = (audio: HTMLAudioElement) => {
          const tryBind = async () => {
            await ensureAudioContextRunning(ctx, 1500);
            if (audioAnalyzerRef.current) return;
            if (String(ctx.state) === "running") {
              tryAttachMediaElementVisualizer(audio, ctx, audioAnalyzerRef);
            }
          };
          const onPlaying = () => {
            void tryBind();
            const started = performance.now();
            const id = window.setInterval(() => {
              if (audioAnalyzerRef.current || performance.now() - started > 4500) {
                window.clearInterval(id);
                return;
              }
              void tryBind();
            }, 80);
          };
          audio.addEventListener("playing", onPlaying, { once: true });
          return tryBind;
        };

        await ensureAudioContextRunning(ctx, 500);

        let audioBuffer: AudioBuffer | null = null;
        if (ctx.state === "running") {
          try {
            const audioFetch = await fetch(audioUrl);
            const arrayBuffer = await audioFetch.arrayBuffer();
            audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
          } catch {
            audioBuffer = null;
          }
        }

        let playedWithBuffer = false;
        if (audioBuffer && ctx.state === "running") {
          try {
            let timeline = voiceHighlightTimeline;
            if (timeline.length === 0 && replyText.trim() && trends.length > 0) {
              timeline = buildProportionalHighlightTimeline(
                replyText,
                trends.map((t) => t.trend_name),
                audioBuffer.duration,
                VOICE_HIGHLIGHT_LINGER_SEC,
                (raw) => resolveTrendCanon(raw) ?? raw,
              );
            }
            /** Model/API highlight without full title in speech — align to best partial phrase, not t=0. */
            if (timeline.length === 0 && highlightForSpeech?.trim()) {
              timeline = buildTimelineForTrendMention(
                replyText,
                highlightForSpeech.trim(),
                audioBuffer.duration,
                VOICE_HIGHLIGHT_LINGER_SEC,
                (raw) => resolveTrendCanon(raw) ?? raw,
              );
            }

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.45;
            analyser.minDecibels = -100;
            analyser.maxDecibels = -20;

            source.connect(analyser);
            analyser.connect(ctx.destination);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            audioAnalyzerRef.current = { analyser, data: dataArray };

            const safetyMs = Math.min(
              240_000,
              Math.max(8_000, (audioBuffer.duration + 3) * 1000),
            );
            armSafety(safetyMs);
            source.onended = () => {
              disarmSafety();
              finishSpeechUi();
            };
            const tWhen = ctx.currentTime;
            source.start(tWhen);
            ttsHighlightScheduleRef.current = {
              segments: timeline,
              mode: "buffer",
              bufferCtxStartTime: tWhen,
              htmlAudio: null,
            };
            markAnswered();
            playedWithBuffer = true;
          } catch (err) {
            console.warn("Web Audio buffer playback failed, falling back to HTML Audio", err);
            audioAnalyzerRef.current = null;
          }
        }

        if (!playedWithBuffer) {
          const audio = new Audio(audioUrl);
          armSafety(240_000);
          audio.onended = () => {
            disarmSafety();
            finishSpeechUi();
          };
          let htmlTimeline = voiceHighlightTimeline;
          const htmlDurGuess = Math.min(
            120,
            Math.max(5, replyText.length * 0.052),
          );
          if (htmlTimeline.length === 0 && replyText.trim() && trends.length > 0) {
            htmlTimeline = buildProportionalHighlightTimeline(
              replyText,
              trends.map((t) => t.trend_name),
              htmlDurGuess,
              VOICE_HIGHLIGHT_LINGER_SEC,
              (raw) => resolveTrendCanon(raw) ?? raw,
            );
          }
          if (htmlTimeline.length === 0 && highlightForSpeech?.trim()) {
            htmlTimeline = buildTimelineForTrendMention(
              replyText,
              highlightForSpeech.trim(),
              htmlDurGuess,
              VOICE_HIGHLIGHT_LINGER_SEC,
              (raw) => resolveTrendCanon(raw) ?? raw,
            );
          }
          ttsHighlightScheduleRef.current = {
            segments: htmlTimeline,
            mode: "html",
            bufferCtxStartTime: null,
            htmlAudio: audio,
          };
          const tryBindHtml = bindHtmlAudioForVisualizer(audio);
          try {
            await tryBindHtml();
            await audio.play();
            markAnswered();
          } catch (playErr) {
            disarmSafety();
            console.warn("HTML Audio playback failed", playErr);
            setIsPlayingTTS(false);
            setHfStatus(null);
            clearTrendHighlightLinger();
            setActiveTrendHighlight(null);
            setAgentEphemeralRow(null);
            setError(
              "Voice was blocked or unsupported. Click Start Agent (or interact with the page) so the browser can unlock audio.",
            );
            markAnswered();
          }
        }
      } else {
        clearTrendHighlightLinger();
        setActiveTrendHighlight(null);
        const noAudioHighlightTimer = window.setTimeout(() => {
          if (highlightForSpeech) setActiveTrendHighlight(highlightForSpeech);
        }, NO_AUDIO_TREND_HIGHLIGHT_DELAY_MS);
        window.setTimeout(() => {
          window.clearTimeout(noAudioHighlightTimer);
          setIsPlayingTTS(false);
          setActiveMessageId(null);
          setHfStatus(null);
          setAgentEphemeralRow(null);
          clearTrendHighlightLinger();
          trendHighlightLingerTimeoutRef.current = window.setTimeout(() => {
            trendHighlightLingerTimeoutRef.current = null;
            setActiveTrendHighlight(null);
          }, TREND_HIGHLIGHT_READ_LINGER_MS);
        }, 6000);
        setMessageStatuses((prev) => ({
          ...prev,
          [msgToProcess.id]: "answered",
        }));
      }
      if (agentMode === "chat_reply") {
        lastReactiveSpokenAtRef.current = Date.now();
      } else {
        lastProactiveSpokenAtRef.current = Date.now();
        hostBanterGuardRef.current.lastAt = lastProactiveSpokenAtRef.current;
      }
      return true;
    } catch (error) {
      console.error("Agent interaction failed", error);
      ttsHighlightScheduleRef.current = null;
      lastSyncedHighlightRef.current = null;
      clearTrendHighlightLinger();
      setActiveTrendHighlight(null);
      const msg =
        error instanceof Error && error.name === "AbortError"
          ? "Agent request timed out. Check your connection and try again."
          : error instanceof Error
            ? error.message
            : "Agent request failed";
      setError(msg);
      setMessageStatuses((prev) => ({
        ...prev,
        [msgToProcess.id]: "answered",
      }));

      setTimeout(() => {
        setIsPlayingTTS(false);
        setActiveMessageId(null);
        setHfStatus(null);
        setAgentEphemeralRow(null);
      }, 3000);
      return false;
    }
  },
  [selectedVoice],
);

  useEffect(() => {
    triggerAgentRef.current = triggerAgent;
  }, [triggerAgent]);

  /** Proactive turn when polar marks trend(s) as new — speak about top 1–2 by heat (not only on leaderboard churn). */
  useEffect(() => {
    if (!isConnected) return;
    if (!newTrendNamesFromRadar.length) return;

    const topNew = newTrendNamesFromRadar.slice(0, NEW_RADAR_SPEECH_MAX_NAMES);
    const fingerprint = topNew.map((n) => normalizeTrendKey(n)).join("|");
    if (fingerprint === lastNewRadarSpeechFingerprintRef.current) return;

    const now = Date.now();
    if (
      lastNewRadarSpeechAtRef.current > 0 &&
      now - lastNewRadarSpeechAtRef.current < NEW_RADAR_SPEECH_MIN_GAP_MS
    ) {
      return;
    }

    lastNewRadarSpeechFingerprintRef.current = fingerprint;
    lastNewRadarSpeechAtRef.current = now;

    const primary = topNew[0]!;
    const label =
      topNew.length === 1
        ? `"${primary}"`
        : `"${primary}" and "${topNew[1]}"`;

    const msg = syntheticAgentMessage({
      id: `new-radar-${now}`,
      message: `Voice cue: NEW ON RADAR — ${label} just surfaced (heat-ranked). Mention these by exact name; if both, keep it tight.`,
      username: "TrendRadar",
    });

    if (stateRefs.current.isPlayingTTS) {
      pushProactiveQueue(proactiveQueueRef, {
        msg,
        opts: { agentMode: "trend_tick", activeTrendSpeaking: primary },
        createdAt: now,
        expiresAt: now + 2 * 60_000,
        priority: 11,
        reason: "new_radar",
      });
      if (process.env.NODE_ENV === "development") {
        console.debug("[new-radar] queued (tts busy)", { topNew });
      }
      return;
    }

    void triggerAgentRef.current(msg, {
      agentMode: "trend_tick",
      activeTrendSpeaking: primary,
    }).then((started) => {
      if (!started) {
        pushProactiveQueue(proactiveQueueRef, {
          msg,
          opts: { agentMode: "trend_tick", activeTrendSpeaking: primary },
          createdAt: Date.now(),
          expiresAt: Date.now() + 2 * 60_000,
          priority: 11,
          reason: "tts_busy",
        });
        metric("proactive_skip_tts_busy_total");
        return;
      }
      metric("proactive_fired_total");
      if (process.env.NODE_ENV === "development") {
        console.debug("[new-radar] fired", { topNew });
      }
    });
  }, [isConnected, newTrendNamesFromRadar]);

  /** Last-resort reset if a run hangs without ever calling finishSpeechUi. */
  useEffect(() => {
    if (!isPlayingTTS) return;
    const id = window.setTimeout(() => {
      console.warn(
        "[Eve] TTS watchdog: resetting stuck playback state after",
        TTS_STUCK_WATCHDOG_MS,
        "ms",
      );
      audioAnalyzerRef.current = null;
      ttsHighlightScheduleRef.current = null;
      lastSyncedHighlightRef.current = null;
      setIsPlayingTTS(false);
      setActiveMessageId(null);
      setHfStatus(null);
      setAgentEphemeralRow(null);
      proactiveQueueRef.current = [];
      clearTrendHighlightLinger();
      setActiveTrendHighlight(null);
    }, TTS_STUCK_WATCHDOG_MS);
    return () => window.clearTimeout(id);
  }, [isPlayingTTS]);

  useEffect(() => {
    if (isPlayingTTS) return;
    if (!isConnected) return;
    const now = Date.now();
    const dropped = proactiveQueueRef.current.filter((x) => x.expiresAt <= now).length;
    if (dropped > 0) {
      for (let i = 0; i < dropped; i++) metric("proactive_skip_stale_total");
    }
    const q = proactiveQueueRef.current
      .filter((x) => x.expiresAt > now)
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    if (!q.length) return;
    const next = q.shift();
    proactiveQueueRef.current = q;
    if (!next) return;
    metric("proactive_attempts_total");
    void triggerAgentRef.current(next.msg, next.opts);
  }, [isPlayingTTS, isConnected]);

  useEffect(() => {
    if (!isConnected) return;
    const id = window.setInterval(() => {
      if (stateRefs.current.isPlayingTTS) {
        metric("proactive_skip_tts_busy_total");
        if (process.env.NODE_ENV === "development") {
          console.debug("[trend-tick] skip: tts playing");
        }
        return;
      }
      const d = dedupedRef.current;
      if (!d.length) {
        metric("proactive_skip_no_trends_total");
        if (process.env.NODE_ENV === "development") {
          console.debug("[trend-tick] skip: no deduped trends");
        }
        return;
      }
      const now = Date.now();
      const g = trendTickGuardRef.current;
      const top = d[0];
      if (!g.seeded) {
        g.lastTop = top.trend_name;
        g.lastHeat = top.maxHeat;
        g.pendingTop = null;
        g.pendingHeat = 0;
        g.seeded = true;
        if (process.env.NODE_ENV === "development") {
          console.debug("[trend-tick] seed baseline", {
            top: g.lastTop,
            heat: g.lastHeat,
          });
        }
        return;
      }
      const changed = top.trend_name !== g.lastTop;
      const jumped =
        g.lastHeat > 5 && top.maxHeat > g.lastHeat * tuningProfile.trendJumpRatio;
      const forceRotate =
        now - lastTrendCommentaryAtRef.current >= tuningProfile.forceTrendRotateMs;
      const inCooldown = now - g.lastTickAt < tuningProfile.trendTickMinMs;
      if (inCooldown) {
        metric("proactive_skip_cooldown_total");
        if (changed || jumped) {
          g.pendingTop = top.trend_name;
          g.pendingHeat = top.maxHeat;
        }
        if (process.env.NODE_ENV === "development") {
          console.debug("[trend-tick] skip: cooldown", {
            remainingMs: tuningProfile.trendTickMinMs - (now - g.lastTickAt),
            changed,
            jumped,
            forceRotate,
            pendingTop: g.pendingTop,
          });
        }
        return;
      }

      const hasPending = !!g.pendingTop;
      const pendingTop = g.pendingTop;
      const shouldTrigger = changed || jumped || hasPending || forceRotate;
      if (!shouldTrigger) {
        if (process.env.NODE_ENV === "development") {
          console.debug("[trend-tick] skip: no change", {
            top: top.trend_name,
            heat: top.maxHeat,
          });
        }
        return;
      }

      const preferred =
        pendingTop && d.find((x) => trendDisplayNamesMatch(x.trend_name, pendingTop))
          ? d.find((x) => trendDisplayNamesMatch(x.trend_name, pendingTop)) ?? top
          : top;
      const selected = selectRotatingTrend(
        d,
        recentTrendFocusRef.current,
        rotatingTrendCursorRef.current,
      );
      let focusTrend =
        selected.trend &&
        !trendDisplayNamesMatch(selected.trend.trend_name, g.lastTop)
          ? selected.trend
          : preferred;
      rotatingTrendCursorRef.current = selected.nextCursor;
      const freshRadar = newTrendNamesRef.current;
      if (freshRadar.length > 0) {
        const hitNew = d.find((x) =>
          freshRadar.some((n) => trendDisplayNamesMatch(x.trend_name, n)),
        );
        if (hitNew) focusTrend = hitNew;
      }
      if (!focusTrend) return;

      const trendTickMsg = syntheticAgentMessage({
        id: `trend-tick-${now}`,
        message: `Voice cue: spotlighting “${focusTrend.trend_name}” on the radar.`,
        username: "TrendRadar",
      });
      metric("proactive_attempts_total");
      void triggerAgentRef.current(trendTickMsg, {
        agentMode: "trend_tick",
        activeTrendSpeaking: focusTrend.trend_name,
      }).then((started) => {
        if (!started) {
          metric("proactive_skip_tts_busy_total");
          pushProactiveQueue(proactiveQueueRef, {
            msg: trendTickMsg,
            opts: {
              agentMode: "trend_tick",
              activeTrendSpeaking: focusTrend.trend_name,
            },
            createdAt: Date.now(),
            expiresAt: Date.now() + 2 * 60_000,
            priority: 9,
            reason: "tts_busy",
          });
          if (process.env.NODE_ENV === "development") {
            console.debug("[trend-tick] skipped: triggerAgent did not start");
          }
          return;
        }
        g.lastTickAt = Date.now();
        lastTrendCommentaryAtRef.current = Date.now();
        metric("proactive_fired_total");
        g.lastTop = top.trend_name;
        g.lastHeat = top.maxHeat;
        g.pendingTop = null;
        g.pendingHeat = 0;
        recentTrendFocusRef.current = [
          focusTrend.trend_name,
          ...recentTrendFocusRef.current.filter(
            (n) => !trendDisplayNamesMatch(n, focusTrend.trend_name),
          ),
        ].slice(0, TREND_RECENT_MEMORY);
        if (process.env.NODE_ENV === "development") {
          console.debug("[trend-tick] fired", {
            focus: focusTrend.trend_name,
            top: top.trend_name,
          });
        }
      });
    }, tuningProfile.trendTickCheckMs);
    return () => window.clearInterval(id);
  }, [isConnected, tuningProfile]);

  useEffect(() => {
    if (!isConnected) return;
    const id = window.setInterval(() => {
      const d = dedupedRef.current;
      if (!d.length) return;
      const now = Date.now();
      const proactive = decideProactiveTurn({
        nowMs: now,
        lastRealChatAtMs: lastRealChatAtRef.current,
        lastSpokenAtMs: lastProactiveSpokenAtRef.current || hostBanterGuardRef.current.lastAt,
        liveTrends: d,
        lastReactiveSpokenAtMs: lastReactiveSpokenAtRef.current,
        starvationMs: tuningProfile.proactiveStarvationMs,
        reactiveGraceMs: tuningProfile.reactiveGraceMs,
        minNovelty: tuningProfile.minNovelty,
        allowLowNoveltyOnStarvation: tuningProfile.allowLowNoveltyOnStarvation,
      });
      if (!proactive.shouldFire) {
        if (proactive.reason === "cooldown") metric("proactive_skip_cooldown_total");
        if (proactive.reason === "no_trends") metric("proactive_skip_no_trends_total");
        return;
      }
      const selected = selectRotatingTrend(
        d,
        recentTrendFocusRef.current,
        rotatingTrendCursorRef.current,
      );
      rotatingTrendCursorRef.current = selected.nextCursor;
      let focusTrend = selected.trend?.trend_name ?? d[0]?.trend_name ?? null;
      const freshRadar = newTrendNamesRef.current;
      if (freshRadar.length > 0) {
        const hitNew = d.find((x) =>
          freshRadar.some((n) => trendDisplayNamesMatch(x.trend_name, n)),
        );
        if (hitNew) focusTrend = hitNew.trend_name;
      }

      const hostMsg = syntheticAgentMessage({
        id: `host-banter-${now}`,
        message: focusTrend
          ? `Voice cue: host energy — checking heat on “${focusTrend}” and inviting chat input.`
          : "Voice cue: host energy — keeping momentum while chat is quiet.",
        username: "HostFill",
      });
      if (stateRefs.current.isPlayingTTS) {
        metric("proactive_skip_tts_busy_total");
        pushProactiveQueue(proactiveQueueRef, {
          msg: hostMsg,
          opts: { agentMode: "host_banter", activeTrendSpeaking: focusTrend },
          createdAt: Date.now(),
          expiresAt: Date.now() + 2 * 60_000,
          priority: proactive.priority,
          reason: "tts_busy",
        });
        return;
      }
      metric("proactive_attempts_total");
      void triggerAgentRef.current(hostMsg, {
        agentMode: "host_banter",
        activeTrendSpeaking: focusTrend,
      }).then((started) => {
        if (!started) {
          metric("proactive_skip_tts_busy_total");
          return;
        }
        metric("proactive_fired_total");
        if (focusTrend) {
          recentTrendFocusRef.current = [
            focusTrend,
            ...recentTrendFocusRef.current.filter(
              (n) => !trendDisplayNamesMatch(n, focusTrend),
            ),
          ].slice(0, TREND_RECENT_MEMORY);
        }
        if (process.env.NODE_ENV === "development") {
          console.debug("[host-banter] fired", {
            focusTrend,
            novelty: proactive.noveltyScore,
            minGapMs: proactive.minGapMs,
            reason: proactive.reason,
          });
        }
      }).catch(() => {});
    }, tuningProfile.hostCheckMs);
    return () => window.clearInterval(id);
  }, [isConnected, tuningProfile]);

  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(async () => {
      const {
        messages: currentMessages,
        messageStatuses: currentStatuses,
        isPlayingTTS: currentPlayingTTS,
      } = stateRefs.current;

      if (currentPlayingTTS) return;
      if (currentMessages.length === 0) return;

      const useWideCatchUp = catchUpPollAfterConnectRef.current;
      if (useWideCatchUp) {
        catchUpPollAfterConnectRef.current = false;
      }
      const lookback = useWideCatchUp
        ? AGENT_CATCH_UP_LOOKBACK
        : AGENT_POLL_TAIL;

      const msgToProcess = findLatestUnansweredChatMessage(
        currentMessages,
        currentStatuses,
        lookback,
      );
      if (msgToProcess) {
        triggerAgent(msgToProcess);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isConnected, triggerAgent]);

  // Auto-scroll to the bottom of the chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatListMessages, aiReplies]);

  const handleConnect = async (
    isReconnect = false,
    connectOpts?: { fromUserClick?: boolean },
  ) => {
    if (connectOpts?.fromUserClick) {
      await primeWebAudioContext(audioContextRef);
    }

    if (!addressInput.trim()) {
      setError("Please enter a token address or URL");
      return;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (connectHandshakeTimerRef.current != null) {
      window.clearTimeout(connectHandshakeTimerRef.current);
      connectHandshakeTimerRef.current = null;
    }

    try {
      setIsConnecting(true);
      setError(null);
      setConnectionNotice(null);
      // Only clear messages if we are not actively attempting to reconnect (i.e. if it's a fresh manual connection)
      // Since handleConnect clears history, we should avoid wiping during auto-reconnect, but for now it's fine
      // because `messages` are already wiped on fresh start. Wait, doing this will wipe the UI every time it reconnects!
      // Let's only clear messages if we are NOT currently marked as connecting. Wait, handleConnect always runs setIsConnecting(true) first.
      // We can just omit clearing messages here globally, let the user manually clear or just let SSE historical merge handle it.
      // Actually, pumpchat server sends messageHistory on connect. Wiping is fine since history repopulates.
      
      if (!isReconnect) {
        setMessages([]);
        catchUpPollAfterConnectRef.current = true;
        // Optional: you could clear manual metadata here, but likely user wants to keep it
        // setStreamName("");
        // setStreamSymbol("");
        // setStreamDescription("");
      } else {
        catchUpPollAfterConnectRef.current = false;
      }
      // We purposefully DO NOT wipe messageStatuses so they accumulate across reconnects

      // Extract Room ID from URL if provided
      let roomId = addressInput.trim();
      if (roomId.includes("pump.fun/")) {
        const parts = roomId.split("/");
        roomId = parts[parts.length - 1].split("?")[0]; // simple extraction
      }

      if (clientRef.current) {
        clientRef.current.close();
      }

      const client = new EventSource(
        `/api/pumpchat?roomId=${encodeURIComponent(roomId)}&username=${encodeURIComponent(username.trim() || "Anonymous AI Developer")}`
      );

      const clearConnectHandshakeTimer = () => {
        if (connectHandshakeTimerRef.current != null) {
          window.clearTimeout(connectHandshakeTimerRef.current);
          connectHandshakeTimerRef.current = null;
        }
      };

      connectHandshakeTimerRef.current = window.setTimeout(() => {
        connectHandshakeTimerRef.current = null;
        if (clientRef.current !== client) return;
        clientRef.current = null;
        try {
          client.close();
        } catch {
          /* ignore */
        }
        setIsConnecting(false);
        setIsConnected(false);
        setError(
          "Chat stream did not respond in time. Check the token or room ID and press Start Agent again.",
        );
        setConnectionNotice(null);
      }, 25_000);

      client.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'connected') {
            clearConnectHandshakeTimer();
            setIsConnected(true);
            setIsConnecting(false);
            setError(null);
            setConnectionNotice(null);
          } else if (parsed.type === 'messageHistory') {
            clearConnectHandshakeTimer();
            setMessages((prev) => {
              const raw = Array.isArray(parsed.data) ? parsed.data : [];
              const historyFiltered = raw.filter((m: IMessage) => {
                const t = (m?.message || "").trim();
                return !t || !isPumpSpamScamMessage(t);
              });
              if (!isReconnect || prev.length === 0) return historyFiltered;
              const existingIds = new Set(prev.map(m => m.id));
              const newHistoryMessages = historyFiltered.filter((m: IMessage) => m.id && !existingIds.has(m.id));
              const combined = [...prev, ...newHistoryMessages];
              if (combined.length > 100) return combined.slice(-100);
              return combined;
            });
            // Allowed historical messages to be picked up by AI analysis
          } else if (parsed.type === "message") {
            clearConnectHandshakeTimer();
            const msg = parsed.data as IMessage;
            const incomingText = (msg.message || "").trim();
            if (incomingText && isPumpSpamScamMessage(incomingText)) {
              return;
            }
            setMessages((prev) => {
              if (msg.id && prev.some((m) => m.id === msg.id)) return prev;
              const newMessages = [...prev, msg];
              if (newMessages.length > 100) return newMessages.slice(-100);
              return newMessages;
            });
          } else if (parsed.type === 'error') {
            clearConnectHandshakeTimer();
            console.error("Chat error:", parsed.data);
            setConnectionNotice(
              `Connection error: ${parsed.data}. Reconnecting in 3s…`,
            );
            setIsConnected(false);
            setIsConnecting(true);
            client.close();
            reconnectTimeoutRef.current = setTimeout(() => {
              handleConnect(true);
            }, 3000);
          } else if (parsed.type === 'disconnected') {
            clearConnectHandshakeTimer();
            setIsConnected(false);
            setIsConnecting(true); // Indicate reconnecting
            setConnectionNotice("Server disconnected. Reconnecting in 3s…");
            client.close();
            reconnectTimeoutRef.current = setTimeout(() => {
              handleConnect(true);
            }, 3000);
          }
        } catch (err) {
          console.error("Error parsing SSE data", err);
        }
      };

      client.onerror = (err) => {
        clearConnectHandshakeTimer();
        console.error("SSE Error:", err);
        setConnectionNotice("Lost connection to chat server. Reconnecting in 3s…");
        setIsConnected(false);
        setIsConnecting(true);
        client.close();
        reconnectTimeoutRef.current = setTimeout(() => {
           handleConnect(true);
        }, 3000);
      };

      clientRef.current = client;
    } catch (err: any) {
      if (connectHandshakeTimerRef.current != null) {
        window.clearTimeout(connectHandshakeTimerRef.current);
        connectHandshakeTimerRef.current = null;
      }
      setError(err.message || "Failed to initialize client");
      setIsConnecting(false);
    }
  };

  // VPS / headless Chromium: connect without clicking Start (requires browser autoplay flags).
  useEffect(() => {
    if (!autoConnect) return;
    if (autoConnectRanRef.current) return;
    if (!addressInput.trim()) return;
    autoConnectRanRef.current = true;
    const t = window.setTimeout(() => {
      void handleConnect(false);
    }, 750);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when default room is present; handleConnect stable enough for initial connect
  }, [addressInput, autoConnect]);

  const handleDisconnect = () => {
    if (connectHandshakeTimerRef.current != null) {
      window.clearTimeout(connectHandshakeTimerRef.current);
      connectHandshakeTimerRef.current = null;
    }
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setAgentEphemeralRow(null);
    audioAnalyzerRef.current = null;
    setIsConnected(false);
    setIsConnecting(false);
    setMessages([]);
    setIsPlayingTTS(false);
    setActiveMessageId(null);
    setHfStatus(null);
    setStreamName("");
    setStreamSymbol("");
    setIsBondedToken(false);
    setPriceHistory([]);
    setHistoricalPriceData(null);
    lastNewRadarSpeechFingerprintRef.current = "";
    lastNewRadarSpeechAtRef.current = 0;
    mentionedTrendsRef.current = [];
    trendTickGuardRef.current = {
      lastTop: null,
      lastHeat: 0,
      lastTickAt: 0,
      pendingTop: null,
      pendingHeat: 0,
      seeded: false,
    };
    rotatingTrendCursorRef.current = 0;
    recentTrendFocusRef.current = [];
    lastTrendCommentaryAtRef.current = 0;
    proactiveQueueRef.current = [];
    lastReactiveSpokenAtRef.current = 0;
    lastProactiveSpokenAtRef.current = 0;
    ttsHighlightScheduleRef.current = null;
    lastSyncedHighlightRef.current = null;
    const linger = trendHighlightLingerTimeoutRef.current;
    if (linger != null) {
      clearTimeout(linger);
      trendHighlightLingerTimeoutRef.current = null;
    }
    setActiveTrendHighlight(null);
    setError(null);
    setConnectionNotice(null);
    lastAgentSpokenRef.current = null;
    lastAgentHighlightTrendRef.current = null;
    varietySeedRef.current = 0;
    // messageStatuses and aiReplies intentionally kept to persist data
  };

  /** Tight Y scale so small MC moves are visible (avoids a flat line when values barely change). */
  const mcChartYDomain = useMemo((): [number, number] | undefined => {
    if (priceHistory.length < 2) return undefined;
    const vals = priceHistory.map((p) => p.mcSol);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min;
    const pad =
      span > 1e-12
        ? Math.max(span * 0.2, max * 0.003)
        : Math.max(Math.abs(max) * 0.025, 1e-6);
    return [min - pad, max + pad];
  }, [priceHistory]);

  return (
    <div className="h-dvh flex flex-col font-sans overflow-hidden text-[color:var(--eve-text)] selection:bg-[color-mix(in_srgb,var(--eve-accent-a)_35%,transparent)]">
      {/* Full-bleed broadcast background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute inset-0 bg-[var(--eve-bg-deep)]" />
        <div className="absolute top-0 left-0 right-0 h-[58%] bg-gradient-to-b from-[color-mix(in_srgb,var(--eve-accent-a)_22%,transparent)] via-transparent to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-[58%] bg-gradient-to-t from-[color-mix(in_srgb,var(--eve-accent-b)_18%,transparent)] via-transparent to-transparent" />
        <div
          className="absolute top-[-18%] left-[-10%] w-[58%] h-[58%] rounded-full eve-ambient-mesh bg-[radial-gradient(circle_at_center,var(--eve-glow-a)_0%,transparent_68%)] blur-[130px]"
          aria-hidden
        />
        <div
          className="absolute bottom-[-18%] right-[-10%] w-[58%] h-[58%] rounded-full eve-ambient-mesh bg-[radial-gradient(circle_at_center,var(--eve-glow-b)_0%,transparent_68%)] blur-[130px]"
          style={{ animationDelay: "-7s" }}
          aria-hidden
        />
        <div
          className="absolute inset-0 opacity-[0.055] bg-[linear-gradient(rgba(255,255,255,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[length:22px_22px]"
          aria-hidden
        />
      </div>

      <div className={`relative z-10 flex flex-1 min-h-0 flex-col ${isStreamLayout ? "pb-2 sm:pb-2" : "pb-[3.25rem] sm:pb-14"}`}>
      <motion.header
        /* initial must not hide content on SSR — opacity:0 produced a blank page without JS */
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { duration: 0.55, ease: [0.22, 1, 0.36, 1] }
        }
        className={`relative z-20 flex items-center gap-2 sm:gap-4 px-3 sm:px-6 lg:px-8 ${isStreamLayout ? "py-2 min-h-0" : "py-3 min-h-[3.5rem]"} eve-panel rounded-none border-x-0 border-t-0 shrink-0 border-b-[color:var(--eve-border)] shadow-[0_12px_48px_rgba(0,0,0,0.35)]`}
      >
        <div
          className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[color:var(--eve-accent-a)] to-[color:var(--eve-accent-b)] opacity-90"
          aria-hidden
        />
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <img
            src="/clawk.png"
            alt="EVE"
            className={`rounded-xl object-contain bg-white/5 flex-shrink-0 ring-2 ring-[color:var(--eve-border)] shadow-[0_0_24px_var(--eve-glow-a)] ${isStreamLayout ? "w-9 h-9" : "w-11 h-11"}`}
          />
          <div className="min-w-0 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <h1
              className={`eve-display flex flex-wrap items-baseline gap-x-2 gap-y-0 truncate min-w-0 leading-none ${isStreamLayout ? "text-[var(--eve-display-size-stream)]" : "text-[var(--eve-display-size)]"}`}
            >
              <span className="relative eve-hero-sweep inline-block overflow-hidden text-white tracking-[0.06em] drop-shadow-[0_0_28px_var(--eve-glow-a)]">
                EVE
              </span>
              {!isStreamLayout ? (
                <span className="text-[color:var(--eve-accent-a)] font-bold normal-case tracking-normal text-[clamp(0.85rem,2vw,1.15rem)] font-[family-name:var(--font-eve-sans)]">
                  Trend Analyst
                </span>
              ) : (
                <span className="eve-live-pulse text-[color:var(--eve-live)] font-bold normal-case tracking-wide text-sm sm:text-base font-[family-name:var(--font-eve-sans)]">
                  LIVE
                </span>
              )}
            </h1>
            {isStreamLayout ? (
              <span
                className="ml-1 shrink-0 rounded-md border border-[color:var(--eve-live)]/50 bg-[color-mix(in_srgb,var(--eve-live)_12%,transparent)] px-2 py-0.5 text-[10px] eve-ticker text-[color:var(--eve-live)]"
                title="Stream layout: per-trend colors, radar-first, top strip. Auto at ≤640×480 viewport, or set NEXT_PUBLIC_EVE_STREAM_LAYOUT=1. Disable auto with NEXT_PUBLIC_EVE_STREAM_LAYOUT_AUTO=0."
              >
                Stream
              </span>
            ) : null}
            {!isStreamLayout && (isBondedToken || (latestMcSol !== null && latestMcSol > 0)) && (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 sm:pl-3 sm:border-l border-white/10 text-[11px] sm:text-xs">
                {isBondedToken && (
                  <span className="font-mono text-cyan-400 uppercase tracking-wider font-semibold shrink-0">Bonded</span>
                )}
                {latestMcSol !== null && latestMcSol > 0 && (
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
                    <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Market Cap</span>
                    <span className="font-bold tabular-nums text-white">{latestMcSol.toFixed(2)} SOL</span>
                    {solUsdPrice != null && (
                      <span className="text-green-400 font-mono tabular-nums">
                        ${(latestMcSol * solUsdPrice).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {!isStreamLayout && mcChartMounted && priceHistory.length > 1 && (
          <div className="hidden sm:flex flex-col justify-end shrink-0 w-36 h-[52px] border-l border-white/10 pl-3 ml-0.5">
            <p className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-0.5 text-right leading-none">
              MC (SOL)
            </p>
            <div className="h-10 w-full min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={priceHistory} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mcGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00f5ff" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#00f5ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis domain={mcChartYDomain ?? ["auto", "auto"]} hide />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(0,0,0,0.7)",
                      border: "1px solid #00f5ff33",
                      borderRadius: 4,
                      fontSize: 10,
                      padding: "2px 6px",
                    }}
                    itemStyle={{ color: "#00f5ff" }}
                    formatter={(v: any) => [`${Number(v).toFixed(3)} SOL`, ""]}
                    labelFormatter={() => ""}
                  />
                  <Area
                    type="monotone"
                    dataKey="mcSol"
                    stroke="#00f5ff"
                    strokeWidth={1.5}
                    fill="url(#mcGrad)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {!isStreamLayout ? (
          <div className="hidden sm:flex items-center gap-2">
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg py-1.5 px-2 text-sm text-cyan-100 focus:outline-none focus:ring-1 focus:ring-cyan-500/50 appearance-none cursor-pointer"
            >
              <option value="elevenlabs_default" className="bg-gray-900">Eve (ElevenLabs)</option>
              {customVoices.map(v => (
                <option key={v.id} value={v.id} className="bg-gray-900">{v.name} (HF)</option>
              ))}
              {isLoadingVoices && <option disabled className="bg-gray-900 text-gray-500">Loading HF Models...</option>}
            </select>
            <button
              onClick={() => setShowAddVoice(true)}
              className="p-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-cyan-400 transition"
              title="Add Voice Model"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={async () => {
                 if (selectedVoice === "elevenlabs_default") {
                   alert("Please select an HF voice model to test");
                   return;
                 }
                 try {
                   const audioUrl = await generateHuggingFaceTts(
                     "Hello! This is a simple test of the Hugging Face text to speech request.",
                     selectedVoice,
                     "en-US-ChristopherNeural"
                   );
                   if (audioUrl) {
                      const audio = new Audio(audioUrl);
                      audio.play();
                   }
                 } catch (err) {
                    alert("Test TTS failed: " + err);
                 }
              }}
              className="p-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-fuchsia-400 transition"
              title="Test TTS"
            >
              <Volume2 className="w-4 h-4" />
            </button>
          </div>
          ) : null}
          {!isEveKiosk && !isStreamLayout && (
          <div className="relative hidden sm:block w-48 lg:w-64">
            <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 pointer-events-none" />
            <input
              type="text"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              disabled={isConnected || isConnecting}
              placeholder="Token address or URL"
              className="w-full bg-white/5 border border-white/10 rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/60 focus:border-cyan-500/50 transition-all disabled:opacity-50 placeholder:text-gray-500"
            />
          </div>
          )}
          {!isConnected ? (
            <button
              onClick={() => handleConnect(false, { fromUserClick: true })}
              disabled={isConnecting}
              className="relative py-2.5 px-5 sm:px-6 bg-gradient-to-r from-[color:var(--eve-accent-a)] to-[color:var(--eve-accent-b)] hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100 rounded-xl font-extrabold text-black transition-all duration-200 flex items-center justify-center gap-2 overflow-hidden border border-white/20 shadow-[0_0_28px_var(--eve-glow-a)] active:scale-[0.98]"
            >
              <span className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/15 to-transparent rounded-t-xl pointer-events-none opacity-0 hover:opacity-100 transition-opacity duration-200" aria-hidden />
              {isConnecting ? (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Play className="w-4 h-4 relative z-10" />
                  <span className="hidden sm:inline relative z-10">Start Agent</span>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleDisconnect}
              className="py-2.5 px-5 sm:px-6 bg-[color-mix(in_srgb,var(--eve-accent-a)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--eve-accent-a)_22%,transparent)] border border-[color:var(--eve-border-strong)] rounded-xl font-bold text-[color:var(--eve-accent-a)] transition-all flex items-center justify-center gap-2 shadow-[0_0_16px_var(--eve-glow-a)]"
            >
              <Square className="w-4 h-4" />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}
        </div>
      </motion.header>

      {/* Mobile: token input + error below header */}
      {!isEveKiosk && (
      <div className="sm:hidden relative z-10 px-4 py-2 space-y-2">
        <div className="relative">
          <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
          <input
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            disabled={isConnected || isConnecting}
            placeholder="Token address or URL"
            className="w-full bg-white/5 border border-white/10 rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500"
          />
        </div>
        {error && (
          <div className="p-2.5 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-cyan-400 text-xs flex items-start gap-2">
            <span>•</span>
            <span>{error}</span>
          </div>
        )}
      </div>
      )}
      {error && (
        <div className={`relative z-10 px-6 py-2 ${isEveKiosk ? "" : "hidden sm:block"}`}>
          <div className="p-2.5 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-cyan-400 text-sm flex items-start gap-2 max-w-2xl">
            <span>•</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Main: full viewport, edge-to-edge; stacks on small screens */}
      <main className="flex-1 relative z-10 flex flex-col lg:flex-row min-h-0 w-full overflow-hidden">
        {/* Visualizer zone - takes most space, no max-width */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col relative overflow-hidden border-r border-[color:var(--eve-border)]">
          <div className="absolute inset-0 bg-gradient-to-br from-[color-mix(in_srgb,var(--eve-accent-a)_12%,transparent)] via-[color-mix(in_srgb,var(--eve-bg-deep)_40%,black)] to-[color-mix(in_srgb,var(--eve-accent-b)_10%,transparent)]" />
          <div
            className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-[color:var(--eve-accent-a)]/35 to-[color:var(--eve-accent-b)]/25 pointer-events-none"
            aria-hidden
          />
          {/* Name/ticker: full width when stream; when default layout, desktop grid places this above Latest trends only (Mindshare shares the top row — see inner grid). */}
          {isStreamLayout ? (
          <div className="relative z-10 flex flex-wrap items-center gap-2 sm:gap-4 px-3 sm:px-6 lg:px-8 py-1.5 min-h-0">
            <div className="flex min-w-0 flex-shrink-0 flex-wrap items-center gap-2 sm:gap-4">
              <input
                type="text"
                placeholder="Token name"
                value={streamName}
                onChange={e => setStreamName(e.target.value)}
                className="bg-transparent font-bold text-white placeholder:text-gray-500 border-b border-transparent hover:border-white/20 focus:border-cyan-500/60 focus:outline-none transition-colors text-sm w-28 sm:w-36"
              />
              <span className="px-2 py-0.5 bg-white/10 text-gray-300 rounded font-mono text-xs">
                $ <input
                  type="text"
                  placeholder="TICKER"
                  value={streamSymbol}
                  onChange={e => setStreamSymbol(e.target.value.toUpperCase())}
                  className="bg-transparent focus:outline-none placeholder:text-gray-500 font-mono w-12 sm:w-14 text-xs"
                />
              </span>
            </div>
          </div>
          ) : null}

          <div className="flex-1 flex flex-col min-h-0 overflow-hidden overflow-x-hidden relative z-10">
            <div
              className={`flex-1 min-h-0 flex flex-col px-1 sm:px-3 pb-1 pt-0 ${isStreamLayout ? "min-h-0" : ""}`}
            >
              {isStreamLayout ? (
                <div className="flex flex-col flex-1 min-h-0 gap-1.5">
                  {streamHeroTrend ? (
                    <motion.div
                      key={streamHeroTrend.name}
                      layout={!reduceMotion}
                      initial={false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 380, damping: 28 }
                      }
                      className="shrink-0 px-2 py-0.5 text-center border-b border-[color:var(--eve-border)]/80"
                    >
                      <p className="eve-ticker text-[10px] text-[color:var(--eve-muted)]">
                        Leading topic
                      </p>
                      <p
                        className="eve-display text-[clamp(0.95rem,3.8vw,1.4rem)] truncate px-1 leading-tight"
                        style={{
                          color: streamHeroTrend.color,
                          filter: reduceMotion ? undefined : "drop-shadow(0 0 14px currentColor)",
                        }}
                      >
                        {streamHeroTrend.name}
                      </p>
                    </motion.div>
                  ) : null}
                  <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                    <TrendRadarChart
                      variant="stream"
                      reduceMotion={reduceMotion}
                      polar={trendPolarData}
                      activeTrendName={activeTrendHighlight}
                      speechPulse={speechPulse}
                      voice={{
                        audioAnalyzerRef,
                        isPlayingTTS,
                        progressNorm: radarVoiceBonding.progressNorm,
                        dimOthersWhenSpeaking:
                          isPlayingTTS && Boolean(activeTrendHighlight?.trim()),
                      }}
                      bondingHud={
                        <>
                          {!radarVoiceBonding.bondingHasData &&
                          latestMcSol === null ? (
                            <span className="block text-cyan-400/90 text-[10px] leading-tight">
                              Connect a token
                            </span>
                          ) : null}
                          {radarVoiceBonding.bondingHasData &&
                          radarVoiceBonding.progress !== null &&
                          radarVoiceBonding.progress < 100 &&
                          bondingCurveData?.realTokenReserves != null ? (
                            <span className="block font-mono text-fuchsia-200/90 text-[10px] leading-tight">
                              Pending{" "}
                              {(() => {
                                const currentTokens = BigInt(
                                  bondingCurveData.realTokenReserves,
                                );
                                const initialTokens = BigInt("793100000000000");
                                return `${(Number((currentTokens * BigInt("10000")) / initialTokens) / 100).toFixed(1)}%`;
                              })()}
                            </span>
                          ) : null}
                        </>
                      }
                    />
                  </div>
                  <TrendHeatLeaderboard
                    variant="stream"
                    polar={trendPolarData}
                    activeTrendName={activeTrendHighlight}
                    dimUnfocusedDuringSpeech={
                      isPlayingTTS && Boolean(activeTrendHighlight?.trim())
                    }
                    className="shrink-0"
                  />
                </div>
              ) : (
              <div className="flex min-h-0 w-full flex-1 flex-col gap-2 lg:grid lg:min-h-0 lg:grid-cols-[min(320px,100%)_1fr] lg:grid-rows-[auto_1fr] lg:gap-x-3 lg:gap-y-0">
                <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 sm:gap-4 px-3 py-2.5 sm:min-h-[2.75rem] sm:px-6 lg:col-start-1 lg:row-start-1 lg:px-0">
                  <div className="flex min-w-0 flex-shrink-0 flex-wrap items-center gap-2 sm:gap-4">
                    <input
                      type="text"
                      placeholder="Token name"
                      value={streamName}
                      onChange={(e) => setStreamName(e.target.value)}
                      className="w-32 bg-transparent border-b border-transparent font-bold text-white placeholder:text-gray-500 transition-colors hover:border-white/20 focus:border-cyan-500/60 focus:outline-none sm:w-44 text-lg sm:text-xl"
                    />
                    <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-sm text-gray-300">
                      $ <input
                        type="text"
                        placeholder="TICKER"
                        value={streamSymbol}
                        onChange={(e) =>
                          setStreamSymbol(e.target.value.toUpperCase())
                        }
                        className="w-16 bg-transparent font-mono placeholder:text-gray-500 focus:outline-none sm:w-20"
                      />
                    </span>
                  </div>
                </div>
                <div className="flex min-h-0 w-full flex-1 flex-col self-stretch lg:col-start-1 lg:row-start-2 lg:min-h-0 lg:w-[min(100%,320px)] lg:shrink-0">
                  <TrendHeatLeaderboard
                    polar={trendPolarData}
                    activeTrendName={activeTrendHighlight}
                    dimUnfocusedDuringSpeech={
                      isPlayingTTS && Boolean(activeTrendHighlight?.trim())
                    }
                    className="min-h-0 flex-1"
                  />
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0">
                  <TrendRadarChart
                    reduceMotion={reduceMotion}
                    polar={trendPolarData}
                    activeTrendName={activeTrendHighlight}
                    speechPulse={speechPulse}
                    voice={{
                      audioAnalyzerRef,
                      isPlayingTTS,
                      progressNorm: radarVoiceBonding.progressNorm,
                      dimOthersWhenSpeaking:
                        isPlayingTTS && Boolean(activeTrendHighlight?.trim()),
                    }}
                    bondingHud={
                      <>
                        {!radarVoiceBonding.bondingHasData &&
                        latestMcSol === null ? (
                          <span className="block text-cyan-400/90 leading-tight">
                            Connect a token
                          </span>
                        ) : null}
                        {radarVoiceBonding.bondingHasData &&
                        radarVoiceBonding.progress !== null &&
                        radarVoiceBonding.progress < 100 &&
                        bondingCurveData?.realTokenReserves != null ? (
                          <span className="block font-mono text-fuchsia-200/90 leading-tight">
                            Pending{" "}
                            {(() => {
                              const currentTokens = BigInt(
                                bondingCurveData.realTokenReserves,
                              );
                              const initialTokens = BigInt("793100000000000");
                              return `${(Number((currentTokens * BigInt("10000")) / initialTokens) / 100).toFixed(1)}%`;
                            })()}
                          </span>
                        ) : null}
                      </>
                    }
                  />
                </div>
              </div>
              )}
              {trendsError && (
                <p className="mt-1 shrink-0 px-1 text-[10px] text-red-400/90">
                  {trendsError}
                </p>
              )}
            </div>

            <AnimatePresence mode="wait">
              {hfStatus && (
                <motion.div
                  key="hf-status"
                  initial={false}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: reduceMotion ? 0 : 0.25 }}
                  className="flex justify-center px-4 py-2 shrink-0"
                >
                  <div className="flex items-center justify-center gap-2 text-xs font-mono bg-fuchsia-900/30 text-fuchsia-200 border border-fuchsia-500/20 py-1.5 px-3 rounded-full w-max max-w-full">
                    <Loader2 className="w-3 h-3 animate-spin text-fuchsia-400" />
                    {hfStatus.stage === "pending" && (
                      <span>
                        Queued in HF Space...{" "}
                        {hfStatus.position
                          ? `Pos: ${hfStatus.position}`
                          : ""}
                      </span>
                    )}
                    {hfStatus.stage === "generating" && (
                      <span>
                        Generating Voice...{" "}
                        {hfStatus.eta ? `ETA: ${hfStatus.eta}s` : ""}
                      </span>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Chat panel - fixed width, match main column height to footer padding */}
        <div className="w-full sm:w-[320px] lg:w-[380px] flex-shrink-0 min-h-0 flex flex-col self-stretch eve-panel rounded-none border-y-0 border-r-0 overflow-hidden relative shadow-[0_0_40px_rgba(0,0,0,0.4)]">
          <div
            className="absolute left-0 top-0 bottom-0 w-px bg-gradient-to-b from-[color:var(--eve-accent-a)]/50 via-[color:var(--eve-accent-b)]/35 to-[color:var(--eve-accent-a)]/40 pointer-events-none"
            aria-hidden
          />
          {connectionNotice ? (
            <div
              className="relative z-10 shrink-0 border-b border-amber-500/25 bg-amber-950/30 px-3 py-2 sm:px-4"
              role="status"
              aria-live="polite"
            >
              <p
                className="text-center text-[10px] leading-snug text-amber-400/95 sm:text-xs"
                title={connectionNotice}
              >
                {connectionNotice}
              </p>
            </div>
          ) : null}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-[color:var(--eve-border)] p-3 sm:p-4">
            <h2 className="eve-ticker text-sm flex items-center gap-2 text-[color:var(--eve-text)]">
              <MessageSquare className="w-4 h-4 text-[color:var(--eve-accent-a)]" />
              Live Chat
            </h2>
            <span className="text-[10px] font-mono text-[color:var(--eve-accent-b)] bg-[color-mix(in_srgb,var(--eve-accent-b)_12%,transparent)] px-2 py-0.5 rounded-full border border-[color:var(--eve-border)]">
              {messages.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {!isConnected && chatListMessages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-3 text-xs text-center p-6">
                  <Radio className="w-8 h-8 opacity-20" />
                  <p>Awaiting connection to token feed.</p>
                </div>
              ) : chatListMessages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-3 text-xs">
                  <div className="flex gap-1 items-center opacity-50">
                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse delay-75" />
                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse delay-150" />
                  </div>
                  <p>Listening...</p>
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {chatListMessages.map((msg, i) => {
                    const isActive = msg.id === activeMessageId;
                    const isTooShort = msg.message.trim().length <= 3;
                    const replyText = aiReplies[msg.id];
                    const hideCueBubble = isSyntheticChatAgentRow(msg);
                    
                    return (
                      <React.Fragment key={msg.id || i}>
                        {!hideCueBubble && (
                        <motion.div
                          initial={false}
                          animate={{ opacity: 1, x: 0, scale: 1 }}
                          transition={{ duration: reduceMotion ? 0 : 0.18 }}
                          className={`pb-1 px-3 rounded-lg flex items-start gap-2 transition-all group ${
                            isActive 
                              ? 'bg-cyan-900/40 border border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.35)] z-10 scale-[1.02]' 
                              : 'hover:bg-white/5 opacity-90 hover:opacity-100'
                          }`}
                        >
                        <div className="w-6 h-6 rounded-full bg-cyan-900/50 flex-shrink-0 flex items-center justify-center text-cyan-300 text-xs font-bold overflow-hidden mt-0.5 sm:mt-0">
                          {msg.profile_image ? (
                            <img src={msg.profile_image} alt="" className="w-full h-full object-cover" />
                          ) : (
                            (msg.username || "U").charAt(0).toUpperCase()
                          )}
                        </div>
                        <span className={`font-bold text-[14px] flex-shrink-0 ${isActive ? 'text-white' : 'text-[#8A2BE2]'}`}>
                          {msg.username?.slice(0,6) || "Anonymous"}
                        </span>
                        <span className={`text-[14px] break-words flex-1 ${isActive ? 'text-white font-medium' : 'text-gray-200'}`}>
                          {msg.message}
                        </span>
                        
                        {/* {isTooShort ? (
                           <div className="shrink-0 px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wider flex items-center gap-1 bg-gray-500/20 text-gray-400 border border-gray-500/30">
                             ⊘ IGNORED
                           </div>
                        ) : (
                          messageStatuses[msg.id] && messageStatuses[msg.id] !== 'history' ? (
                            <div className={`shrink-0 px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wider flex items-center gap-1 ${
                              messageStatuses[msg.id] === 'processing' 
                                ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' 
                                : 'bg-green-500/20 text-green-400 border border-green-500/30'
                            }`}>
                              {messageStatuses[msg.id] === 'processing' ? (
                                <>
                                  <div className="w-1.5 h-1.5 border border-cyan-400/50 border-t-cyan-400 rounded-full animate-spin" />
                                  WAIT
                                </>
                              ) : (
                                <>✓ DONE</>
                              )}
                            </div>
                          ) : (
                            <button 
                              onClick={() => triggerAgent(msg)}
                              disabled={isPlayingTTS}
                              className="shrink-0 p-1.5 rounded-full bg-white/5 hover:bg-cyan-500/20 text-gray-400 hover:text-cyan-400 border border-transparent hover:border-cyan-500/30 transition-all disabled:opacity-30 disabled:hover:bg-white/5 disabled:hover:text-gray-400 disabled:hover:border-transparent"
                              title="Agent Reply"
                            >
                              <Mic className="w-3 h-3" />
                            </button>
                          )
                        )} */}
                      </motion.div>
                        )}

                      {replyText && (
                        <motion.div
                          initial={false}
                          animate={{ opacity: 1, y: 0 }}
                          className="ml-8 mb-3 mt-1 py-1.5 px-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-start gap-2 backdrop-blur-sm self-start"
                        >
                          <div className="w-6 h-6 rounded-full bg-black/50 flex-shrink-0 overflow-hidden border border-cyan-500/30 mt-0.5 flex items-center justify-center">
                            <img src="/clawk.png" alt="EVE" className="w-full h-full object-cover rounded-full" />
                          </div>
                          <div className="flex flex-col flex-1">
                            <span className="font-bold text-[13px] text-cyan-400 leading-none mb-1">
                              {streamName || "Eve"}
                            </span>
                            <span className="text-[13px] text-cyan-100 font-medium leading-snug">
                              {replyText}
                            </span>
                          </div>
                        </motion.div>
                      )}
                      </React.Fragment>
                    );
                  })}
                </AnimatePresence>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
      </main>
      </div>

      <SiteFooter />

      <AnimatePresence>
        {showAddVoice && (
          <motion.div
            initial={false}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={false}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0f0f15] border border-white/10 p-5 rounded-2xl w-full max-w-sm shadow-2xl relative"
            >
              <button
                onClick={() => setShowAddVoice(false)}
                className="absolute top-3 right-3 text-gray-500 hover:text-white transition"
              >
                <X className="w-5 h-5" />
              </button>
              <h3 className="text-lg font-bold text-white mb-4">Add Voice Model</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Model Name</label>
                  <input
                    type="text"
                    value={newVoiceName}
                    onChange={e => setNewVoiceName(e.target.value)}
                    placeholder="e.g. mr_krabs"
                    className="w-full bg-white/5 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500 text-white placeholder-gray-600"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Model URL</label>
                  <input
                    type="text"
                    value={newVoiceUrl}
                    onChange={e => setNewVoiceUrl(e.target.value)}
                    placeholder="https://huggingface.co/..."
                    className="w-full bg-white/5 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500 text-white placeholder-gray-600"
                  />
                </div>
                <button
                  onClick={handleAddVoice}
                  disabled={isAddingVoice || !newVoiceName || !newVoiceUrl}
                  className="w-full py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 disabled:hover:bg-cyan-500 text-white rounded-lg font-semibold flex items-center justify-center gap-2 transition"
                >
                  {isAddingVoice ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {isAddingVoice ? 'Adding Model...' : 'Add Voice Model'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
