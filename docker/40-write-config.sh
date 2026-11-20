#!/bin/sh
# Writes /config.js for the static dashboard from environment variables. Unset values fall back to the build's defaults.
set -eu
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
out="${WARRANT_WEB_ROOT:-/usr/share/nginx/html}/config.js"
{
  echo "window.__WARRANT__ = {"
  [ -n "${RELAYER_URL:-}" ]  && echo "  relayerUrl: \"$(esc "$RELAYER_URL")\","
  [ -n "${RPC_URL:-}" ]      && echo "  rpcUrl: \"$(esc "$RPC_URL")\","
  [ -n "${EXPLORER_URL:-}" ] && echo "  explorer: \"$(esc "$EXPLORER_URL")\","
  [ -n "${INDEXER_URL:-}" ]  && echo "  indexerUrl: \"$(esc "$INDEXER_URL")\","
  [ -n "${FACTORY_ADDRESS:-}" ]  && echo "  factory: \"$(esc "$FACTORY_ADDRESS")\","
  [ -n "${REGISTRY_ADDRESS:-}" ] && echo "  registry: \"$(esc "$REGISTRY_ADDRESS")\","
  echo "};"
} > "$out"
echo "wrote $out"
