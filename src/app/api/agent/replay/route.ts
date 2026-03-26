import { NextRequest, NextResponse } from "next/server";
import { getOpsSessionAddress } from "@/lib/ops-auth/request-session";
import { loadReplayCasesFromJsonl, runReplay, summarizeReplay, type ReplayCase } from "@/lib/voice-agent/replay/harness";

export const dynamic = "force-dynamic";

type ReplayBody = {
  cases?: ReplayCase[];
  datasetPath?: string;
};

function isAllowedDatasetPath(p: string): boolean {
  return p.startsWith("data/replay/") && !p.includes("..");
}

export async function POST(req: NextRequest) {
  if (!getOpsSessionAddress(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await req.json()) as ReplayBody;
    let cases: ReplayCase[] = [];
    if (Array.isArray(body.cases) && body.cases.length > 0) {
      cases = body.cases;
    } else if (typeof body.datasetPath === "string" && isAllowedDatasetPath(body.datasetPath)) {
      cases = await loadReplayCasesFromJsonl(body.datasetPath);
    } else {
      return NextResponse.json(
        { ok: false, error: "Provide cases[] or datasetPath under data/replay/" },
        { status: 400 },
      );
    }

    const results = await runReplay(cases);
    return NextResponse.json({
      ok: true,
      summary: summarizeReplay(results),
      results,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Replay failed" },
      { status: 500 },
    );
  }
}

