import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** In-memory SOL/USD to avoid hammering CoinGecko on every poll. */
let solUsdCache: { value: number; at: number } | null = null;
const SOL_USD_TTL_MS = 45_000;

async function getSolUsd(): Promise<number | null> {
  const now = Date.now();
  if (solUsdCache && now - solUsdCache.at < SOL_USD_TTL_MS) {
    return solUsdCache.value;
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    );
    if (!res.ok) return solUsdCache?.value ?? null;
    const data = (await res.json()) as { solana?: { usd?: number } };
    const p = data.solana?.usd;
    if (typeof p === "number" && p > 0) {
      solUsdCache = { value: p, at: now };
      return p;
    }
  } catch {
    return solUsdCache?.value ?? null;
  }
  return solUsdCache?.value ?? null;
}

function parsePositiveNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Token MC snapshot for the EVE chart — uses Moralis (same key as /api/agent/moralis).
 * Prefers metadata marketCap / FDV (USD), else spot usdPrice × circulatingSupply.
 */
export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint?.trim()) {
    return NextResponse.json({ ok: false, reason: "missing_mint" }, { status: 400 });
  }

  const key = process.env.MORALIS_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, reason: "no_moralis_key" });
  }

  const solUsd = await getSolUsd();
  if (solUsd == null || solUsd <= 0) {
    return NextResponse.json({ ok: false, reason: "sol_price_unavailable" });
  }

  const headers = {
    accept: "application/json",
    "X-API-Key": key,
  } as const;

  const base = `https://solana-gateway.moralis.io/token/mainnet/${encodeURIComponent(mint.trim())}`;

  try {
    const [metaRes, priceRes] = await Promise.all([
      fetch(`${base}/metadata`, { headers }),
      fetch(`${base}/price`, { headers }),
    ]);

    const meta = metaRes.ok ? ((await metaRes.json()) as Record<string, unknown>) : null;
    const price = priceRes.ok ? ((await priceRes.json()) as Record<string, unknown>) : null;

    if (!meta && !price) {
      return NextResponse.json({
        ok: false,
        reason: "moralis_http",
        metaStatus: metaRes.status,
        priceStatus: priceRes.status,
      });
    }

    let mcapUsd: number | null = null;
    let source: "marketCap" | "fdv" | "spot_x_circ" | null = null;

    if (meta) {
      const mc = parsePositiveNumber(meta.marketCap);
      if (mc != null) {
        mcapUsd = mc;
        source = "marketCap";
      }
      if (mcapUsd == null) {
        const fdv = parsePositiveNumber(meta.fullyDilutedValue);
        if (fdv != null) {
          mcapUsd = fdv;
          source = "fdv";
        }
      }
    }

    if (mcapUsd == null && price && meta) {
      const circ = parsePositiveNumber(meta.circulatingSupply);
      const usdPx = parsePositiveNumber(price.usdPrice);
      if (circ != null && usdPx != null) {
        mcapUsd = circ * usdPx;
        source = "spot_x_circ";
      }
    }

    if (mcapUsd == null || mcapUsd <= 0) {
      return NextResponse.json({ ok: false, reason: "no_mcap" });
    }

    const mcSol = mcapUsd / solUsd;

    return NextResponse.json({
      ok: true,
      mcSol,
      mcapUsd,
      solUsd,
      source,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "unknown";
    return NextResponse.json({ ok: false, reason: "error", message });
  }
}
