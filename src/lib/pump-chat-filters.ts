/**
 * Pump.fun live chat junk / scam patterns (spacing and punctuation stripped).
 */

const NORM_RE = /[\s_.,\-:;'"`()[\]{}|/\\]+/g;

function compactAlnumLower(s: string): string {
  return s.toLowerCase().replace(NORM_RE, "");
}

/**
 * Common spam: spaced "DEV bot / Batch Swap / Go To site / CT . APP" style CTAs.
 */
export function isPumpSpamScamMessage(message: string): boolean {
  const c = compactAlnumLower(message.trim());
  if (c.length < 12) return false;
  const hasDevBot = c.includes("devbot");
  const batchSwap =
    c.includes("batchswap") ||
    (c.includes("batch") && c.includes("swap"));
  const gotoSite =
    c.includes("goto") ||
    c.includes("gotsite") ||
    c.includes("visit") && c.includes("site");
  const ctApp =
    c.includes("ctapp") ||
    (c.includes("ct") && c.includes("app"));

  if (batchSwap && (gotoSite || ctApp)) return true;
  if (hasDevBot && batchSwap) return true;
  if (hasDevBot && ctApp && (c.includes("swap") || c.includes("site")))
    return true;
  return false;
}
