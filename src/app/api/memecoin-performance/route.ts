import { NextRequest, NextResponse } from "next/server";
import { getAllLaunches, getLaunchWithSnapshots } from "@/lib/memecoin-performance/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/memecoin-performance?mint=X — single launch with all snapshots
 * GET /api/memecoin-performance — all launches with latest snapshot
 */
export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");

  if (mint) {
    const data = await getLaunchWithSnapshots(mint);
    if (!data) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(data);
  }

  const launches = await getAllLaunches();
  return NextResponse.json({ launches });
}
