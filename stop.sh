#!/bin/sh
set -e
if pgrep -f 'even-t3-bridge/src/index.ts' >/dev/null 2>&1; then
  pkill -f 'even-t3-bridge/src/index.ts' || true
  echo "stopped"
else
  echo "not running"
fi
