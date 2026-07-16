#!/usr/bin/env bash
# Bridge script: read port from userData, POST hook payload to localhost.
# Always exit 0 — Claude Code must not see failures from our notifier.
set -u
if [ "$(uname -s)" = "Darwin" ]; then
  PORT_FILE="${HOME}/Library/Application Support/DesktopPet/notify.port"
else
  PORT_FILE="${HOME}/.config/DesktopPet/notify.port"
fi
[ -f "$PORT_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")
[ -n "$PORT" ] || exit 0
curl -s -X POST -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:${PORT}/notify" >/dev/null 2>&1
exit 0
