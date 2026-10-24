#!/bin/sh
# VS Code started from the Dock may not have mise's node on PATH.
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then exec node server.mjs; fi
exec "$HOME/.local/share/mise/shims/node" server.mjs
