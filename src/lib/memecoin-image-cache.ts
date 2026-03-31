/**
 * Shared image generation + in-memory cache for memecoin images.
 * Uses Together.ai FLUX.1-schnell.
 */

const MAX_CACHE = 200;
const cache = new Map<string, Promise<{ buf: Buffer; ct: string } | null>>();

async function generateImage(prompt: string): Promise<{ buf: Buffer; ct: string } | null> {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) {
    console.error("[memecoin-image] TOGETHER_API_KEY not set");
    return null;
  }

  const start = Date.now();
  try {
    const res = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "black-forest-labs/FLUX.1-schnell",
        prompt,
        width: 256,
        height: 256,
        steps: 4,
        n: 1,
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error(`[memecoin-image] Together API ${res.status} after ${((Date.now() - start) / 1000).toFixed(1)}s:`, err.slice(0, 200));
      return null;
    }

    const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return null;

    console.log(`[memecoin-image] generated in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return { buf: Buffer.from(b64, "base64"), ct: "image/png" };
  } catch (e) {
    console.error(`[memecoin-image] failed after ${((Date.now() - start) / 1000).toFixed(1)}s:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export function getOrFetchImage(prompt: string): Promise<{ buf: Buffer; ct: string } | null> {
  const existing = cache.get(prompt);
  if (existing) return existing;

  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }

  const p = generateImage(prompt);
  cache.set(prompt, p);
  p.then((result) => {
    if (!result) cache.delete(prompt);
  });
  return p;
}

/**
 * Prewarm an image into the cache. Returns a promise that resolves when done.
 */
export function prewarmImage(prompt: string): Promise<{ buf: Buffer; ct: string } | null> {
  return getOrFetchImage(prompt);
}
