import { NextRequest, NextResponse } from "next/server";
import { sendDeployTriggerToAgent } from "@/lib/deployAgentClient";
import { recordLaunch } from "@/lib/memecoin-performance/db";
import { scheduleSnapshots } from "@/lib/memecoin-performance/poller";

export const dynamic = "force-dynamic";

// Rate limit: one launch per 5 minutes
let lastLaunchAt = 0;
const RATE_LIMIT_MS = 5 * 60_000;

/**
 * POST /api/launch-memecoin
 * Body: { name, ticker, description, imageUrl }
 * Public-facing route — injects xCommunityUrl from env server-side.
 */
export async function POST(req: NextRequest) {
  const now = Date.now();
  if (now - lastLaunchAt < RATE_LIMIT_MS) {
    return NextResponse.json(
      { ok: false, error: "Rate limited — one launch per 5 minutes" },
      { status: 429 },
    );
  }

  try {
    const body = (await req.json()) as {
      name?: string;
      ticker?: string;
      description?: string;
      imageUrl?: string;
      // Performance tracking fields
      tagline?: string;
      sourceTrends?: Array<{ trend_name: string; heat_score?: number; sentiment?: string }>;
      viabilityScore?: number;
      imageDescription?: string;
    };

    if (!body.name?.trim() || !body.ticker?.trim()) {
      return NextResponse.json(
        { ok: false, error: "name and ticker are required" },
        { status: 400 },
      );
    }

    const xCommunityUrl = process.env.EVE_X_COMMUNITY_URL?.trim() || "https://x.com/eve_memecoin";

    console.log(`[launch-memecoin] deploying "${body.name}" ($${body.ticker})`);
    lastLaunchAt = now;

    const result = await sendDeployTriggerToAgent({
      name: body.name.trim(),
      ticker: body.ticker.trim(),
      description: (body.description || "").trim(),
      xCommunityUrl,
      imageUrl: body.imageUrl?.trim(),
      skipVanityMint: true,
    });

    console.log(`[launch-memecoin] result:`, result.ok ? `mint=${result.mint}` : result.error);

    if (result.ok) {
      // Record launch to performance DB (fire-and-forget)
      if (result.mint && !result.dryRun) {
        const topTrend = body.sourceTrends?.[0];
        recordLaunch({
          mint: result.mint,
          name: body.name!.trim(),
          ticker: body.ticker!.trim(),
          tagline: body.tagline,
          imageUrl: body.imageUrl?.trim(),
          sourceTrends: body.sourceTrends,
          viabilityScore: body.viabilityScore,
          heatScoreAtLaunch: topTrend?.heat_score,
          sentimentAtLaunch: topTrend?.sentiment,
          imageDescription: body.imageDescription,
        }).catch(() => {});
        scheduleSnapshots(result.mint);
      }
      return NextResponse.json({
        ok: true,
        mint: result.mint,
        signature: result.signature,
        dryRun: result.dryRun,
      });
    } else {
      // Reset rate limit on failure so retry is possible
      lastLaunchAt = 0;
      return NextResponse.json(
        { ok: false, error: result.error || "Deploy failed" },
        { status: result.httpStatus >= 400 ? result.httpStatus : 502 },
      );
    }
  } catch (e) {
    lastLaunchAt = 0;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
