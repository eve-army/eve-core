import type { IntentKind, TurnRequest } from "@/lib/voice-agent/types";

const VOTE_ONLY = /^(?:!vote|!v|!pick)\b/i;

export function classifyIntent(req: TurnRequest): IntentKind {
  const m = (req.message || "").trim();
  if (!m) return "off_topic";
  if (VOTE_ONLY.test(m)) return "vote_or_pick_command";
  if (/\?/.test(m)) return "direct_question";
  if (/\b(bad|wrong|boring|one dimensional|stale|repeat|again)\b/i.test(m)) {
    return "feedback_or_critique";
  }
  if (/\b(trend|ticker|coin|launch|name idea|meme)\b/i.test(m)) return "trend_prompt";
  if (/^(gm|gn|lfg|lol|wow)\b/i.test(m.toLowerCase())) return "generic_hype";
  return "direct_question";
}
