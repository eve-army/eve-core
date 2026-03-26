export default function OpsDeployPage() {
  return (
    <div className="max-w-2xl space-y-4 text-zinc-300 text-sm leading-relaxed">
      <h1 className="text-lg font-semibold text-white">Pump Assistant (bonding)</h1>
      <p>
        The original <strong className="text-zinc-100">Bonding agent / Pump Assistant</strong> from{" "}
        <code className="text-cyan-400/90">moltspaces-ui-draft</code> (under <code className="text-cyan-400/90">/pumpfun</code>)
        is not vendored in this repository yet. Add it as a submodule or copy into{" "}
        <code className="text-cyan-400/90">vendor/moltspaces-ui-draft</code>, then mount that UI here under{" "}
        <code className="text-cyan-400/90">/ops/console/deploy</code>.
      </p>
      <p className="text-zinc-500">
        Eve remains the <strong className="text-zinc-400">Trend Analyst</strong> on mint{" "}
        <code className="text-xs break-all text-fuchsia-300/90">
          4mVbX7EZonRcEfiyFbbw2ByrYc7xAkUMp3NKWhDwpump
        </code>{" "}
        (set <code className="text-cyan-400/90">EVE_DEFAULT_ROOM</code> on the VPS to match).
      </p>
      <p className="text-zinc-500">
        After a token bonds, point operators at <code className="text-cyan-400/90">/eve</code> with the mint to run the
        trend-focused agent.
      </p>
    </div>
  );
}
