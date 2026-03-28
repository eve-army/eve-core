#!/usr/bin/env bash
# Start the XTTS FastAPI server using the local venv.
# Run from repo root: bash xtts-server/start.sh

set -e

VENV="${VENV:-$HOME/.venv}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$VENV/bin/python" ]; then
  echo "Error: venv not found at $VENV" >&2
  echo "Create one with: python3 -m venv $VENV && $VENV/bin/pip install -r $SCRIPT_DIR/requirements.txt" >&2
  exit 1
fi

echo "Starting XTTS server on http://0.0.0.0:8020 …"
cd "$SCRIPT_DIR"
"$VENV/bin/uvicorn" server:app --host 0.0.0.0 --port 8020
