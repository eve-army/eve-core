import { recordSnapshot } from "./db";

/**
 * Schedule performance snapshots for a launched memecoin.
 * Snapshots at: 1min, 5min, 15min, 1hr, 6hr, 24hr after launch.
 */
export function scheduleSnapshots(mint: string): void {
  const intervals = [
    1 * 60_000,        // 1 min
    5 * 60_000,        // 5 min
    15 * 60_000,       // 15 min
    60 * 60_000,       // 1 hr
    6 * 60 * 60_000,   // 6 hr
    24 * 60 * 60_000,  // 24 hr
  ];

  for (const delay of intervals) {
    setTimeout(() => void captureSnapshot(mint), delay);
  }

  console.log(`[memecoin-perf] scheduled ${intervals.length} snapshots for ${mint.slice(0, 8)}...`);
}

async function captureSnapshot(mint: string): Promise<void> {
  try {
    // Fetch MCap via internal API (uses Moralis)
    const metricsRes = await fetch(
      `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/api/token/metrics?mint=${mint}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    let mcapSol: number | undefined;
    let mcapUsd: number | undefined;

    if (metricsRes.ok) {
      const data = (await metricsRes.json()) as { mcSol?: number; mcapUsd?: number };
      mcapSol = data.mcSol;
      mcapUsd = data.mcapUsd;
    }

    // Fetch bonding progress via Pump SDK (best-effort)
    let bondingProgress: number | undefined;
    try {
      const bondRes = await fetch(
        `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/api/token/metrics?mint=${mint}&bonding=1`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (bondRes.ok) {
        const bd = (await bondRes.json()) as { bondingProgress?: number };
        bondingProgress = bd.bondingProgress;
      }
    } catch { /* best-effort */ }

    await recordSnapshot({ mint, mcapSol, mcapUsd, bondingProgress });
    console.log(`[memecoin-perf] snapshot for ${mint.slice(0, 8)}...: mcap=$${mcapUsd?.toFixed(0) ?? "?"}`);
  } catch (e) {
    console.error(`[memecoin-perf] snapshot failed for ${mint.slice(0, 8)}...:`, e instanceof Error ? e.message : e);
  }
}
