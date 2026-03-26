import type { DedupedTrend } from "@/lib/live-trends";
import type { VoiceHighlightSegment } from "@/lib/voice-highlight-timeline";

export type AgentMode = "chat_reply" | "trend_tick" | "vote_summary" | "host_banter";

export type TurnKind =
  | "direct_reply"
  | "clarify"
  | "trend_commentary"
  | "vote_summary"
  | "host_fill"
  | "safety_redirect";

export type IntentKind =
  | "direct_question"
  | "feedback_or_critique"
  | "vote_or_pick_command"
  | "trend_prompt"
  | "generic_hype"
  | "off_topic";

export type TurnRequest = {
  roomId?: string;
  message?: string;
  username?: string;
  skipTTS?: boolean;
  agentMode?: AgentMode;
  liveTrendsDeduped?: DedupedTrend[];
  voteTally?: Record<string, number>;
  voteLeader?: string;
  activeTrendSpeaking?: string | null;
  recentChatTranscript?: string;
  lastAgentSay?: string | null;
  /** Last turn's radar highlight trend — server avoids repeating the same spotlight. */
  lastAgentHighlightTrend?: string | null;
  /**
   * Trend names whose radar row is `change: "new"` vs the prior poll (client diff).
   * Agent should prioritize calling these out; same order as heat-ranked polar when possible.
   */
  newTrendNamesFromRadar?: string[];
  /** Session-scoped trend names already spoken about; client fills from reply text matches. */
  recentlyMentionedTrendNames?: string[];
  streamName?: string;
  isBondedToken?: boolean;
  solUsdPrice?: number | null;
  bondingCurveData?: unknown;
  historicalPriceData?: unknown;
  priceChanges?: {
    change1m?: number | null;
    change5m?: number | null;
    currentMcSol?: number | null;
  };
  varietySeed?: number;
};

export type MemoryFact = {
  key: string;
  value: string;
  score: number;
  source: "room" | "user" | "system";
};

export type MemoryTurn = {
  role: "user" | "assistant" | "system";
  speaker: string;
  text: string;
  tsIso: string;
};

export type MemoryBundle = {
  roomSummary: string | null;
  userSummary: string | null;
  shortTermTurns: MemoryTurn[];
  longTermFacts: MemoryFact[];
};

export type TurnDecision = {
  turnKind: TurnKind;
  intent: IntentKind;
  shouldSpeak: boolean;
  requiresDirectAnswer: boolean;
  focusTrend: string | null;
  reason: string;
};

export type QualityScores = {
  directness: number;
  relevance: number;
  novelty: number;
  memoryUsefulness: number;
  safety: number;
};

export type VoiceTimelineEvent =
  | {
      type: "highlight_segment";
      startSec: number;
      endSec: number;
      trendName: string;
    }
  | {
      type: "subtitle_chunk";
      startSec: number;
      endSec: number;
      text: string;
    };

export type CharacterAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

export type TurnResponse = {
  text: string;
  audio?: string;
  highlightTrendName: string | null;
  highlightTimeline: VoiceHighlightSegment[];
  events: VoiceTimelineEvent[];
  decision: TurnDecision;
  memory: MemoryBundle;
  quality: QualityScores;
  promptVersion: string;
  latencyMs: number;
};
