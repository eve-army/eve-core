"use client";

import { useCallback, useEffect, useState } from "react";
import type { OpsStreamRow, TuningProfileId } from "@/lib/ops-streams/types";
import type { ReplaySummary } from "@/lib/voice-agent/replay/harness";

export function OpsConsolePageClient() {
  const [streams, setStreams] = useState<OpsStreamRow[]>([]);
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpsStreamRow | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayErr, setReplayErr] = useState<string | null>(null);
  const [replaySummary, setReplaySummary] = useState<ReplaySummary | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const r = await fetch("/api/ops/streams", { credentials: "include" });
      const d = (await r.json()) as { streams?: OpsStreamRow[]; error?: string };
      if (!r.ok) {
        setListErr(d.error || `HTTP ${r.status}`);
        return;
      }
      setListErr(null);
      if (Array.isArray(d.streams)) setStreams(d.streams);
    } catch {
      setListErr("Failed to load streams");
    }
  }, []);

  const refreshDetail = useCallback(async (mint: string) => {
    try {
      const r = await fetch(`/api/ops/streams/${encodeURIComponent(mint)}`, {
        credentials: "include",
      });
      if (!r.ok) return;
      const d = (await r.json()) as { stream?: OpsStreamRow };
      if (d.stream) setDetail(d.stream);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshList();
    const id = window.setInterval(() => void refreshList(), 8000);
    return () => window.clearInterval(id);
  }, [refreshList]);

  useEffect(() => {
    if (!selectedMint) {
      setDetail(null);
      return;
    }
    void refreshDetail(selectedMint);
    const id = window.setInterval(() => void refreshDetail(selectedMint), 3000);
    return () => window.clearInterval(id);
  }, [selectedMint, refreshDetail]);

  useEffect(() => {
    if (streams.length === 0) {
      setSelectedMint(null);
      return;
    }
    if (!selectedMint || !streams.some((s) => s.mint === selectedMint)) {
      setSelectedMint(streams[0]!.mint);
    }
  }, [streams, selectedMint]);

  async function saveTuning(mint: string, tuning: TuningProfileId) {
    await fetch(`/api/ops/streams/${encodeURIComponent(mint)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tuningProfile: tuning }),
    });
    void refreshDetail(mint);
  }

  async function runReplaySample() {
    setReplayBusy(true);
    setReplayErr(null);
    try {
      const res = await fetch("/api/agent/replay", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetPath: "data/replay/sample.jsonl" }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        summary?: ReplaySummary;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Replay run failed");
      }
      setReplaySummary(data.summary ?? null);
    } catch (e) {
      setReplayErr(e instanceof Error ? e.message : "Replay failed");
    } finally {
      setReplayBusy(false);
    }
  }

  const tel = detail?.lastTelemetry;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-lg font-semibold text-white">Streams</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Registered when agents run against a mint. Tune autonomy and inspect last turn telemetry.
        </p>
        {listErr ? <p className="text-sm text-red-400 mt-2">{listErr}</p> : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 rounded-xl border border-white/10 bg-black/30 overflow-hidden">
          <div className="px-3 py-2 border-b border-white/10 text-xs uppercase tracking-wider text-zinc-500">
            Active mints
          </div>
          <ul className="max-h-[420px] overflow-y-auto">
            {streams.length === 0 ? (
              <li className="px-3 py-4 text-sm text-zinc-500">No streams yet — start an agent on /eve.</li>
            ) : (
              streams.map((s) => (
                <li key={s.mint}>
                  <button
                    type="button"
                    onClick={() => setSelectedMint(s.mint)}
                    className={`w-full text-left px-3 py-2.5 text-sm border-b border-white/5 hover:bg-white/5 ${
                      selectedMint === s.mint ? "bg-cyan-500/10 border-l-2 border-l-cyan-400" : ""
                    }`}
                  >
                    <div className="font-mono text-xs text-cyan-200/90 truncate" title={s.mint}>
                      {s.displayName || s.ticker || s.mint.slice(0, 8) + "…"}
                    </div>
                    <div className="text-[10px] text-zinc-500 truncate">{s.mint}</div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!detail && selectedMint ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : !detail ? (
            <p className="text-sm text-zinc-500">Select a stream.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 justify-between">
                <div>
                  <h2 className="text-white font-medium">{detail.displayName || "Unnamed"}</h2>
                  <p className="text-xs font-mono text-zinc-500 break-all">{detail.mint}</p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] uppercase tracking-wider text-zinc-500">Autonomy</label>
                  <select
                    value={detail.tuningProfile}
                    onChange={(e) => {
                      const v = e.target.value as TuningProfileId;
                      void saveTuning(detail.mint, v);
                    }}
                    className="bg-black/50 border border-white/15 rounded px-2 py-1 text-xs text-zinc-200"
                  >
                    <option value="quiet">Quiet Room</option>
                    <option value="normal">Normal Room</option>
                    <option value="high_traffic">High Traffic</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-400">Turn Rationale</p>
                  <p className="text-xs text-zinc-200 mt-1">
                    {tel
                      ? `${tel.decision.turnKind} / ${tel.decision.intent} · ${tel.decision.reason}`
                      : "—"}
                  </p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-400">Memory Chips</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(tel?.memory?.longTermFacts ?? []).slice(0, 6).map((f, i) => (
                      <span
                        key={`${f.key}-${i}-${f.value.slice(0, 12)}`}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-500/15 border border-fuchsia-500/30 text-fuchsia-200"
                        title={f.value}
                      >
                        {f.value.slice(0, 36)}
                      </span>
                    ))}
                    {(!tel?.memory?.longTermFacts || tel.memory.longTermFacts.length === 0) && (
                      <span className="text-xs text-zinc-500">No memory facts yet</span>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-400">Quality</p>
                  <p className="text-xs text-zinc-200 mt-1">
                    {tel?.quality
                      ? `d ${tel.quality.directness.toFixed(2)} · r ${tel.quality.relevance.toFixed(2)} · n ${tel.quality.novelty.toFixed(2)}`
                      : "—"}
                  </p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-400">Replay</p>
                    <button
                      type="button"
                      onClick={() => void runReplaySample()}
                      disabled={replayBusy}
                      className="text-[10px] px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50"
                    >
                      {replayBusy ? "Running…" : "Run sample"}
                    </button>
                  </div>
                  <p className="text-xs text-zinc-200 mt-1">
                    {replaySummary
                      ? `${Math.round(replaySummary.passRate * 100)}% pass · ${Math.round(replaySummary.avgLatencyMs)}ms · d ${replaySummary.avgDirectness.toFixed(2)}`
                      : "No replay run yet"}
                  </p>
                  {replayErr ? <p className="text-[10px] text-red-400 mt-1">{replayErr}</p> : null}
                </div>
              </div>
              {detail.telemetryAt ? (
                <p className="text-[10px] text-zinc-600">Last telemetry: {detail.telemetryAt}</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
