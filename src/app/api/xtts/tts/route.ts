import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/xtts/tts
 * Body: { text: string, speaker_name?: string }
 * Returns: { audio_base64: string } (WAV)
 */
export async function POST(req: NextRequest) {
  const baseUrl = process.env.XTTS_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json({ error: "XTTS_BASE_URL not set" }, { status: 503 });
  }
  try {
    const body = (await req.json()) as { text?: string; speaker_name?: string };
    if (!body.text?.trim()) {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }
    const res = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: body.text,
        speaker_name: body.speaker_name || "Ana Florence",
        language: "en",
      }),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `XTTS ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { audio_base64?: string };
    return NextResponse.json({ audio_base64: data.audio_base64 });
  } catch {
    return NextResponse.json({ error: "XTTS unavailable" }, { status: 502 });
  }
}
