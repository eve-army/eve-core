#!/usr/bin/env bash
# Capture Chromium (Xvfb) showing /eve and publish video+audio to LiveKit/pump RTMP.
# Requires: Xvfb, pulseaudio (or pipewire-pulse), chromium, ffmpeg, curl.
# Env: /etc/eve-core/rtmp.env — RTMP_URL or RTMP_BASE + RTMP_STREAM_KEY (same as livekit-publish.sh).
# Optional in rtmp.env: EVE_INTERNAL_URL, VIDEO_SIZE, VIDEO_FPS, VIDEO_BITRATE, etc.
# Chromium flags: autoplay allowed; pair with NEXT_PUBLIC_EVE_AUTO_CONNECT=1 on the app build.
set -euo pipefail

: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set (e.g. /run/user/<uid> — see systemd unit)}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

if [[ -f /etc/eve-core/rtmp.env ]]; then
  set -a
  # shellcheck source=/dev/null
  source /etc/eve-core/rtmp.env
  set +a
fi

if [[ -z "${RTMP_URL:-}" ]]; then
  if [[ -n "${RTMP_BASE:-}" && -n "${RTMP_STREAM_KEY:-}" ]]; then
    RTMP_URL="${RTMP_BASE%/}/${RTMP_STREAM_KEY}"
  fi
fi
if [[ -z "${RTMP_URL:-}" ]]; then
  echo "eve-browser-rtmp: set RTMP_URL or RTMP_BASE+RTMP_STREAM_KEY in /etc/eve-core/rtmp.env" >&2
  exit 1
fi

EVE_INTERNAL_URL="${EVE_INTERNAL_URL:-http://127.0.0.1:3000/eve}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
VIDEO_SIZE="${VIDEO_SIZE:-1280x720}"
VIDEO_FPS="${VIDEO_FPS:-24}"
VIDEO_BITRATE="${VIDEO_BITRATE:-2000k}"
VIDEO_MAXRATE="${VIDEO_MAXRATE:-2500k}"
AUDIO_BITRATE="${AUDIO_BITRATE:-128k}"
GOP=$(( VIDEO_FPS * 2 ))
IFS=x read -r VID_W VID_H <<< "${VIDEO_SIZE}"
VID_W="${VID_W:-1280}"
VID_H="${VID_H:-720}"

# --- Xvfb ---
if ! command -v Xvfb >/dev/null 2>&1; then
  echo "eve-browser-rtmp: install Xvfb (apt install xvfb)" >&2
  exit 1
fi
Xvfb "$DISPLAY" -screen 0 "${VIDEO_SIZE}x24" -nolisten tcp &
PIDS+=("$!")
sleep 1

# --- PulseAudio user daemon + null sink (Chromium → sink; ffmpeg ← monitor) ---
if ! command -v pactl >/dev/null 2>&1; then
  echo "eve-browser-rtmp: install pulseaudio or pipewire-pulse (pactl required)" >&2
  exit 1
fi

# Use PipeWire/pulse socket if already present; otherwise start PulseAudio as this user.
if ! pactl info >/dev/null 2>&1; then
  if command -v pulseaudio >/dev/null 2>&1; then
    pulseaudio -D --exit-idle-time=-1 2>/dev/null || pulseaudio --start --exit-idle-time=-1 2>/dev/null || true
  fi
fi
if ! pactl info >/dev/null 2>&1; then
  echo "eve-browser-rtmp: no Pulse-compatible server (pactl info failed). Install pulseaudio or pipewire-pulse." >&2
  exit 1
fi

SINK_NAME="eve_stream_sink"
if ! pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -qx "$SINK_NAME"; then
  pactl load-module module-null-sink "sink_name=${SINK_NAME}" \
    sink_properties=device.description=EVE_Stream_RTMP 2>/dev/null || {
    echo "eve-browser-rtmp: failed to load null sink; is PulseAudio running?" >&2
    exit 1
  }
fi
export PULSE_SINK="$SINK_NAME"
MONITOR_NAME="${SINK_NAME}.monitor"

# --- Wait for Next.js ---
echo "eve-browser-rtmp: waiting for ${EVE_INTERNAL_URL} ..."
for _ in $(seq 1 90); do
  if curl -sf "$EVE_INTERNAL_URL" >/dev/null; then break; fi
  sleep 2
done
if ! curl -sf "$EVE_INTERNAL_URL" >/dev/null; then
  echo "eve-browser-rtmp: eve-core did not become ready in time" >&2
  exit 1
fi

# --- Chromium ---
CHROME_BIN=""
for c in chromium-browser chromium google-chrome google-chrome-stable; do
  if command -v "$c" >/dev/null 2>&1; then CHROME_BIN="$c"; break; fi
done
if [[ -z "$CHROME_BIN" ]]; then
  echo "eve-browser-rtmp: install chromium-browser or google-chrome-stable" >&2
  exit 1
fi

# shellcheck disable=SC2086
"$CHROME_BIN" \
  --kiosk \
  --no-first-run \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=Translate,BackForwardCache \
  --window-size="${VID_W},${VID_H}" \
  --window-position=0,0 \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-sandbox \
  --user-data-dir="${TMPDIR:-/tmp}/eve-chromium-profile-$$" \
  "$EVE_INTERNAL_URL" &
PIDS+=("$!")

sleep 4

# Optional: focus window and send Enter (if auto-connect did not run).
# Google Chrome WM_CLASS is "Google-chrome"; Chromium is "Chromium".
# A single --sync --class Chromium blocks forever when using Google Chrome, so ffmpeg never starts.
if command -v xdotool >/dev/null 2>&1; then
  _xd_done=
  if command -v timeout >/dev/null 2>&1; then
    for _class in Google-chrome Chromium; do
      if timeout 5 xdotool search --sync --onlyvisible --class "$_class" windowactivate 2>/dev/null; then
        _xd_done=1
        break
      fi
    done
  fi
  if [[ -z "${_xd_done:-}" ]]; then
    for _ in $(seq 1 40); do
      for _class in Google-chrome Chromium; do
        _wid=$(xdotool search --onlyvisible --class "$_class" 2>/dev/null | head -1 || true)
        if [[ -n "${_wid:-}" ]]; then
          xdotool windowactivate "$_wid" 2>/dev/null || true
          _xd_done=1
          break 2
        fi
      done
      sleep 0.5
    done
  fi
  sleep 0.5
  xdotool key Return 2>/dev/null || true
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "eve-browser-rtmp: ffmpeg not found" >&2
  exit 1
fi

echo "eve-browser-rtmp: streaming to RTMP (video ${VIDEO_SIZE} @ ${VIDEO_FPS} fps) ..."
# Foreground ffmpeg; EXIT trap cleans Xvfb + Chromium when ffmpeg stops.
ffmpeg -hide_banner -loglevel warning -nostdin \
  -f x11grab -video_size "$VIDEO_SIZE" -framerate "$VIDEO_FPS" -draw_mouse 0 -i "${DISPLAY}.0" \
  -f pulse -i "$MONITOR_NAME" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_MAXRATE" -bufsize 6000k \
  -g "$GOP" \
  -c:a aac -ar 44100 -ac 2 -b:a "$AUDIO_BITRATE" \
  -f flv "$RTMP_URL"
