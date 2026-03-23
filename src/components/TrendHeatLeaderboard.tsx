"use client";

import React, { useMemo } from "react";
import {
  sentimentPalette,
  trendDisplayNamesMatch,
  type TrendChangeKind,
  type TrendPolarBuild,
} from "@/lib/live-trends";

function changeBorder(change: TrendChangeKind): string {
  switch (change) {
    case "new":
      return "#22d3ee";
    case "heat_up":
      return "#4ade80";
    case "heat_down":
      return "#fbbf24";
    default:
      return "rgba(148,163,184,0.25)";
  }
}

type Props = {
  polar: TrendPolarBuild | null;
  activeTrendName: string | null;
  className?: string;
};

/**
 * Heat-ranked list using the same sentiment fill + motion border colors as the mindshare radar.
 */
export default function TrendHeatLeaderboard({
  polar,
  activeTrendName,
  className = "",
}: Props) {
  const rows = useMemo(() => {
    if (!polar?.points.length) return [];
    return [...polar.points].sort((a, b) => b.maxHeat - a.maxHeat);
  }, [polar]);

  return (
    <div
      className={`flex flex-col rounded-xl border border-white/10 bg-black/30 overflow-hidden ${className}`}
    >
      <div className="px-4 sm:px-5 py-2.5 border-b border-white/5 shrink-0">
        <span className="text-sm font-mono uppercase tracking-widest text-cyan-400/90">
          Latest trends
        </span>
        <p className="text-xs text-zinc-500 mt-1 font-mono leading-snug">
          Ranked by heat · colors match radar
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 sm:px-4 py-2">
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
              const border = changeBorder(pt.change);
              return (
                <li key={pt.trend_name}>
                  <div
                    className={`flex items-start gap-2 rounded-lg border border-l-[3px] transition-colors box-border ${
                      isActive
                        ? "bg-cyan-500/10 border-cyan-500/35"
                        : "bg-white/[0.03] border-white/5 hover:border-white/10"
                    }`}
                    style={{ borderLeftColor: border }}
                  >
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
                      <p
                        className="text-sm font-medium text-zinc-100 leading-snug break-words hyphens-auto"
                        title={pt.trend_name}
                      >
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
