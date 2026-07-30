#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/ctscout-pack.XXXXXX")"
trap 'rm -rf -- "$PACK_TMP"' EXIT

PACK_JSON="$(
  cd "$REPO_ROOT"
  npm_config_cache="$PACK_TMP/npm-cache" npm pack \
    --ignore-scripts \
    --json \
    --pack-destination "$PACK_TMP"
)"
PACK_NAME="$(
  node -e 'const chunks=[]; process.stdin.on("data", c => chunks.push(c)); process.stdin.on("end", () => process.stdout.write(JSON.parse(Buffer.concat(chunks).toString())[0].filename));' \
    <<<"$PACK_JSON"
)"
PACK_TARBALL="$PACK_TMP/$PACK_NAME"
PACK_LIST="$PACK_TMP/contents.txt"
INSTALL_ROOT="$PACK_TMP/consumer"
INSTALLED_PACKAGE="$INSTALL_ROOT/node_modules/ctscout-mcp-server"
INSTALLED_BIN="$INSTALL_ROOT/node_modules/.bin/ctscout-mcp-server"
EXPECTED_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"

tar -tzf "$PACK_TARBALL" >"$PACK_LIST"

# Install the exact tarball as a consumer would. `npm ci` has already placed
# every locked dependency in npm's cache, so --offline makes this contract test
# network-free while still proving dependency resolution in a clean project.
mkdir -p "$INSTALL_ROOT"
npm install \
  --prefix "$INSTALL_ROOT" \
  --ignore-scripts \
  --offline \
  --no-audit \
  --no-fund \
  --package-lock=false \
  "$PACK_TARBALL"

node "$REPO_ROOT/scripts/assert-packed-artifact.mjs" \
  "$INSTALLED_PACKAGE" \
  "$INSTALLED_BIN" \
  "$PACK_LIST" \
  "$EXPECTED_VERSION"
