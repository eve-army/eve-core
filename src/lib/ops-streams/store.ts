import { OPS_STREAMS_SQL } from "@/lib/ops-streams/sql";
import type {
  AgentRole,
  OpsStreamRow,
  OpsTelemetrySnapshot,
  TuningProfileId,
} from "@/lib/ops-streams/types";
import { parseTuningProfileId } from "@/lib/ops-streams/types";
import type { MemoryBundle, QualityScores, TurnDecision } from "@/lib/voice-agent/types";

function isPgEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

type PgClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<void>;
};

async function getPgClient(): Promise<PgClientLike | null> {
  if (!isPgEnabled()) return null;
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
    return client;
  } catch {
    return null;
  }
}

type MemRow = {
  displayName: string | null;
  ticker: string | null;
  agentRole: AgentRole;
  tuningProfile: TuningProfileId;
  lastTelemetry: OpsTelemetrySnapshot | null;
  telemetryAt: string | null;
  updatedAt: string;
};

const memoryStreams = new Map<string, MemRow>();

function defaultRow(): MemRow {
  const now = new Date().toISOString();
  return {
    displayName: null,
    ticker: null,
    agentRole: "trend_analyst",
    tuningProfile: "normal",
    lastTelemetry: null,
    telemetryAt: null,
    updatedAt: now,
  };
}

function rowToApi(mint: string, r: MemRow): OpsStreamRow {
  return {
    mint,
    displayName: r.displayName,
    ticker: r.ticker,
    agentRole: r.agentRole,
    tuningProfile: r.tuningProfile,
    lastTelemetry: r.lastTelemetry,
    telemetryAt: r.telemetryAt,
    updatedAt: r.updatedAt,
  };
}

function parseAgentRole(v: unknown): AgentRole {
  return v === "bonding_assistant" ? "bonding_assistant" : "trend_analyst";
}

function parseTelemetryJson(v: unknown): OpsTelemetrySnapshot | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "string" || !o.decision || !o.memory || !o.quality) return null;
  return o as unknown as OpsTelemetrySnapshot;
}

export async function upsertStreamMeta(
  mintRaw: string,
  partial: {
    displayName?: string | null;
    ticker?: string | null;
    agentRole?: AgentRole;
  },
): Promise<void> {
  const mint = mintRaw.trim();
  if (!mint) return;

  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query(OPS_STREAMS_SQL.createTables);
      await pg.query(
        `insert into eve_ops_streams (mint, display_name, ticker, agent_role, updated_at)
         values ($1, $2, $3, coalesce($4::text, 'trend_analyst'), now())
         on conflict (mint) do update set
           display_name = coalesce(excluded.display_name, eve_ops_streams.display_name),
           ticker = coalesce(excluded.ticker, eve_ops_streams.ticker),
           agent_role = coalesce(excluded.agent_role, eve_ops_streams.agent_role),
           updated_at = now()`,
        [
          mint,
          partial.displayName !== undefined ? partial.displayName : null,
          partial.ticker !== undefined ? partial.ticker : null,
          partial.agentRole !== undefined ? partial.agentRole : null,
        ],
      );
    } finally {
      await pg.end?.().catch(() => {});
    }
    return;
  }

  const cur = memoryStreams.get(mint) ?? defaultRow();
  if (partial.displayName !== undefined) cur.displayName = partial.displayName;
  if (partial.ticker !== undefined) cur.ticker = partial.ticker;
  if (partial.agentRole !== undefined) cur.agentRole = partial.agentRole;
  cur.updatedAt = new Date().toISOString();
  memoryStreams.set(mint, cur);
}


export async function getTuningProfile(mintRaw: string): Promise<TuningProfileId> {
  const mint = mintRaw.trim();
  if (!mint) return "normal";

  const pg = await getPgClient();
  if (pg) {
    try {
      const res = await pg.query(
        `select tuning_profile from eve_ops_streams where mint = $1 limit 1`,
        [mint],
      );
      const v = res.rows[0]?.tuning_profile;
      return parseTuningProfileId(String(v ?? "")) ?? "normal";
    } catch {
      return "normal";
    } finally {
      await pg.end?.().catch(() => {});
    }
  }

  return memoryStreams.get(mint)?.tuningProfile ?? "normal";
}

export async function setTuningProfile(mintRaw: string, tuning: TuningProfileId): Promise<boolean> {
  const mint = mintRaw.trim();
  if (!mint) return false;

  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query(OPS_STREAMS_SQL.createTables);
      const res = await pg.query(
        `insert into eve_ops_streams (mint, tuning_profile, updated_at)
         values ($1, $2, now())
         on conflict (mint) do update set tuning_profile = excluded.tuning_profile, updated_at = now()
         returning mint`,
        [mint, tuning],
      );
      return res.rows.length > 0;
    } catch {
      return false;
    } finally {
      await pg.end?.().catch(() => {});
    }
  }

  const cur = memoryStreams.get(mint) ?? defaultRow();
  cur.tuningProfile = tuning;
  cur.updatedAt = new Date().toISOString();
  memoryStreams.set(mint, cur);
  return true;
}

export async function setTelemetry(
  mintRaw: string,
  decision: TurnDecision,
  memory: MemoryBundle,
  quality: QualityScores,
  latencyMs?: number,
): Promise<void> {
  const mint = mintRaw.trim();
  if (!mint) return;

  const snapshot: OpsTelemetrySnapshot = {
    at: new Date().toISOString(),
    decision,
    memory,
    quality,
    latencyMs,
  };

  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query(OPS_STREAMS_SQL.createTables);
      await pg.query(
        `insert into eve_ops_streams (mint, last_telemetry, telemetry_at, updated_at)
         values ($1, $2::jsonb, now(), now())
         on conflict (mint) do update set
           last_telemetry = excluded.last_telemetry,
           telemetry_at = excluded.telemetry_at,
           updated_at = now()`,
        [mint, JSON.stringify(snapshot)],
      );
    } finally {
      await pg.end?.().catch(() => {});
    }
    return;
  }

  const cur = memoryStreams.get(mint) ?? defaultRow();
  cur.lastTelemetry = snapshot;
  cur.telemetryAt = snapshot.at;
  cur.updatedAt = snapshot.at;
  memoryStreams.set(mint, cur);
}

export async function listStreams(): Promise<OpsStreamRow[]> {
  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query(OPS_STREAMS_SQL.createTables);
      const res = await pg.query(
        `select mint, display_name, ticker, agent_role, tuning_profile, last_telemetry, telemetry_at, updated_at
         from eve_ops_streams
         order by updated_at desc`,
      );
      return res.rows.map((r) => ({
        mint: String(r.mint),
        displayName: (r.display_name as string) ?? null,
        ticker: (r.ticker as string) ?? null,
        agentRole: parseAgentRole(r.agent_role),
        tuningProfile: parseTuningProfileId(String(r.tuning_profile)) ?? "normal",
        lastTelemetry: parseTelemetryJson(r.last_telemetry),
        telemetryAt:
          r.telemetry_at instanceof Date
            ? r.telemetry_at.toISOString()
            : r.telemetry_at
              ? String(r.telemetry_at)
              : null,
        updatedAt:
          r.updated_at instanceof Date
            ? r.updated_at.toISOString()
            : String(r.updated_at ?? new Date().toISOString()),
      }));
    } catch {
      return [];
    } finally {
      await pg.end?.().catch(() => {});
    }
  }

  return Array.from(memoryStreams.entries())
    .map(([mint, r]) => rowToApi(mint, r))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getStream(mintRaw: string): Promise<OpsStreamRow | null> {
  const mint = mintRaw.trim();
  if (!mint) return null;

  const pg = await getPgClient();
  if (pg) {
    try {
      const res = await pg.query(
        `select mint, display_name, ticker, agent_role, tuning_profile, last_telemetry, telemetry_at, updated_at
         from eve_ops_streams where mint = $1 limit 1`,
        [mint],
      );
      const r = res.rows[0];
      if (!r) return null;
      return {
        mint: String(r.mint),
        displayName: (r.display_name as string) ?? null,
        ticker: (r.ticker as string) ?? null,
        agentRole: parseAgentRole(r.agent_role),
        tuningProfile: parseTuningProfileId(String(r.tuning_profile)) ?? "normal",
        lastTelemetry: parseTelemetryJson(r.last_telemetry),
        telemetryAt:
          r.telemetry_at instanceof Date
            ? r.telemetry_at.toISOString()
            : r.telemetry_at
              ? String(r.telemetry_at)
              : null,
        updatedAt:
          r.updated_at instanceof Date
            ? r.updated_at.toISOString()
            : String(r.updated_at ?? new Date().toISOString()),
      };
    } catch {
      return null;
    } finally {
      await pg.end?.().catch(() => {});
    }
  }

  const r = memoryStreams.get(mint);
  if (!r) return null;
  return rowToApi(mint, r);
}
