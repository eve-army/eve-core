import { NextResponse } from "next/server";
import { sendDeployTriggerToAgent } from "@/lib/deployAgentClient";

/**
 * POST /api/internal/deploy-memecoin
 * Merges eve-core concept + eve-social X link into a TRIGGER and forwards to the autodeployment agent.
 *
 * Headers: X-Internal-Secret — must match INTERNAL_DEPLOY_SECRET (never expose this route publicly).
 */
export async function POST(request: Request) {
  const secret = process.env.INTERNAL_DEPLOY_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "INTERNAL_DEPLOY_SECRET not configured" },
      { status: 503 }
    );
  }

  const hdr = request.headers.get("x-internal-secret")?.trim();
  if (hdr !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name : "";
    const ticker = typeof body?.ticker === "string" ? body.ticker : "";
    const description = typeof body?.description === "string" ? body.description : "";
    const xCommunityUrl = typeof body?.xCommunityUrl === "string" ? body.xCommunityUrl : "";

    if (!name.trim() || !ticker.trim() || !xCommunityUrl.trim()) {
      return NextResponse.json(
        { ok: false, error: "name, ticker, and xCommunityUrl are required" },
        { status: 400 }
      );
    }

    const result = await sendDeployTriggerToAgent({
      name,
      ticker,
      description,
      xCommunityUrl,
      imageUrl: typeof body?.imageUrl === "string" ? body.imageUrl : undefined,
      websiteUrl: typeof body?.websiteUrl === "string" ? body.websiteUrl : undefined,
      telegramUrl: typeof body?.telegramUrl === "string" ? body.telegramUrl : undefined,
      skipVanityMint: body?.skipVanityMint === true ? true : body?.skipVanityMint === false ? false : undefined,
      vanitySuffix: typeof body?.vanitySuffix === "string" ? body.vanitySuffix : undefined,
      correlationId: typeof body?.correlationId === "string" ? body.correlationId : undefined,
    });

    const { httpStatus, ...bodyOut } = result;
    return NextResponse.json(bodyOut, { status: httpStatus });
  } catch (e) {
    console.error("[internal/deploy-memecoin]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
