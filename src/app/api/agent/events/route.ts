import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const MAX_EVENT_CLIENTS = Math.max(5, Number(process.env.EVE_EVENTS_MAX_CLIENTS || 50));
const KEEPALIVE_MS = Math.max(5000, Number(process.env.EVE_EVENTS_KEEPALIVE_MS || 15000));
const EVENT_BURST_LIMIT = Math.max(5, Number(process.env.EVE_EVENTS_BURST_LIMIT || 20));

const globalState = globalThis as typeof globalThis & {
  __eveEventClients?: number;
};
if (typeof globalState.__eveEventClients !== "number") {
  globalState.__eveEventClients = 0;
}

/**
 * Compatibility endpoint for future realtime turn/event streaming.
 * For now, we keep the contract and send heartbeat frames.
 */
export async function GET(req: NextRequest) {
  if ((globalState.__eveEventClients || 0) >= MAX_EVENT_CLIENTS) {
    return new Response(
      JSON.stringify({ ok: false, error: "Too many event clients, retry later." }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }
  const encoder = new TextEncoder();
  globalState.__eveEventClients = (globalState.__eveEventClients || 0) + 1;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let sentInWindow = 0;
      let windowStart = Date.now();
      const push = (s: string) => {
        if (closed) return;
        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          sentInWindow = 0;
        }
        if (sentInWindow >= EVENT_BURST_LIMIT) {
          return;
        }
        sentInWindow += 1;
        controller.enqueue(encoder.encode(s));
      };
      push(
        `data: ${JSON.stringify({
          type: "connected",
          ts: Date.now(),
          maxClients: MAX_EVENT_CLIENTS,
          burstPerSec: EVENT_BURST_LIMIT,
        })}\n\n`,
      );
      const id = setInterval(() => {
        push(`: keepalive\n\n`);
      }, KEEPALIVE_MS);
      req.signal.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        clearInterval(id);
        controller.close();
        globalState.__eveEventClients = Math.max(0, (globalState.__eveEventClients || 1) - 1);
      });
    },
    cancel() {
      globalState.__eveEventClients = Math.max(0, (globalState.__eveEventClients || 1) - 1);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Encoding": "none",
      "X-Eve-Event-Clients": String(globalState.__eveEventClients || 0),
    },
  });
}
