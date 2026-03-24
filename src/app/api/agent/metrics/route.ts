import { NextRequest, NextResponse } from "next/server";
import { getMetricsSnapshot, incCounter } from "@/lib/voice-agent/observability/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    metrics: getMetricsSnapshot(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { key?: string };
    const k = body?.key;
    if (typeof k !== "string" || !k.trim()) {
      return NextResponse.json({ ok: false, error: "missing key" }, { status: 400 });
    }
    incCounter(k as Parameters<typeof incCounter>[0]);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
  }
}
