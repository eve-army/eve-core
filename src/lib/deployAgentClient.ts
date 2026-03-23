import { createHmac, randomUUID } from "node:crypto";

export const DEPLOY_TRIGGER_SCHEMA_VERSION = 1 as const;

export interface DeployMemecoinInput {
  name: string;
  ticker: string;
  description: string;
  /** From eve-social */
  xCommunityUrl: string;
  imageUrl?: string;
  websiteUrl?: string;
  telegramUrl?: string;
  skipVanityMint?: boolean;
  vanitySuffix?: string;
  /** If omitted, a new UUID v4 is generated */
  correlationId?: string;
}

export interface DeployAgentResponse {
  ok: boolean;
  mint?: string;
  signature?: string;
  dryRun?: boolean;
  duplicate?: boolean;
  error?: string;
  details?: unknown;
}

export type DeployAgentResult = DeployAgentResponse & { httpStatus: number };

function signBody(secret: string, rawBody: string, timestampSec: number): { timestamp: string; signature: string } {
  const timestamp = String(timestampSec);
  const payload = `${timestamp}.${rawBody}`;
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return { timestamp, signature };
}

/**
 * Sends a versioned TRIGGER to the autodeployment agent (loopback + HMAC).
 */
export async function sendDeployTriggerToAgent(
  input: DeployMemecoinInput
): Promise<DeployAgentResult> {
  const secret = process.env.TRIGGER_HMAC_SECRET?.trim();
  const baseUrl = process.env.DEPLOY_AGENT_URL?.trim() || "http://127.0.0.1:4077";
  if (!secret) {
    return { ok: false, error: "TRIGGER_HMAC_SECRET is not configured", httpStatus: 503 };
  }

  const correlationId = input.correlationId?.trim() || randomUUID();
  const body = {
    schemaVersion: DEPLOY_TRIGGER_SCHEMA_VERSION,
    correlationId,
    name: input.name.trim(),
    ticker: input.ticker.trim(),
    description: input.description.trim(),
    xCommunityUrl: input.xCommunityUrl.trim(),
    ...(input.imageUrl != null && input.imageUrl !== ""
      ? { imageUrl: input.imageUrl.trim() }
      : {}),
    ...(input.websiteUrl != null ? { websiteUrl: input.websiteUrl.trim() } : {}),
    ...(input.telegramUrl != null ? { telegramUrl: input.telegramUrl.trim() } : {}),
    ...(input.skipVanityMint != null ? { skipVanityMint: input.skipVanityMint } : {}),
    ...(input.vanitySuffix != null && input.vanitySuffix !== ""
      ? { vanitySuffix: input.vanitySuffix.trim().toLowerCase() }
      : {}),
  };

  const rawBody = JSON.stringify(body);
  const { timestamp, signature } = signBody(secret, rawBody, Math.floor(Date.now() / 1000));

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/trigger`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body: rawBody,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Deploy agent unreachable: ${message}`, httpStatus: 502 };
  }

  const text = await res.text();
  let json: DeployAgentResponse;
  try {
    json = JSON.parse(text) as DeployAgentResponse;
  } catch {
    return {
      ok: false,
      error: `Agent response not JSON (${res.status}): ${text.slice(0, 200)}`,
      httpStatus: res.status || 502,
    };
  }

  return { httpStatus: res.status, ...json };
}
