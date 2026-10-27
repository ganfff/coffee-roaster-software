#!/bin/sh
set -eu
ROASTER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROASTER_STATE="${ROASTER_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ganf-roaster}"
exec "$ROASTER_ROOT/.venv/bin/python" "$ROASTER_ROOT/device_main.py" --config "$ROASTER_ROOT/config.yaml" --data-dir "$ROASTER_STATE" --host 127.0.0.1 --port "${ROASTER_PORT:-8000}" "$@"
