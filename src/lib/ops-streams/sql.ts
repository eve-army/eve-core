/** Ops streams + telemetry; created alongside optional agent memory tables. */
export const OPS_STREAMS_SQL = {
  createTables: `
create table if not exists eve_ops_streams (
  mint text primary key,
  display_name text,
  ticker text,
  agent_role text not null default 'trend_analyst',
  tuning_profile text not null default 'normal',
  last_telemetry jsonb,
  telemetry_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists eve_ops_streams_updated_at_idx on eve_ops_streams (updated_at desc);
`,
};
