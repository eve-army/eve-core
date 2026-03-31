/**
 * Fetches trending meme coins from CoinGecko for market context.
 * Cached in-memory for 5 minutes.
 */

type TrendingMeme = {
  name: string;
  symbol: string;
  description?: string;
};

let cached: { data: TrendingMeme[]; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function getTrendingMemes(): Promise<TrendingMeme[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/search/trending", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return cached?.data ?? [];

    const json = (await res.json()) as {
      coins?: Array<{
        item: {
          name?: string;
          symbol?: string;
          data?: { content?: string };
        };
      }>;
    };

    const memes: TrendingMeme[] = (json.coins ?? []).slice(0, 10).map((c) => ({
      name: c.item.name || "Unknown",
      symbol: c.item.symbol || "???",
      description: c.item.data?.content?.slice(0, 100),
    }));

    cached = { data: memes, at: Date.now() };
    return memes;
  } catch {
    return cached?.data ?? [];
  }
}
