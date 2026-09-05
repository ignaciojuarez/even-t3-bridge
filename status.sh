#!/bin/sh
echo "=== process ==="
pgrep -lf 'even-t3-bridge/src/index.ts' || echo "(not running)"
echo "=== even-terminal (port conflict) ==="
pgrep -lf 'even-terminal' || echo "(not running)"
echo "=== runtime ==="
if [ -f "$HOME/.even-t3-bridge/runtime.json" ]; then
  cat "$HOME/.even-t3-bridge/runtime.json"
else
  echo "(no runtime)"
fi
echo "=== T3 ==="
if [ -f "$HOME/.t3/userdata/server-runtime.json" ]; then
  cat "$HOME/.t3/userdata/server-runtime.json"
else
  echo "(T3 not running)"
fi
