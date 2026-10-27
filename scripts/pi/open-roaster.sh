#!/bin/sh
set -eu
ROASTER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROASTER_STATE="${ROASTER_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ganf-roaster}"
ROASTER_URL="http://127.0.0.1:${ROASTER_PORT:-8000}"
mkdir -p "$ROASTER_STATE"
if ! curl --fail --silent "$ROASTER_URL/api/v1/runtime/health" >/dev/null; then
    nohup "$ROASTER_ROOT/start-roaster.sh" > "$ROASTER_STATE/service.log" 2>&1 &
    ROASTER_ATTEMPT=0
    until curl --fail --silent "$ROASTER_URL/api/v1/runtime/health" >/dev/null; do
        ROASTER_ATTEMPT=$((ROASTER_ATTEMPT+1))
        if [ "$ROASTER_ATTEMPT" -ge 30 ]; then
            printf 'Service did not start. See %s/service.log\n' "$ROASTER_STATE" >&2
            exit 1
        fi
        sleep 1
    done
fi
exec xdg-open "$ROASTER_URL"
