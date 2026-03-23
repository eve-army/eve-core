"use client";

import React, { useEffect, useRef } from "react";

/** Global scale for voice rim (~20% of prior intensity — subtle glow). */
const VOICE_GAIN = 0.2;

const NUM_BARS = 192;
const MAX_BAR_LENGTH_BASE = 58;
const BAR_WIDTH_BASE = 1.6;
const OUTER_RING_OFFSET = 0.5;
const MID_RING_OFFSET = 0.25;
const NUM_PARTICLES = 14;
/** Reference radius (px) for scaling bar lengths vs original orb. */
const REF_POLAR_RADIUS_PX = 100;

const SMOOTHING = 0.55;
const SPEECH_DECAY = 0.92;
const BAR_DECAY = 0.88;

export type VoiceMindshareRimLayout = {
  width: number;
  height: number;
  cx: number;
  cy: number;
  polarRadiusPx: number;
};

type Props = {
  layout: VoiceMindshareRimLayout | null;
  isPlayingTTS: boolean;
  /** 0–1 bonding progress (0 when no curve data). */
  progressNorm: number;
  audioAnalyzerRef: React.MutableRefObject<{
    analyser: AnalyserNode;
    data: Uint8Array;
  } | null>;
  className?: string;
};

/**
 * Audio + bonding energy drawn **outside** the mindshare polar radius so ECharts scatter stays readable.
 * Soft center bloom on top (low alpha). Pointer-events none.
 */
export default function VoiceMindshareRimCanvas({
  layout,
  isPlayingTTS,
  progressNorm,
  audioAnalyzerRef,
  className = "",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prevBarLevelsRef = useRef<Float32Array | null>(null);
  const prevSpeechLevelRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || layout.width < 8 || layout.height < 8) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    let frameId = 0;

    const { width: w, height: h, cx, cy, polarRadiusPx: R } = layout;
    const scale = R / REF_POLAR_RADIUS_PX;
    const MAX_BAR_LENGTH = MAX_BAR_LENGTH_BASE * scale * VOICE_GAIN;
    const BAR_WIDTH = BAR_WIDTH_BASE * scale * Math.sqrt(VOICE_GAIN);
    const midRingRadius = R + MAX_BAR_LENGTH * 0.45;
    const outerRingRadius = R + MAX_BAR_LENGTH + 8 * scale;
    const outerBarMax = 24 * scale * VOICE_GAIN;

    const startTime = performance.now();

    const draw = () => {
      if (cancelled) return;
      const t = (performance.now() - startTime) * 0.001;

      ctx.clearRect(0, 0, w, h);

      const analyzer = audioAnalyzerRef.current;
      const speed = isPlayingTTS ? 3.5 : 1.3;
      let speechLevel = 0;
      const barAudioLevels = new Float32Array(NUM_BARS);
      const AUDIO_GAIN = 2.2;

      if (analyzer) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AnalyserNode buffer typing vs SharedArrayBuffer
        analyzer.analyser.getByteFrequencyData(analyzer.data as any);
        const freq = analyzer.data;
        let sum = 0;
        for (let j = 0; j < freq.length; j++) sum += freq[j];
        let rawSpeech = Math.min(1, (sum / (freq.length * 255)) * 1.8);
        // TTS often maps weakly into frequency bins; time-domain peak tracks voice better.
        if (sum < freq.length * 3) {
          const td = new Uint8Array(analyzer.analyser.fftSize);
          analyzer.analyser.getByteTimeDomainData(td);
          let pk = 0;
          for (let j = 0; j < td.length; j++) {
            const v = Math.abs(td[j]! - 128);
            if (v > pk) pk = v;
          }
          rawSpeech = Math.max(rawSpeech, Math.min(1, (pk / 128) * 1.25));
        }
        speechLevel =
          prevSpeechLevelRef.current * SMOOTHING + rawSpeech * (1 - SMOOTHING);
        prevSpeechLevelRef.current = speechLevel;
        for (let i = 0; i < NUM_BARS; i++) {
          const pos = i / NUM_BARS;
          const spectrumT = pos <= 0.5 ? pos * 2 : (1 - pos) * 2;
          const binExact = spectrumT * (freq.length - 1);
          const binIndex = Math.floor(binExact);
          const nextBin = Math.min(binIndex + 1, freq.length - 1);
          const frac = binExact - binIndex;
          const v =
            freq[binIndex] * (1 - frac) + freq[nextBin] * frac;
          const raw = Math.min(1, (v / 255) * AUDIO_GAIN);
          barAudioLevels[i] = prevBarLevelsRef.current
            ? prevBarLevelsRef.current[i] * SMOOTHING + raw * (1 - SMOOTHING)
            : raw;
        }
        prevBarLevelsRef.current = barAudioLevels.slice();
      } else {
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

      // TTS burst rings — expand outside polar edge
      if (speechLevel > 0.04) {
        for (let b = 0; b < 3; b++) {
          const phase = (t * 2.8 + b * 0.2) % 1;
          const r = R + (8 + phase * 48) * scale * VOICE_GAIN;
          const alpha =
            (1 - phase) * 0.55 * Math.min(1, speechLevel * 1.5) * VOICE_GAIN;
          ctx.strokeStyle = `rgba(0, 245, 255, ${alpha})`;
          ctx.lineWidth = Math.max(0.8, 1.2 * scale * Math.sqrt(VOICE_GAIN));
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Particles — orbit just outside R
      for (let p = 0; p < NUM_PARTICLES; p++) {
        const orbitAngle = t * 0.8 + p * 0.22 + (p % 3) * 0.7;
        const orbitRadius =
          R + (4 + (p % 5) * 9 + progressNorm * 8) * scale;
        const px = cx + Math.cos(orbitAngle) * orbitRadius;
        const py = cy + Math.sin(orbitAngle) * orbitRadius;
        const pulse = 0.5 + 0.5 * Math.sin(t * 4 + p * 0.5);
        const speechBoost = 0.15 + speechLevel * 0.9;
        const particleAlpha =
          Math.min(
            0.85,
            (0.25 + progressNorm * 0.25 + speechBoost) * pulse,
          ) * VOICE_GAIN;
        const particleSize =
          (1.2 + (p % 2) * 0.5 + speechLevel * 1.4) *
          scale *
          Math.sqrt(VOICE_GAIN);
        const hueP = (260 + progressNorm * 80 + p * 3) % 360;
        ctx.fillStyle = `hsla(${hueP}, 90%, 75%, ${particleAlpha})`;
        ctx.beginPath();
        ctx.arc(px, py, particleSize, 0, Math.PI * 2);
        ctx.fill();
      }

      const hue =
        (238 + progressNorm * 100 + (speechLevel > 0.05 ? Math.sin(t * 2.5) * 35 : 0)) %
        360;
      const sat = 92;

      const drawBar = (
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        alpha: number,
        glowWidth: number,
        lightMod: number,
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

      // Rim bars: anchor at R, extend outward (main / mid / outer staggered rings)
      for (let i = 0; i < NUM_BARS; i++) {
        const angle = (i / NUM_BARS) * Math.PI * 2 - Math.PI / 2;
        const angleMid = angle + MID_RING_OFFSET * ((Math.PI * 2) / NUM_BARS);
        const angleOuter = angle + OUTER_RING_OFFSET * ((Math.PI * 2) / NUM_BARS);

        const wave1 = Math.sin(t * speed * 2 + i * 0.32) * 0.5 + 0.5;
        const wave2 = Math.sin(t * speed * 1.4 + i * 0.18) * 0.4 + 0.5;
        const wave3 = Math.sin(t * speed * 3.2 + i * 0.48) * 0.35 + 0.5;
        const wave4 = Math.sin(t * speed * 0.9 + i * 0.25) * 0.25 + 0.5;
        const wave = (wave1 + wave2 + wave3 + wave4) / 4;
        const audioNorm = barAudioLevels[i];
        const barBlend = 0.12 * wave + 0.88 * audioNorm;
        const barLength =
          (baseLevel + barBlend * 0.85 + ttsBoost * 0.55) * MAX_BAR_LENGTH;
        const barLengthClamped = Math.max(2, Math.min(MAX_BAR_LENGTH, barLength));

        const waveM1 = Math.sin(t * speed * 2.1 + i * 0.33 + 0.9) * 0.5 + 0.5;
        const waveM2 = Math.sin(t * speed * 1.35 + i * 0.19) * 0.4 + 0.5;
        const waveM = (waveM1 + waveM2) / 2;
        const midAudio = (barAudioLevels[i] + barAudioLevels[(i + 1) % NUM_BARS]) / 2;
        const midBlend = 0.1 * waveM + 0.9 * midAudio;
        const midLen =
          (baseLevel * 0.8 + midBlend * 0.8 + ttsBoost * 0.5) *
          (MAX_BAR_LENGTH * 0.55);
        const midLenClamped = Math.max(2, Math.min(MAX_BAR_LENGTH * 0.55, midLen));

        const waveO1 = Math.sin(t * speed * 2.3 + i * 0.35 + 1.5) * 0.5 + 0.5;
        const waveO2 = Math.sin(t * speed * 1.15 + i * 0.21 + 0.8) * 0.4 + 0.5;
        const waveO = (waveO1 + waveO2) / 2;
        const outerBlend =
          0.1 * waveO + 0.9 * barAudioLevels[(i + 2) % NUM_BARS];
        const barLengthOuter =
          (baseLevel * 0.6 + outerBlend * 0.75 + ttsBoost * 0.5) * outerBarMax;
        const barLengthOuterClamped = Math.max(
          2,
          Math.min(outerBarMax, barLengthOuter),
        );

        const lightMod = audioNorm * 35;

        const innerX = cx + Math.cos(angle) * R;
        const innerY = cy + Math.sin(angle) * R;
        const outerX = cx + Math.cos(angle) * (R + barLengthClamped);
        const outerY = cy + Math.sin(angle) * (R + barLengthClamped);
        drawBar(
          innerX,
          innerY,
          outerX,
          outerY,
          0.92 * VOICE_GAIN,
          8 * VOICE_GAIN,
          lightMod,
        );

        const midStartX = cx + Math.cos(angleMid) * midRingRadius;
        const midStartY = cy + Math.sin(angleMid) * midRingRadius;
        const midEndX = cx + Math.cos(angleMid) * (midRingRadius + midLenClamped);
        const midEndY = cy + Math.sin(angleMid) * (midRingRadius + midLenClamped);
        drawBar(
          midStartX,
          midStartY,
          midEndX,
          midEndY,
          0.82 * VOICE_GAIN,
          6 * VOICE_GAIN,
          lightMod * 0.9,
        );

        const outerStartX = cx + Math.cos(angleOuter) * outerRingRadius;
        const outerStartY = cy + Math.sin(angleOuter) * outerRingRadius;
        const outerEndX =
          cx + Math.cos(angleOuter) * (outerRingRadius + barLengthOuterClamped);
        const outerEndY =
          cy + Math.sin(angleOuter) * (outerRingRadius + barLengthOuterClamped);
        drawBar(
          outerStartX,
          outerStartY,
          outerEndX,
          outerEndY,
          0.72 * VOICE_GAIN,
          5 * VOICE_GAIN,
          lightMod * 0.8,
        );
      }

      // Outer halo — slightly outside main rim
      if (speechLevel > 0.025) {
        const haloAlpha =
          (0.06 + 0.18 * speechLevel * (0.8 + 0.4 * Math.sin(t * 5))) *
          VOICE_GAIN;
        ctx.strokeStyle = `rgba(0, 245, 255, ${Math.min(1, haloAlpha)})`;
        ctx.lineWidth = Math.max(1, 2 * scale * Math.sqrt(VOICE_GAIN));
        ctx.beginPath();
        ctx.arc(cx, cy, outerRingRadius + 18 * scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Dashed energy ring
      ctx.strokeStyle = `rgba(0, 245, 255, ${(0.05 + 0.035 * Math.sin(t * 2)) * VOICE_GAIN})`;
      ctx.lineWidth = Math.max(0.6, 1 * scale * Math.sqrt(VOICE_GAIN));
      ctx.setLineDash([4 * scale, 8 * scale]);
      ctx.beginPath();
      ctx.arc(cx, cy, outerRingRadius + 22 * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Center bloom (subtle, on top of prior strokes — tints scatter)
      const bloomR = Math.max(20, R * 0.36);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, bloomR);
      cg.addColorStop(
        0,
        `rgba(0, 245, 255, ${(0.06 + speechLevel * 0.22) * VOICE_GAIN})`,
      );
      cg.addColorStop(
        0.45,
        `rgba(160, 0, 255, ${(0.03 + speechLevel * 0.08) * VOICE_GAIN})`,
      );
      cg.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, bloomR, 0, Math.PI * 2);
      ctx.fill();

      frameId = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [
    layout?.width,
    layout?.height,
    layout?.cx,
    layout?.cy,
    layout?.polarRadiusPx,
    isPlayingTTS,
    progressNorm,
    audioAnalyzerRef,
  ]);

  if (!layout || layout.width < 8 || layout.height < 8) return null;

  return (
    <canvas
      ref={canvasRef}
      width={Math.round(layout.width)}
      height={Math.round(layout.height)}
      className={`pointer-events-none absolute inset-0 z-20 mix-blend-screen ${className}`}
      aria-hidden
    />
  );
}
