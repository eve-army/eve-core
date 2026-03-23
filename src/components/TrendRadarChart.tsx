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
  polarPixelLayout,
} from "@/lib/mindshare-radar-layout";
import ReactEcharts from "echarts-for-react";
import VoiceMindshareRimCanvas, {
  type VoiceMindshareRimLayout,
} from "@/components/VoiceMindshareRimCanvas";

/** Padding inside the square viewport (px). */
const SQUARE_PAD_PX = 8;

export type TrendRadarVoiceProps = {
  audioAnalyzerRef: React.MutableRefObject<{
    analyser: AnalyserNode;
    data: Uint8Array;
  } | null>;
  isPlayingTTS: boolean;
  /** 0–1 bonding progress when curve data exists. */
  progressNorm: number;
};

type Props = {
  polar: TrendPolarBuild | null;
  activeTrendName: string | null;
  speechPulse: number;
  /** Optional voice rim + bloom aligned to polar geometry. */
  voice?: TrendRadarVoiceProps;
  /** Compact bonding / connect hints in header row. */
  bondingHud?: React.ReactNode;
};

function changeBorder(change: TrendChangeKind): string {
  switch (change) {
    case "new":
      return "#22d3ee";
    case "heat_up":
      return "#4ade80";
    case "heat_down":
      return "#fbbf24";
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

function changeTooltipLine(change: TrendChangeKind): string {
  switch (change) {
    case "new":
      return "<span style='color:#22d3ee'>●</span> New in top slice";
    case "heat_up":
      return "<span style='color:#4ade80'>▲</span> Heat up vs last poll";
    case "heat_down":
      return "<span style='color:#fbbf24'>▼</span> Heat down vs last poll";
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
}: Props) {
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
    return Math.max(
      120,
      Math.floor(Math.min(w, h) - 2 * SQUARE_PAD_PX),
    );
  }, [viewportSize]);

  useEffect(() => {
    if (squareSide < 8) {
      setRimLayout(null);
      return;
    }
    const { cx, cy, polarRadiusPx } = polarPixelLayout(squareSide, squareSide);
    setRimLayout({
      width: squareSide,
      height: squareSide,
      cx,
      cy,
      polarRadiusPx,
    });
  }, [squareSide]);

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
          textStyle: { color: "#94a3b8", fontSize: 14 },
          subtextStyle: { color: "#64748b", fontSize: 11 },
        },
      };
    }

    const pulse = 0.75 + Math.min(1, speechPulse) * 0.25;
    const { points, radiusMax } = polar;

    const seriesData = points.map((p) => {
      const pal = sentimentPalette(p.sentiment);
      const isActive = trendDisplayNamesMatch(activeTrendName, p.trend_name);
      const rel = p.maxHeat / radiusMax;
      const baseSize = 14 + rel * 22;
      const boosted = baseSize + changeSizeBoost(p.change);
      const symbolSize = isActive
        ? Math.max(52, boosted * 1.22)
        : boosted;
      const fillOpacity = 0.38 + pulse * 0.52 * (0.45 + rel * 0.55);
      return {
        value: [p.maxHeat, p.angleDeg] as [number, number],
        name: p.trend_name,
        label: {
          show: true,
          formatter: () => shortTrendLabel(p.trend_name),
          position: "top",
          distance: 10,
          fontSize: isActive ? 12 : 11,
          fontWeight: isActive ? 700 : 500,
          color: "#e2e8f0",
          textBorderColor: "rgba(2,6,23,0.94)",
          textBorderWidth: 2,
        },
        itemStyle: {
          color: pal.symbol,
          opacity: isActive ? Math.min(1, fillOpacity + 0.12) : fillOpacity,
          borderColor: isActive ? "#22d3ee" : changeBorder(p.change),
          borderWidth: changeBorderWidth(p.change, isActive),
          shadowBlur: isActive ? 22 : 0,
          shadowColor: isActive ? "rgba(34,211,238,0.55)" : "transparent",
        },
        symbolSize,
      };
    });

    return {
      backgroundColor: "transparent",
      textStyle: { color: "#94a3b8", fontSize: 10 },
      tooltip: {
        trigger: "item",
        backgroundColor: "rgba(15,15,21,0.92)",
        borderColor: "rgba(34,211,238,0.35)",
        textStyle: { color: "#e2e8f0", fontSize: 11 },
        formatter: (params: {
          dataIndex: number;
        }) => {
          const pt = points[params.dataIndex];
          if (!pt) return "";
          const pal = sentimentPalette(pt.sentiment);
          const motion = changeTooltipLine(pt.change);
          const motionBlock = motion ? `${motion}<br/>` : "";
          return `${motionBlock}<span style="color:${pal.symbol}">●</span> <b>${pt.trend_name}</b><br/>heat ${pt.maxHeat.toFixed(1)}<br/>${pt.sentiment}`;
        },
      },
      polar: {
        center: [`${POLAR_CENTER_X * 100}%`, `${POLAR_CENTER_Y * 100}%`],
        radius: `${POLAR_RADIUS * 100}%`,
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
          lineStyle: { color: "rgba(148,163,184,0.11)" },
        },
      },
      radiusAxis: {
        type: "value",
        min: 0,
        max: radiusMax,
        axisLine: { show: false },
        axisLabel: { color: "#64748b", fontSize: 9 },
        splitLine: {
          show: true,
          lineStyle: { color: "rgba(148,163,184,0.14)" },
        },
        splitArea: {
          show: true,
          areaStyle: {
            color: ["rgba(15,23,42,0.48)", "rgba(15,23,42,0.2)"],
          },
        },
      },
      series: [
        {
          name: "Trends",
          type: "scatter",
          coordinateSystem: "polar",
          symbol: "circle",
          data: seriesData,
          labelLayout: {
            hideOverlap: true,
            moveOverlap: "shiftY",
          },
          emphasis: {
            focus: "self",
            scale: 1.12,
            itemStyle: {
              shadowBlur: 18,
              shadowColor: "rgba(34,211,238,0.45)",
            },
            label: {
              fontSize: 12,
              fontWeight: 600,
            },
          },
          animation: true,
          animationDuration: 220,
          animationDurationUpdate: 380,
          animationEasingUpdate: "cubicOut",
        },
      ],
    };
  }, [polar, activeTrendName, speechPulse]);

  const capHint =
    polar && polar.points.length > 0
      ? `${polar.points.length} trend${polar.points.length === 1 ? "" : "s"}`
      : null;

  return (
    <div className="w-full min-h-0 h-full flex flex-col rounded-xl border border-white/10 bg-black/30 overflow-hidden">
      <div className="px-3 py-2 border-b border-white/5 flex items-center justify-between gap-2 shrink-0 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-400/90">
          Mindshare radar
        </span>
        <div className="flex items-center gap-2 flex-wrap justify-end flex-1 min-w-0">
          {bondingHud ? (
            <div className="shrink-0 text-right max-w-[min(100%,12rem)]">
              {bondingHud}
            </div>
          ) : null}
          <span className="text-[9px] text-zinc-500 font-mono text-right max-w-[min(100%,20rem)] leading-snug">
            {capHint ? `${capHint} · ` : ""}
            radius = heat · fill = sentiment · cyan ring = new · green = heat up ·
            amber = down
          </span>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="relative flex-1 min-h-[200px] min-w-0 flex items-start justify-center overflow-hidden pt-2"
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
    </div>
  );
}
