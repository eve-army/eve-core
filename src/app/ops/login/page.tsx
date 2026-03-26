"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useState } from "react";

const GET_TOKEN_MS = 25_000;
const OPS_AUTH_FETCH_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(label));
      }
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

export default function OpsLoginPage() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const [err, setErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** Bumps to re-run Privy token → /api/ops/auth/privy without calling `login()` (Privy forbids login when already authenticated). */
  const [syncAttempt, setSyncAttempt] = useState(0);

  useEffect(() => {
    if (!ready || !authenticated) {
      setSyncing(false);
      return;
    }

    let cancelled = false;
    setSyncing(true);
    setErr(null);

    void (async () => {
      try {
        let accessToken: string | null;
        try {
          accessToken = await withTimeout(
            getAccessToken(),
            GET_TOKEN_MS,
            "GET_TOKEN_TIMEOUT",
          );
        } catch (e) {
          if (!cancelled && e instanceof Error && e.message === "GET_TOKEN_TIMEOUT") {
            setErr(
              "Timed out waiting for Privy (access token). Another browser extension may be blocking the wallet — try a private window with only Phantom enabled, or turn off extra wallet / assistant extensions, then try again.",
            );
            setSyncing(false);
            return;
          }
          throw e;
        }
        if (cancelled) return;
        if (!accessToken) {
          setErr("No Privy access token. Try again or sign out and reconnect.");
          setSyncing(false);
          return;
        }

        const ac = new AbortController();
        const fetchTimer = window.setTimeout(() => ac.abort(), OPS_AUTH_FETCH_MS);
        let res: Response;
        try {
          res = await fetch("/api/ops/auth/privy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken }),
            credentials: "include",
            signal: ac.signal,
          });
        } catch (fe) {
          if (!cancelled) {
            const msg =
              fe instanceof Error && fe.name === "AbortError"
                ? "Server authorization timed out. Check that the app is running and OPS env vars are set, then retry."
                : fe instanceof Error
                  ? fe.message
                  : "Network error talking to /api/ops/auth/privy";
            setErr(msg);
            setSyncing(false);
          }
          return;
        } finally {
          window.clearTimeout(fetchTimer);
        }

        let data: { ok?: boolean; error?: string; detail?: string };
        try {
          data = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
        } catch {
          if (!cancelled) {
            setErr(`Server returned ${res.status} (invalid JSON). Is /api/ops/auth/privy reachable?`);
            setSyncing(false);
          }
          return;
        }
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          const msg = data.error || `Server returned ${res.status}`;
          const devExtra =
            data.detail && process.env.NODE_ENV === "development"
              ? `\n\n${data.detail}`
              : "";
          setErr(msg + devExtra);
          try {
            await logout();
          } catch {
            /* ignore */
          }
          setSyncing(false);
          return;
        }
        window.location.href = "/ops/console";
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Login failed");
        }
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, getAccessToken, logout, syncAttempt]);

  async function onPrimaryClick() {
    setErr(null);
    if (syncing) {
      setSyncing(false);
      try {
        await logout();
      } catch {
        /* ignore */
      }
      return;
    }
    if (authenticated) {
      setSyncAttempt((n) => n + 1);
      return;
    }
    void login();
  }

  const primaryLabel = !ready
    ? "Loading…"
    : syncing
      ? "Cancel sign-in"
      : authenticated
        ? "Retry connection to Eve Ops"
        : "Log in with Privy";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-black/40 p-8 shadow-[0_0_40px_rgba(34,211,238,0.08)]">
        <h1 className="text-xl font-bold text-cyan-400 tracking-tight">Eve Ops</h1>
        <p className="text-sm text-zinc-400 mt-2">
          Sign in with Privy using a Solana wallet that is listed in{" "}
          <code className="text-cyan-300/90">OPS_ADMIN_SOLANA_WALLETS</code>.
        </p>
        <button
          type="button"
          onClick={() => void onPrimaryClick()}
          disabled={!ready}
          className={`mt-6 w-full py-3 rounded-xl font-bold text-black disabled:opacity-50 ${
            syncing
              ? "bg-zinc-600 hover:bg-zinc-500"
              : "bg-gradient-to-r from-cyan-500 to-fuchsia-600"
          }`}
        >
          {primaryLabel}
        </button>
        {ready && syncing ? (
          <p className="mt-2 text-[11px] text-zinc-500 text-center">
            Contacting Eve Ops with your Privy session… Cancel to sign out and start over.
          </p>
        ) : null}
        {ready && authenticated && !syncing && err ? (
          <p className="mt-2 text-[11px] text-amber-400/90 text-center">
            Privy can still show you as signed in while Eve Ops hasn&apos;t opened a session yet (see
            error below). Use <strong className="font-semibold">Retry connection to Eve Ops</strong> —
            don&apos;t use Log in again until you sign out.
          </p>
        ) : null}
        {err ? <p className="mt-4 text-sm text-red-400">{err}</p> : null}
        <p className="mt-6 text-[11px] text-zinc-600 leading-relaxed space-y-2">
          <span className="block">
            Eve Ops uses <strong className="text-zinc-500 font-semibold">Solana wallets only</strong>{" "}
            (Phantom, etc.). If sign-in stalls or the wallet modal misbehaves, another extension may be
            interfering — use a private window with only Phantom, or disable other wallet and assistant
            extensions.
          </span>
          <span className="block text-zinc-500">
            DevTools messages from filenames you don&apos;t recognize are injected by the browser or
            extensions, not by this app.
          </span>
          <span className="block text-zinc-500">
            A 401 after sign-in usually means Privy env mismatch: app id + verification key + secret
            must all be from the same Privy app (see error text if any detail appears below in dev).
          </span>
        </p>
      </div>
    </div>
  );
}
