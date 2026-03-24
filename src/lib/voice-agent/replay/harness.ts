import type { TurnRequest } from "@/lib/voice-agent/types";
import { runTurn } from "@/lib/voice-agent/orchestrator/engine";
import { readFile } from "node:fs/promises";

export type ReplayCase = {
  name: string;
  request: TurnRequest;
};

export type ReplayResult = {
  name: string;
  ok: boolean;
  latencyMs: number;
  directness: number;
  relevance: number;
};

export type ReplaySummary = {
  total: number;
  ok: number;
  failed: number;
  passRate: number;
  avgLatencyMs: number;
  avgDirectness: number;
  avgRelevance: number;
};

function parseReplayLine(line: string): ReplayCase | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t) as Partial<ReplayCase>;
    if (!obj.name || !obj.request) return null;
    return { name: String(obj.name), request: obj.request as TurnRequest };
  } catch {
    return null;
  }
}

export async function loadReplayCasesFromJsonl(path: string): Promise<ReplayCase[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .map(parseReplayLine)
    .filter((x): x is ReplayCase => !!x);
}

export async function runReplay(cases: ReplayCase[]): Promise<ReplayResult[]> {
  const out: ReplayResult[] = [];
  for (const c of cases) {
    try {
      const r = await runTurn({ ...c.request, skipTTS: true });
      out.push({
        name: c.name,
        ok: true,
        latencyMs: r.latencyMs,
        directness: r.quality.directness,
        relevance: r.quality.relevance,
      });
    } catch {
      out.push({
        name: c.name,
        ok: false,
        latencyMs: -1,
        directness: 0,
        relevance: 0,
      });
    }
  }
  return out;
}

export function summarizeReplay(results: ReplayResult[]): ReplaySummary {
  const total = results.length;
  const okRows = results.filter((r) => r.ok);
  const ok = okRows.length;
  const failed = total - ok;
  const sum = (vals: number[]) => vals.reduce((a, b) => a + b, 0);
  return {
    total,
    ok,
    failed,
    passRate: total ? ok / total : 0,
    avgLatencyMs: ok ? sum(okRows.map((r) => r.latencyMs)) / ok : 0,
    avgDirectness: ok ? sum(okRows.map((r) => r.directness)) / ok : 0,
    avgRelevance: ok ? sum(okRows.map((r) => r.relevance)) / ok : 0,
  };
}
