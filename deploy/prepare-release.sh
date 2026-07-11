#!/usr/bin/env bash
set -euo pipefail

bun_bin="${BUN_BIN:-/usr/local/bin/bun}"
if [ ! -x "$bun_bin" ]; then
  echo "Bun is not installed at the configured system path." >&2
  exit 1
fi

"$bun_bin" install --frozen-lockfile
test -f frontend/dist/index.html
