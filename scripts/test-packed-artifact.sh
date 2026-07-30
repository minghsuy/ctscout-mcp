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

tar -tzf "$PACK_TARBALL" >"$PACK_LIST"

tar -xzf "$PACK_TARBALL" -C "$PACK_TMP"
ln -s "$REPO_ROOT/node_modules" "$PACK_TMP/package/node_modules"
ln -s "$PACK_TMP/package/dist/index.js" "$PACK_TMP/ctscout-mcp-server"

# Intentional: the stdio adapter still uses SDK v1's sessionful compatibility
# path, so this exercises its latest 2025-11-25 revision. The older
# 2024-11-05 fixture in symlink-boot.test.ts separately guards old clients.
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"packed-artifact-test","version":"0.0.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | CTSCOUT_API_KEY="ds_free_packed_contract_test" \
  node "$PACK_TMP/ctscout-mcp-server" \
  >"$PACK_TMP/stdout.jsonl" \
  2>"$PACK_TMP/stderr.txt"

node "$REPO_ROOT/scripts/assert-packed-artifact.mjs" \
  "$PACK_TMP/package" \
  "$PACK_TMP/stdout.jsonl" \
  "$PACK_TMP/stderr.txt" \
  "$PACK_LIST"
