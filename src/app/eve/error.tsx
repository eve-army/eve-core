"use client";

/**
 * Surfaces render errors for /eve instead of a blank “Internal Server Error” page when possible.
 */
export default function EveRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center bg-[var(--eve-bg-deep)] text-[var(--eve-text)] p-6 gap-6 eve-broadcast-root">
      <div className="eve-panel max-w-lg w-full p-8 text-center space-y-3 border-[color:var(--eve-border)]">
        <h1 className="eve-display text-3xl text-[color:var(--eve-danger)]">
          Something broke
        </h1>
        <p className="text-sm text-[color:var(--eve-muted)] font-mono break-words">
          {error.message}
        </p>
        {error.digest ? (
          <p className="text-xs text-[color:var(--eve-muted)] font-mono opacity-80">
            digest: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => reset()}
          className="mt-2 px-6 py-3 rounded-xl bg-gradient-to-r from-[color:var(--eve-accent-a)] to-[color:var(--eve-accent-b)] text-black font-extrabold shadow-[0_0_24px_var(--eve-glow-a)] hover:brightness-110 transition-all"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
