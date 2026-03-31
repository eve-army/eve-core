"use client";

import React, { useEffect, useRef } from "react";

const PARTICLE_COUNT = 250;
const DPR_CAP = 2;

// Simplex-like noise (fast hash-based)
function noise2D(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

function flowAngle(x: number, y: number, t: number, scale: number): number {
  const nx = x * scale + t * 0.15;
  const ny = y * scale + t * 0.12;
  return noise2D(nx, ny) * Math.PI * 2;
}

type Particle = {
  x: number;
  y: number;
  speed: number;
  hue: number;
  alpha: number;
  size: number;
};

type Props = {
  className?: string;
  launchPhase?: string;
  speechPulse?: number;
};

export default function BackgroundFlowField({ className = "", launchPhase = "idle", speechPulse = 0 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ w: 1920, h: 1080 });
  const particlesRef = useRef<Particle[]>([]);

  // Initialize particles
  useEffect(() => {
    const particles: Particle[] = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random(),
        y: Math.random(),
        speed: 0.2 + Math.random() * 0.5,
        hue: [190, 330, 45][i % 3], // cyan, pink, gold
        alpha: 0.02 + Math.random() * 0.05,
        size: 0.5 + Math.random() * 1.5,
      });
    }
    particlesRef.current = particles;
  }, []);

  // Resize
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
  useEffect(() => {
    let raf: number;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) { raf = requestAnimationFrame(draw); return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { raf = requestAnimationFrame(draw); return; }

      const dpr = Math.min(devicePixelRatio, DPR_CAP);
      const { w, h } = sizeRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Fade trail (creates motion blur effect)
      ctx.fillStyle = "rgba(5,8,18,0.08)";
      ctx.fillRect(0, 0, w, h);

      const t = performance.now() / 1000;
      const isCountdown = launchPhase === "countdown";
      const isSuccess = launchPhase === "success";
      const speedMult = 1 + speechPulse * 1.5 + (isCountdown ? 2 : 0) + (isSuccess ? 3 : 0);
      const scale = 0.003;
      const cx = w / 2;
      const cy = h / 2;

      for (const p of particlesRef.current) {
        const px = p.x * w;
        const py = p.y * h;
        const angle = flowAngle(p.x, p.y, t, scale);

        // During countdown: converge toward center
        let dx = Math.cos(angle) * p.speed * speedMult;
        let dy = Math.sin(angle) * p.speed * speedMult;
        if (isCountdown) {
          const toCx = (cx - px) * 0.002;
          const toCy = (cy - py) * 0.002;
          dx += toCx;
          dy += toCy;
        }

        p.x += dx / w;
        p.y += dy / h;

        // Wrap around edges
        if (p.x < 0) p.x = 1;
        if (p.x > 1) p.x = 0;
        if (p.y < 0) p.y = 1;
        if (p.y > 1) p.y = 0;

        // Draw
        const alpha = p.alpha + speechPulse * 0.03 + (isSuccess ? 0.08 : 0);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `hsla(${p.hue}, 85%, 60%, 1)`;
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [launchPhase, speechPulse]);

  return (
    <div ref={containerRef} className={`fixed inset-0 pointer-events-none ${className}`} style={{ zIndex: 0 }}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    </div>
  );
}
