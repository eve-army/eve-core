"use client";

import React, { useState, useEffect, useRef } from "react";
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

const NUM_BARS = 192;
const INNER_RADIUS_BASE = 42;
const MAX_BAR_LENGTH_BASE = 58;
const BAR_WIDTH_BASE = 1.6;
const OUTER_RING_OFFSET = 0.5;
const MID_RING_OFFSET = 0.25;
const NUM_PARTICLES = 52;
const VISUALIZER_SIZE = 560;

const SMOOTHING = 0.55; // temporal smoothing: higher = smoother, less jitter
const SPEECH_DECAY = 0.92; // when speech ends, level decays per frame (smooth fade-out)
const BAR_DECAY = 0.88; // when speech ends, bar levels decay toward wave per frame

function BondingCurveVisualizer({
  bondingCurveData,
  isBondedToken,
  currentMcSol,
  solUsdPrice,
  isPlayingTTS,
  audioAnalyzerRef,
  priceHistory,
}: {
  bondingCurveData: any;
  isBondedToken: boolean;
  currentMcSol: number | null;
  solUsdPrice: number | null;
  isPlayingTTS: boolean;
  audioAnalyzerRef: React.MutableRefObject<{ analyser: AnalyserNode; data: Uint8Array } | null>;
  priceHistory: { timestamp: number; mcSol: number }[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevBarLevelsRef = useRef<Float32Array | null>(null);
  const prevSpeechLevelRef = useRef<number>(0);
  const progress = isBondedToken ? 100 : getBondingProgressPercent(bondingCurveData);
  const solInCurve = getSolInCurve(bondingCurveData);
  const isComplete = isBondedToken || !!bondingCurveData?.complete;
  const hasData = isBondedToken || (progress !== null && solInCurve !== null);

  const progressNorm = hasData ? progress! / 100 : 0;
  const size = VISUALIZER_SIZE;
  const scale = size / 340;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frameId: number;
    let startTime = performance.now();

    const draw = () => {
      const t = (performance.now() - startTime) * 0.001;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;

      const INNER_RADIUS = INNER_RADIUS_BASE * scale;
      const MAX_BAR_LENGTH = MAX_BAR_LENGTH_BASE * scale;
      const BAR_WIDTH = BAR_WIDTH_BASE * scale;
      const midRingRadius = INNER_RADIUS + MAX_BAR_LENGTH * 0.45;
      const outerRingRadius = INNER_RADIUS + MAX_BAR_LENGTH + 8;

      ctx.clearRect(0, 0, w, h);

      // Real-time audio: get frequency data, symmetric mapping, temporal smoothing
      const analyzer = audioAnalyzerRef.current;
      const speed = isPlayingTTS ? 3.5 : 1.3;
      let speechLevel = 0;
      const barAudioLevels = new Float32Array(NUM_BARS);
      const AUDIO_GAIN = 2.2;
      if (analyzer) {
        analyzer.analyser.getByteFrequencyData(analyzer.data as any);
        const freq = analyzer.data;
        let sum = 0;
        for (let j = 0; j < freq.length; j++) sum += freq[j];
        const rawSpeech = Math.min(1, (sum / (freq.length * 255)) * 1.8);
        speechLevel = prevSpeechLevelRef.current * SMOOTHING + rawSpeech * (1 - SMOOTHING);
        prevSpeechLevelRef.current = speechLevel;
        for (let i = 0; i < NUM_BARS; i++) {
          const pos = i / NUM_BARS;
          const spectrumT = pos <= 0.5 ? pos * 2 : (1 - pos) * 2;
          const binExact = spectrumT * (freq.length - 1);
          const binIndex = Math.floor(binExact);
          const nextBin = Math.min(binIndex + 1, freq.length - 1);
          const frac = binExact - binIndex;
          const v = freq[binIndex] * (1 - frac) + freq[nextBin] * frac;
          const raw = Math.min(1, (v / 255) * AUDIO_GAIN);
          barAudioLevels[i] = prevBarLevelsRef.current
            ? prevBarLevelsRef.current[i] * SMOOTHING + raw * (1 - SMOOTHING)
            : raw;
        }
        prevBarLevelsRef.current = barAudioLevels.slice();
      } else {
        // Smooth fade-out: decay speech level and morph bars toward wave
        speechLevel = prevSpeechLevelRef.current * SPEECH_DECAY;
        prevSpeechLevelRef.current = speechLevel;
        for (let i = 0; i < NUM_BARS; i++) {
          const wave1 = Math.sin(t * speed * 2 + i * 0.32) * 0.5 + 0.5;
          const wave2 = Math.sin(t * speed * 1.4 + i * 0.18) * 0.4 + 0.5;
          const wave3 = Math.sin(t * speed * 3.2 + i * 0.48) * 0.35 + 0.5;
          const wave4 = Math.sin(t * speed * 0.9 + i * 0.25) * 0.25 + 0.5;
          const wave = (wave1 + wave2 + wave3 + wave4) / 4;
          barAudioLevels[i] = prevBarLevelsRef.current
            ? prevBarLevelsRef.current[i] * BAR_DECAY + wave * (1 - BAR_DECAY)
            : wave;
        }
        prevBarLevelsRef.current = barAudioLevels.slice();
      }

      const baseLevel = progressNorm * 0.88 + 0.06;
      const ttsBoost = speechLevel * 1.8;

      // ---- 1) TTS burst rings (scaled) - fade with speechLevel ----
      if (speechLevel > 0.015) {
        for (let b = 0; b < 5; b++) {
          const phase = (t * 2.8 + b * 0.2) % 1;
          const r = (22 + phase * 100) * scale;
          const alpha = (1 - phase) * 0.7 * Math.min(1, speechLevel * 1.5);
          ctx.strokeStyle = `rgba(0, 245, 255, ${alpha})`;
          ctx.lineWidth = Math.max(2, 3 * scale);
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // ---- 2) Orbiting particles (scaled, more of them) ----
      for (let p = 0; p < NUM_PARTICLES; p++) {
        const orbitAngle = t * 0.8 + p * 0.22 + (p % 3) * 0.7;
        const orbitRadius = (18 + (p % 5) * 12 + progressNorm * 10) * scale;
        const px = cx + Math.cos(orbitAngle) * orbitRadius;
        const py = cy + Math.sin(orbitAngle) * orbitRadius;
        const pulse = 0.5 + 0.5 * Math.sin(t * 4 + p * 0.5);
        const speechBoost = 0.2 + speechLevel * 1.1;
        const particleAlpha = Math.min(1, (0.3 + progressNorm * 0.3 + speechBoost) * pulse);
        const particleSize = (1.4 + (p % 2) * 0.6 + speechLevel * 1.6) * scale;
        const hueP = (260 + progressNorm * 80 + p * 3) % 360;
        ctx.fillStyle = `hsla(${hueP}, 90%, 75%, ${particleAlpha})`;
        ctx.beginPath();
        ctx.arc(px, py, particleSize, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- 3) Center radar sweep ----
      const sweepAngle = (t * 0.6) % (Math.PI * 2);
      const sweepWidth = 0.22 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, INNER_RADIUS + 6, sweepAngle, sweepAngle + sweepWidth);
      ctx.closePath();
      const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, INNER_RADIUS + 6);
      sweepGrad.addColorStop(0, "rgba(0, 245, 255, 0.25)");
      sweepGrad.addColorStop(0.6, "rgba(180, 0, 255, 0.06)");
      sweepGrad.addColorStop(1, "rgba(0, 245, 255, 0)");
      ctx.fillStyle = sweepGrad;
      ctx.fill();

      // ---- 4) Bar rings: always use barAudioLevels (smooth transition speech ↔ wave) ----
      const hue = (238 + progressNorm * 100 + (speechLevel > 0.05 ? Math.sin(t * 2.5) * 35 : 0)) % 360;
      const sat = 92;
      const drawBar = (
        fromX: number, fromY: number, toX: number, toY: number,
        alpha: number, glowWidth: number, lightMod: number
      ) => {
        const light = 52 + lightMod;
        const g = ctx.createLinearGradient(fromX, fromY, toX, toY);
        g.addColorStop(0, `hsla(${hue}, ${sat}%, ${light}%, ${alpha * 0.5})`);
        g.addColorStop(0.4, `hsla(${hue}, ${sat}%, 72%, ${alpha})`);
        g.addColorStop(0.8, `hsla(${(hue + 55) % 360}, ${sat}%, 80%, ${alpha})`);
        g.addColorStop(1, `hsla(${(hue + 70) % 360}, ${sat}%, 85%, ${alpha * 0.9})`);
        ctx.strokeStyle = `hsla(${hue}, ${sat}%, 78%, ${alpha * 0.35})`;
        ctx.lineWidth = BAR_WIDTH + glowWidth;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        ctx.strokeStyle = g;
        ctx.lineWidth = BAR_WIDTH;
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
      };

      for (let i = 0; i < NUM_BARS; i++) {
        const angle = (i / NUM_BARS) * Math.PI * 2 - Math.PI / 2;
        const angleMid = angle + MID_RING_OFFSET * (Math.PI * 2 / NUM_BARS);
        const angleOuter = angle + OUTER_RING_OFFSET * (Math.PI * 2 / NUM_BARS);

        const wave1 = Math.sin(t * speed * 2 + i * 0.32) * 0.5 + 0.5;
        const wave2 = Math.sin(t * speed * 1.4 + i * 0.18) * 0.4 + 0.5;
        const wave3 = Math.sin(t * speed * 3.2 + i * 0.48) * 0.35 + 0.5;
        const wave4 = Math.sin(t * speed * 0.9 + i * 0.25) * 0.25 + 0.5;
        const wave = (wave1 + wave2 + wave3 + wave4) / 4;
        const audioNorm = barAudioLevels[i];
        const barBlend = 0.12 * wave + 0.88 * audioNorm;
        const barLength = (baseLevel + barBlend * 0.85 + ttsBoost * 0.55) * MAX_BAR_LENGTH;
        const barLengthClamped = Math.max(2, Math.min(MAX_BAR_LENGTH, barLength));

        const waveM1 = Math.sin(t * speed * 2.1 + i * 0.33 + 0.9) * 0.5 + 0.5;
        const waveM2 = Math.sin(t * speed * 1.35 + i * 0.19) * 0.4 + 0.5;
        const waveM = (waveM1 + waveM2) / 2;
        const midAudio = (barAudioLevels[i] + barAudioLevels[(i + 1) % NUM_BARS]) / 2;
        const midBlend = 0.1 * waveM + 0.9 * midAudio;
        const midLen = (baseLevel * 0.8 + midBlend * 0.8 + ttsBoost * 0.5) * (MAX_BAR_LENGTH * 0.55);
        const midLenClamped = Math.max(2, Math.min(MAX_BAR_LENGTH * 0.55, midLen));

        const waveO1 = Math.sin(t * speed * 2.3 + i * 0.35 + 1.5) * 0.5 + 0.5;
        const waveO2 = Math.sin(t * speed * 1.15 + i * 0.21 + 0.8) * 0.4 + 0.5;
        const waveO = (waveO1 + waveO2) / 2;
        const outerBlend = 0.1 * waveO + 0.9 * barAudioLevels[(i + 2) % NUM_BARS];
        const outerBarMax = 24 * scale;
        const barLengthOuter = (baseLevel * 0.6 + outerBlend * 0.75 + ttsBoost * 0.5) * outerBarMax;
        const barLengthOuterClamped = Math.max(2, Math.min(outerBarMax, barLengthOuter));

        const lightMod = audioNorm * 35;

        const innerX = cx + Math.cos(angle) * INNER_RADIUS;
        const innerY = cy + Math.sin(angle) * INNER_RADIUS;
        const outerX = cx + Math.cos(angle) * (INNER_RADIUS + barLengthClamped);
        const outerY = cy + Math.sin(angle) * (INNER_RADIUS + barLengthClamped);
        drawBar(innerX, innerY, outerX, outerY, 1, 10, lightMod);

        const midStartX = cx + Math.cos(angleMid) * midRingRadius;
        const midStartY = cy + Math.sin(angleMid) * midRingRadius;
        const midEndX = cx + Math.cos(angleMid) * (midRingRadius + midLenClamped);
        const midEndY = cy + Math.sin(angleMid) * (midRingRadius + midLenClamped);
        drawBar(midStartX, midStartY, midEndX, midEndY, 0.88, 7, lightMod * 0.9);

        const outerStartX = cx + Math.cos(angleOuter) * outerRingRadius;
        const outerStartY = cy + Math.sin(angleOuter) * outerRingRadius;
        const outerEndX = cx + Math.cos(angleOuter) * (outerRingRadius + barLengthOuterClamped);
        const outerEndY = cy + Math.sin(angleOuter) * (outerRingRadius + barLengthOuterClamped);
        drawBar(outerStartX, outerStartY, outerEndX, outerEndY, 0.78, 6, lightMod * 0.8);
      }

      // ---- 5) Inner core glow: much brighter with speech ----
      const circleGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, INNER_RADIUS + 22);
      circleGrad.addColorStop(0, `rgba(0, 245, 255, ${0.12 + speechLevel * 0.5})`);
      circleGrad.addColorStop(0.5, `rgba(160, 0, 255, ${0.04 + speechLevel * 0.12})`);
      circleGrad.addColorStop(1, "rgba(0, 245, 255, 0)");
      ctx.fillStyle = circleGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, INNER_RADIUS + 28, 0, Math.PI * 2);
      ctx.fill();

      // ---- 6) Outer halo (scaled) - fade with speechLevel ----
      if (speechLevel > 0.01) {
        const haloAlpha = 0.08 + 0.22 * speechLevel * (0.8 + 0.4 * Math.sin(t * 5));
        ctx.strokeStyle = `rgba(0, 245, 255, ${Math.min(1, haloAlpha)})`;
        ctx.lineWidth = Math.max(3, 4 * scale);
        ctx.beginPath();
        ctx.arc(cx, cy, 132 * scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ---- 7) Rotating dashed "energy" ring for extra motion ----
      const dashAngle = (t * 0.4) % (Math.PI * 2);
      ctx.strokeStyle = `rgba(0, 245, 255, ${0.06 + 0.04 * Math.sin(t * 2)})`;
      ctx.lineWidth = 1.5 * scale;
      ctx.setLineDash([4 * scale, 8 * scale]);
      ctx.beginPath();
      ctx.arc(cx, cy, outerRingRadius + 15 * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      frameId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(frameId);
  }, [progressNorm, isPlayingTTS, isComplete, audioAnalyzerRef]);

  return (
    <div className="relative mb-8 flex flex-col items-center">
      <div
        className="relative rounded-full overflow-visible transition-all duration-500"
        style={{
          width: size,
          height: size,
          filter: isPlayingTTS
            ? "drop-shadow(0 0 45px rgba(0,245,255,0.5)) drop-shadow(0 0 90px rgba(180,0,255,0.2))"
            : "drop-shadow(0 0 32px rgba(160,0,255,0.3)) drop-shadow(0 0 60px rgba(0,200,255,0.1))",
          transform: isPlayingTTS ? "scale(1.02)" : "scale(1)",
        }}
      >
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          className="block w-full h-full rounded-full"
          style={{ background: "transparent" }}
        />
        {/* Center overlay: dark only in center so bars show at edges */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none rounded-full"
          style={{
            background: "radial-gradient(circle at center, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.4) 28%, transparent 55%)",
            width: size,
            height: size,
            top: 0,
            left: 0,
          }}
        >
          {(!hasData && !currentMcSol) ? (
            <p className="text-sm text-cyan-400/80 text-center px-4 font-medium">Connect a token</p>
          ) : (
            <>
              {hasData && progressNorm < 1 && bondingCurveData?.realTokenReserves != null && (
                <>
                  <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Pending</span>
                  <span className="text-[1.75rem] sm:text-3xl font-black tabular-nums text-transparent bg-clip-text bg-gradient-to-b from-cyan-300 to-fuchsia-400">
                    {(() => {
                      const currentTokens = BigInt(bondingCurveData.realTokenReserves);
                      const initialTokens = BigInt("793100000000000");
                      return `${(Number((currentTokens * BigInt("10000")) / initialTokens) / 100).toFixed(1)}%`;
                    })()}
                  </span>
                </>
              )}
              {isBondedToken && (
                <span className="text-xs sm:text-sm font-mono text-cyan-400 uppercase tracking-wider font-bold mb-1">Bonded on Raydium</span>
              )}
              {currentMcSol !== null && currentMcSol > 0 && (
                <>
                  <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mt-2">Market Cap</span>
                  <div className="flex flex-col items-center leading-tight mt-1">
                    <span className="text-xs sm:text-sm font-bold tabular-nums text-white">
                      {currentMcSol.toFixed(2)} SOL
                    </span>
                    {solUsdPrice && (
                      <span className="text-[10px] sm:text-[11px] font-mono tabular-nums text-green-400 mt-0.5">
                        ${(currentMcSol * solUsdPrice).toLocaleString('en-US', {maximumFractionDigits:0})}
                      </span>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PumpfunChatPage() {
  const [addressInput, setAddressInput] = useState("");
  const [username, setUsername] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  // AI Agent state
  const [isPlayingTTS, setIsPlayingTTS] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [aiResponseText, setAiResponseText] = useState<string | null>(null);
  const [hfStatus, setHfStatus] = useState<{stage: string, position?: number, eta?: number} | null>(null);
  const [bondingCurveData, setBondingCurveData] = useState<any>(null);
  const [isBondedToken, setIsBondedToken] = useState<boolean>(false);
  const [solUsdPrice, setSolUsdPrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<{ timestamp: number; mcSol: number }[]>([]);
  const [historicalPriceData, setHistoricalPriceData] = useState<any>(null);
  
  // Stream Info State (Manual Entry)
  const [streamName, setStreamName] = useState("");
  const [streamSymbol, setStreamSymbol] = useState("");
  
  // Voice Models State
  const [customVoices, setCustomVoices] = useState<{name: string, id: string}[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("elevenlabs_default");
  const [isLoadingVoices, setIsLoadingVoices] = useState<boolean>(true);
  
  const [showAddVoice, setShowAddVoice] = useState(false);
  const [newVoiceName, setNewVoiceName] = useState("");
  const [newVoiceUrl, setNewVoiceUrl] = useState("");
  const [isAddingVoice, setIsAddingVoice] = useState(false);

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
  
  // Track last played timestamp to avoid replaying the same broadcast
  const lastPlayedTimestampRef = useRef<number>(0);

  // Web Audio API: analyser + frequency data for speech-synced visualizer
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioAnalyzerRef = useRef<{ analyser: AnalyserNode; data: Uint8Array } | null>(null);

  const clientRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
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
  const stateRefs = useRef({ messages, messageStatuses, isPlayingTTS, bondingCurveData, priceHistory, streamName, isBondedToken, solUsdPrice, historicalPriceData });
  useEffect(() => {
    stateRefs.current = { messages, messageStatuses, isPlayingTTS, bondingCurveData, priceHistory, streamName, isBondedToken, solUsdPrice, historicalPriceData };
  }, [messages, messageStatuses, isPlayingTTS, bondingCurveData, priceHistory, streamName, isBondedToken, solUsdPrice, historicalPriceData]);

  // Fetch Sol USD Price
  useEffect(() => {
    const fetchSolPrice = async () => {
      try {
        // Jupiter v2 requires API keys for some origins now. Using Coingecko as a reliable alternative for simple price checks.
        const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
        if (res.ok) {
           const data = await res.json();
           const price = data.solana?.usd;
           if (price) {
             setSolUsdPrice(parseFloat(price));
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
        const url = `/api/agent/moralis?tokenAddress=${currentTokenAddress}`; 
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
               // Token has bonded or doesn't have pump curve data, fetch from DexScreener
               try {
                 const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${currentTokenAddress}`);
                 if (dexRes.ok) {
                   const dexData = await dexRes.json();
                   if (dexData.pairs && dexData.pairs.length > 0) {
                     // Raydium pair for memecoins is usually first
                     const pair = dexData.pairs.find((p: any) => p.dexId === 'raydium') || dexData.pairs[0];
                     if (pair && pair.priceNative) {
                       mcSol = parseFloat(pair.priceNative) * 1_000_000_000;
                     }
                   }
                 }
               } catch (e) {
                 console.error("Dexscreener fetch error:", e);
               }
               setIsBondedToken(true);
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

  const triggerAgent = async (msgToProcess: IMessage) => {
    if (stateRefs.current.isPlayingTTS) return;
    
    setActiveMessageId(msgToProcess.id);
    setIsPlayingTTS(true);
    setAiResponseText(null);
    setHfStatus(null);

    try {
      setMessageStatuses(prev => ({ ...prev, [msgToProcess.id]: 'processing' }));

      let change1m = null;
      let change5m = null;
      const history = stateRefs.current.priceHistory;
      if (history && history.length > 0) {
        const currentPrice = history[history.length - 1].mcSol;
        const now = Date.now();
        
        // Find price closest to 1 min ago
        const oneMinAgo = now - 60 * 1000;
        const price1mRaw = history.reduce((prev, curr) => Math.abs(curr.timestamp - oneMinAgo) < Math.abs(prev.timestamp - oneMinAgo) ? curr : prev);
        if (now - price1mRaw.timestamp > 30 * 1000) { // Should be at least 30s away
          change1m = ((currentPrice - price1mRaw.mcSol) / price1mRaw.mcSol) * 100;
        }

        // Find price closest to 5 mins ago
        const fiveMinAgo = now - 5 * 60 * 1000;
        const price5mRaw = history.reduce((prev, curr) => Math.abs(curr.timestamp - fiveMinAgo) < Math.abs(prev.timestamp - fiveMinAgo) ? curr : prev);
        if (now - price5mRaw.timestamp > 3 * 60 * 1000) { // Should be at least 3m away
          change5m = ((currentPrice - price5mRaw.mcSol) / price5mRaw.mcSol) * 100;
        }
      }

      const useHF = selectedVoice !== "elevenlabs_default";

      const res = await fetch('/api/agent/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msgToProcess.message,
          username: msgToProcess.username,
          bondingCurveData: stateRefs.current.bondingCurveData,
          priceChanges: { change1m, change5m, currentMcSol: history.length > 0 ? history[history.length - 1].mcSol : null },
          historicalPriceData: stateRefs.current.historicalPriceData,
          streamName: stateRefs.current.streamName,
          isBondedToken: stateRefs.current.isBondedToken,
          solUsdPrice: stateRefs.current.solUsdPrice,
          skipTTS: useHF
        }),
      });

      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }

      const data = await res.json();
      setAiResponseText(data.text);
      setAiReplies(prev => ({ ...prev, [msgToProcess.id]: data.text }));
      
      let audioUrl = data.audio;
      if (useHF && data.text) {
         try {
           audioUrl = await generateHuggingFaceTts(
             data.text,
             selectedVoice,
             "en-US-ChristopherNeural",
             (status) => {
               setHfStatus(status);
             }
           );
         } catch (err) {
           console.error("HF TTS Error", err);
         } finally {
            setHfStatus(null);
         }
      }

      if (audioUrl) {
        // Play through Web Audio API so visualizer can read real-time frequency data
        try {
          const ctx = audioContextRef.current ?? new (window.AudioContext || (window as any).webkitAudioContext)();
          if (!audioContextRef.current) audioContextRef.current = ctx;
          if (ctx.state === "suspended") await ctx.resume();

          const res = await fetch(audioUrl);
          const arrayBuffer = await res.arrayBuffer();
          const buffer = await ctx.decodeAudioData(arrayBuffer);

          const source = ctx.createBufferSource();
          source.buffer = buffer;

          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.7;
          analyser.minDecibels = -75;
          analyser.maxDecibels = -5;

          source.connect(analyser);
          analyser.connect(ctx.destination);

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          audioAnalyzerRef.current = { analyser, data: dataArray };

          source.start(0);
          source.onended = () => {
            audioAnalyzerRef.current = null;
            setIsPlayingTTS(false);
            setActiveMessageId(null);
            setAiResponseText(null);
            setHfStatus(null);
          };
          setMessageStatuses(prev => ({ ...prev, [msgToProcess.id]: 'answered' }));
        } catch (err) {
          console.warn("Web Audio playback failed, falling back to HTML Audio", err);
          audioAnalyzerRef.current = null;
          const audio = new Audio(audioUrl);
          audio.onended = () => {
            setIsPlayingTTS(false);
            setActiveMessageId(null);
            setAiResponseText(null);
            setHfStatus(null);
          };
          await audio.play();
          setMessageStatuses(prev => ({ ...prev, [msgToProcess.id]: 'answered' }));
        }
      } else {
        // Fallback if no audio was generated
        setTimeout(() => {
          setIsPlayingTTS(false);
          setActiveMessageId(null);
          setAiResponseText(null);
          setHfStatus(null);
        }, 6000);
        setMessageStatuses(prev => ({ ...prev, [msgToProcess.id]: 'answered' }));
      }
    } catch (error) {
      console.error("Agent interaction failed", error);
      // Mark as answered or error so the UI can move on from the loading state
      setMessageStatuses(prev => ({ ...prev, [msgToProcess.id]: 'answered' }));
      
      // If we had text but audio failed, we should still show the text for a bit
      setTimeout(() => {
         setIsPlayingTTS(false);
         setActiveMessageId(null);
         setAiResponseText(null);
         setHfStatus(null);
      }, 3000);
    }
  };

  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(async () => {
      const { messages: currentMessages, messageStatuses: currentStatuses, isPlayingTTS: currentPlayingTTS } = stateRefs.current;

      if (currentPlayingTTS) return; // Don't interrupt if already processing
      if (currentMessages.length === 0) return;
      
      // Look for recent messages (only the last 2 to prevent answering old backlog)
      const recentMessages = currentMessages.slice(-2);
      
      // Filter out messages that are already processing/answered, or too short/junk
      const validMessages = recentMessages.filter(msg => {
        const isHandled = currentStatuses[msg.id];
        const isTooShort = msg.message.trim().length <= 3;
        // Basic junk filters (can be expanded later)
        const isJunk = /^(lfg|gm|gn|wow|lol|lmao)$/i.test(msg.message.trim());
        
        return !isHandled && !isTooShort && !isJunk;
      });

      if (validMessages.length > 0) {
        // ALWAYS pick the LAST valid message instead of a random one
        const msgToProcess = validMessages[validMessages.length - 1];
        triggerAgent(msgToProcess);
      }
    }, 1000); // Check every 1 second to make response immediate

    return () => clearInterval(interval);
  }, [isConnected]);

  // Auto-scroll to the bottom of the chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, aiReplies]);

  const handleConnect = async (isReconnect = false) => {
    // Unlock Audio Context on user interaction to prevent Autoplay blocks
    try {
      const unlockAudio = new Audio("data:audio/mp3;base64,//OwgAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA//////////////////////////////////////////////////////////////////8AAABhTEFNRTMuMTAwA8EAAAAAAAAAABRAJAICAQAAwYAAAnGQb1MAAAAAAAAAAAAAAAAAAAAA");
      unlockAudio.volume = 0.01;
      unlockAudio.play().catch(e => console.warn("Audio unlock failed:", e));
    } catch(e) {}

    if (!addressInput.trim()) {
      setError("Please enter a token address or URL");
      return;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    try {
      setIsConnecting(true);
      setError(null);
      // Only clear messages if we are not actively attempting to reconnect (i.e. if it's a fresh manual connection)
      // Since handleConnect clears history, we should avoid wiping during auto-reconnect, but for now it's fine
      // because `messages` are already wiped on fresh start. Wait, doing this will wipe the UI every time it reconnects!
      // Let's only clear messages if we are NOT currently marked as connecting. Wait, handleConnect always runs setIsConnecting(true) first.
      // We can just omit clearing messages here globally, let the user manually clear or just let SSE historical merge handle it.
      // Actually, pumpchat server sends messageHistory on connect. Wiping is fine since history repopulates.
      
      if (!isReconnect) {
        setMessages([]);
        // Optional: you could clear manual metadata here, but likely user wants to keep it
        // setStreamName("");
        // setStreamSymbol("");
        // setStreamDescription("");
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

      client.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'connected') {
            setIsConnected(true);
            setIsConnecting(false);
            setError(null);
          } else if (parsed.type === 'messageHistory') {
            setMessages((prev) => {
              if (!isReconnect || prev.length === 0) return parsed.data || [];
              const existingIds = new Set(prev.map(m => m.id));
              const newHistoryMessages = (parsed.data || []).filter((m: any) => m.id && !existingIds.has(m.id));
              const combined = [...prev, ...newHistoryMessages];
              if (combined.length > 100) return combined.slice(-100);
              return combined;
            });
            // Allowed historical messages to be picked up by AI analysis
          } else if (parsed.type === 'message') {
            setMessages((prev) => {
              // Avoid duplicates if SSE reconnects and sends history
              if (parsed.data.id && prev.some(m => m.id === parsed.data.id)) return prev;
              const newMessages = [...prev, parsed.data];
              if (newMessages.length > 100) return newMessages.slice(-100);
              return newMessages;
            });
          } else if (parsed.type === 'error') {
            console.error("Chat error:", parsed.data);
            setError(`Connection error: ${parsed.data}. Reconnecting in 3s...`);
            setIsConnected(false);
            setIsConnecting(true);
            client.close();
            reconnectTimeoutRef.current = setTimeout(() => {
              handleConnect(true);
            }, 3000);
          } else if (parsed.type === 'disconnected') {
            setIsConnected(false);
            setIsConnecting(true); // Indicate reconnecting
            setError("Server disconnected. Reconnecting in 3s...");
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
        console.error("SSE Error:", err);
        setError("Lost connection to chat server. Reconnecting in 3s...");
        setIsConnected(false);
        setIsConnecting(true);
        client.close();
        reconnectTimeoutRef.current = setTimeout(() => {
           handleConnect(true);
        }, 3000);
      };

      clientRef.current = client;
    } catch (err: any) {
      setError(err.message || "Failed to initialize client");
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    if (clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    audioAnalyzerRef.current = null;
    setIsConnected(false);
    setIsConnecting(false);
    setMessages([]);
    setIsPlayingTTS(false);
    setActiveMessageId(null);
    setAiResponseText(null);
    setStreamName("");
    setStreamSymbol("");
    setIsBondedToken(false);
    setPriceHistory([]);
    setHistoricalPriceData(null);
    // messageStatuses and aiReplies intentionally kept to persist data
  };

  return (
    <div className="h-screen bg-[#050508] text-white flex flex-col font-sans selection:bg-cyan-500/30 overflow-hidden">
      {/* Full-bleed background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-0 left-0 right-0 h-[50%] bg-gradient-to-b from-cyan-950/25 via-transparent to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-[50%] bg-gradient-to-t from-fuchsia-950/20 via-transparent to-transparent" />
        <div className="absolute top-[-15%] left-[-5%] w-[50%] h-[50%] bg-cyan-600/15 blur-[140px] rounded-full" />
        <div className="absolute bottom-[-15%] right-[-5%] w-[50%] h-[50%] bg-fuchsia-600/15 blur-[140px] rounded-full" />
      </div>

      {/* Compact header: branding + connect inline, gradient accent line */}
      <header className="relative z-20 flex items-center justify-between gap-4 px-4 sm:px-6 lg:px-8 py-3 bg-black/30 backdrop-blur-xl">
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-500/40 to-fuchsia-500/40" aria-hidden />
        <div className="flex items-center gap-3 min-w-0">
          <img src="/clawk.png" alt="EVE" className="w-10 h-10 rounded-xl object-contain bg-white/5 flex-shrink-0 ring-1 ring-white/10 shadow-sm" />
          <h1 className="text-xl sm:text-2xl font-black tracking-tight truncate">
            <span className="bg-gradient-to-r from-white via-white to-gray-400 bg-clip-text text-transparent">EVE</span>
            <span className="text-cyan-400 ml-1.5 font-semibold">Pump Assistant</span>
          </h1>
        </div>
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
          {!isConnected ? (
            <button
              onClick={() => handleConnect(false)}
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
      {error && (
        <div className="hidden sm:block relative z-10 px-6 py-2">
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
          {/* Overlay bar: token name and ticker only (Pending % and MC moved to visualizer center) */}
          <div className="relative z-10 flex items-center gap-4 px-4 sm:px-6 lg:px-8 py-3 flex-wrap">
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

          {/* Visualizer + status - centered, fills space */}
          <div className="flex-1 flex flex-col items-center justify-center relative z-10 px-4 py-6 min-h-0">
            {/* Mini price chart in top-right of center area */}
          {priceHistory.length > 1 && (
            <div className="absolute top-3 right-3 w-36 h-16 z-20 pointer-events-none">
              <p className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-0.5 text-right">MC (SOL)</p>
              <ResponsiveContainer width="100%" height="80%">
                <AreaChart data={priceHistory} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mcGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00f5ff" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#00f5ff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis domain={['auto', 'auto']} hide />
                  <Tooltip
                    contentStyle={{ background: 'rgba(0,0,0,0.7)', border: '1px solid #00f5ff33', borderRadius: 4, fontSize: 10, padding: '2px 6px' }}
                    itemStyle={{ color: '#00f5ff' }}
                    formatter={(v: any) => [`${Number(v).toFixed(3)} SOL`, '']}
                    labelFormatter={() => ''}
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
          )}
          <BondingCurveVisualizer
              bondingCurveData={bondingCurveData}
              isBondedToken={isBondedToken}
              currentMcSol={priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].mcSol : null}
              solUsdPrice={solUsdPrice}
              isPlayingTTS={isPlayingTTS}
              audioAnalyzerRef={audioAnalyzerRef}
              priceHistory={priceHistory}
            />
            <div className="h-20 flex flex-col items-center justify-center mt-2">
              <AnimatePresence mode="wait">
                {isPlayingTTS && activeMessageId ? (
                  <motion.div
                    key="speaking"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="text-center"
                  >
                    <p className="text-lg sm:text-xl font-medium flex items-center gap-2 justify-center bg-gradient-to-r from-white via-cyan-100 to-fuchsia-200 bg-clip-text text-transparent">
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping flex-shrink-0" />
                      {aiResponseText ? "Speaking…" : "Generating…"}
                    </p>
                    <p className="text-gray-400 text-sm max-w-md mx-auto mt-1 italic line-clamp-2">
                      "{messages.find(m => m.id === activeMessageId)?.message || "..."}"
                    </p>
                    {aiResponseText && (
                      <p className="text-cyan-200/90 text-sm sm:text-base max-w-md mx-auto mt-2 font-medium">
                        "{aiResponseText}"
                      </p>
                    )}
                    {hfStatus && (
                      <div className="flex items-center justify-center gap-2 mt-3 text-xs font-mono bg-fuchsia-900/30 text-fuchsia-200 border border-fuchsia-500/20 py-1.5 px-3 rounded-full mx-auto w-max max-w-full">
                         <Loader2 className="w-3 h-3 animate-spin text-fuchsia-400" />
                         {hfStatus.stage === "pending" && (
                           <span>Queued in HF Space... {hfStatus.position ? `Pos: ${hfStatus.position}` : ''}</span>
                         )}
                         {hfStatus.stage === "generating" && (
                           <span>Generating Voice... {hfStatus.eta ? `ETA: ${hfStatus.eta}s` : ''}</span>
                         )}
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.p
                    key="waiting"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-gray-500 text-base sm:text-lg animate-pulse"
                  >
                    {isConnected ? "Listening to chat…" : "Connect a token to start"}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
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
          <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {!isConnected && messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-600 gap-3 text-xs text-center p-6">
                  <Radio className="w-8 h-8 opacity-20" />
                  <p>Awaiting connection to token feed.</p>
                </div>
              ) : messages.length === 0 ? (
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
                  {messages.map((msg, i) => {
                    const isActive = msg.id === activeMessageId;
                    const isTooShort = msg.message.trim().length <= 3;
                    const replyText = aiReplies[msg.id];
                    
                    return (
                      <React.Fragment key={msg.id || i}>
                        <motion.div
                          initial={{ opacity: 0, x: -10, scale: 0.95 }}
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
                          initial={{ opacity: 0, y: -5 }}
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

      <AnimatePresence>
        {showAddVoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
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
