import type { MemoryBundle, TurnDecision, TurnRequest } from "@/lib/voice-agent/types";

export const PROMPT_VERSION = "quantum-v1";

export function buildPrompt(req: TurnRequest, decision: TurnDecision, memory: MemoryBundle): string {
  const name = req.streamName?.trim() || "Eve";
  const message = (req.message || "").trim();
  const trend = decision.focusTrend ? `Focus trend: "${decision.focusTrend}".` : "No forced trend focus.";
  const memoryTurns = memory.shortTermTurns
    .slice(-12)
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");
  const facts = memory.longTermFacts.map((f) => `- ${f.value}`).join("\n");

  const modePolicy =
    decision.turnKind === "direct_reply"
      ? "FIRST sentence must directly answer the user message. Trend commentary is optional and secondary."
      : decision.turnKind === "trend_commentary"
        ? "Discuss exactly one hot trend, include one concrete launch angle/ticker, and end with a direct audience prompt."
        : decision.turnKind === "vote_summary"
          ? "Summarize current vote race, mention leader, and include !vote or !pick cue."
          : "Keep momentum with host energy, spotlight one trend (optionally mention one challenger), and ask one direct question.";

  return `You are ${name}, a live voice co-host for a memecoin stream.

TURN CONTRACT (${PROMPT_VERSION})
- Decision: ${decision.turnKind} / ${decision.intent}
- ${modePolicy}
- ${trend}
- No financial guarantees.

ROOM MEMORY
Room summary: ${memory.roomSummary ?? "none"}
User summary: ${memory.userSummary ?? "none"}
Facts:
${facts || "- none"}

RECENT TURNS
${memoryTurns || "none"}

User message:
"${message}"

Output strict JSON only:
{"say":"...", "highlightTrend":null}
Rules:
- Keep say concise and spoken.
- If one clear trend is central, set highlightTrend to exact trend text; else null.
- If direct reply mode: begin by addressing the user's statement/question explicitly.
- If trend_commentary or host_fill: include one explicit audience CTA (question mark, !vote, or !pick).
`;
}

