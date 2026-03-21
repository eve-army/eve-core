import { NextRequest } from 'next/server';
import { PumpChatClient } from 'pump-chat-client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const roomId = searchParams.get('roomId');
  const username = searchParams.get('username') || 'Anonymous AI Developer';

  if (!roomId) {
    return new Response('Room ID is required', { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let isClosed = false;

      const safeEnqueue = (data: string) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch (e) {
          isClosed = true;
        }
      };

      const keepAliveInterval = setInterval(() => {
        safeEnqueue(': keepalive\n\n');
      }, 15000);

      const safeClose = () => {
        if (isClosed) return;
        isClosed = true;
        clearInterval(keepAliveInterval);
        try {
          controller.close();
        } catch (e) {}
      };

      const client = new PumpChatClient({
        roomId,
        username,
        messageHistoryLimit: 100,
      });

      // Forward events to the client
      client.on('connected', () => {
        safeEnqueue(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      });

      client.on('message', (message) => {
        safeEnqueue(`data: ${JSON.stringify({ type: 'message', data: message })}\n\n`);
      });

      client.on('messageHistory', (history) => {
        safeEnqueue(`data: ${JSON.stringify({ type: 'messageHistory', data: history })}\n\n`);
      });

      client.on('error', (err) => {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        safeEnqueue(`data: ${JSON.stringify({ type: 'error', data: errorMsg })}\n\n`);
      });

      client.on('disconnected', () => {
        safeEnqueue(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
        // Do not close the SSE connection here, allow pump-chat-client to reconnect automatically
      });

      // Handle client disconnect
      req.signal.addEventListener('abort', () => {
        isClosed = true;
        client.disconnect();
        safeClose();
      });

      // Connect to pump.fun
      try {
        client.connect();
      } catch (err: any) {
        safeEnqueue(`data: ${JSON.stringify({ type: 'error', data: err.message })}\n\n`);
        safeClose();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Content-Encoding': 'none',
    },
  });
}
