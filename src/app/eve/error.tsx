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
    <div className="min-h-[50vh] flex flex-col items-center justify-center bg-[#050508] text-white p-6 gap-4">
      <h1 className="text-lg font-semibold text-red-300">Something went wrong on /eve</h1>
      <p className="text-sm text-zinc-400 max-w-lg text-center font-mono break-words">
        {error.message}
      </p>
      {error.digest ? (
        <p className="text-xs text-zinc-600 font-mono">digest: {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-sm font-medium"
      >
        Try again
      </button>
    </div>
  );
}
