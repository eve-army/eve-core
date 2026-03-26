import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OPS_SESSION_COOKIE, getOpsSessionSecret, verifyOpsSession } from "@/lib/ops-auth/session";

export const dynamic = "force-dynamic";

export default async function OpsIndexPage() {
  const secret = getOpsSessionSecret();
  const c = await cookies();
  const tok = c.get(OPS_SESSION_COOKIE)?.value;
  const sub = secret ? verifyOpsSession(secret, tok) : null;
  redirect(sub ? "/ops/console" : "/ops/login");
}
