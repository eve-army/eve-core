"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  sentimentPalette,
  trendDisplayNamesMatch,
  type TrendChangeKind,
  type TrendPolarBuild,
} from "@/lib/live-trends";
import { streamTrendColor } from "@/lib/trend-stream-palette";
import { broadcastChartTheme as bct } from "@/lib/broadcast-chart-theme";

/** Native tooltip: title + optional API summary (deduped live-trends). */
function trendHoverTitle(pt: { trend_name: string; summary: string }): string {
  const s = pt.summary.trim();
  if (s) return `${pt.trend_name} — ${s}`;
  return pt.trend_name;
}

function changeBorder(change: TrendChangeKind): string {
  switch (change) {
    case "new":
      return bct.changeNew;
    case "heat_up":
      return bct.changeUp;
    case "heat_down":
      return bct.changeDown;
    default:
      return "rgba(148,163,184,0.25)";
  }
}

type Props = {
  polar: TrendPolarBuild | null;
  activeTrendName: string | null;
  className?: string;
  /** Horizontal top-N chips for stream embeds (640×360). */
  variant?: "default" | "stream";
  /** While a trend is highlighted during speech, fade rows that are not the focus. */
  dimUnfocusedDuringSpeech?: boolean;
};

/**
 * Heat-ranked list using the same sentiment fill + motion border colors as the mindshare radar.
 */
const STRIP_MAX = 8;

export default function TrendHeatLeaderboard({
  polar,
  activeTrendName,
  className = "",
  variant = "default",
  dimUnfocusedDuringSpeech = false,
}: Props) {
  const reduceMotion = useReducedMotion() === true;
  const rows = useMemo(() => {
    if (!polar?.points.length) return [];
    return [...polar.points].sort((a, b) => b.maxHeat - a.maxHeat);
  }, [polar]);

  const stripRows = useMemo(() => rows.slice(0, STRIP_MAX), [rows]);

  const activeStripPt = useMemo(() => {
    if (!activeTrendName?.trim()) return null;
    return (
      stripRows.find((pt) =>
        trendDisplayNamesMatch(activeTrendName, pt.trend_name),
      ) ?? null
    );
  }, [stripRows, activeTrendName]);

  const activeRowRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!activeTrendName?.trim()) return;
    const el = activeRowRef.current;
    if (!el) return;
    el.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
    });
  }, [activeTrendName, reduceMotion]);

  if (variant === "stream") {
    return (
      <div
        className={`eve-panel shrink-0 overflow-hidden border-[color:var(--eve-border)] shadow-[0_0_24px_var(--eve-glow-b)] ${className}`}
      >
        <div className="px-2 py-1.5 border-b border-[color:var(--eve-border)] flex items-center justify-between gap-2">
          <span className="eve-ticker text-[10px] text-[color:var(--eve-accent-b)]">
            Top heat
          </span>
          <span className="text-[9px] text-[color:var(--eve-muted)] truncate font-mono">
            Swipe →
          </span>
        </div>
        <div className="overflow-x-auto overflow-y-hidden px-2 py-2 scrollbar-thin">
          {stripRows.length === 0 ? (
            <p className="text-[11px] text-[color:var(--eve-muted)] text-center py-1 eve-ticker">
              {polar && polar.totalAvailable === 0
                ? "Waiting for data…"
                : "No trends yet"}
            </p>
          ) : (
            <div className="flex gap-2 min-w-max pb-0.5">
              {stripRows.map((pt, i) => {
                const isActive = trendDisplayNamesMatch(
                  activeTrendName,
                  pt.trend_name,
                );
                const dimmed =
                  dimUnfocusedDuringSpeech &&
                  Boolean(activeTrendName?.trim()) &&
                  !isActive;
                const border = changeBorder(pt.change);
                const dot = streamTrendColor(pt.trend_name, i);
                const short =
                  pt.trend_name.length > 12
                    ? `${pt.trend_name.slice(0, 11)}…`
                    : pt.trend_name;
                return (
                  <div key={pt.trend_name} className="relative group shrink-0">
                    <motion.div
                      title={pt.image_url ? undefined : trendHoverTitle(pt)}
                      layout={!reduceMotion}
                      transition={
                        reduceMotion
                          ? undefined
                          : { type: "spring", stiffness: 420, damping: 34 }
                      }
                      className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 min-w-0 max-w-[155px] shrink-0 transition-opacity duration-200 ${
                        isActive
                          ? "bg-[color-mix(in_srgb,var(--eve-accent-a)_18%,transparent)] border-[color:var(--eve-border-strong)] scale-[1.02]"
                          : "bg-[color-mix(in_srgb,var(--eve-bg-mid)_70%,transparent)] border-[color:var(--eve-border)]"
                      } ${dimmed ? "opacity-[0.28]" : ""}`}
                      style={{ borderLeftWidth: 4, borderLeftColor: border }}
                    >
                      <span className="eve-display text-sm text-[color:var(--eve-muted)] w-4 text-center shrink-0 leading-none">
                        {i + 1}
                      </span>
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: dot,
                          boxShadow: `0 0 10px ${dot}99`,
                        }}
                        aria-hidden
                      />
                      <span className="eve-ticker text-[11px] text-[color:var(--eve-text)] truncate min-w-0 font-bold">
                        {short}
                      </span>
                      <span
                        className="text-[10px] font-mono text-[color:var(--eve-accent-a)] shrink-0 tabular-nums font-bold"
                        style={{ fontFamily: "var(--font-eve-mono), monospace" }}
                      >
                        {pt.maxHeat.toFixed(0)}
                      </span>
                    </motion.div>
                    {pt.image_url && (
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 pointer-events-none">
                        <div className="rounded-lg overflow-hidden shadow-xl border border-white/10 bg-gray-900">
                          <img
                            src={pt.image_url}
                            alt={pt.trend_name}
                            className="max-w-[200px] max-h-[140px] object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                          <div className="px-2 py-1.5 text-[10px] text-zinc-300 leading-snug max-w-[200px]">
                            <b>{pt.trend_name}</b>
                            {pt.summary.trim() ? <p className="mt-0.5 text-zinc-400">{pt.summary.trim().slice(0, 120)}</p> : null}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {activeStripPt?.summary.trim() ? (
          <div className="px-2 py-1.5 border-t border-[color:var(--eve-border)] bg-[color-mix(in_srgb,var(--eve-accent-a)_10%,transparent)] shrink-0">
            <p className="text-[9px] font-mono uppercase tracking-wide text-[color:var(--eve-accent-a)] mb-0.5">
              On air
            </p>
            <p className="text-[10px] text-[color:var(--eve-text)] leading-snug line-clamp-4">
              {activeStripPt.summary.trim()}
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`eve-panel flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-[color:var(--eve-border)] ${className}`}
    >
      <div className="px-4 sm:px-5 py-3 border-b border-[color:var(--eve-border)] shrink-0">
        <span className="eve-ticker text-sm text-[color:var(--eve-accent-a)]">
          Latest trends
        </span>
        <p className="text-xs text-[color:var(--eve-muted)] mt-1 font-mono leading-snug">
          Ranked by heat · colors match radar
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-2">
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500 px-1 py-4 text-center">
            {polar && polar.totalAvailable === 0
              ? "Waiting for data…"
              : "No trends yet"}
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((pt, i) => {
              const pal = sentimentPalette(pt.sentiment);
              const isActive = trendDisplayNamesMatch(activeTrendName, pt.trend_name);
              const dimmed =
                dimUnfocusedDuringSpeech &&
                Boolean(activeTrendName?.trim()) &&
                !isActive;
              const border = changeBorder(pt.change);
              return (
                <li
                  key={pt.trend_name}
                  ref={isActive ? activeRowRef : undefined}
                  className="relative group"
                >
                  <div
                    title={pt.image_url ? undefined : trendHoverTitle(pt)}
                    className={`flex items-start gap-2 rounded-lg border border-l-[3px] transition-[opacity,colors] duration-200 box-border ${
                      isActive
                        ? "bg-[color-mix(in_srgb,var(--eve-accent-a)_14%,transparent)] border-[color:var(--eve-border-strong)]"
                        : "bg-white/[0.03] border-[color:var(--eve-border)] hover:border-[color:var(--eve-border-strong)]"
                    } ${dimmed ? "opacity-[0.3]" : ""}`}
                    style={{ borderLeftColor: border }}
                  >
                    {pt.image_url && (
                      <div className="absolute left-full top-0 ml-2 hidden group-hover:block z-50 pointer-events-none">
                        <div className="rounded-lg overflow-hidden shadow-xl border border-white/10 bg-gray-900">
                          <img
                            src={pt.image_url}
                            alt={pt.trend_name}
                            className="w-[200px] max-h-[140px] object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                          {pt.summary.trim() ? (
                            <p className="px-2 py-1.5 text-[10px] text-zinc-400 leading-snug max-w-[200px]">
                              {pt.summary.trim().slice(0, 120)}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    )}
                    <div className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2 sm:px-3.5 sm:py-2">
                    <span
                      className="tabular-nums text-sm font-bold font-mono text-zinc-200 min-w-[1.75rem] text-right shrink-0 leading-none pt-0.5"
                      aria-hidden
                    >
                      {i + 1}
                    </span>
                    <span
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: pal.symbol,
                        boxShadow: `0 0 10px ${pal.symbol}55`,
                      }}
                      title={pt.sentiment}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1 space-y-1 overflow-hidden">
                      <p className="text-sm font-medium text-zinc-100 leading-snug break-words hyphens-auto">
                        {pt.trend_name}
                      </p>
                      <p className="text-xs font-mono text-zinc-500 leading-snug tracking-wide break-words">
                        <span className="text-zinc-500">heat</span>
                        <span className="mx-1.5 text-zinc-600" aria-hidden>
                          ·
                        </span>
                        <span
                          className="tabular-nums text-sm font-semibold tracking-tight"
                          style={{ color: pal.symbol }}
                        >
                          {pt.maxHeat.toFixed(1)}
                        </span>
                        <span className="mx-1.5 text-zinc-600" aria-hidden>
                          ·
                        </span>
                        <span className="font-medium text-zinc-400">
                          {pt.sentiment}
                        </span>
                      </p>
                      {isActive && pt.summary.trim() ? (
                        <p className="text-xs text-zinc-400 leading-snug border-t border-white/[0.08] pt-1.5 mt-1.5">
                          {pt.summary.trim()}
                        </p>
                      ) : null}
                    </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
