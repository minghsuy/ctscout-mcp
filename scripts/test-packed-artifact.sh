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
EXPECTED_MCP_SERVER_VERSION="$(node -p "require('$REPO_ROOT/package.json').dependencies['@modelcontextprotocol/server']")"
LOCKED_MCP_SERVER_SPECIFIER="$(node -p "require('$REPO_ROOT/package-lock.json').packages[''].dependencies['@modelcontextprotocol/server']")"
RUNTIME_PACKS="$PACK_TMP/runtime-packs"
CONSUMER_CACHE="$PACK_TMP/consumer-cache"

tar -tzf "$PACK_TARBALL" >"$PACK_LIST"

# Pack the exact locked runtime dependencies too. npm ci guarantees these
# directories match package-lock.json; passing their tarballs explicitly lets
# the consumer install run against an intentionally empty cache. That proves
# the package's dependency graph without either a repo node_modules symlink or
# a registry/packument lookup.
mkdir -p "$INSTALL_ROOT" "$RUNTIME_PACKS"
for dependency in \
  "$REPO_ROOT/node_modules/@modelcontextprotocol/server" \
  "$REPO_ROOT/node_modules/@modelcontextprotocol/core" \
  "$REPO_ROOT/node_modules/zod"; do
  npm_config_cache="$PACK_TMP/runtime-cache" npm pack \
    --ignore-scripts \
    --silent \
    --pack-destination "$RUNTIME_PACKS" \
    "$dependency" \
    >/dev/null
done

npm_config_cache="$CONSUMER_CACHE" npm install \
  --prefix "$INSTALL_ROOT" \
  --ignore-scripts \
  --offline \
  --no-audit \
  --no-fund \
  --package-lock=false \
  "$PACK_TARBALL" \
  "$RUNTIME_PACKS"/*.tgz

node "$REPO_ROOT/scripts/assert-packed-artifact.mjs" \
  "$INSTALLED_PACKAGE" \
  "$INSTALLED_BIN" \
  "$PACK_LIST" \
  "$EXPECTED_VERSION" \
  "$EXPECTED_MCP_SERVER_VERSION" \
  "$LOCKED_MCP_SERVER_SPECIFIER"
