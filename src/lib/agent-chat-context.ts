import type { IMessage } from "@/lib/pumpChatClient";
import { isPumpSpamScamMessage } from "@/lib/pump-chat-filters";

const SYNTHETIC_USERNAMES = new Set(
  ["trendradar", "votebooth", "hostfill", "eve"].map((s) => s.toLowerCase()),
);

const VOTE_ONLY = /^(?:!vote|!v|!pick)\b/i;
const JUNK_ONEWORD = /^(lfg|gm|gn|wow|lol|lmao)$/i;

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export type BuildTranscriptOptions = {
  /** Max chat lines (user + optional Eve lines count toward this). Default 20. */
  maxLines?: number;
  /** Max total characters. Default 2500. */
  maxChars?: number;
  /** Max chars per user message line. Default 200. */
  lineTrunc?: number;
  /** Max chars per Eve reply line. Default 280. */
  eveTrunc?: number;
};

/**
 * Bounded transcript for the voice agent: recent pump chat + Eve replies keyed by message id.
 * Oldest first. Skips synthetic triggers, vote-only, spam, and ultra-short junk.
 */
export function buildRecentChatTranscript(
  messages: IMessage[],
  aiReplies: Record<string, string>,
  opts?: BuildTranscriptOptions,
): string | null {
  const maxLines = opts?.maxLines ?? 20;
  const maxChars = opts?.maxChars ?? 2500;
  const lineTrunc = opts?.lineTrunc ?? 200;
  const eveTrunc = opts?.eveTrunc ?? 280;

  const slice = messages.slice(-40);
  const lines: string[] = [];

  for (const msg of slice) {
    if (lines.length >= maxLines) break;
    const u = (msg.username || "anon").trim();
    const uLow = u.toLowerCase();
    if (SYNTHETIC_USERNAMES.has(uLow)) continue;

    const trimmed = msg.message.trim();
    if (trimmed.length <= 3) continue;
    if (VOTE_ONLY.test(trimmed)) continue;
    if (isPumpSpamScamMessage(trimmed)) continue;
    if (JUNK_ONEWORD.test(trimmed)) continue;

    lines.push(`${u}: ${truncate(trimmed, lineTrunc)}`);

    const eve = aiReplies[msg.id];
    if (typeof eve === "string" && eve.trim() && lines.length < maxLines) {
      lines.push(`Eve: ${truncate(eve.trim(), eveTrunc)}`);
    }
  }

  if (lines.length === 0) return null;

  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    const firstNl = out.indexOf("\n");
    if (firstNl > 0 && firstNl < 80) out = out.slice(firstNl + 1);
  }
  return out;
}
