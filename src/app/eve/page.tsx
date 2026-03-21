import PumpfunChatPage from "./PumpfunChatPage";
import { getEveStreamPublicConfig } from "./stream-config";

/** Read EVE_* from process env on each request (VPS app.env), not at build time. */
export const dynamic = "force-dynamic";

export default function EvePage() {
  const config = getEveStreamPublicConfig();
  return <PumpfunChatPage {...config} />;
}
