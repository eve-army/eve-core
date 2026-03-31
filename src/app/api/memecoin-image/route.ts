import { NextRequest, NextResponse } from "next/server";
import { getOrFetchImage } from "@/lib/memecoin-image-cache";

export const dynamic = "force-dynamic";

/**
 * GET /api/memecoin-image?prompt=...
 * Generates images via Together.ai FLUX.1-schnell and serves from in-memory cache.
 */
export async function GET(req: NextRequest) {
  const prompt = req.nextUrl.searchParams.get("prompt");
  if (!prompt) {
    return new NextResponse("Missing prompt", { status: 400 });
  }

  const result = await getOrFetchImage(prompt);
  if (result) {
    return new NextResponse(new Uint8Array(result.buf), {
      headers: {
        "Content-Type": result.ct,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  }

  // 1x1 transparent pixel fallback
  const pixel = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
  return new NextResponse(pixel, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-cache" },
  });
}
