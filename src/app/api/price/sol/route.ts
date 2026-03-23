import { NextResponse } from "next/server";

/** Server-side SOL/USD so the browser is not blocked by CoinGecko CORS on localhost. */
export async function GET() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (compatible; EveCore/1.0; +https://github.com/)",
        },
        next: { revalidate: 60 },
      },
    );
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `coingecko ${res.status}` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as {
      solana?: { usd?: number };
    };
    const usd = data.solana?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) {
      return NextResponse.json({ ok: false, error: "no price" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, usd });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
