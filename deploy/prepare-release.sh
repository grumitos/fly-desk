#!/usr/bin/env bash
set -euo pipefail

bun_bin="${BUN_BIN:-/usr/local/bin/bun}"
if [ ! -x "$bun_bin" ]; then
  echo "Bun is not installed at the configured system path." >&2
  exit 1
fi

"$bun_bin" install --frozen-lockfile --backend copyfile

# A release has to carry its own dependencies. Emptying Bun's package cache is
# the standing remedy when the builder leaves root-owned files in it, and a
# release that only borrows from that cache stops working the moment it is
# emptied. `--backend copyfile` asks for copies but does not promise them: with
# a global store configured, Bun links packages into `node_modules` whatever the
# backend says, and the flag reports success either way. So the guarantee has to
# come from reading the result, not from the request. Nothing in this repository
# turns that store on, and this is what keeps it that way.
release_root="$(pwd -P)"
borrowed=""
while IFS= read -r link; do
  [ -n "$link" ] || continue
  target="$(readlink -f "$link" 2>/dev/null || true)"
  [ -n "$target" ] || continue
  case "$target" in
    "$release_root"/*) ;;
    *)
      borrowed="$link -> $target"
      break
      ;;
  esac
done < <(find node_modules frontend/node_modules -type l -print 2>/dev/null || true)

if [ -n "$borrowed" ]; then
  echo "Release install is not self-contained; a dependency lives outside it: $borrowed" >&2
  exit 1
fi

test -f frontend/dist/index.html
