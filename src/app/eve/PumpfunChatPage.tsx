"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { EveStreamPublicConfig } from "./stream-config";
import { IMessage } from '@/lib/pumpChatClient';
import { motion, AnimatePresence } from "framer-motion";
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
  trendDisplayNamesMatch,
} from "@/lib/live-trends";
import {
  buildProportionalHighlightTimeline,
  VOICE_HIGHLIGHT_LINGER_SEC,
  type VoiceHighlightSegment,
} from "@/lib/voice-highlight-timeline";
import { isPumpSpamScamMessage } from "@/lib/pump-chat-filters";
import { buildRecentChatTranscript } from "@/lib/agent-chat-context";
import TrendHeatLeaderboard from "@/components/TrendHeatLeaderboard";

const TrendRadarChart = dynamic(() => import("@/components/TrendRadarChart"), {
  ssr: false,
  loading: () => (
    <div className="w-full min-h-[220px] rounded-xl border border-white/10 bg-black/20 animate-pulse" />
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
const VOTE_GOAL_DEFAULT = 15;
const VOTE_COOLDOWN_MS = 12_000;
const VOTE_SUMMARY_COOLDOWN_MS = 90_000;
/** Host banter check interval; actual spacing uses silence decay inside handler. */
const HOST_BANTER_CHECK_MS = 30_000;
/** Abort agent API fetch if the server or network hangs. */
const AGENT_FETCH_TIMEOUT_MS = 90_000;
/** HF Gradio TTS can stall indefinitely; fall back to text-only after this. */
const HF_TTS_TIMEOUT_MS = 180_000;
/** If playback never finishes, reset so the poller can run again. */
const TTS_STUCK_WATCHDOG_MS = 4 * 60 * 1000;

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
  ["trendradar", "votebooth", "hostfill"].map((s) => s.toLowerCase()),
);

/** Rows that trigger the agent but are not in the live pump feed — shown ephemerally during TTS. */
function isSyntheticChatAgentRow(msg: IMessage): boolean {
  const u = (msg.username || "").trim().toLowerCase();
  if (SYNTHETIC_AGENT_USERNAMES.has(u)) return true;
  const id = msg.id || "";
  return (
    id.startsWith("trend-tick-") ||
    id.startsWith("host-banter-") ||
    id.startsWith("vote-sum-") ||
    id.startsWith("winner-")
  );
}

/**
 * One-shot after connect: scan back through history for the latest real line (spam often clogs the tail).
 * After that pass we only consider the last 2 messages so we don’t auto-reply backward through old chat.
 */
const AGENT_CATCH_UP_LOOKBACK = 100;
const AGENT_POLL_TAIL = 2;

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

function parseChatVote(
  text: string,
  trendOptions: string[],
): { key: string } | null {
  const t = text.trim();
  const num = t.match(/^(?:!vote|!v)\s+(\d+)\s*$/i);
  if (num) {
    const idx = parseInt(num[1], 10) - 1;
    if (idx >= 0 && idx < trendOptions.length) return { key: trendOptions[idx] };
    return null;
  }
  const pick = t.match(/^!pick\s+(.+)$/i);
  if (pick) {
    const q = pick[1].trim().toLowerCase();
    if (!q) return null;
    const exact = trendOptions.find((n) => n.toLowerCase() === q);
    if (exact) return { key: exact };
    const sub = trendOptions.find(
      (n) =>
        n.toLowerCase().includes(q) ||
        (q.length >= 3 && n.toLowerCase().includes(q.slice(0, 14))),
    );
    if (sub) return { key: sub };
  }
  return null;
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
}: EveStreamPublicConfig) {
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
  const [trendsFetchedAt, setTrendsFetchedAt] = useState<string | null>(null);
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const [voteTally, setVoteTally] = useState<Record<string, number>>({});
  const voteCooldownRef = useRef<Record<string, number>>({});
  const [winningTrend, setWinningTrend] = useState<string | null>(null);
  const [speechPulse, setSpeechPulse] = useState(0);
  const [activeTrendHighlight, setActiveTrendHighlight] = useState<
    string | null
  >(null);

  /** Sync radar highlight to spoken mentions (ElevenLabs alignment or proportional fallback). */
  const ttsHighlightScheduleRef = useRef<{
    segments: VoiceHighlightSegment[];
    mode: "buffer" | "html";
    bufferCtxStartTime: number | null;
    htmlAudio: HTMLAudioElement | null;
  } | null>(null);
  const lastSyncedHighlightRef = useRef<string | null>(null);

  const voteOptionsRef = useRef<string[]>([]);
  const dedupedRef = useRef<DedupedTrend[]>([]);
  const trendTickGuardRef = useRef({
    lastTop: null as string | null,
    lastHeat: 0,
    lastTickAt: 0,
    seeded: false,
  });
  const voteLeaderPrevRef = useRef<string | null>(null);
  const lastVoteSummaryAtRef = useRef(0);
  const winnerAnnouncedRef = useRef(false);
  /** Last time a real chatter sent a non-spam, non-vote message (for host banter decay). */
  const lastRealChatAtRef = useRef(Date.now());
  const hostBanterGuardRef = useRef({ lastAt: Date.now() });
  /** Last successful agent TTS line (say) for continuity. */
  const lastAgentSpokenRef = useRef<string | null>(null);
  /** Increments each agent call for server-side style rotation. */
  const varietySeedRef = useRef(0);
  /**
   * After a fresh connect (e.g. page refresh), run one poller pass with a wide lookback
   * so spam at the chat tail doesn’t hide the latest real message.
   */
  const catchUpPollAfterConnectRef = useRef(false);
  const triggerAgentRef = useRef<
    (msg: IMessage, opts?: AgentCallOptions) => Promise<void>
  >(async () => {});

  /** Prior deduped maxHeat by trend name — for polar diff (new / heat up / down). */
  const prevTrendHeatRef = useRef<Map<string, { maxHeat: number }>>(new Map());
  /** Dev-only: log client spacing between successful polls. */
  const lastTrendPullMsRef = useRef<number | null>(null);

  const liveTrendsDeduped = useMemo(
    () => dedupeTrendsByName(liveTrendRows),
    [liveTrendRows],
  );
  /** Polar scatter from deduped trends; full deduped list still drives votes. */
  const trendPolarData = useMemo(
    () =>
      buildTrendPolarScatterData(liveTrendsDeduped, {
        previousByName: prevTrendHeatRef.current,
      }),
    [liveTrendsDeduped],
  );

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

  const voteGoal = Math.max(
    3,
    Number(
      typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_EVE_VOTE_GOAL
        : undefined,
    ) || VOTE_GOAL_DEFAULT,
  );

  const voteLeader = useMemo(() => {
    const e = Object.entries(voteTally).sort((a, b) => b[1] - a[1]);
    return e[0]?.[0] ?? null;
  }, [voteTally]);

  const top3Votes = useMemo(() => {
    return Object.entries(voteTally)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }, [voteTally]);

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
  /** Synthetic agent triggers (radar / host / vote) appended to chat UI while Eve speaks. */
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
    voteOptionsRef.current = liveTrendsDeduped
      .slice(0, 20)
      .map((d) => d.trend_name);
  }, [liveTrendsDeduped]);

  useEffect(() => {
    dedupedRef.current = liveTrendsDeduped;
  }, [liveTrendsDeduped]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    const u = (last.username || "").trim().toLowerCase();
    if (["trendradar", "votebooth", "hostfill", "eve"].includes(u)) return;
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
          setTrendsFetchedAt(j.fetchedAt ?? new Date().toISOString());
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
      if (next !== lastSyncedHighlightRef.current) {
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
    voteTally,
    voteLeader,
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
      voteTally,
      voteLeader,
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
    voteTally,
    voteLeader,
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
      return;
    }

    hostBanterGuardRef.current.lastAt = Date.now();
    varietySeedRef.current += 1;
    const varietySeed = varietySeedRef.current;
    const recentChatTranscript = buildRecentChatTranscript(
      stateRefs.current.messages,
      stateRefs.current.aiReplies,
    );
    const lastAgentSay = lastAgentSpokenRef.current;

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
        res = await fetch("/api/agent/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
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
            voteTally: stateRefs.current.voteTally,
            voteLeader: stateRefs.current.voteLeader,
            activeTrendSpeaking: activeSpeak,
            recentChatTranscript: recentChatTranscript ?? undefined,
            lastAgentSay: lastAgentSay ?? undefined,
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

      setActiveTrendHighlight(null);
      lastSyncedHighlightRef.current = null;
      ttsHighlightScheduleRef.current = null;

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
        audioAnalyzerRef.current = null;
        ttsHighlightScheduleRef.current = null;
        lastSyncedHighlightRef.current = null;
        setActiveTrendHighlight(null);
        setIsPlayingTTS(false);
        setActiveMessageId(null);
        setHfStatus(null);
        setAgentEphemeralRow(null);
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
          if (htmlTimeline.length === 0 && replyText.trim() && trends.length > 0) {
            const durGuess = Math.min(
              120,
              Math.max(5, replyText.length * 0.052),
            );
            htmlTimeline = buildProportionalHighlightTimeline(
              replyText,
              trends.map((t) => t.trend_name),
              durGuess,
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
            setActiveTrendHighlight(null);
            setAgentEphemeralRow(null);
            setError(
              "Voice was blocked or unsupported. Click Start Agent (or interact with the page) so the browser can unlock audio.",
            );
            markAnswered();
          }
        }
      } else {
        if (highlightForSpeech) setActiveTrendHighlight(highlightForSpeech);
        setTimeout(() => {
          setActiveTrendHighlight(null);
          setIsPlayingTTS(false);
          setActiveMessageId(null);
          setHfStatus(null);
          setAgentEphemeralRow(null);
        }, 6000);
        setMessageStatuses((prev) => ({
          ...prev,
          [msgToProcess.id]: "answered",
        }));
      }
    } catch (error) {
      console.error("Agent interaction failed", error);
      ttsHighlightScheduleRef.current = null;
      lastSyncedHighlightRef.current = null;
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
    }
  },
  [selectedVoice],
);

  useEffect(() => {
    triggerAgentRef.current = triggerAgent;
  }, [triggerAgent]);

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
      setActiveTrendHighlight(null);
      setAgentEphemeralRow(null);
    }, TTS_STUCK_WATCHDOG_MS);
    return () => window.clearTimeout(id);
  }, [isPlayingTTS]);

  useEffect(() => {
    if (!isConnected) return;
    const id = window.setInterval(() => {
      if (stateRefs.current.isPlayingTTS) return;
      const d = dedupedRef.current;
      if (!d.length) return;
      const now = Date.now();
      const g = trendTickGuardRef.current;
      const top = d[0];
      if (!g.seeded) {
        g.lastTop = top.trend_name;
        g.lastHeat = top.maxHeat;
        g.seeded = true;
        return;
      }
      if (now - g.lastTickAt < TREND_TICK_MIN_MS) {
        g.lastHeat = top.maxHeat;
        g.lastTop = top.trend_name;
        return;
      }
      const changed = top.trend_name !== g.lastTop;
      const jumped = g.lastHeat > 5 && top.maxHeat > g.lastHeat * 1.35;
      g.lastHeat = top.maxHeat;
      g.lastTop = top.trend_name;
      if (!changed && !jumped) return;
      g.lastTickAt = now;
      void triggerAgentRef.current(
        syntheticAgentMessage({
          id: `trend-tick-${now}`,
          message: `Voice cue: spotlighting “${top.trend_name}” on the radar.`,
          username: "TrendRadar",
        }),
        { agentMode: "trend_tick", activeTrendSpeaking: top.trend_name },
      );
    }, 60_000);
    return () => window.clearInterval(id);
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected) return;
    const id = window.setInterval(() => {
      if (stateRefs.current.isPlayingTTS) return;
      const d = dedupedRef.current;
      if (!d.length) return;
      const now = Date.now();
      const silence = now - lastRealChatAtRef.current;
      let minGap = 50_000;
      if (silence > 5 * 60 * 1000) minGap = 90_000;
      if (silence > 12 * 60 * 1000) minGap = 4 * 60 * 1000;

      if (now - hostBanterGuardRef.current.lastAt < minGap) return;

      void triggerAgentRef.current(
        syntheticAgentMessage({
          id: `host-banter-${now}`,
          message:
            "Voice cue: host energy — keeping momentum while chat is quiet.",
          username: "HostFill",
        }),
        { agentMode: "host_banter", activeTrendSpeaking: null },
      );
    }, HOST_BANTER_CHECK_MS);
    return () => window.clearInterval(id);
  }, [isConnected]);

  useEffect(() => {
    for (const [name, n] of Object.entries(voteTally)) {
      if (n >= voteGoal && !winnerAnnouncedRef.current) {
        winnerAnnouncedRef.current = true;
        setWinningTrend(name);
        void triggerAgentRef.current(
          syntheticAgentMessage({
            id: `winner-${Date.now()}`,
            message: `[Stream: "${name}" hit ${voteGoal} votes and wins this voting round. Celebrate the pick and hype the room in two short sentences.]`,
            username: "VoteBooth",
          }),
          { agentMode: "chat_reply", activeTrendSpeaking: name },
        );
        break;
      }
    }
  }, [voteTally, voteGoal]);

  useEffect(() => {
    if (!isConnected || !voteLeader) return;
    const total = Object.values(voteTally).reduce((s, x) => s + x, 0);
    if (total < 3) return;
    const prev = voteLeaderPrevRef.current;
    if (prev === voteLeader) return;
    if (prev !== null) {
      const now = Date.now();
      if (
        now - lastVoteSummaryAtRef.current >= VOTE_SUMMARY_COOLDOWN_MS &&
        !stateRefs.current.isPlayingTTS
      ) {
        lastVoteSummaryAtRef.current = now;
        void triggerAgentRef.current(
          syntheticAgentMessage({
            id: `vote-sum-${now}`,
            message: "Voice cue: vote standings update.",
            username: "VoteBooth",
          }),
          { agentMode: "vote_summary" },
        );
      }
    }
    voteLeaderPrevRef.current = voteLeader;
  }, [voteLeader, voteTally, isConnected]);

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
              if (!isReconnect || prev.length === 0) return parsed.data || [];
              const existingIds = new Set(prev.map(m => m.id));
              const newHistoryMessages = (parsed.data || []).filter((m: any) => m.id && !existingIds.has(m.id));
              const combined = [...prev, ...newHistoryMessages];
              if (combined.length > 100) return combined.slice(-100);
              return combined;
            });
            // Allowed historical messages to be picked up by AI analysis
          } else if (parsed.type === "message") {
            clearConnectHandshakeTimer();
            const msg = parsed.data as IMessage;
            if (isVoteOnlyMessage(msg.message)) {
              const v = parseChatVote(msg.message, voteOptionsRef.current);
              if (v) {
                const uid = (msg.username || "anon").toLowerCase();
                const now = Date.now();
                if (
                  now - (voteCooldownRef.current[uid] ?? 0) >=
                  VOTE_COOLDOWN_MS
                ) {
                  voteCooldownRef.current[uid] = now;
                  setVoteTally((vt) => ({
                    ...vt,
                    [v.key]: (vt[v.key] ?? 0) + 1,
                  }));
                }
              }
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
    setVoteTally({});
    voteCooldownRef.current = {};
    setWinningTrend(null);
    winnerAnnouncedRef.current = false;
    voteLeaderPrevRef.current = null;
    trendTickGuardRef.current = {
      lastTop: null,
      lastHeat: 0,
      lastTickAt: 0,
      seeded: false,
    };
    ttsHighlightScheduleRef.current = null;
    lastSyncedHighlightRef.current = null;
    setActiveTrendHighlight(null);
    setError(null);
    setConnectionNotice(null);
    lastAgentSpokenRef.current = null;
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
    <div className="h-dvh bg-[#050508] text-white flex flex-col font-sans selection:bg-cyan-500/30 overflow-hidden">
      {/* Full-bleed background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-0 left-0 right-0 h-[50%] bg-gradient-to-b from-cyan-950/25 via-transparent to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-[50%] bg-gradient-to-t from-fuchsia-950/20 via-transparent to-transparent" />
        <div className="absolute top-[-15%] left-[-5%] w-[50%] h-[50%] bg-cyan-600/15 blur-[140px] rounded-full" />
        <div className="absolute bottom-[-15%] right-[-5%] w-[50%] h-[50%] bg-fuchsia-600/15 blur-[140px] rounded-full" />
      </div>

      <div className="relative z-10 flex flex-1 min-h-0 flex-col pb-[3.25rem] sm:pb-14">
      {/* Compact header: branding + connect inline, gradient accent line */}
      <header className="relative z-20 flex items-center gap-3 sm:gap-4 px-4 sm:px-6 lg:px-8 py-3 bg-black/30 backdrop-blur-xl shrink-0 min-h-[3.25rem]">
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/40 to-fuchsia-500/40" aria-hidden />
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <img src="/clawk.png" alt="EVE" className="w-10 h-10 rounded-xl object-contain bg-white/5 flex-shrink-0 ring-1 ring-white/10 shadow-sm" />
          <div className="min-w-0 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <h1 className="text-xl sm:text-2xl font-black tracking-tight truncate">
              <span className="bg-gradient-to-r from-white via-white to-gray-400 bg-clip-text text-transparent">EVE</span>
              <span className="text-cyan-400 ml-1.5 font-semibold">Trend Analyst</span>
            </h1>
            {(isBondedToken || (latestMcSol !== null && latestMcSol > 0)) && (
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
        {mcChartMounted && priceHistory.length > 1 && (
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
          {!isEveKiosk && (
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
              className="relative py-2.5 px-5 sm:px-6 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 rounded-xl font-semibold text-white transition-all duration-200 flex items-center justify-center gap-2 overflow-hidden border border-cyan-400/40 hover:border-cyan-300/60 active:scale-[0.98]"
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
              className="py-2.5 px-5 sm:px-6 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 rounded-xl font-semibold text-cyan-400 transition-all flex items-center justify-center gap-2"
            >
              <Square className="w-4 h-4" />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}
        </div>
      </header>

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
      <main className="flex-1 relative z-10 flex flex-col lg:flex-row min-h-0 w-full">
        {/* Visualizer zone - takes most space, no max-width */}
        <div className="flex-1 min-w-0 flex flex-col relative overflow-hidden border-r border-white/5">
          <div className="absolute inset-0 bg-gradient-to-br from-cyan-950/20 via-black/40 to-fuchsia-950/10" />
          <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-cyan-500/20 to-transparent pointer-events-none" aria-hidden />
          {/* Overlay bar: token name, ticker, and connection status (inline so radar height is stable) */}
          <div className="relative z-10 flex items-center gap-3 sm:gap-4 px-4 sm:px-6 lg:px-8 py-3 min-h-[3rem]">
            <div className="flex items-center gap-3 sm:gap-4 flex-shrink-0 flex-wrap">
              <input
                type="text"
                placeholder="Token name"
                value={streamName}
                onChange={e => setStreamName(e.target.value)}
                className="bg-transparent text-lg sm:text-xl font-bold text-white placeholder:text-gray-500 border-b border-transparent hover:border-white/20 focus:border-cyan-500/60 focus:outline-none transition-colors w-32 sm:w-44"
              />
              <span className="text-sm px-2 py-1 bg-white/10 text-gray-300 rounded font-mono">
                $ <input
                  type="text"
                  placeholder="TICKER"
                  value={streamSymbol}
                  onChange={e => setStreamSymbol(e.target.value.toUpperCase())}
                  className="bg-transparent w-16 sm:w-20 focus:outline-none placeholder:text-gray-500 font-mono"
                />
              </span>
            </div>
            <div className="flex-1 min-w-0 flex items-center justify-end self-center">
              {connectionNotice ? (
                <span
                  className="text-xs sm:text-sm text-amber-400/95 tabular-nums text-right truncate max-w-full"
                  title={connectionNotice}
                >
                  {connectionNotice}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden relative z-10">
            <div className="flex-1 min-h-0 flex flex-col px-2 sm:px-3 pt-1 pb-1 lg:pt-0">
              <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:items-stretch gap-3 min-h-0">
                <TrendHeatLeaderboard
                  polar={trendPolarData}
                  activeTrendName={activeTrendHighlight}
                  className="max-h-[min(38vh,340px)] lg:max-h-none lg:h-full lg:min-h-0 lg:w-[min(100%,320px)] lg:shrink-0"
                />
                <div className="flex-1 min-h-0 min-w-0 flex flex-col min-h-[240px] lg:min-h-0">
                  <TrendRadarChart
                    polar={trendPolarData}
                    activeTrendName={activeTrendHighlight}
                    speechPulse={speechPulse}
                    voice={{
                      audioAnalyzerRef,
                      isPlayingTTS,
                      progressNorm: radarVoiceBonding.progressNorm,
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
              {trendsError && (
                <p className="text-[10px] text-red-400/90 mt-1 px-1 shrink-0">{trendsError}</p>
              )}
              {trendsFetchedAt && !trendsError && (
                <p className="text-[9px] text-zinc-600 mt-0.5 px-1 font-mono shrink-0">
                  Updated{" "}
                  {new Date(trendsFetchedAt).toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: true,
                  })}
                </p>
              )}
            </div>

            {winningTrend && (
              <div className="mx-2 mb-2 px-3 py-2 rounded-lg bg-fuchsia-500/20 border border-fuchsia-500/40 text-fuchsia-100 text-xs font-semibold text-center">
                Vote winner: {winningTrend}
              </div>
            )}

            <div className="shrink-0 px-3 py-2 border-y border-white/5 space-y-1.5 bg-black/20">
              <p className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider">
                Chat votes · !vote 1–{Math.min(20, liveTrendsDeduped.length) || "N"} · !pick name
              </p>
              <div className="flex flex-wrap gap-1.5">
                {top3Votes.length === 0 ? (
                  <span className="text-[10px] text-zinc-500">No votes yet</span>
                ) : (
                  top3Votes.map(([name, n]) => (
                    <span
                      key={name}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-200 border border-cyan-500/25 truncate max-w-[160px]"
                      title={name}
                    >
                      {name.length > 22 ? `${name.slice(0, 20)}…` : name} · {n}
                    </span>
                  ))
                )}
              </div>
              {voteLeader && (
                <p className="text-[11px] text-cyan-400/90">
                  Leading:{" "}
                  <span className="font-semibold text-white">{voteLeader}</span>{" "}
                  <span className="text-zinc-500">
                    (goal {voteGoal} to crown)
                  </span>
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

        {/* Chat panel - fixed width, full height, glass + gradient accent */}
        <div className="w-full sm:w-[320px] lg:w-[380px] flex-shrink-0 flex flex-col bg-black/20 backdrop-blur-xl overflow-hidden relative">
          <div className="absolute left-0 top-0 bottom-0 w-px bg-gradient-to-b from-cyan-500/30 via-fuchsia-500/20 to-cyan-500/20 pointer-events-none" aria-hidden />
          <div className="p-3 sm:p-4 border-b border-white/5 flex items-center justify-between flex-shrink-0">
            <h2 className="text-sm font-bold flex items-center gap-2 text-white">
              <MessageSquare className="w-4 h-4 text-cyan-400" />
              Live Chat
            </h2>
            <span className="text-[10px] font-mono text-cyan-300/80 bg-white/5 px-2 py-0.5 rounded-full">
              {messages.length}
            </span>
          </div>
          <div className="px-3 py-1.5 border-b border-white/5 bg-white/[0.02] shrink-0">
            <p className="text-[9px] text-zinc-500 leading-snug">
              Vote for launch themes:{" "}
              <span className="text-cyan-400/90 font-mono">!vote 1</span> or{" "}
              <span className="text-cyan-400/90 font-mono">!pick partial-name</span>
            </p>
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
                    
                    return (
                      <React.Fragment key={msg.id || i}>
                        <motion.div
                          initial={false}
                          animate={{ opacity: 1, x: 0, scale: 1 }}
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
