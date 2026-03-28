/**
 * Generates rolling summaries of conversation sessions using Qwen.
 * Called asynchronously after every N turns — never blocks a response.
 */

import type { MemoryTurn } from "@/lib/voice-agent/types";

const QWEN_BASE_URL = () => process.env.QWEN_BASE_URL || "https://server.songjam.space";
const QWEN_MODEL = () => process.env.QWEN_MODEL || "qwen2.5:3b";

async function callQwen(prompt: string): Promise<string> {
  try {
    const res = await fetch(`${QWEN_BASE_URL()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: QWEN_MODEL(),
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content?.trim() || "";
  } catch {
    return "";
  }
}

export async function summarizeRoom(
  turns: MemoryTurn[],
  existingSummary: string | null,
): Promise<string> {
  if (turns.length === 0) return existingSummary || "";
  const transcript = turns
    .slice(-20)
    .map((t) => `${t.speaker}: ${t.text}`)
    .join("\n");
  const prior = existingSummary ? `Prior summary: ${existingSummary}\n\n` : "";
  const prompt = `${prior}You are summarising a live crypto stream conversation involving an AI host called Eve.
Given these recent exchanges, write a concise 2-3 sentence summary capturing:
- What topics or tokens were discussed
- Any notable moments, questions, or reactions from viewers
- The general energy/mood of the conversation

Be factual and specific. No filler phrases.

Exchanges:
${transcript}

Summary:`;
  return callQwen(prompt);
}

export async function summarizeUser(
  username: string,
  turns: MemoryTurn[],
  existingSummary: string | null,
): Promise<string> {
  if (turns.length === 0) return existingSummary || "";
  const messages = turns
    .filter((t) => t.role === "user")
    .slice(-15)
    .map((t) => t.text)
    .join("\n");
  const prior = existingSummary ? `Prior context: ${existingSummary}\n\n` : "";
  const prompt = `${prior}Summarise what you know about the viewer "${username}" based on their messages in a crypto stream chat.
Include: what tokens/trends they seem interested in, questions they've asked, their apparent knowledge level, and personality if apparent.
Keep it to 1-2 sentences. Be specific, no filler.

Their messages:
${messages}

Summary:`;
  return callQwen(prompt);
}
