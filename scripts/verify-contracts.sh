#!/usr/bin/env bash
# Source-verify the deployed contracts on the Aevum Blockscout explorer.
#
# The factory deploys each vault itself, so the explorer cannot match a vault's source on its own: every vault
# needs its own `forge verify-contract` call with its constructor arguments. This script reads the addresses and
# the constructor arguments from the chain, so nothing has to be copied by hand.
#
# usage: bash scripts/verify-contracts.sh [vault ...]
#   with no arguments: the factory, the registry and the demo vault from deployments/aevum.json;
#   with vault addresses: those vaults as well (or instead).
set -euo pipefail

export PATH="$PATH:${HOME}/.foundry/bin"
RPC="${AEVUM_RPC_URL:-https://rpc-test.qday.info}"
VERIFIER_URL="${EXPLORER_API_URL:-https://explorer-test.qday.info/api/}"
CHAIN=44005
COMPILER="0.8.24"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

read_field() {
  node -e "const d=require('./deployments/aevum.json'); process.stdout.write(String(d$1 ?? ''))"
}
FACTORY="$(read_field '.WarrantFactory.address')"
REGISTRY="$(read_field '.AgentRegistry.address')"
TUSD8="$(read_field '.tUSD8')"
DEPLOY_BLOCK="$(read_field '.deployBlock')"

# already verified on the explorer? (Blockscout v2 API answers 404 for an unverified address)
is_verified() {
  curl -fsS "https://explorer-test.qday.info/api/v2/smart-contracts/$1" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.exit(JSON.parse(s).is_verified?0:1)}catch{process.exit(1)}})"
}

verify() {
  local address="$1" contract="$2"; shift 2
  echo "== $contract $address"
  if is_verified "$address"; then
    echo "   already verified: https://explorer-test.qday.info/address/$address?tab=contract"
    return 0
  fi
  forge verify-contract "$address" "$contract" \
    --chain "$CHAIN" \
    --verifier blockscout \
    --verifier-url "$VERIFIER_URL" \
    --compiler-version "$COMPILER" \
    --watch \
    "$@"
  echo "   https://explorer-test.qday.info/address/$address?tab=contract"
}

# WarrantFactory(tUSD8, treasury)
verify "$FACTORY" "src/WarrantFactory.sol:WarrantFactory" \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$TUSD8" "$(cast call "$FACTORY" 'owner()(address)' --rpc-url "$RPC")")"

# AgentRegistry has no constructor arguments
verify "$REGISTRY" "src/AgentRegistry.sol:AgentRegistry"

# WarrantVault(tUSD8, owner, guardian, registry): read all four from the vault itself
verify_vault() {
  local vault="$1"
  local owner guardian
  owner="$(cast call "$vault" 'owner()(address)' --rpc-url "$RPC")"
  guardian="$(cast call "$vault" 'guardian()(address)' --rpc-url "$RPC" 2>/dev/null || echo 0x0000000000000000000000000000000000000000)"
  verify "$vault" "src/WarrantVault.sol:WarrantVault" \
    --constructor-args "$(cast abi-encode 'constructor(address,address,address,address)' "$TUSD8" "$owner" "$guardian" "$REGISTRY")"
}

if [ "$#" -eq 0 ]; then
  # the first vault the factory ever deployed, the one docs/live-run.md walks through (unless a vault is not built yet)
  FIRST_CREATED_BLOCK="$((DEPLOY_BLOCK))"
  DEMO_VAULT="$(curl -fsS "https://explorer-test.qday.info/api?module=logs&action=getLogs&fromBlock=${FIRST_CREATED_BLOCK}&toBlock=latest&address=${FACTORY}&topic0=$(cast keccak 'VaultCreated(address,address,address,bytes32)')" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).result||[];const f=r[0];process.stdout.write(f?'0x'+f.topics[2].slice(26):'')})")"
  if [ -n "$DEMO_VAULT" ]; then verify_vault "$DEMO_VAULT"; fi
else
  for v in "$@"; do verify_vault "$v"; done
fi

echo
echo "all listed contracts are source-verified."
