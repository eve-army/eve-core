"use client";

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { MemecoinIdea } from "@/lib/memecoin-ideas";

// Confetti particle
type Confetti = { x: number; y: number; vx: number; vy: number; rot: number; rotSpeed: number; color: string; size: number; life: number };

const CONFETTI_COLORS = ["#00f5ff", "#ffd700", "#ff2d95", "#3cff9a", "#d4ff00", "#fff"];
const CONFETTI_COUNT = 120;

type Props = {
  visible: boolean;
  idea: MemecoinIdea | null;
  mint: string | null;
  signature: string | null;
  onDismiss?: () => void;
};

function ConfettiCanvas({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Confetti[]>([]);

  useEffect(() => {
    if (!active) { particlesRef.current = []; return; }
    const ps: Confetti[] = [];
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      ps.push({
        x: Math.random() * window.innerWidth,
        y: -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * 4,
        vy: 2 + Math.random() * 4,
        rot: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 10,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        size: 4 + Math.random() * 6,
        life: 1,
      });
    }
    particlesRef.current = ps;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf: number;

    const draw = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of particlesRef.current) {
        if (p.life <= 0) continue;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05; // gravity
        p.rot += p.rotSpeed;
        p.life -= 0.003;

        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[60]" />;
}

export default function LaunchResultOverlay({ visible, idea, mint, signature, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);

  const copyMint = () => {
    if (!mint) return;
    navigator.clipboard.writeText(mint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <>
      <ConfettiCanvas active={visible && !!mint} />
      <AnimatePresence>
        {visible && idea && mint && (
          <motion.div
            key="launch-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            onClick={onDismiss}
          >
            {/* Backdrop with radial glow */}
            <div className="absolute inset-0 bg-black/80 backdrop-blur-md" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,215,0,0.08)_0%,transparent_60%)]" />

            {/* Content */}
            <motion.div
              initial={{ scale: 0.5, y: 40, filter: "blur(10px)" }}
              animate={{ scale: 1, y: 0, filter: "blur(0px)" }}
              exit={{ scale: 0.9, y: -20, filter: "blur(5px)" }}
              transition={{ type: "spring", stiffness: 200, damping: 20 }}
              className="relative z-10 flex flex-col items-center gap-5 px-10 py-8 max-w-lg text-center"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Token image with glow ring */}
              {idea.imageUrl && (
                <motion.img
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 200, damping: 15, delay: 0.2 }}
                  src={idea.imageUrl}
                  alt={idea.name}
                  className="w-28 h-28 rounded-2xl object-cover ring-4 ring-[#3cff9a] shadow-[0_0_60px_rgba(60,255,154,0.5)]"
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    const fallback = `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(idea.ticker)}`;
                    if (img.src !== fallback) img.src = fallback;
                  }}
                />
              )}

              {/* Name — massive gradient text */}
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-[#00f5ff] via-[#ffd700] to-[#ff2d95] bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(255,215,0,0.4)]"
              >
                {idea.name}
              </motion.h2>

              {/* Ticker */}
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="text-2xl font-mono font-bold text-[#00f5ff] drop-shadow-[0_0_20px_rgba(0,245,255,0.5)]"
              >
                ${idea.ticker}
              </motion.p>

              {/* Status badge */}
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.6 }}
                className="flex items-center gap-2 rounded-full bg-[#3cff9a]/20 border-2 border-[#3cff9a]/60 px-6 py-2 shadow-[0_0_30px_rgba(60,255,154,0.3)]"
              >
                <span className="h-3 w-3 rounded-full bg-[#3cff9a] animate-pulse" />
                <span className="text-base font-bold text-[#3cff9a] tracking-wide">LAUNCHED ON PUMP.FUN</span>
              </motion.div>

              {/* Tagline */}
              {idea.tagline && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.7 }}
                  className="text-base text-zinc-300 italic"
                >
                  {idea.tagline}
                </motion.p>
              )}

              {/* Pump.fun link — big and prominent */}
              <motion.a
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.8 }}
                href={`https://pump.fun/coin/${mint}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-lg text-[#00f5ff] font-bold underline underline-offset-4 hover:text-white transition drop-shadow-[0_0_10px_rgba(0,245,255,0.4)]"
              >
                View on pump.fun
              </motion.a>

              {/* Mint address */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.9 }}
                className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-2.5 border border-white/10"
              >
                <span className="text-sm font-mono text-zinc-400">
                  {mint.slice(0, 16)}...{mint.slice(-8)}
                </span>
                <button
                  onClick={copyMint}
                  className="text-sm font-bold text-[#00f5ff] hover:text-white transition px-2 py-1 rounded bg-white/5 hover:bg-white/10"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </motion.div>

              {/* Signature */}
              {signature && (
                <a
                  href={`https://solscan.io/tx/${signature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition"
                >
                  TX: {signature.slice(0, 16)}...
                </a>
              )}

              <p className="text-xs text-zinc-600 mt-3">Click anywhere to dismiss</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
