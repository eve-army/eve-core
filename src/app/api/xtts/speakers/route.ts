import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const baseUrl = process.env.XTTS_BASE_URL;
  if (!baseUrl) {
    return NextResponse.json({ speakers: [] });
  }
  try {
    const res = await fetch(`${baseUrl}/speakers`, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ speakers: [] });
    const data = (await res.json()) as { speakers?: string[] };
    return NextResponse.json({ speakers: data.speakers ?? [] });
  } catch {
    return NextResponse.json({ speakers: [] });
  }
}
