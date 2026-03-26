/**
 * Ops allowlist: Solana wallet addresses (base58), comma/whitespace separated.
 * Env: OPS_ADMIN_SOLANA_WALLETS (preferred) or OPS_ADMIN_WALLETS (legacy name, Solana only).
 */

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

export function parseOpsAdminSolanaAllowlist(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw || typeof raw !== "string") return out;
  for (const part of raw.split(/[\s,]+/)) {
    const a = part.trim();
    if (BASE58_RE.test(a)) out.add(a);
  }
  return out;
}

export function getOpsAdminAllowlistFromEnv(): Set<string> {
  const primary = process.env.OPS_ADMIN_SOLANA_WALLETS?.trim();
  const legacy = process.env.OPS_ADMIN_WALLETS?.trim();
  return parseOpsAdminSolanaAllowlist(primary || legacy);
}

/** True if any linked Solana address is in the allowlist (exact base58 match). */
export function isOpsAdminSolanaAddress(
  solanaAddresses: string[],
  allowlist: Set<string>,
): boolean {
  if (allowlist.size === 0) return false;
  for (const addr of solanaAddresses) {
    const a = addr.trim();
    if (allowlist.has(a)) return true;
  }
  return false;
}
