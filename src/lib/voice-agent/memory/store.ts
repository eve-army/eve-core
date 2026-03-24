import type { MemoryBundle, MemoryFact, MemoryTurn, TurnRequest } from "@/lib/voice-agent/types";
import { buildRecentChatTranscript } from "@/lib/agent-chat-context";
import type { IMessage } from "@/lib/pumpChatClient";
import {
  fetchPersistentMemoryBundle,
  isPersistentMemoryEnabled,
  recordPersistentTurn,
} from "@/lib/voice-agent/memory/postgres";

type RoomMemoryState = {
  roomSummary: string | null;
  turns: MemoryTurn[];
  facts: MemoryFact[];
};

type UserMemoryState = {
  userSummary: string | null;
  facts: MemoryFact[];
};

const roomMemory = new Map<string, RoomMemoryState>();
const userMemory = new Map<string, UserMemoryState>();

const MAX_TURNS = 80;

type TurnRecordMeta = {
  intent?: string;
  turnKind?: string;
  quality?: unknown;
};

function roomKey(req: TurnRequest): string {
  return req.roomId?.trim() || "default-room";
}

function userKey(req: TurnRequest): string {
  const u = req.username?.trim().toLowerCase();
  return u && u.length > 0 ? `${roomKey(req)}:${u}` : `${roomKey(req)}:anon`;
}

function scoreFact(text: string): number {
  const t = text.toLowerCase();
  if (/\b(don't|dont|never|hate|avoid)\b/.test(t)) return 0.9;
  if (/\b(like|love|prefer|want)\b/.test(t)) return 0.8;
  return 0.45;
}

function extractFactCandidate(text: string): string | null {
  const t = text.trim();
  if (t.length < 12) return null;
  if (!/(prefer|like|love|hate|dont|don't|never|want|please)/i.test(t)) return null;
  return t.slice(0, 220);
}

export async function getMemoryBundle(req: TurnRequest): Promise<MemoryBundle> {
  if (isPersistentMemoryEnabled()) {
    const persistent = await fetchPersistentMemoryBundle(req);
    if (persistent) return persistent;
  }
  const rKey = roomKey(req);
  const uKey = userKey(req);
  const room = roomMemory.get(rKey);
  const user = userMemory.get(uKey);
  return {
    roomSummary: room?.roomSummary ?? null,
    userSummary: user?.userSummary ?? null,
    shortTermTurns: room?.turns.slice(-20) ?? [],
    longTermFacts: [...(room?.facts ?? []), ...(user?.facts ?? [])]
      .sort((a, b) => b.score - a.score)
      .slice(0, 12),
  };
}

export async function recordTurn(
  req: TurnRequest,
  role: "user" | "assistant",
  text: string,
  meta?: TurnRecordMeta,
): Promise<void> {
  if (isPersistentMemoryEnabled()) {
    await recordPersistentTurn(req, role, text, meta?.intent, meta?.turnKind, meta?.quality);
  }
  const rKey = roomKey(req);
  const uKey = userKey(req);

  const room = roomMemory.get(rKey) ?? { roomSummary: null, turns: [], facts: [] };
  room.turns.push({
    role,
    speaker: role === "assistant" ? "Eve" : req.username?.trim() || "anon",
    text: text.trim().slice(0, 600),
    tsIso: new Date().toISOString(),
  });
  if (room.turns.length > MAX_TURNS) room.turns = room.turns.slice(-MAX_TURNS);

  const cand = role === "user" ? extractFactCandidate(text) : null;
  if (cand) {
    room.facts = [
      {
        key: `room-fact-${Date.now()}`,
        value: cand,
        score: scoreFact(cand),
        source: "room" as const,
      },
      ...room.facts,
    ].slice(0, 40);
  }
  roomMemory.set(rKey, room);

  if (role === "user") {
    const user = userMemory.get(uKey) ?? { userSummary: null, facts: [] };
    if (cand) {
      user.facts = [
        {
          key: `user-fact-${Date.now()}`,
          value: cand,
          score: scoreFact(cand),
          source: "user" as const,
        },
        ...user.facts,
      ].slice(0, 25);
    }
    userMemory.set(uKey, user);
  }
}

export function backfillSessionTranscript(
  req: TurnRequest,
  messages: IMessage[],
  aiReplies: Record<string, string>,
): void {
  const transcript = buildRecentChatTranscript(messages, aiReplies);
  if (!transcript) return;
  const rKey = roomKey(req);
  const room = roomMemory.get(rKey) ?? { roomSummary: null, turns: [], facts: [] };
  const lines = transcript.split("\n").slice(-20);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const speaker = line.slice(0, idx).trim();
    const text = line.slice(idx + 1).trim();
    room.turns.push({
      role: /^eve$/i.test(speaker) ? "assistant" : "user",
      speaker,
      text,
      tsIso: new Date().toISOString(),
    });
  }
  room.turns = room.turns.slice(-MAX_TURNS);
  roomMemory.set(rKey, room);
}
