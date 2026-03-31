"use client";

import React, { useEffect, useRef, useCallback, useMemo } from "react";
import type { DedupedTrend } from "@/lib/live-trends";
import { normalizeTrendKey } from "@/lib/live-trends";
import type { MemecoinIdea } from "@/lib/memecoin-ideas";

// ── Constants ────────────────────────────────────────────────
const MAX_INPUT_NODES = 12;
const HIDDEN1_COUNT = 7;
const HIDDEN2_COUNT = 5;
const DPR_CAP = 2;

const COL_INPUT = 0.13;
const COL_H1 = 0.37;
const COL_H2 = 0.58;
const COL_OUTPUT = 0.80;

const ACCENT_CYAN = "#00f5ff";
const ACCENT_PINK = "#ff2d95";
const ACCENT_DIM = "rgba(0,245,255,0.08)";
const NODE_BG = "rgba(15,20,35,0.85)";
const TEXT_PRIMARY = "#e2e8f0";
const TEXT_MUTED = "#64748b";
const TICKER_COLOR = "#00f5ff";

// ── Hashing ──────────────────────────────────────────────────
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function hashTo01(s: string): number {
  return (hashStr(s) % 10000) / 10000;
}

// ── Layout helpers ───────────────────────────────────────────
type Vec2 = { x: number; y: number };

const LABEL_ZONE = 36; // px for column label text
const OUTPUT_TOP_PAD = 46; // extra top padding for output cards (below label)

function distributeY(h: number, count: number, bottomPadFrac: number): number[] {
  if (count <= 0) return [];
  const top = LABEL_ZONE;
  const bottom = h * bottomPadFrac;
  const usable = h - top - bottom;
  if (count === 1) return [top + usable / 2];
  return Array.from({ length: count }, (_, i) => top + (i / (count - 1)) * usable);
}

type LayoutResult = {
  inputs: Vec2[];
  hidden1: Vec2[];
  hidden2: Vec2[];
  outputs: Vec2[];
};

function distributeYOutput(h: number, count: number): number[] {
  if (count <= 0) return [];
  const top = LABEL_ZONE + OUTPUT_TOP_PAD;
  const bottom = 140; // reserve space for a full card height at bottom
  const usable = h - top - bottom;
  if (count === 1) return [top];
  return Array.from({ length: count }, (_, i) => top + (i / (count - 1)) * usable);
}

function computeLayout(w: number, h: number, inputCount: number, outputCount: number): LayoutResult {
  const iy = distributeY(h, inputCount, 0.06);
  const h1y = distributeY(h, HIDDEN1_COUNT, 0.1);
  const h2y = distributeY(h, HIDDEN2_COUNT, 0.14);
  const oy = distributeYOutput(h, Math.max(1, outputCount));
  return {
    inputs: iy.map((y) => ({ x: w * COL_INPUT, y })),
    hidden1: h1y.map((y) => ({ x: w * COL_H1, y })),
    hidden2: h2y.map((y) => ({ x: w * COL_H2, y })),
    outputs: oy.map((y) => ({ x: w * COL_OUTPUT, y })),
  };
}

// ── Connection routing (deterministic per-trend) ─────────────
function connectionsForTrend(trendIdx: number, trendName: string, h1Count: number, h2Count: number) {
  const h = hashStr(trendName);
  const h1a = h % h1Count;
  const h1b = (h + 3) % h1Count;
  const h2a = (h + 1) % h2Count;
  const h2b = (h + 4) % h2Count;
  return { h1Targets: [h1a, h1b], h2Targets: [h2a, h2b] };
}

// ── Bezier drawing ───────────────────────────────────────────
function drawBezier(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, alpha: number, color: string, width: number, dashOffset?: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dashOffset !== undefined) {
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = dashOffset;
  }
  ctx.beginPath();
  const cx = (from.x + to.x) / 2;
  ctx.moveTo(from.x, from.y);
  ctx.bezierCurveTo(cx, from.y, cx, to.y, to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function pointOnBezier(from: Vec2, to: Vec2, t: number): Vec2 {
  const cx = (from.x + to.x) / 2;
  const u = 1 - t;
  const x = u * u * u * from.x + 3 * u * u * t * cx + 3 * u * t * t * cx + t * t * t * to.x;
  const y = u * u * u * from.y + 3 * u * u * t * from.y + 3 * u * t * t * to.y + t * t * t * to.y;
  return { x, y };
}

// ── Pulse particle with motion trail ─────────────────────────
function drawPulse(ctx: CanvasRenderingContext2D, from: Vec2, to: Vec2, t: number, radius: number, color: string) {
  // Draw 4 trailing particles for motion blur effect
  for (let trail = 3; trail >= 0; trail--) {
    const tt = Math.max(0, t - trail * 0.03);
    const p = pointOnBezier(from, to, tt);
    const trailAlpha = 1 - trail * 0.25;
    const trailRadius = radius * (1 - trail * 0.15);
    ctx.save();
    ctx.globalAlpha = trailAlpha;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, trailRadius);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, trailRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── Word-wrap helper for canvas text ─────────────────────────
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [text];
}

// ── Component ────────────────────────────────────────────────
type LaunchPhase = "idle" | "selecting" | "countdown" | "deploying" | "success" | "failed";

type Props = {
  trends: DedupedTrend[];
  memecoins: MemecoinIdea[];
  activeTrendName: string | null;
  isProcessing: boolean;
  speechPulse: number;
  isPlayingTTS: boolean;
  audioAnalyzerRef: React.MutableRefObject<{ analyser: AnalyserNode; data: Uint8Array } | null>;
  variant: "default" | "stream";
  className?: string;
  launchPhase?: LaunchPhase;
  launchSelectedId?: string | null;
  launchCountdownSec?: number;
};

export default function NeuralNetCanvas({
  trends,
  memecoins,
  activeTrendName,
  isProcessing,
  speechPulse,
  isPlayingTTS,
  className = "",
  launchPhase = "idle",
  launchSelectedId = null,
  launchCountdownSec = 0,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ w: 800, h: 500 });
  const processingStartRef = useRef<number | null>(null);
  const imgCacheRef = useRef<Map<string, HTMLImageElement | null>>(new Map());

  const inputTrends = useMemo(
    () => trends.filter((t) => t.image_url).slice(0, MAX_INPUT_NODES),
    [trends],
  );

  const readyMemecoins = useMemo(
    () => memecoins.filter((m) => m.status !== "fading" && m.imageUrl).slice(-8),
    [memecoins],
  );

  // Preload all images (trend + memecoin) into cache
  useEffect(() => {
    const cache = imgCacheRef.current;
    const urls: (string | null | undefined)[] = [
      ...readyMemecoins.map((mc) => mc.imageUrl),
      ...inputTrends.map((t) => t.image_url),
    ];
    for (const url of urls) {
      if (!url || cache.has(url)) continue;
      cache.set(url, null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => cache.set(url, img);
      img.onerror = () => cache.set(url, null);
      img.src = url;
    }
  }, [readyMemecoins, inputTrends]);

  // Track processing start time for animation
  useEffect(() => {
    if (isProcessing && !processingStartRef.current) {
      processingStartRef.current = performance.now();
    }
    if (!isProcessing) {
      processingStartRef.current = null;
    }
  }, [isProcessing]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        sizeRef.current = { w: width, h: height };
        const canvas = canvasRef.current;
        if (canvas) {
          const dpr = Math.min(devicePixelRatio, DPR_CAP);
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animation loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(devicePixelRatio, DPR_CAP);
    const { w, h } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const t = performance.now() / 1000;
    const layout = computeLayout(w, h, inputTrends.length, readyMemecoins.length);
    const glowBoost = isPlayingTTS ? 0.15 + speechPulse * 0.3 : 0;

    // ── CONNECTIONS ──────────────────────────────────────────
    for (let i = 0; i < inputTrends.length; i++) {
      const trend = inputTrends[i];
      const from = layout.inputs[i];
      if (!from) continue;
      const conn = connectionsForTrend(i, trend.trend_name, HIDDEN1_COUNT, HIDDEN2_COUNT);
      const isActive = activeTrendName != null && normalizeTrendKey(trend.trend_name) === normalizeTrendKey(activeTrendName);
      const baseAlpha = isActive ? 0.25 + glowBoost : 0.06 + glowBoost * 0.3;
      const color = isActive ? ACCENT_CYAN : ACCENT_DIM;
      const lineW = isActive ? 1.5 : 0.7;

      // Input → Hidden1
      for (const h1i of conn.h1Targets) {
        const to = layout.hidden1[h1i];
        if (!to) continue;
        drawBezier(ctx, from, to, baseAlpha, color, lineW);

        // Processing pulse
        if (isProcessing) {
          const elapsed = processingStartRef.current ? (performance.now() - processingStartRef.current) / 1000 : 0;
          const pulseT = ((elapsed * 0.4 + hashTo01(trend.trend_name) * 0.5) % 1);
          drawPulse(ctx, from, to, pulseT, 4 + glowBoost * 3, ACCENT_CYAN);
        }

        // Hidden1 → Hidden2
        for (const h2i of conn.h2Targets) {
          const h2 = layout.hidden2[h2i];
          if (!h2) continue;
          drawBezier(ctx, to, h2, baseAlpha * 0.8, color, lineW * 0.8);

          if (isProcessing) {
            const elapsed = processingStartRef.current ? (performance.now() - processingStartRef.current) / 1000 : 0;
            const pulseT = ((elapsed * 0.35 + hashTo01(trend.trend_name) * 0.3 + 0.3) % 1);
            drawPulse(ctx, to, h2, pulseT, 3 + glowBoost * 2, ACCENT_CYAN);
          }

          // Hidden2 → matching output
          for (let oi = 0; oi < readyMemecoins.length; oi++) {
            const mc = readyMemecoins[oi];
            const outNode = layout.outputs[oi];
            if (!outNode) continue;
            const isMatch = mc.sourceTrends.some(
              (st) => normalizeTrendKey(st) === normalizeTrendKey(trend.trend_name),
            );
            if (isMatch) {
              drawBezier(ctx, h2, outNode, isActive ? 0.35 : 0.12, ACCENT_CYAN, isActive ? 2 : 0.8);
            }
          }
        }
      }
    }

    // Ensure every output node has at least one connection from hidden2
    for (let oi = 0; oi < readyMemecoins.length; oi++) {
      const mc = readyMemecoins[oi];
      const outNode = layout.outputs[oi];
      if (!outNode) continue;
      const hasInputMatch = inputTrends.some((trend) =>
        mc.sourceTrends.some((st) => normalizeTrendKey(st) === normalizeTrendKey(trend.trend_name)),
      );
      if (!hasInputMatch) {
        // No input trend matched — connect from a deterministic hidden2 node
        const h2i = hashStr(mc.id) % HIDDEN2_COUNT;
        const h2 = layout.hidden2[h2i];
        if (h2) {
          drawBezier(ctx, h2, outNode, 0.12 + glowBoost * 0.2, ACCENT_CYAN, 0.8);
          // Also connect a hidden1 node to that hidden2 node
          const h1i = hashStr(mc.id + "h1") % HIDDEN1_COUNT;
          const h1 = layout.hidden1[h1i];
          if (h1) {
            drawBezier(ctx, h1, h2, 0.08 + glowBoost * 0.1, ACCENT_DIM, 0.6);
          }
        }
      }
    }

    // Ambient hidden → hidden connections (animated dashes)
    for (let a = 0; a < HIDDEN1_COUNT; a++) {
      const from = layout.hidden1[a];
      if (!from) continue;
      const target = layout.hidden2[a % HIDDEN2_COUNT];
      if (!target) continue;
      drawBezier(ctx, from, target, 0.06 + glowBoost * 0.1, ACCENT_DIM, 0.5, -t * 20 + a * 10);
    }

    // ── INPUT NODES ──────────────────────────────────────────
    for (let i = 0; i < inputTrends.length; i++) {
      const trend = inputTrends[i];
      const pos = layout.inputs[i];
      if (!pos) continue;
      const isActive = activeTrendName != null && normalizeTrendKey(trend.trend_name) === normalizeTrendKey(activeTrendName);
      const heat = Math.min(trend.maxHeat, 10);
      const radius = 6 + heat * 1.8 + (isActive ? 4 : 0);
      const pulse = Math.sin(t * 2 + i * 0.7) * 0.15;

      const trendImg = trend.image_url ? imgCacheRef.current.get(trend.image_url) ?? null : null;
      const imgRadius = Math.max(radius, 14); // ensure image is always visible

      // Glow
      ctx.save();
      const glow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, imgRadius * 2.5);
      glow.addColorStop(0, isActive ? "rgba(0,245,255,0.3)" : "rgba(0,245,255,0.06)");
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, imgRadius * 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (trendImg) {
        // Circular image
        ctx.save();
        ctx.globalAlpha = 0.85 + pulse + glowBoost;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, imgRadius, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(trendImg, pos.x - imgRadius, pos.y - imgRadius, imgRadius * 2, imgRadius * 2);
        ctx.restore();
        // Cyan ring border
        ctx.save();
        ctx.globalAlpha = isActive ? 0.8 : 0.3;
        ctx.strokeStyle = ACCENT_CYAN;
        ctx.lineWidth = isActive ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, imgRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else {
        // Fallback circle
        ctx.save();
        ctx.globalAlpha = 0.7 + pulse + glowBoost;
        ctx.fillStyle = isActive ? ACCENT_CYAN : "rgba(0,245,255,0.5)";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Label
      ctx.save();
      ctx.fillStyle = isActive ? TEXT_PRIMARY : TEXT_MUTED;
      const labelFont = `${isActive ? "bold " : ""}${w < 600 ? 9 : 11}px system-ui, sans-serif`;
      ctx.font = labelFont;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const labelX = pos.x + imgRadius + 6;
      const labelMaxW = w * COL_H1 - labelX - 10; // don't overlap hidden layer 1
      const labelLines = wrapText(ctx, trend.trend_name, Math.max(60, labelMaxW));
      const labelLineH = (w < 600 ? 9 : 11) + 3;
      const labelStartY = pos.y - ((labelLines.length - 1) * labelLineH) / 2;
      for (let li = 0; li < labelLines.length; li++) {
        ctx.fillText(labelLines[li], labelX, labelStartY + li * labelLineH);
      }
      ctx.restore();
    }

    // ── HIDDEN LAYER 1 (rotating rings) ───────────────────────
    for (let i = 0; i < HIDDEN1_COUNT; i++) {
      const pos = layout.hidden1[i];
      if (!pos) continue;
      const pulse = Math.sin(t * 1.5 + i * 1.2) * 0.3;
      const r = 5 + (isProcessing ? 3 : 0) + pulse;
      const alpha = 0.3 + (isProcessing ? 0.4 : 0) + glowBoost;
      const hue = 200 + i * 20;
      const rotSpeed = (isProcessing ? 3 : 1) * (i % 2 === 0 ? 1 : -1);

      // Outer rotating ring
      ctx.save();
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = `hsla(${hue}, 85%, 65%, 1)`;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = `hsla(${hue}, 90%, 60%, 0.6)`;
      ctx.shadowBlur = isProcessing ? 16 : 6;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 3, t * rotSpeed + i, t * rotSpeed + i + Math.PI * 1.4);
      ctx.stroke();
      ctx.restore();

      // Inner filled circle
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `hsla(${hue}, 85%, 65%, 1)`;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ── HIDDEN LAYER 2 (rotating rings) ─────────────────────
    for (let i = 0; i < HIDDEN2_COUNT; i++) {
      const pos = layout.hidden2[i];
      if (!pos) continue;
      const pulse = Math.sin(t * 1.8 + i * 1.5 + 1) * 0.25;
      const r = 6 + (isProcessing ? 3 : 0) + pulse;
      const alpha = 0.3 + (isProcessing ? 0.35 : 0) + glowBoost;
      const hue = 280 + i * 15;
      const rotSpeed = (isProcessing ? 2.5 : 0.8) * (i % 2 === 0 ? -1 : 1);

      // Outer rotating ring
      ctx.save();
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = `hsla(${hue}, 80%, 60%, 1)`;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = `hsla(${hue}, 85%, 55%, 0.5)`;
      ctx.shadowBlur = isProcessing ? 14 : 5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 3, t * rotSpeed + i * 2, t * rotSpeed + i * 2 + Math.PI * 1.3);
      ctx.stroke();
      ctx.restore();

      // Inner filled circle
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, 1)`;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ── OUTPUT NODES (Memecoin cards) ────────────────────────
    const isLaunching = launchPhase !== "idle";
    for (let i = 0; i < readyMemecoins.length; i++) {
      const mc = readyMemecoins[i];
      const pos = layout.outputs[i];
      if (!pos) continue;

      const isSelected = launchSelectedId === mc.id;
      const imgEl = mc.imageUrl ? imgCacheRef.current.get(mc.imageUrl) ?? null : null;
      const hasImg = imgEl != null;
      const imgSize = 48;
      const textLeftPad = hasImg ? imgSize + 12 : 10;
      const rightPad = 10;
      const fontSize = w < 600 ? 10 : 12;
      const tickerFontSize = w < 600 ? 9 : 11;
      const srcFontSize = w < 600 ? 8 : 9;
      const lineHeight = fontSize + 3;
      const cardMaxW = 180;
      const textAreaW = cardMaxW - textLeftPad - rightPad;

      // Word-wrap the name and source trend within the fixed width
      ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      const nameLines = wrapText(ctx, mc.name, textAreaW);
      ctx.font = `${srcFontSize}px system-ui, sans-serif`;
      const src = mc.sourceTrends[0] || "";
      const srcLines = wrapText(ctx, src, textAreaW);

      // Compute card height from content
      const topPad = 8;
      const gap = 3;
      const nameBlockH = nameLines.length * lineHeight;
      const tickerLineH = tickerFontSize + gap;
      const srcBlockH = srcLines.length * (srcFontSize + 2);
      const barH = 8;
      const contentH = topPad + nameBlockH + gap + tickerLineH + gap + srcBlockH + gap + barH + 4;
      const cardH = hasImg ? Math.max(contentH, imgSize + 16) : contentH;
      const cardW = cardMaxW;

      const cx = pos.x - cardW / 2;
      const floatY = Math.sin(t * 1.2 + i * 1.8) * 2; // subtle floating animation
      const cy = pos.y + floatY;
      const fadeAlpha = mc.status === "fading" ? 0.3 : 1;
      const age = (Date.now() - mc.createdAt) / 1000;
      const entryScale = Math.min(1, age / 0.5);
      // During launch: dim non-selected cards, highlight selected
      const launchDim = isLaunching && !isSelected ? 0.2 : 1;
      const goldPulse = isSelected ? Math.sin(t * 4) * 0.3 + 0.7 : 0;

      ctx.save();
      ctx.globalAlpha = fadeAlpha * entryScale * launchDim;

      // Card background
      ctx.fillStyle = NODE_BG;
      ctx.shadowColor = isSelected ? `rgba(255,215,0,${0.4 + goldPulse * 0.3})` : "rgba(0,245,255,0.2)";
      ctx.shadowBlur = isSelected ? 24 : 12;
      ctx.beginPath();
      ctx.roundRect(cx, cy, cardW, cardH, 8);
      ctx.fill();

      // Border
      ctx.strokeStyle = isSelected ? `rgba(255,215,0,${0.6 + goldPulse * 0.4})` : "rgba(0,245,255,0.25)";
      ctx.lineWidth = isSelected ? 2.5 : 1;
      ctx.stroke();

      ctx.shadowBlur = 0;

      // Image thumbnail (if loaded)
      if (hasImg) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(cx + 6, cy + (cardH - imgSize) / 2, imgSize, imgSize, 6);
        ctx.clip();
        ctx.drawImage(imgEl, cx + 6, cy + (cardH - imgSize) / 2, imgSize, imgSize);
        ctx.restore();
      }

      let cursorY = cy + topPad;

      // Name — word-wrapped
      ctx.fillStyle = TEXT_PRIMARY;
      ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      for (const line of nameLines) {
        ctx.fillText(line, cx + textLeftPad, cursorY);
        cursorY += lineHeight;
      }
      cursorY += gap;

      // Ticker
      ctx.fillStyle = TICKER_COLOR;
      ctx.font = `bold ${tickerFontSize}px monospace`;
      ctx.fillText(`$${mc.ticker}`, cx + textLeftPad, cursorY);
      cursorY += tickerLineH + gap;

      // Source trend — word-wrapped
      ctx.fillStyle = TEXT_MUTED;
      ctx.font = `${srcFontSize}px system-ui, sans-serif`;
      for (const line of srcLines) {
        ctx.fillText(line, cx + textLeftPad, cursorY);
        cursorY += srcFontSize + 2;
      }
      cursorY += gap;

      // Viability bar
      const barY = cy + cardH - 6;
      const barW = cardW - 16;
      ctx.fillStyle = "rgba(100,116,139,0.3)";
      ctx.fillRect(cx + 8, barY, barW, 2);
      ctx.fillStyle = ACCENT_CYAN;
      ctx.fillRect(cx + 8, barY, barW * (mc.viabilityScore / 100), 2);

      ctx.restore();
    }

    // ── Empty state labels ───────────────────────────────────
    if (inputTrends.length === 0) {
      ctx.save();
      ctx.fillStyle = TEXT_MUTED;
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for trends...", w * COL_INPUT, h / 2);
      ctx.restore();
    }

    if (readyMemecoins.length === 0) {
      ctx.save();
      ctx.fillStyle = TEXT_MUTED;
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Awaiting memecoin ideas...", w * COL_OUTPUT, h / 2);
      ctx.restore();
    }

    // ── Countdown number (large, center canvas) ──────────────
    if (launchPhase === "countdown" && launchCountdownSec > 0) {
      ctx.save();
      ctx.globalAlpha = 0.15 + Math.sin(t * 6) * 0.05;
      ctx.fillStyle = "#ffd700";
      ctx.font = `bold ${Math.min(w, h) * 0.28}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(launchCountdownSec), w / 2, h / 2);
      ctx.restore();
    }

    // ── Deploying convergence lines ─────────────────────────
    if (launchPhase === "deploying" && launchSelectedId) {
      const selIdx = readyMemecoins.findIndex((m) => m.id === launchSelectedId);
      const selOut = selIdx >= 0 ? layout.outputs[selIdx] : null;
      if (selOut) {
        for (let hi = 0; hi < HIDDEN2_COUNT; hi++) {
          const h2 = layout.hidden2[hi];
          if (!h2) continue;
          const pulseAlpha = 0.3 + Math.sin(t * 8 + hi) * 0.2;
          drawBezier(ctx, h2, selOut, pulseAlpha, "#ffd700", 2);
          const pt = ((t * 0.6 + hi * 0.15) % 1);
          drawPulse(ctx, h2, selOut, pt, 5, "#ffd700");
        }
      }
    }

    // ── Success particle burst ──────────────────────────────
    if (launchPhase === "success" && launchSelectedId) {
      const selIdx = readyMemecoins.findIndex((m) => m.id === launchSelectedId);
      const selOut = selIdx >= 0 ? layout.outputs[selIdx] : null;
      if (selOut) {
        const burstAge = (Date.now() - (readyMemecoins[selIdx]?.createdAt ?? Date.now())) / 1000;
        for (let p = 0; p < 20; p++) {
          const angle = (p / 20) * Math.PI * 2 + t * 0.5;
          const dist = 30 + burstAge * 15 + Math.sin(t * 3 + p) * 10;
          const px = selOut.x + Math.cos(angle) * dist;
          const py = selOut.y + 40 + Math.sin(angle) * dist;
          const alpha = Math.max(0, 0.6 - dist / 200);
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = p % 3 === 0 ? "#ffd700" : p % 3 === 1 ? "#00f5ff" : "#3cff9a";
          ctx.beginPath();
          ctx.arc(px, py, 2 + Math.sin(t * 4 + p) * 1, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        // "LIVE" label
        ctx.save();
        ctx.globalAlpha = 0.8 + Math.sin(t * 3) * 0.2;
        ctx.fillStyle = "#3cff9a";
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("LIVE ON PUMP.FUN", selOut.x, selOut.y - 12);
        ctx.restore();
      }
    }

    // ── Layer labels ─────────────────────────────────────────
    ctx.save();
    ctx.fillStyle = "rgba(100,116,139,0.4)";
    ctx.font = "bold 9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.letterSpacing = "1px";
    ctx.fillText("TRENDS", w * COL_INPUT, 16);
    ctx.fillText("ANALYSIS", w * COL_H1, 16);
    ctx.fillText("SYNTHESIS", w * COL_H2, 16);
    ctx.fillText("MEMECOINS", w * COL_OUTPUT, 16);
    ctx.restore();
  }, [inputTrends, readyMemecoins, activeTrendName, isProcessing, isPlayingTTS, speechPulse, launchPhase, launchSelectedId, launchCountdownSec]);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    </div>
  );
}
