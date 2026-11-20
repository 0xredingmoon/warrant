#!/usr/bin/env bash
# Local anvil fork of Aevum testnet (chain 44005, Shanghai EVM). Nothing here touches the real network.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
PORT="${PORT:-8545}"
exec anvil --fork-url "${AEVUM_RPC_URL:-https://rpc-test.qday.info}" --hardfork shanghai --port "$PORT" --silent "$@"
