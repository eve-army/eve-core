"use client";

import React from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import type { MemecoinIdea } from "@/lib/memecoin-ideas";

type LaunchPhase = "idle" | "selecting" | "countdown" | "deploying" | "success" | "failed";

type Props = {
  memecoins: MemecoinIdea[];
  className?: string;
  launchPhase?: LaunchPhase;
  launchSelectedId?: string | null;
  launchCountdownSec?: number;
  launchMint?: string | null;
};

export default function MemecoinTicker({
  memecoins,
  className = "",
  launchPhase = "idle",
  launchSelectedId = null,
  launchCountdownSec = 0,
  launchMint = null,
}: Props) {
  const reduceMotion = useReducedMotion() === true;
  const visible = memecoins.filter((m) => m.status !== "fading" || m.status === ("selected" as string)).slice(-8);
  const isLaunching = launchPhase !== "idle";

  // Success banner replaces the ticker
  if (launchPhase === "success" && launchMint) {
    const selected = memecoins.find((m) => m.id === launchSelectedId);
    return (
      <div className={`eve-panel shrink-0 overflow-hidden border-[color:#3cff9a] shadow-[0_0_24px_rgba(60,255,154,0.3)] ${className}`}>
        <div className="px-4 py-3 text-center">
          <p className="text-lg font-bold text-[#3cff9a]">
            {selected?.name ?? "Memecoin"} (${selected?.ticker ?? "???"}) IS LIVE!
          </p>
          <a
            href={`https://pump.fun/coin/${launchMint}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[color:var(--eve-accent-a)] underline hover:text-white transition"
          >
            pump.fun/coin/{launchMint.slice(0, 8)}...
          </a>
        </div>
      </div>
    );
  }

  if (visible.length === 0) return null;

  return (
    <div
      className={`eve-panel shrink-0 overflow-hidden border-[color:var(--eve-border)] shadow-[0_0_24px_var(--eve-glow-b)] ${className}`}
    >
      <div className="px-2 py-1.5 border-b border-[color:var(--eve-border)] flex items-center justify-between gap-2">
        <span className="eve-ticker text-[10px] text-[color:var(--eve-accent-a)]">
          Memecoin Ideas
        </span>
        <span className="text-[9px] text-[color:var(--eve-muted)] truncate font-mono">
          {visible.length} generated
        </span>
      </div>
      <div className="overflow-x-auto overflow-y-hidden px-2 py-2 scrollbar-thin">
        <div className="flex gap-2 min-w-max pb-0.5">
          <AnimatePresence mode="popLayout">
            {visible.map((mc) => (
              <motion.div
                key={mc.id}
                layout={!reduceMotion}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={
                  reduceMotion
                    ? undefined
                    : { type: "spring", stiffness: 400, damping: 30 }
                }
                className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2 min-w-[140px] shrink-0 bg-[color-mix(in_srgb,var(--eve-bg-mid)_70%,transparent)] transition-opacity duration-300 ${
                  isLaunching && launchSelectedId !== mc.id ? "opacity-20" : ""
                } ${launchSelectedId === mc.id ? "border-[#ffd700] shadow-[0_0_16px_rgba(255,215,0,0.4)]" : "border-[color:var(--eve-border)]"}`}
                style={{
                  borderLeftWidth: 3,
                  borderLeftColor: launchSelectedId === mc.id ? "#ffd700" : "#00f5ff",
                }}
              >
                <div className="flex items-start gap-2">
                  {mc.imageUrl && (
                    <div className="w-10 h-10 rounded shrink-0 overflow-hidden bg-white/5 relative">
                      <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-white/10 to-transparent" />
                      <img
                        src={mc.imageUrl}
                        alt={mc.name}
                        className="w-full h-full object-cover relative z-10"
                        onLoad={(e) => {
                          (e.target as HTMLImageElement).previousElementSibling?.remove();
                        }}
                        onError={(e) => {
                          const img = e.target as HTMLImageElement;
                          img.style.display = "none";
                        }}
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="eve-ticker text-[12px] text-[color:var(--eve-text)] font-bold">
                      {mc.name}
                    </span>
                    <span
                      className="text-[11px] font-mono text-[color:var(--eve-accent-a)] font-bold"
                      style={{ fontFamily: "var(--font-eve-mono), monospace" }}
                    >
                      ${mc.ticker}
                    </span>
                    {launchPhase === "countdown" && launchSelectedId === mc.id && launchCountdownSec > 0 && (
                      <span className="ml-auto text-[10px] font-mono font-bold text-[#ffd700] animate-pulse">
                        T-{launchCountdownSec}s
                      </span>
                    )}
                  </div>
                </div>
                {mc.tagline && (
                  <span className="text-[9px] text-[color:var(--eve-muted)] leading-snug">
                    {mc.tagline}
                  </span>
                )}
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[color:var(--eve-accent-a)]"
                      style={{ width: `${mc.viabilityScore}%` }}
                    />
                  </div>
                  <span className="text-[8px] font-mono text-[color:var(--eve-muted)] tabular-nums">
                    {mc.viabilityScore}
                  </span>
                </div>
                {mc.sourceTrends[0] && (
                  <span className="text-[8px] text-[color:var(--eve-muted)]">
                    from: {mc.sourceTrends[0]}
                  </span>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
