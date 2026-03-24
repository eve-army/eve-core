/**
 * Postgres/pgvector adapter scaffold for production deployment.
 * This code path is optional and disabled unless DATABASE_URL exists.
 * It allows a staged migration from in-memory memory to durable retrieval.
 */

import type { MemoryBundle, MemoryFact, MemoryTurn, TurnRequest } from "@/lib/voice-agent/types";

export const MEMORY_SQL = {
  createTables: `
create table if not exists agent_turns (
  id bigserial primary key,
  room_id text not null,
  user_name text,
  role text not null,
  text text not null,
  intent text,
  turn_kind text,
  quality jsonb,
  created_at timestamptz not null default now()
);

create table if not exists room_memory (
  room_id text primary key,
  summary text,
  updated_at timestamptz not null default now()
);

create table if not exists user_memory (
  room_id text not null,
  user_name text not null,
  summary text,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_name)
);

-- enable extension vector; then:
-- create table if not exists memory_embeddings (
--   id bigserial primary key,
--   room_id text not null,
--   user_name text,
--   text text not null,
--   embedding vector(1536) not null,
--   metadata jsonb,
--   created_at timestamptz not null default now()
-- );
`,
};

export function isPersistentMemoryEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

type PgClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<void>;
};

async function getPgClient(): Promise<PgClientLike | null> {
  if (!isPersistentMemoryEnabled()) return null;
  try {
    // Optional runtime dependency; fallback to in-memory when unavailable.
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

function keyForFact(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function coerceScore(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0.5;
}

export async function fetchPersistentMemoryBundle(req: TurnRequest): Promise<MemoryBundle | null> {
  const roomId = req.roomId?.trim() || "default-room";
  const username = req.username?.trim().toLowerCase() || "anon";
  const pg = await getPgClient();
  if (!pg) return null;
  try {
    const [turnsRes, roomRes, userRes, factsRes] = await Promise.all([
      pg.query(
        `select role, user_name, text, created_at
         from agent_turns
         where room_id = $1
         order by created_at desc
         limit 20`,
        [roomId],
      ),
      pg.query(`select summary from room_memory where room_id = $1 limit 1`, [roomId]),
      pg.query(`select summary from user_memory where room_id = $1 and user_name = $2 limit 1`, [roomId, username]),
      pg.query(
        `select role, user_name, text
         from agent_turns
         where room_id = $1 and role = 'user'
         order by created_at desc
         limit 40`,
        [roomId],
      ),
    ]);

    const shortTermTurns: MemoryTurn[] = turnsRes.rows
      .slice()
      .reverse()
      .map((r) => ({
        role: (r.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        speaker: (typeof r.user_name === "string" && r.user_name.trim()) || (r.role === "assistant" ? "Eve" : "anon"),
        text: typeof r.text === "string" ? r.text.slice(0, 600) : "",
        tsIso: r.created_at instanceof Date ? r.created_at.toISOString() : new Date().toISOString(),
      }));

    const longTermFacts: MemoryFact[] = [];
    for (const r of factsRes.rows) {
      const text = typeof r.text === "string" ? r.text.trim() : "";
      if (!text) continue;
      longTermFacts.push({
        key: keyForFact("pg-fact"),
        value: text.slice(0, 220),
        score: coerceScore((r as { score?: unknown }).score),
        source: "room",
      });
      if (longTermFacts.length >= 12) break;
    }

    return {
      roomSummary: (roomRes.rows[0]?.summary as string | undefined) ?? null,
      userSummary: (userRes.rows[0]?.summary as string | undefined) ?? null,
      shortTermTurns,
      longTermFacts,
    };
  } catch {
    return null;
  } finally {
    await pg.end?.().catch(() => {});
  }
}

export async function recordPersistentTurn(
  req: TurnRequest,
  role: "user" | "assistant",
  text: string,
  intent?: string,
  turnKind?: string,
  quality?: unknown,
): Promise<boolean> {
  const roomId = req.roomId?.trim() || "default-room";
  const username = req.username?.trim().toLowerCase() || "anon";
  const pg = await getPgClient();
  if (!pg) return false;
  try {
    await pg.query(MEMORY_SQL.createTables);
    await pg.query(
      `insert into agent_turns (room_id, user_name, role, text, intent, turn_kind, quality)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [roomId, username, role, text.slice(0, 2000), intent ?? null, turnKind ?? null, quality ?? null],
    );
    return true;
  } catch {
    return false;
  } finally {
    await pg.end?.().catch(() => {});
  }
}
