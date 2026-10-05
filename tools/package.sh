#!/usr/bin/env bash
# Builds the Chrome Web Store upload ZIP.
#
# Validates first, then packs only what the extension needs at runtime — no docs,
# no tooling, no VCS metadata, no macOS resource forks (the store rejects the
# "__MACOSX" entries that a plain `zip -r` leaves behind).
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/terriergpt-companion-${VERSION}.zip"

echo "Validating…"
node tools/validate.mjs
node tools/test-prompt.mjs
node tools/test-agents.mjs
node tools/test-flows.mjs

rm -rf dist
mkdir -p dist

echo "Packing ${OUT}…"
COPYFILE_DISABLE=1 zip -r -q -X "$OUT" \
  manifest.json \
  service-worker.js \
  lib \
  content \
  sidepanel \
  options \
  icons \
  -x '*.DS_Store' '*/.*'

echo
unzip -l "$OUT"
echo
echo "Ready: ${OUT}"
echo "Upload at https://chrome.google.com/webstore/devconsole — set Visibility to Unlisted."
