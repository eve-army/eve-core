/**
 * Pump.fun live chat junk / scam patterns (spacing and punctuation stripped).
 */

const NORM_RE = /[\s_.,\-:;'"`()[\]{}|/\\]+/g;
const ZERO_WIDTH_RE = /\u200b|\u200c|\u200d|\ufeff|\u00a0/g;

function compactAlnumLower(s: string): string {
  return s
    .toLowerCase()
    .replace(ZERO_WIDTH_RE, "")
    .replace(NORM_RE, "");
}

/**
 * Obfuscated “DEV bot … Batch Swap … Go To site … CT.APP” promos (any spacing / symbols).
 * Example normalized body: devbotbatchswapgotositectapp
 */
function isDevBatchSwapSiteCtAppScam(c: string): boolean {
  if (c.length < 20) return false;
  const hasDevBot = c.includes("devbot");
  const hasBatchSwap =
    c.includes("batchswap") || (c.includes("batch") && c.includes("swap"));
  const hasGoSite =
    c.includes("gotosite") ||
    c.includes("gotsite") ||
    (c.includes("goto") && c.includes("site")) ||
    (c.includes("go") && c.includes("to") && c.includes("site"));
  const hasCtApp =
    c.includes("ctapp") || (c.includes("ct") && c.includes("app"));
  return hasDevBot && hasBatchSwap && hasGoSite && hasCtApp;
}

/**
 * Common spam: spaced "DEV bot / Batch Swap / Go To site / CT . APP" style CTAs.
 */
export function isPumpSpamScamMessage(message: string): boolean {
  const c = compactAlnumLower(message.trim());
  if (c.length < 12) return false;

  if (isDevBatchSwapSiteCtAppScam(c)) return true;

  const hasDevBot = c.includes("devbot");
  const batchSwap =
    c.includes("batchswap") || (c.includes("batch") && c.includes("swap"));
  const gotoSite =
    c.includes("goto") ||
    c.includes("gotsite") ||
    (c.includes("visit") && c.includes("site"));
  const ctApp =
    c.includes("ctapp") || (c.includes("ct") && c.includes("app"));

  if (batchSwap && (gotoSite || ctApp)) return true;
  if (hasDevBot && batchSwap) return true;
  if (hasDevBot && ctApp && (c.includes("swap") || c.includes("site")))
    return true;
  return false;
}
