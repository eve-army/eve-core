import type { MemoryBundle, QualityScores, TurnDecision } from "@/lib/voice-agent/types";

export type TuningProfileId = "quiet" | "normal" | "high_traffic";

export type AgentRole = "trend_analyst" | "bonding_assistant";

export const TUNING_PROFILE_IDS: TuningProfileId[] = ["quiet", "normal", "high_traffic"];

export function parseTuningProfileId(v: string | undefined | null): TuningProfileId | null {
  if (!v || typeof v !== "string") return null;
  const x = v.trim() as TuningProfileId;
  return TUNING_PROFILE_IDS.includes(x) ? x : null;
}

export type OpsTelemetrySnapshot = {
  at: string;
  decision: TurnDecision;
  memory: MemoryBundle;
  quality: QualityScores;
  latencyMs?: number;
};

export type OpsStreamRow = {
  mint: string;
  displayName: string | null;
  ticker: string | null;
  agentRole: AgentRole;
  tuningProfile: TuningProfileId;
  lastTelemetry: OpsTelemetrySnapshot | null;
  telemetryAt: string | null;
  updatedAt: string;
};
