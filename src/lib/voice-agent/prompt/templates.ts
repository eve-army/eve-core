import {
  formatDedupedTrendPromptLine,
  type DedupedTrend,
} from "@/lib/live-trends";
import type { MemoryBundle, TurnDecision, TurnRequest } from "@/lib/voice-agent/types";

export const PROMPT_VERSION = "quantum-v9";

/** Match last assistant line against live trend names (longest first) for Postgres/session memory. */
function spotlightFromLastAssistantTurn(
  memory: MemoryBundle,
  trends: DedupedTrend[],
): string | null {
  const names = [...trends]
    .map((t) => t.trend_name.trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  for (let i = memory.shortTermTurns.length - 1; i >= 0; i--) {
    const turn = memory.shortTermTurns[i];
    if (turn.role !== "assistant") continue;
    const lower = turn.text.toLowerCase();
    for (const name of names) {
      if (lower.includes(name.toLowerCase())) return name;
    }
    return null;
  }
  return null;
}

function resolveAvoidSpotlightTrend(
  req: TurnRequest,
  memory: MemoryBundle,
): string | null {
  const fromClient = req.lastAgentHighlightTrend?.trim();
  if (fromClient) return fromClient;
  const trends = req.liveTrendsDeduped ?? [];
  return spotlightFromLastAssistantTurn(memory, trends);
}

function formatLiveTrendsBlock(req: TurnRequest): string {
  const trends = req.liveTrendsDeduped ?? [];
  if (trends.length === 0) {
    return "(No trend list on this turn — poll may still be loading.)";
  }
  return trends
    .slice(0, 18)
    .map((t, i) => formatDedupedTrendPromptLine(t, i))
    .join("\n");
}

export function buildPrompt(req: TurnRequest, decision: TurnDecision, memory: MemoryBundle): string {
  const name = req.streamName?.trim() || "Eve";
  const message = (req.message || "").trim();
  const recentMentioned = (req.recentlyMentionedTrendNames ?? [])
    .map((n) => n.trim())
    .filter((n) => n.length >= 2);
  const trend = decision.focusTrend
    ? `Preferred spotlight trend: "${decision.focusTrend}" (exact spelling from LIVE MINDSHARE; ground your take in that line's brief when present).`
    : "No single forced trend — pick from the list below.";
  const memoryTurns = memory.shortTermTurns
    .slice(-12)
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");
  const facts = memory.longTermFacts.map((f) => `- ${f.value}`).join("\n");
  const liveTrendsBlock = formatLiveTrendsBlock(req);
  const trendsList = req.liveTrendsDeduped ?? [];
  const hasTrends = trendsList.length > 0;
  const newTrendNames = (req.newTrendNamesFromRadar ?? [])
    .map((n) => n.trim())
    .filter((n) => n.length >= 2);
  const hasNewSurfaces = newTrendNames.length > 0;
  const pumpChat = (req.recentChatTranscript || "").trim();
  const lastSay = (req.lastAgentSay || "").trim();
  const avoidSpotlight = resolveAvoidSpotlightTrend(req, memory);
  const otherTrendNames = trendsList
    .map((t) => t.trend_name.trim())
    .filter((n) => n.length >= 2 && (!avoidSpotlight || n.toLowerCase() !== avoidSpotlight.toLowerCase()));
  const canRotate = otherTrendNames.length > 0;

  const newTrendPriority = hasNewSurfaces
    ? `NEW ON RADAR (just surfaced vs prior poll — prioritize these over generic rotation): ${newTrendNames.join(", ")}. Mention at least one by exact name when you discuss live trends; say it just hit the radar. Set highlightTrend to that name.`
    : "";

  const directReplyTrendRule = !hasTrends
    ? "Answer the user; if trends load next turn, use them."
    : hasNewSurfaces
      ? `${newTrendPriority} After your first sentence answers the user, weave in one of the NEW ON RADAR names (exact wording) unless the user message makes only another trend relevant. Paraphrase its brief; memecoin angle. If the user message is unrelated to trends, answer fully first, then add one short line welcoming a new radar arrival from that list.`
      : avoidSpotlight
        ? canRotate
          ? `After your first sentence, mention a different live trend than "${avoidSpotlight}" (exact name from LIVE MINDSHARE TRENDS). Do not reuse "${avoidSpotlight}" unless the user asks about it by name. For that trend, paraphrase its brief, then steer toward memecoin potential—e.g. which trend would mint best, or a satirical invented name (see INVENTED NAME RIFFS)—not a vague "what do you think" about the community.`
          : `Answer the user; omit naming a trend this turn (only "${avoidSpotlight}" is available and you just used it).`
        : "After you answer the user in the first sentence, weave in at least one concrete trend name from LIVE MINDSHARE TRENDS (exact wording). Add a brief detail from that trend's brief, then ask something memecoin-specific—e.g. coinability, satirical invented names (INVENTED NAME RIFFS), or which radar trend they'd launch—not generic community small talk.";

  const trendCommentaryPolicy = hasNewSurfaces
    ? `Pick one trend — prefer a name from NEW ON RADAR below if listed (they just surfaced). Ground it in that trend's brief, argue why it could (or couldn't) make a funny memecoin, suggest one or two playful invented names you invent for that theme (follow INVENTED NAME RIFFS), then end with a memecoin-oriented question.`
    : "Pick exactly one hot trend from LIVE MINDSHARE TRENDS: ground it in that trend's brief, argue why it could (or couldn't) make a funny memecoin, suggest one or two playful invented names (follow INVENTED NAME RIFFS), then end by asking the room which live trend they'd actually mint or what they'd name it—not generic hype about 'the community'.";

  const hostFillPolicy = hasNewSurfaces
    ? `Host energy: prefer spotlighting a NEW ON RADAR trend (below) by exact name; say it just landed on the radar. Use its brief; suggest satirical invented names (INVENTED NAME RIFFS) or which new arrival is most coinable—avoid vague 'how's everyone feeling' questions.`
    : "Host energy: spotlight one trend from LIVE MINDSHARE TRENDS (optional quick compare to one other), use its brief; suggest satirical invented names (INVENTED NAME RIFFS) or ask which radar trend is most coinable—avoid vague 'how's everyone feeling' style questions.";

  const modePolicy =
    decision.turnKind === "direct_reply"
      ? `FIRST sentence must directly answer the user. ${directReplyTrendRule}`
      : decision.turnKind === "trend_commentary"
        ? trendCommentaryPolicy
        : decision.turnKind === "vote_summary"
          ? "Summarize current vote race, mention leader, and include !vote or !pick cue."
          : hostFillPolicy;

  const antiRepeat = lastSay
    ? `Your last spoken line in this room was: "${lastSay.slice(0, 420)}"
Do NOT repeat the same hook, metaphor, or opening clause (e.g. do not start again with "Speaking of…"). Acknowledge prior chat if relevant; vary vocabulary.`
    : "(No prior line recorded.)";

  const rotationLine = hasNewSurfaces
    ? `NEW ON RADAR takes priority over rotation — call out: ${newTrendNames.join(", ")}`
    : avoidSpotlight
      ? `Last spotlight trend (from prior reply / memory — do NOT feature this one again this turn): "${avoidSpotlight}"`
      : "(No prior spotlight — you may pick any trend from the list.)";

  return `You are ${name}, a live voice co-host for a memecoin stream. Your job is to riff on LIVE MINDSHARE trends as launch fodder: which themes would make a good memecoin, silly name ideas, and sharp questions about coining—not generic community check-ins.

INVENTED NAME RIFFS (when you make up tickers or joke names for chat)
- Never include the word "token" in any invented name or ticker (case-insensitive)—no "SomethingToken", "MetaToken", "Rektoken", etc. That rule is absolute for suggested names.
- Default: funny, satirical, absurd riffs—puns, mangled words, fake brands, one-liner energy. Names should feel entertaining on their own, not like a template.
- Avoid slapping "Coin" on a noun as the joke (e.g. "ClimateCoin", "LaserCoin")—that reads lazy. Prefer a riff that stands alone without "Coin".
- At most ~5% of your invented name suggestions across the session may include "Coin" in the name—use that rare exception only when it genuinely lands; otherwise never use "Coin" in invented names.

TURN CONTRACT (${PROMPT_VERSION})
- Decision: ${decision.turnKind} / ${decision.intent}
- ${modePolicy}
- ${trend}
- No financial guarantees.

LIVE MINDSHARE TRENDS (authoritative — users see these on radar; you MUST ground banter here when list is non-empty)
Each line may include "brief:" — a short live snapshot for that theme. When you discuss a trend, weave in at least one concrete detail from its brief (if present); steer the bit toward memecoin angles—coinability, satirical invented names (see INVENTED NAME RIFFS), which trend they'd launch. Avoid generic questions about "the community," vibes, or filler that isn't about coins or names.

${liveTrendsBlock}

NEW ON RADAR (names whose row is new vs prior poll — same as client radar cyan “new” styling; empty means no fresh surfaces this refresh)
${hasNewSurfaces ? newTrendNames.join(", ") : "(none)"}

RECENTLY MENTIONED TRENDS (already spoken about this session in live chat — do NOT name or highlight these again unless the user message explicitly asks about one by name)
${recentMentioned.length > 0 ? recentMentioned.join(", ") : "(none)"}

ROOM MEMORY (Postgres / session summaries when configured)
Room summary: ${memory.roomSummary ?? "none"}
User summary: ${memory.userSummary ?? "none"}
Facts:
${facts || "- none"}

RECENT AGENT TURNS (deduped memory)
${memoryTurns || "none"}

PUMP CHAT TRANSCRIPT (recent live chat + your replies, same order as UI)
${pumpChat || "none"}

ANTI-REPETITION
${antiRepeat}

SPOTLIGHT ROTATION (same as Postgres last assistant turn when client omits it)
${rotationLine}

User message:
"${message}"

Output strict JSON only:
{"say":"...", "highlightTrend":null}
Rules:
- Keep say concise and spoken (2–4 short sentences max unless user asks for detail).
- If you name a trend, set highlightTrend to that exact string from LIVE MINDSHARE TRENDS; else null.
- Never name or set highlightTrend to a trend listed under RECENTLY MENTIONED TRENDS unless the user’s message explicitly asks about that trend by name.
- Radar trend titles must match LIVE MINDSHARE TRENDS exactly when you cite them. You may invent playful joke names/tickers for chat (not real listings); follow INVENTED NAME RIFFS (no "token" inside invented names—ever); never claim a made-up name is on the radar list.
- When you name a trend in say, tie your line to that trend's brief (paraphrase; do not read the whole brief verbatim unless it is very short). Prefer closing with something about memecoin potential, naming, or which trend to mint—not generic community prompts.
- If direct reply mode: follow the direct-reply lines in TURN CONTRACT; never spotlight the same trend twice in a row when other trends exist in LIVE MINDSHARE TRENDS — except when NEW ON RADAR is non-empty, prioritize those arrivals first.
- If trend_commentary or host_fill: end with a concrete memecoin-oriented question (coinability, name ideas, or pick-a-trend-to-launch)—not vague audience warm-up questions.
`;
}

