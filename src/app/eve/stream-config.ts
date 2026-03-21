/**
 * /eve stream defaults for VPS: read at request time from process.env (next start).
 * Use EVE_* in /etc/eve-core/app.env — no rebuild required.
 * NEXT_PUBLIC_* still work as build-time fallbacks for local/CI.
 */
export type EveStreamPublicConfig = {
  defaultRoom: string;
  streamUsername: string;
  streamName: string;
  streamTicker: string;
  autoConnect: boolean;
  kiosk: boolean;
};

function pick(runtime: string | undefined, baked: string | undefined): string {
  return (runtime ?? baked ?? "").trim();
}

function truthyEnv(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}

export function getEveStreamPublicConfig(): EveStreamPublicConfig {
  const defaultRoom = pick(
    process.env.EVE_DEFAULT_ROOM,
    process.env.NEXT_PUBLIC_EVE_DEFAULT_ROOM
  );
  const streamUsername = pick(
    process.env.EVE_STREAM_USERNAME,
    process.env.NEXT_PUBLIC_EVE_STREAM_USERNAME
  );
  const streamName = pick(
    process.env.EVE_STREAM_NAME,
    process.env.NEXT_PUBLIC_EVE_STREAM_NAME
  );
  const streamTicker = pick(
    process.env.EVE_STREAM_TICKER,
    process.env.NEXT_PUBLIC_EVE_STREAM_TICKER
  );

  const autoConnect =
    truthyEnv(process.env.EVE_AUTO_CONNECT) ||
    process.env.NEXT_PUBLIC_EVE_AUTO_CONNECT === "1";

  const kiosk =
    truthyEnv(process.env.EVE_KIOSK) ||
    process.env.NEXT_PUBLIC_EVE_KIOSK === "1";

  return {
    defaultRoom,
    streamUsername,
    streamName,
    streamTicker,
    autoConnect,
    kiosk,
  };
}
