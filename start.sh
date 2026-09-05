#!/bin/sh
# Foreground: prints pairing URL + token. Stop stock even-terminal first if it owns :3456.
# Pass --tailscale to advertise this T3 and scan peers. Pass --host to bind a specific address.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
if [ ! -d node_modules ]; then
  npm install
fi
exec npx tsx src/index.ts "$@"
