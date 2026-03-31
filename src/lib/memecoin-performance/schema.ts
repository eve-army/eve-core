/** SQL for memecoin launch + performance tracking tables. */
export const MEMECOIN_PERF_SQL = {
  createTables: `
CREATE TABLE IF NOT EXISTS memecoin_launches (
  mint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  tagline TEXT,
  image_url TEXT,
  source_trends JSONB,
  viability_score INTEGER,
  heat_score_at_launch NUMERIC,
  sentiment_at_launch TEXT,
  image_description TEXT,
  launched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memecoin_snapshots (
  id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES memecoin_launches(mint),
  mcap_sol NUMERIC,
  mcap_usd NUMERIC,
  bonding_progress NUMERIC,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_mint_time ON memecoin_snapshots(mint, measured_at);
`,
};
