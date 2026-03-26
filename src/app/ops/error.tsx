"use client";

/**
 * Catches render errors under /ops/*(pages). Layout-level failures still surface as a generic 500;
 * use the terminal log for those.
 */
export default function OpsRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 p-6 gap-4">
      <div className="max-w-lg w-full rounded-2xl border border-white/10 bg-black/50 p-8 text-center space-y-3">
        <h1 className="text-xl font-bold text-red-400">Ops page error</h1>
        <p className="text-sm text-zinc-400 font-mono break-words">{error.message}</p>
        {error.digest ? (
          <p className="text-xs text-zinc-600 font-mono">digest: {error.digest}</p>
        ) : null}
        <p className="text-[11px] text-zinc-600 leading-relaxed">
          Wallet extension conflicts come from the browser, not this app — try a private window with only
          Phantom or disable other extensions.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-2 px-6 py-3 rounded-xl font-bold bg-gradient-to-r from-cyan-500 to-fuchsia-600 text-black"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
