import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { prewarmImage } from "@/lib/memecoin-image-cache";
import { getTrendingMemes } from "@/lib/trending-memes";

export const dynamic = "force-dynamic";

const openai = new OpenAI();

type TrendInput = {
  trend_name: string;
  summary?: string;
  heat_score?: number;
  sentiment?: string;
  tweet_count?: number;
  maxHeat?: number;
};

/**
 * POST /api/memecoin-ideas
 * Body: { trends: [{ trend_name, summary, heat_score, sentiment, tweet_count, maxHeat }] }
 * Returns: { memecoins: [{ name, ticker, trend, tagline, imageDescription, mood, generatedImageUrl }] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { trends?: TrendInput[] };
    const trends = (body.trends ?? []).slice(0, 8);
    if (trends.length === 0) {
      return NextResponse.json({ memecoins: [] });
    }

    const trendNames = trends.map((t) => t.trend_name);

    // Build rich trend context
    const trendList = trends
      .map((t, i) => {
        const parts = [`${i + 1}. **${t.trend_name}**`];
        if (t.summary) parts.push(`   Summary: ${t.summary}`);
        if (t.sentiment) parts.push(`   Sentiment: ${t.sentiment}`);
        if (t.heat_score) parts.push(`   Heat: ${t.heat_score}${t.maxHeat ? ` (peak: ${t.maxHeat})` : ""}`);
        if (t.tweet_count) parts.push(`   Tweets: ${t.tweet_count}`);
        return parts.join("\n");
      })
      .join("\n\n");

    // Fetch trending meme coins for market awareness (best-effort)
    let trendingMemesContext = "";
    try {
      const memes = await getTrendingMemes();
      if (memes.length > 0) {
        trendingMemesContext = `\n\nCURRENTLY TRENDING MEME COINS (for market awareness — don't copy these, but understand the vibe):\n${memes.map((m: { name: string; symbol: string; description?: string }) => `- ${m.name} ($${m.symbol}) — ${m.description || "trending"}`).join("\n")}`;
      }
    } catch { /* best-effort */ }

    const systemPrompt = `You are the world's best memecoin creator — a genius at the intersection of internet culture, crypto degenerate humor, and viral marketing. You understand what makes memes spread: absurdity, relatability, cultural timing, and visual impact.

Your job: take real-time trending topics and create memecoin concepts that would genuinely go viral. Think like the creators of BONK, WIF (dogwifhat), PEPE, or BRETT — names that are instantly memeable, visually iconic, and capture a cultural moment.`;

    const userPrompt = `Create exactly ${Math.min(4, trends.length)} memecoin concepts from these trending topics. Each coin must come from a DIFFERENT trend.

TRENDING TOPICS:
${trendList}
${trendingMemesContext}

NAMING RULES:
- Names MUST have spaces between words. Multi-word names only.
- Be CLEVER and INDIRECT — puns, wordplay, absurd mashups, pop culture references
- Think meme-first: would someone share this name? Would it make people laugh?
- BAD: literal descriptions like "Pentagon Ops" or "Bitcoin Whale". NEVER do this.
- GOOD: "Siri Took a Wrong Turn", "Tee Time Mugshot", "Rug Pull Therapy", "Chad's Last Stand"
- NEVER include "Token", "Coin", "Inu", or "Moon" in the name

TICKER RULES:
- 3-6 uppercase letters only. No numbers, spaces, or special characters.
- Must NOT contain "COIN", "TOKEN", or "SWAP".
- Should be catchy and pronounceable, not just initials.

IMAGE DESCRIPTION RULES (critical — this drives the visual identity):
- Write a vivid, specific image description (2-3 sentences) that would make a stunning token image
- DO NOT default to "cute mascot" — be creative with the visual style:
  - Photorealistic scenes, surreal compositions, editorial photography styles
  - Pop art, anime, pixel art, oil painting, collage, propaganda poster
  - Animals, objects, scenes, abstract concepts — whatever fits the meme
- Reference specific visual elements from the trend (people, places, objects, events)
- Include mood, lighting, color palette, and composition details
- The image should be INSTANTLY recognizable and memeable — think profile picture worthy
- NEVER include text, words, letters, or numbers in the image description

Each coin MUST have:
- "trend": copied EXACTLY from the trend names above
- "tagline": a funny one-liner that would work as a tweet
- "imageDescription": detailed visual description for AI image generation (2-3 sentences)
- "mood": one of "absurd", "chaotic", "wholesome", "dark_humor", "surreal", "hype"

Output strict JSON only:
{"memecoins":[{"name":"...","ticker":"...","trend":"...","tagline":"...","imageDescription":"...","mood":"..."}]}`;

    let raw: string;
    try {
      const start = Date.now();
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.9,
        max_tokens: 2000,
      });
      raw = completion.choices[0]?.message?.content?.trim() || "";
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[memecoin-ideas] GPT-4o-mini responded in ${elapsed}s (${raw.length} chars)`);
    } catch (e) {
      console.error("[memecoin-ideas] OpenAI failed:", e instanceof Error ? e.message : e);
      return NextResponse.json({ memecoins: [] });
    }

    try {
      const parsed = JSON.parse(raw) as { memecoins?: unknown[] };
      console.log("[memecoin-ideas] raw output:", raw.slice(0, 600));

      // Fuzzy match: find the best matching trend for the LLM's trend field
      function fuzzyMatchTrend(llmTrend: string, name: string, tagline: string): string {
        const haystack = `${llmTrend} ${name} ${tagline}`.toLowerCase();
        let bestMatch = "";
        let bestScore = 0;
        for (const tn of trendNames) {
          const words = tn.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
          const score = words.filter((w) => haystack.includes(w)).length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = tn;
          }
        }
        return bestScore >= 1 ? bestMatch : "";
      }

      const seenNames = new Set<string>();
      const seenTickers = new Set<string>();
      const seenTrends = new Set<string>();
      const BANNED_TICKER = ["COIN", "TOKEN", "SWAP"];

      const memecoins = (parsed.memecoins ?? [])
        .filter((m): m is Record<string, string> =>
          m != null && typeof m === "object" &&
          typeof (m as Record<string, string>).name === "string" &&
          typeof (m as Record<string, string>).ticker === "string"
        )
        .map((m) => {
          let name = m.name.trim().replace(/token|coin/gi, "").replace(/\s+/g, " ").trim();
          if (!name.includes(" ")) {
            name = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
          }
          const ticker = m.ticker.trim().replace(/^\$/, "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
          const rawTrend = (m.trend || "").trim();
          const tagline = (m.tagline || "").trim();
          const imageDescription = (m.imageDescription || "").trim();
          const mood = (m.mood || "absurd").trim();
          const matchedTrend = fuzzyMatchTrend(rawTrend, name, tagline);
          return { name, ticker, trend: matchedTrend, tagline, imageDescription, mood };
        })
        .filter((m) => {
          if (!m.name || !m.ticker || m.ticker.length < 3) return false;
          if (!m.name.includes(" ")) return false;
          if (/coin|token/i.test(m.name)) return false;
          if (BANNED_TICKER.some((w) => m.ticker.includes(w))) return false;
          if (m.trend) {
            const trendKey = m.trend.toLowerCase();
            if (seenTrends.has(trendKey)) return false;
            seenTrends.add(trendKey);
          }
          const nk = m.name.toLowerCase();
          if (seenNames.has(nk) || seenTickers.has(m.ticker)) return false;
          seenNames.add(nk);
          seenTickers.add(m.ticker);
          return true;
        })
        .slice(0, 4);

      // Generate image URLs using LLM-crafted imageDescription
      const prewarmPromises: Promise<unknown>[] = [];
      const memesWithImages = memecoins.map((mc) => {
        const imgPrompt = mc.imageDescription
          ? `${mc.imageDescription}, no text, no words, no letters, no watermark`
          : `${mc.name}, ${mc.tagline}, vibrant digital art, dark background, no text`;
        prewarmPromises.push(prewarmImage(imgPrompt));
        const generatedImageUrl = `/api/memecoin-image?prompt=${encodeURIComponent(imgPrompt)}`;
        return { ...mc, generatedImageUrl };
      });

      // Wait up to 5s for images to cache
      await Promise.race([
        Promise.allSettled(prewarmPromises),
        new Promise((r) => setTimeout(r, 5000)),
      ]);

      console.log("[memecoin-ideas] validated:", memesWithImages.length, "coins with AI images");
      return NextResponse.json({ memecoins: memesWithImages });
    } catch {
      return NextResponse.json({ memecoins: [] });
    }
  } catch {
    return NextResponse.json({ memecoins: [] }, { status: 500 });
  }
}
