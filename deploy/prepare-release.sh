#!/usr/bin/env bash
set -euo pipefail

# A release runs from its own tree and installs nothing: the runtime imports
# only Bun and Node built-ins, the frontend arrives built, and bunfig.toml turns
# off Bun's install-on-import, so a package the tree does not carry is an error
# rather than a download. This checks that the release still has that shape.

bun_bin="${BUN_BIN:-/usr/local/bin/bun}"
if [ ! -x "$bun_bin" ]; then
  echo "Bun is not installed at the configured system path." >&2
  exit 1
fi

"$bun_bin" --no-env-file -e '
const declared = Object.keys((await Bun.file("package.json").json()).dependencies ?? {});
if (declared.length > 0) {
  console.error(`A release installs no packages, yet package.json declares runtime dependencies: ${declared.join(", ")}.`);
  process.exit(1);
}
'

test -f frontend/dist/index.html
