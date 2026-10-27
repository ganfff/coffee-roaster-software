#!/bin/sh
set -eu
ROASTER_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 -m venv "$ROASTER_ROOT/.venv"
"$ROASTER_ROOT/.venv/bin/python" -m pip install -r "$ROASTER_ROOT/requirements.txt"
if [ ! -f "$ROASTER_ROOT/config.yaml" ]; then
    cp "$ROASTER_ROOT/config.example.yaml" "$ROASTER_ROOT/config.yaml"
fi
ROASTER_APPLICATIONS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$ROASTER_APPLICATIONS"
printf '[Desktop Entry]\nType=Application\nName=咖啡烘焙机控制台\nExec="%s/open-roaster.sh"\nIcon=applications-utilities\nTerminal=false\nCategories=Utility;\n' "$ROASTER_ROOT" > "$ROASTER_APPLICATIONS/ganf-roaster.desktop"
printf '%s\n' 'Installed. Open 咖啡烘焙机控制台, or run ./start-roaster.sh for terminal debugging.'
