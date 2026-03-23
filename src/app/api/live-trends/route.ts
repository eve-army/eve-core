import { NextResponse } from "next/server";
import {
  DEFAULT_LIVE_TRENDS_URL,
  parseLiveTrendsJson,
} from "@/lib/live-trends";

export const dynamic = "force-dynamic";

/**
 * Optional server-side cache for upstream (seconds). 0 or unset = always revalidate upstream.
 * Set e.g. 10 if the worker is rate-limited.
 */
function upstreamCacheRevalidateSec(): number {
  const raw = process.env.LIVE_TRENDS_CACHE_SEC?.trim();
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export async function GET() {
  const url =
    process.env.LIVE_TRENDS_URL?.trim() || DEFAULT_LIVE_TRENDS_URL;
  const cacheSec = upstreamCacheRevalidateSec();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      ...(cacheSec > 0
        ? { next: { revalidate: cacheSec } }
        : { cache: "no-store" as RequestCache }),
    });
    if (!res.ok) {
      console.error("live-trends upstream", res.status, await res.text().catch(() => ""));
      return NextResponse.json(
        { error: `Upstream ${res.status}`, trends: [] },
        { status: 502 }
      );
    }
    const json = await res.json();
    const trends = parseLiveTrendsJson(json);
    if (process.env.NODE_ENV === "development") {
      console.debug("[live-trends] upstream", {
        count: trends.length,
        cacheSec: cacheSec || "no-store",
      });
    }
    const cc =
      cacheSec > 0
        ? `private, s-maxage=${cacheSec}, stale-while-revalidate=${Math.min(120, cacheSec * 3)}`
        : "private, no-store, must-revalidate";
    return NextResponse.json(
      { trends, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": cc } },
    );
  } catch (e) {
    console.error("live-trends fetch", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed", trends: [] },
      { status: 502 }
    );
  }
}
