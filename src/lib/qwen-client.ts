/**
 * Global serialized Qwen client.
 * Ollama processes one request at a time — concurrent requests queue and timeout.
 * This module ensures only one request is in flight at any time.
 */

type QwenMessage = { role: string; content: string };

const QWEN_BASE_URL = () => process.env.QWEN_BASE_URL || "https://server.songjam.space";
const QWEN_MODEL = () => process.env.QWEN_MODEL || "qwen2.5:3b";

let pending: Promise<unknown> = Promise.resolve();

async function doFetch(messages: QwenMessage[]): Promise<string> {
  const url = `${QWEN_BASE_URL()}/api/chat`;
  console.log(`[qwen-client] request started (${messages.length} messages)`);
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: QWEN_MODEL(),
      messages,
      stream: false,
      format: "json",
    }),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!res.ok) {
    const err = await res.text();
    console.error(`[qwen-client] error ${res.status} after ${elapsed}s`);
    throw new Error(`Qwen API returned ${res.status}: ${err}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content?.trim() || "";
  console.log(`[qwen-client] response OK after ${elapsed}s (${content.length} chars)`);
  return content;
}

/**
 * Send a chat request to Qwen. Requests are serialized — only one in flight at a time.
 */
export async function qwenChat(messages: QwenMessage[]): Promise<string> {
  const request = pending.then(() => doFetch(messages));
  // Chain: next caller waits for this one to finish (success or failure)
  pending = request.catch(() => {});
  return request;
}

/**
 * Secondary Qwen queue — independent from the primary queue.
 * Use for background tasks (e.g. memecoin ideas) that shouldn't be blocked
 * by the voice agent or other primary callers.
 */
let pendingSecondary: Promise<unknown> = Promise.resolve();

export async function qwenChatSecondary(messages: QwenMessage[]): Promise<string> {
  const request = pendingSecondary.then(() => doFetch(messages));
  pendingSecondary = request.catch(() => {});
  return request;
}
