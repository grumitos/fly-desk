#!/usr/bin/env bash
set -euo pipefail

# The release artifact the platform installs, as `deploy-vps.yml` ships it:
# `git archive` of the revision under one `app/` root, the frontend built from
# this checkout, and a REVISION file. Ordering, timestamps, ownership and gzip
# metadata are normalized, so the same revision and build give the same bytes,
# and nothing untracked can enter a release.
#
#   scripts/pack-release.sh <revision> <output.tar.gz>

if [ "$#" -ne 2 ]; then
  echo "Usage: scripts/pack-release.sh <revision> <output.tar.gz>" >&2
  exit 2
fi
revision="$1"
output="$2"

if [ ! -f frontend/dist/index.html ]; then
  echo "frontend/dist is missing: run \`bun run build\` first." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

install -d -m 0755 "$work/package"
git archive --format=tar --prefix=app/ "$revision" | tar -xf - -C "$work/package"
rm -rf "$work/package/app/frontend/dist"
install -d -m 0755 "$work/package/app/frontend"
cp -R frontend/dist "$work/package/app/frontend/dist"
find "$work/package/app/frontend/dist" -type d -exec chmod 0755 {} +
find "$work/package/app/frontend/dist" -type f -exec chmod 0644 {} +
printf '%s\n' "$revision" > "$work/package/app/REVISION"
chmod 0644 "$work/package/app/REVISION"
tar \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -cf - -C "$work/package" app | gzip -n > "$output"
