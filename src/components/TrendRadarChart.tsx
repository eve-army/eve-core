"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  sentimentPalette,
  trendDisplayNamesMatch,
  type TrendChangeKind,
  type TrendPolarBuild,
} from "@/lib/live-trends";
import {
  POLAR_CENTER_X,
  POLAR_CENTER_Y,
  POLAR_RADIUS,
  POLAR_RADIUS_STREAM,
  polarPixelLayout,
} from "@/lib/mindshare-radar-layout";
import { streamTrendColor } from "@/lib/trend-stream-palette";
import { broadcastChartTheme as bct } from "@/lib/broadcast-chart-theme";
import ReactEcharts from "echarts-for-react";
import VoiceMindshareRimCanvas, {
  type VoiceMindshareRimLayout,
} from "@/components/VoiceMindshareRimCanvas";

/** Padding inside the square viewport (px). */
const SQUARE_PAD_PX = 6;
const SQUARE_PAD_STREAM_PX = 4;
/** Extra inset so ECharts polar labels (especially “top”) stay inside the panel clip rect. */
const LABEL_CANVAS_INSET_STREAM_PX = 34;
const LABEL_CANVAS_INSET_DEFAULT_PX = 10;

export type TrendRadarVoiceProps = {
  audioAnalyzerRef: React.MutableRefObject<{
    analyser: AnalyserNode;
    data: Uint8Array;
  } | null>;
  isPlayingTTS: boolean;
  /** 0–1 bonding progress when curve data exists. */
  progressNorm: number;
  /** Fade non-active dots while a trend is highlighted during speech (focus / selection feel). */
  dimOthersWhenSpeaking?: boolean;
};

type Props = {
  polar: TrendPolarBuild | null;
  activeTrendName: string | null;
  speechPulse: number;
  /** Optional voice rim + bloom aligned to polar geometry. */
  voice?: TrendRadarVoiceProps;
  /** Compact bonding / connect hints in header row. */
  bondingHud?: React.ReactNode;
  /** Stream embed: larger labels, per-trend colors, tighter polar, legend. */
  variant?: "default" | "stream";
  /** When true, ECharts updates are instant (matches prefers-reduced-motion). */
  reduceMotion?: boolean;
};

function changeBorder(change: TrendChangeKind): string {
  switch (change) {
    case "new":
      return bct.changeNew;
    case "heat_up":
      return bct.changeUp;
    case "heat_down":
      return bct.changeDown;
    default:
      return "rgba(15,15,21,0.5)";
  }
}

function changeBorderWidth(change: TrendChangeKind, isActive: boolean): number {
  if (isActive) return 3;
  switch (change) {
    case "new":
      return 2.5;
    case "heat_up":
    case "heat_down":
      return 2;
    default:
      return 1;
  }
}

function changeSizeBoost(change: TrendChangeKind): number {
  switch (change) {
    case "new":
      return 12;
    case "heat_up":
      return 6;
    case "heat_down":
      return 4;
    default:
      return 0;
  }
}

function shortTrendLabel(name: string, maxLen = 26): string {
  const t = name.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

function escapeHtmlTooltip(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortTrendLabelStream(name: string, maxLen = 18): string {
  const t = name.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

function changeTooltipLine(change: TrendChangeKind): string {
  switch (change) {
    case "new":
      return `<span style='color:${bct.changeNew}'>●</span> New in top slice`;
    case "heat_up":
      return `<span style='color:${bct.changeUp}'>▲</span> Heat up vs last poll`;
    case "heat_down":
      return `<span style='color:${bct.changeDown}'>▼</span> Heat down vs last poll`;
    default:
      return "";
  }
}

/**
 * Polar “radar” view: each trend is one dot. Chart is a centered square so the polar grid
 * and voice rim stay fully visible.
 */
export default function TrendRadarChart({
  polar,
  activeTrendName,
  speechPulse,
  voice,
  bondingHud,
  variant = "default",
  reduceMotion = false,
}: Props) {
  const isStream = variant === "stream";
  const animMs = reduceMotion ? 0 : isStream ? 320 : 280;
  const animUpdateMs = reduceMotion ? 0 : isStream ? 520 : 420;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  const [rimLayout, setRimLayout] = useState<VoiceMindshareRimLayout | null>(
    null,
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize({ w: rect.width, h: rect.height });
    };

    measure();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(measure);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const squareSide = useMemo(() => {
    const { w, h } = viewportSize;
    if (w < 16 || h < 16) return 0;
    const pad = isStream ? SQUARE_PAD_STREAM_PX : SQUARE_PAD_PX;
    const labelInset = isStream
      ? LABEL_CANVAS_INSET_STREAM_PX
      : LABEL_CANVAS_INSET_DEFAULT_PX;
    const minSide = isStream ? 100 : 120;
    return Math.max(
      minSide,
      Math.floor(Math.min(w, h) - 2 * pad - 2 * labelInset),
    );
  }, [viewportSize, isStream]);

  const polarRadiusFrac = isStream ? POLAR_RADIUS_STREAM : POLAR_RADIUS;

  useEffect(() => {
    if (squareSide < 8) {
      setRimLayout(null);
      return;
    }
    const { cx, cy, polarRadiusPx } = polarPixelLayout(
      squareSide,
      squareSide,
      polarRadiusFrac,
    );
    setRimLayout({
      width: squareSide,
      height: squareSide,
      cx,
      cy,
      polarRadiusPx,
    });
  }, [squareSide, polarRadiusFrac]);

  const option = useMemo(() => {
    if (!polar || polar.points.length === 0) {
      const subtext =
        polar && polar.totalAvailable === 0
          ? "Waiting for data…"
          : polar
            ? "No trends to plot"
            : "Waiting for data…";
      return {
        backgroundColor: "transparent",
        title: {
          text: "Live trends",
          subtext,
          left: "center",
          top: "middle",
          textStyle: { color: bct.textMuted, fontSize: 15, fontWeight: 600 },
          subtextStyle: { color: bct.axisLabel, fontSize: 12 },
        },
      };
    }

    const pulse = 0.75 + Math.min(1, speechPulse) * 0.25;
    const { points, radiusMax } = polar;
    const dimOthers =
      Boolean(voice?.dimOthersWhenSpeaking) &&
      Boolean(activeTrendName?.trim());

    const heatRank = new Map<string, number>();
    [...points]
      .sort((a, b) => b.maxHeat - a.maxHeat)
      .forEach((p, i) => {
        heatRank.set(p.trend_name, i + 1);
      });

    const seriesData = points.map((p, idx) => {
      const pal = sentimentPalette(p.sentiment);
      const streamColor = streamTrendColor(p.trend_name, idx);
      const isActive = trendDisplayNamesMatch(activeTrendName, p.trend_name);
      const inactiveDim = dimOthers && !isActive ? 0.24 : 1;
      const rel = p.maxHeat / radiusMax;
      const baseSize = 14 + rel * 22;
      const boosted = baseSize + changeSizeBoost(p.change);
      const symbolSize = isActive
        ? Math.max(isStream ? 44 : 52, boosted * (isStream ? 1.12 : 1.22))
        : boosted * (dimOthers && !isActive ? 0.82 : 1);
      const fillOpacity =
        (0.38 + pulse * 0.52 * (0.45 + rel * 0.55)) * inactiveDim;
      const rank = heatRank.get(p.trend_name) ?? 999;
      const fillColor = isStream ? streamColor : pal.symbol;
      const streamLabelMax = isActive ? 52 : 18;
      const defaultLabelMax = isActive ? 48 : 26;
      const labelText = isStream
        ? `{rank|#${rank}} {name|${shortTrendLabelStream(p.trend_name, streamLabelMax)}}`
        : shortTrendLabel(p.trend_name, defaultLabelMax);
      const labelColor =
        dimOthers && !isActive ? bct.textMuted : bct.text;
      const rankColor =
        dimOthers && !isActive ? bct.textMuted : streamColor;
      return {
        value: [p.maxHeat, p.angleDeg] as [number, number],
        name: p.trend_name,
        label: isStream
          ? {
              show: true,
              formatter: labelText,
              position: "top",
              distance: 12,
              overflow: "none" as const,
              rich: {
                rank: {
                  color: rankColor,
                  fontSize: isActive ? 14 : 12,
                  fontWeight: 800,
                  padding: [0, 4, 0, 0],
                },
                name: {
                  color: labelColor,
                  fontSize: isActive ? 17 : dimOthers && !isActive ? 12 : 14,
                  fontWeight: isActive ? 800 : 650,
                  textBorderColor: bct.labelHalo,
                  textBorderWidth: 4,
                },
              },
            }
          : {
              show: true,
              formatter: () => shortTrendLabel(p.trend_name, defaultLabelMax),
              position: "top",
              distance: 10,
              overflow: "none" as const,
              fontSize: isActive ? 14 : dimOthers && !isActive ? 10 : 12,
              fontWeight: isActive ? 800 : 600,
              color: labelColor,
              textBorderColor: bct.labelHalo,
              textBorderWidth: 3,
            },
        itemStyle: {
          color: fillColor,
          opacity:
            (isActive ? Math.min(1, fillOpacity / inactiveDim + 0.12) : fillOpacity) *
            (dimOthers && !isActive ? 0.92 : 1),
          borderColor: isActive ? bct.accentA : changeBorder(p.change),
          borderWidth: changeBorderWidth(p.change, isActive),
          shadowBlur: isActive ? 26 : isStream ? 8 : 0,
          shadowColor: isActive
            ? bct.activeShadow
            : isStream
              ? "rgba(0,0,0,0.45)"
              : "transparent",
        },
        symbolSize,
      };
    });

    return {
      backgroundColor: "transparent",
      textStyle: { color: bct.textMuted, fontSize: 11 },
      tooltip: {
        trigger: "item",
        /** Avoid clipping: layout uses overflow-hidden; tooltip must not render inside the chart box. */
        appendToBody: true,
        confine: false,
        backgroundColor: bct.tooltipBg,
        borderColor: bct.tooltipBorder,
        borderWidth: 1,
        padding: [10, 14],
        textStyle: { color: bct.text, fontSize: 12 },
        extraCssText:
          "max-width:min(380px,92vw);white-space:normal;word-break:break-word;line-height:1.45;",
        formatter: (params: {
          dataIndex: number;
        }) => {
          const pt = points[params.dataIndex];
          if (!pt) return "";
          const pal = sentimentPalette(pt.sentiment);
          const dotColor = isStream
            ? streamTrendColor(pt.trend_name, params.dataIndex)
            : pal.symbol;
          const motion = changeTooltipLine(pt.change);
          const motionBlock = motion ? `${motion}<br/>` : "";
          const sum = pt.summary.trim();
          const summaryBlock = sum
            ? `<br/><span style="opacity:.92;font-size:11px;line-height:1.35">${escapeHtmlTooltip(sum)}</span>`
            : "";
          return `${motionBlock}<span style="color:${dotColor}">●</span> <b>${escapeHtmlTooltip(pt.trend_name)}</b><br/>heat ${pt.maxHeat.toFixed(1)}<br/>${escapeHtmlTooltip(pt.sentiment)}${summaryBlock}`;
        },
      },
      polar: {
        center: [`${POLAR_CENTER_X * 100}%`, `${POLAR_CENTER_Y * 100}%`],
        radius: `${polarRadiusFrac * 100}%`,
      },
      angleAxis: {
        type: "value",
        min: 0,
        max: 360,
        startAngle: 90,
        clockwise: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: {
          show: true,
          lineStyle: { color: bct.splitLine },
        },
      },
      radiusAxis: {
        type: "value",
        min: 0,
        max: radiusMax,
        axisLine: { show: false },
        axisLabel: { color: bct.axisLabel, fontSize: isStream ? 10 : 9 },
        splitLine: {
          show: true,
          lineStyle: { color: bct.splitLine },
        },
        splitArea: {
          show: true,
          areaStyle: {
            color: [bct.splitAreaLo, bct.splitAreaHi],
          },
        },
      },
      series: [
        {
          name: "Trends",
          type: "scatter",
          coordinateSystem: "polar",
          clip: false,
          symbol: "circle",
          data: seriesData,
          labelLayout: isStream
            ? {
                hideOverlap: false,
                moveOverlap: "shiftY",
              }
            : {
                hideOverlap: true,
                moveOverlap: "shiftY",
              },
          emphasis: {
            focus: "self",
            scale: 1.12,
            itemStyle: {
              shadowBlur: 24,
              shadowColor: bct.emphasisShadow,
            },
            label: {
              fontSize: isStream ? 15 : 13,
              fontWeight: 700,
            },
          },
          animation: !reduceMotion,
          animationDuration: animMs,
          animationDurationUpdate: animUpdateMs,
          animationEasingUpdate: "cubicOut",
        },
      ],
    };
  }, [
    polar,
    activeTrendName,
    speechPulse,
    isStream,
    polarRadiusFrac,
    reduceMotion,
    voice?.dimOthersWhenSpeaking,
  ]);

  const capHint =
    polar && polar.points.length > 0
      ? `${polar.points.length} trend${polar.points.length === 1 ? "" : "s"}`
      : null;

  return (
    <div
      className={`eve-panel w-full min-h-0 h-full flex flex-col border-[color:var(--eve-border)] shadow-[0_0_32px_var(--eve-glow-a)] ${
        isStream ? "overflow-visible" : "overflow-hidden"
      }`}
    >
      <div
        className={`px-3 border-b border-[color:var(--eve-border)] flex items-center justify-between gap-2 shrink-0 flex-wrap ${isStream ? "py-1.5" : "py-2"}`}
      >
        <span
          className={`eve-ticker text-[color:var(--eve-accent-a)] ${isStream ? "text-[10px]" : "text-xs"}`}
        >
          {isStream ? "Live trends" : "Mindshare radar"}
        </span>
        <div className="flex items-center gap-2 flex-wrap justify-end flex-1 min-w-0">
          {bondingHud ? (
            <div className="shrink-0 text-right max-w-[min(100%,12rem)]">
              {bondingHud}
            </div>
          ) : null}
          {!isStream ? (
            <span className="text-[10px] text-[color:var(--eve-muted)] font-mono text-right max-w-[min(100%,20rem)] leading-snug">
              {capHint ? `${capHint} · ` : ""}
              radius = heat · fill = sentiment · cyan ring = new · green = heat up ·
              amber = down
            </span>
          ) : (
            <span className="text-[10px] text-[color:var(--eve-muted)] font-mono truncate max-w-[50%]">
              {capHint ?? ""}
            </span>
          )}
        </div>
      </div>
      {isStream && voice?.isPlayingTTS && activeTrendName ? (
        <div className="shrink-0 px-2 py-1.5 text-center border-b border-[color:var(--eve-border-strong)] bg-[color-mix(in_srgb,var(--eve-accent-a)_12%,transparent)]">
          <p className="eve-ticker text-[11px] sm:text-sm font-bold text-[color:var(--eve-text)] truncate px-1">
            On air:{" "}
            <span className="text-white drop-shadow-[0_0_12px_var(--eve-glow-a)]">
              {activeTrendName}
            </span>
          </p>
        </div>
      ) : null}
      <div
        ref={viewportRef}
        className={`relative flex min-h-[200px] min-w-0 flex-1 items-center justify-center overflow-visible ${isStream ? "py-1" : "py-0"}`}
      >
        {squareSide > 0 ? (
          <div
            className="relative z-10 shrink-0"
            style={{ width: squareSide, height: squareSide }}
          >
            <ReactEcharts
              option={option}
              style={{ height: "100%", width: "100%" }}
              opts={{ renderer: "canvas" }}
            />
            {voice && rimLayout ? (
              <VoiceMindshareRimCanvas
                layout={rimLayout}
                isPlayingTTS={voice.isPlayingTTS}
                progressNorm={voice.progressNorm}
                audioAnalyzerRef={voice.audioAnalyzerRef}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {isStream ? (
        <div className="shrink-0 px-2 py-1.5 border-t border-[color:var(--eve-border)] bg-[color-mix(in_srgb,var(--eve-bg-mid)_88%,transparent)] text-[10px] leading-tight text-[color:var(--eve-muted)] flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 eve-ticker">
          <span>
            <span className="text-[color:var(--eve-accent-a)]">●</span> new
          </span>
          <span className="text-zinc-600">·</span>
          <span>
            <span className="text-[color:var(--eve-live)]">▲</span> hotter
          </span>
          <span className="text-zinc-600">·</span>
          <span>
            <span className="text-[color:var(--eve-accent-c)]">▼</span> cooler
          </span>
          <span className="text-zinc-600">·</span>
          <span className="opacity-90">Each dot = trend hue</span>
        </div>
      ) : null}
    </div>
  );
}
