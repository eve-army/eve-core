# eve-core

Minimal Next.js app: the **EVE / pump.fun assistant** UI and APIs extracted from moltspaces-ui-draft.

- **`/`** redirects to **`/pumpfun`**, which redirects to **`/eve`** (same path behavior as the draft app).
- **EVE UI:** `src/app/eve/`
- **APIs:** `src/app/api/pumpchat`, `src/app/api/agent/respond`, `src/app/api/agent/moralis`

## Setup

Copy [`.env.example`](.env.example) to **`.env.local`** (or edit the repo’s `.env.local` template) and set at least **`OPENAI_API_KEY`** and **`ELEVENLABS_API_KEY`**. All keys the app reads are documented in `.env.example`.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000/pumpfun](http://localhost:3000/pumpfun) (redirects to `/eve`) or [http://localhost:3000/eve](http://localhost:3000/eve).

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | For AI replies | `/api/agent/respond` |
| `ELEVENLABS_API_KEY` | For default voice | Same route (ElevenLabs TTS) |
| `ELEVENLABS_VOICE_ID` | Optional | Which ElevenLabs voice to use; defaults to Rachel |
| `MORALIS_API_KEY` | Optional | Bonded-token OHLCV (`/api/agent/moralis`) and **live MC** for the chart (`/api/token/metrics`, preferred over DexScreener when set) |
| `NEXT_PUBLIC_RPC_URL` | Optional | Solana RPC; falls back to public mainnet |

Hugging Face TTS (non-default voices) uses the public Space `AdamSongjam/ultimate-rvc` from the browser via `@gradio/client`.

## Build

```bash
npm run build
npm start
```

Typecheck only (no bundler): `npx tsc --noEmit`

## Production (VPS + LiveKit RTMP)

To run on a VPS (e.g. **78.46.210.25**) with **nginx**, **Let’s Encrypt**, **systemd**, and a **24/7 ffmpeg** publisher to pump.fun’s **LiveKit RTMP ingress**, follow **[deploy/VPS-SETUP.md](deploy/VPS-SETUP.md)**. It includes:

- `deploy/systemd/*.service` — `eve-core` (Next.js) and `eve-livekit-rtmp` (ffmpeg)
- `deploy/nginx-eve-core.conf` — reverse proxy with long timeouts for SSE (`/api/pumpchat`)
- `deploy/scripts/livekit-publish.sh` — RTMP publish (test pattern, looped file, or black/silent)
- `deploy/app.env.example` / `deploy/rtmp.env.example` — templates for `/etc/eve-core/*.env` (never commit secrets)

### If you see `Bus error (core dumped)` when running Next

On some Linux setups, Node loads the **wrong** `@next/swc` binary (for example **musl** inside `next/node_modules` on a **glibc** distro). Loading that `.node` file can crash the process with a bus error before any JS runs.

This repo works around that by:

1. **`postinstall`** — removes non-wasm `@next/swc-*` native packages so Next does not pick the wrong ABI.
2. **`NEXT_TEST_WASM=1`** on `dev` / `build` — skips loading native SWC and uses the WASM compiler instead (see `@next/swc-wasm-nodejs` in devDependencies).

The **first** `npm run dev` or `npm run build` after a clean cache may spend **1–2 minutes** downloading the WASM SWC bundle into `~/.cache/next-swc`; later runs start quickly.

On **Windows**, set the env var in the script (e.g. install `cross-env` and use `cross-env NEXT_TEST_WASM=1 next dev`).

### Workspace / lockfile warning

If Next warns about **multiple lockfiles** (e.g. `~/package-lock.json` vs this project), either remove the stray lockfile in the parent directory or rely on `outputFileTracingRoot` in `next.config.ts`, which pins tracing to this app.
