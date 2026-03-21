#!/usr/bin/env bash
# Publish A/V to LiveKit RTMP ingress (24/7 under systemd).
# Environment: load /etc/eve-core/rtmp.env or export vars before running.
set -euo pipefail

if [[ -z "${RTMP_URL:-}" ]]; then
  if [[ -n "${RTMP_BASE:-}" && -n "${RTMP_STREAM_KEY:-}" ]]; then
    RTMP_URL="${RTMP_BASE%/}/${RTMP_STREAM_KEY}"
  fi
fi

if [[ -z "${RTMP_URL:-}" ]]; then
  echo "livekit-publish: set RTMP_URL or RTMP_BASE+RTMP_STREAM_KEY" >&2
  exit 1
fi

INPUT_MODE="${INPUT_MODE:-lavfi}"
VIDEO_SIZE="${VIDEO_SIZE:-1280x720}"
VIDEO_FPS="${VIDEO_FPS:-30}"
VIDEO_BITRATE="${VIDEO_BITRATE:-2500k}"
VIDEO_MAXRATE="${VIDEO_MAXRATE:-3000k}"
AUDIO_BITRATE="${AUDIO_BITRATE:-128k}"
GOP=$(( VIDEO_FPS * 2 ))

common_video=( -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p )
common_out=( -f flv "$RTMP_URL" )

case "$INPUT_MODE" in
  lavfi)
    exec ffmpeg -hide_banner -loglevel warning -nostdin -re \
      -f lavfi -i "testsrc=size=${VIDEO_SIZE}:rate=${VIDEO_FPS}" \
      -f lavfi -i "sine=frequency=440:sample_rate=44100" \
      "${common_video[@]}" \
      -b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_MAXRATE" -bufsize 6000k \
      -g "$GOP" \
      -c:a aac -ar 44100 -ac 2 -b:a "$AUDIO_BITRATE" \
      "${common_out[@]}"
    ;;
  loop)
    if [[ -z "${INPUT_FILE:-}" || ! -f "$INPUT_FILE" ]]; then
      echo "livekit-publish: INPUT_MODE=loop requires existing INPUT_FILE" >&2
      exit 1
    fi
    exec ffmpeg -hide_banner -loglevel warning -nostdin -re \
      -stream_loop -1 -i "$INPUT_FILE" \
      "${common_video[@]}" \
      -b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_MAXRATE" -bufsize 6000k \
      -g "$GOP" \
      -c:a aac -ar 44100 -ac 2 -b:a "$AUDIO_BITRATE" \
      "${common_out[@]}"
    ;;
  black)
    exec ffmpeg -hide_banner -loglevel warning -nostdin -re \
      -f lavfi -i "color=c=black:s=${VIDEO_SIZE}:r=${VIDEO_FPS}" \
      -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100" \
      "${common_video[@]}" \
      -b:v "${VIDEO_BITRATE:-1500k}" -maxrate "${VIDEO_MAXRATE:-1800k}" -bufsize 3600k \
      -g "$GOP" \
      -c:a aac -ar 44100 -ac 2 -b:a 64k \
      "${common_out[@]}"
    ;;
  *)
    echo "livekit-publish: INPUT_MODE must be lavfi, loop, or black" >&2
    exit 1
    ;;
esac
