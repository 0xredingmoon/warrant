#!/usr/bin/env bash
# Deploy the protocol to the local anvil fork with a throwaway funded key, via the real forge deploy script.
# Writes deployments/fork.json. Run `pnpm fork` first.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
RPC="${RPC_URL:-http://127.0.0.1:8545}"
read -r KEY ADDR < <(cast wallet new --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")).data[0];console.log(j.private_key,j.address)')
cast rpc --rpc-url "$RPC" anvil_setBalance "$ADDR" 0x56BC75E2D63100000 >/dev/null   # 100 tQDAY (fork only)
DEPLOYER_PRIVATE_KEY="$KEY" forge script script/Deploy.s.sol --rpc-url "$RPC" --legacy --broadcast >/dev/null
node scripts/record-deployment.mjs fork 44005 https://explorer-test.qday.info >/dev/null
echo "deployed to fork: deployments/fork.json"
