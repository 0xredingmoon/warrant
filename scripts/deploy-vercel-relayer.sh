#!/usr/bin/env bash
# Deploy the Warrant relayer as a Vercel Hobby function (free, no credit card, no paid plan).
#
#   VERCEL_TOKEN=… ./scripts/deploy-vercel-relayer.sh
#
# Reads RELAYER_PRIVATE_KEY from .demo/hosted-relayer.key (or RELAYER_KEY_FILE)
# and sets it as a production env var without printing it. Never upgrades the
# project to Pro and never starts a paid add-on.
set -euo pipefail

# Do not leak secrets if someone runs `bash -x`.
set +o xtrace
export PS4='+ '

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "VERCEL_TOKEN is not set." >&2
  echo "Sign in with GitHub at https://vercel.com/signup (Hobby plan, no card)," >&2
  echo "then create a token named warrant-relayer at https://vercel.com/account/tokens" >&2
  echo "(scope: Full Account, expiry after mid-December 2026 is fine) and export it." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEY_FILE="${RELAYER_KEY_FILE:-$ROOT/.demo/hosted-relayer.key}"
if [[ -z "${RELAYER_PRIVATE_KEY:-}" ]]; then
  if [[ ! -f "$KEY_FILE" ]]; then
    echo "Relayer key file not found: $KEY_FILE" >&2
    echo "Set RELAYER_PRIVATE_KEY or RELAYER_KEY_FILE to a throwaway testnet key." >&2
    exit 1
  fi
  RELAYER_PRIVATE_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
fi
if [[ ! "$RELAYER_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "Relayer key is not a 32-byte 0x-prefixed hex key" >&2
  exit 1
fi

FACTORY_ADDRESS="${FACTORY_ADDRESS:-0x66687369d9C683aaaaDAe98b747b63eE7e0662E3}"
RPC_URL="${RPC_URL:-https://rpc-test.qday.info}"
CHAIN_ID="${CHAIN_ID:-44005}"
EXPLORER_URL="${EXPLORER_URL:-https://explorer-test.qday.info}"
PROJECT_NAME="${VERCEL_PROJECT_NAME:-warrant-relayer}"

VC=(npx --yes vercel@latest)
TOKEN_ARGS=(--token "$VERCEL_TOKEN" --yes)

echo "Linking Vercel project $PROJECT_NAME (Hobby / free)..."
LINK_ARGS=("${TOKEN_ARGS[@]}" --project "$PROJECT_NAME")
if [[ -n "${VERCEL_SCOPE:-}" ]]; then
  LINK_ARGS+=(--scope "$VERCEL_SCOPE")
fi
# Non-interactive link: create the project on the personal Hobby team if needed.
if ! "${VC[@]}" link "${LINK_ARGS[@]}" >/dev/null; then
  "${VC[@]}" project add "$PROJECT_NAME" "${TOKEN_ARGS[@]}" || true
  if ! "${VC[@]}" link "${LINK_ARGS[@]}"; then
    echo "Could not link the Vercel project. Check that the token has Full Account scope." >&2
    exit 1
  fi
fi

upsert_env() {
  local name="$1"
  local value="$2"
  # Remove a previous production value if it exists (stdout/stderr may mention the name, never the value).
  "${VC[@]}" env rm "$name" production "${TOKEN_ARGS[@]}" >/dev/null 2>&1 || true
  # stdin only: the value never appears on the command line.
  printf '%s' "$value" | "${VC[@]}" env add "$name" production "${TOKEN_ARGS[@]}" >/dev/null
  echo "set production env $name"
}

# Secrets and public config. DATABASE_PATH is /tmp because the function FS is otherwise read-only.
upsert_env RELAYER_PRIVATE_KEY "$RELAYER_PRIVATE_KEY"
unset RELAYER_PRIVATE_KEY
upsert_env FACTORY_ADDRESS "$FACTORY_ADDRESS"
upsert_env RPC_URL "$RPC_URL"
upsert_env CHAIN_ID "$CHAIN_ID"
upsert_env EXPLORER_URL "$EXPLORER_URL"
upsert_env DATABASE_PATH "/tmp/relayer.db"
upsert_env TRUSTED_IP_HEADER "x-forwarded-for"

echo "Deploying $PROJECT_NAME to production on the Hobby plan…"
# --prod promotes the deployment. No plan flag: stay on Hobby.
URL="$("${VC[@]}" deploy --prod "${TOKEN_ARGS[@]}" --name "$PROJECT_NAME")"
echo "deployed: $URL"
echo "health: ${URL%/}/health"
echo "Set the GitHub Pages config RELAYER_URL to that origin and republish the dashboard."
