import { MEMECOIN_PERF_SQL } from "./schema";

type PgClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<void>;
};

let initialized = false;

async function getPgClient(): Promise<PgClientLike | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
    const mod = (await dynamicImport("pg")) as {
      Client: new (cfg: { connectionString: string; ssl?: { rejectUnauthorized: boolean } }) => PgClientLike & {
        connect: () => Promise<void>;
      };
    };
    const client = new mod.Client({
      connectionString: process.env.DATABASE_URL!,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();

    if (!initialized) {
      await client.query(MEMECOIN_PERF_SQL.createTables);
      initialized = true;
      console.log("[memecoin-perf] tables initialized");
    }

    return client;
  } catch (e) {
    console.error("[memecoin-perf] DB connection failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export type LaunchRecord = {
  mint: string;
  name: string;
  ticker: string;
  tagline?: string;
  imageUrl?: string;
  sourceTrends?: Array<{ trend_name: string; heat_score?: number; sentiment?: string }>;
  viabilityScore?: number;
  heatScoreAtLaunch?: number;
  sentimentAtLaunch?: string;
  imageDescription?: string;
};

export async function recordLaunch(record: LaunchRecord): Promise<boolean> {
  const client = await getPgClient();
  if (!client) return false;
  try {
    await client.query(
      `INSERT INTO memecoin_launches (mint, name, ticker, tagline, image_url, source_trends, viability_score, heat_score_at_launch, sentiment_at_launch, image_description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (mint) DO NOTHING`,
      [
        record.mint,
        record.name,
        record.ticker,
        record.tagline || null,
        record.imageUrl || null,
        record.sourceTrends ? JSON.stringify(record.sourceTrends) : null,
        record.viabilityScore ?? null,
        record.heatScoreAtLaunch ?? null,
        record.sentimentAtLaunch || null,
        record.imageDescription || null,
      ],
    );
    console.log(`[memecoin-perf] recorded launch: ${record.ticker} (${record.mint.slice(0, 8)}...)`);
    return true;
  } catch (e) {
    console.error("[memecoin-perf] recordLaunch failed:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    await client.end?.();
  }
}

export type SnapshotRecord = {
  mint: string;
  mcapSol?: number;
  mcapUsd?: number;
  bondingProgress?: number;
};

export async function recordSnapshot(record: SnapshotRecord): Promise<boolean> {
  const client = await getPgClient();
  if (!client) return false;
  try {
    await client.query(
      `INSERT INTO memecoin_snapshots (mint, mcap_sol, mcap_usd, bonding_progress)
       VALUES ($1, $2, $3, $4)`,
      [record.mint, record.mcapSol ?? null, record.mcapUsd ?? null, record.bondingProgress ?? null],
    );
    return true;
  } catch (e) {
    console.error("[memecoin-perf] recordSnapshot failed:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    await client.end?.();
  }
}

export async function getLaunchWithSnapshots(mint: string) {
  const client = await getPgClient();
  if (!client) return null;
  try {
    const { rows: launches } = await client.query(
      `SELECT * FROM memecoin_launches WHERE mint = $1`, [mint],
    );
    if (launches.length === 0) return null;
    const { rows: snapshots } = await client.query(
      `SELECT * FROM memecoin_snapshots WHERE mint = $1 ORDER BY measured_at`, [mint],
    );
    return { launch: launches[0], snapshots };
  } catch {
    return null;
  } finally {
    await client.end?.();
  }
}

export async function getAllLaunches() {
  const client = await getPgClient();
  if (!client) return [];
  try {
    const { rows } = await client.query(
      `SELECT l.*, s.mcap_sol AS latest_mcap_sol, s.mcap_usd AS latest_mcap_usd, s.bonding_progress AS latest_bonding
       FROM memecoin_launches l
       LEFT JOIN LATERAL (
         SELECT mcap_sol, mcap_usd, bonding_progress FROM memecoin_snapshots
         WHERE mint = l.mint ORDER BY measured_at DESC LIMIT 1
       ) s ON true
       ORDER BY l.launched_at DESC
       LIMIT 100`,
    );
    return rows;
  } catch {
    return [];
  } finally {
    await client.end?.();
  }
}
