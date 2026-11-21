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

# CLI 66 reads VERCEL_TOKEN from the environment; do not put the token on argv.
# --cwd $ROOT so a folder named deploy/ is not treated as the project root.
# Do not put --yes before the subcommand: `vercel --yes teams ls` is parsed as a
# deploy of two paths and errors with "Can't deploy more than one path."
VC=(npx --yes vercel@latest --cwd "$ROOT")
if [[ -n "${VERCEL_SCOPE:-}" ]]; then
  VC+=(--scope "$VERCEL_SCOPE")
fi

echo "Checking the Vercel team is on the Hobby plan…"
# `teams ls` writes the table to stderr. A failed lookup must not abort the script
# before we have printed anything; we still refuse a non-Hobby plan when we see one.
plan="$("${VC[@]}" teams ls 2>&1 | awk 'tolower($0) ~ /hobby|pro|enterprise/ { for (i=1;i<=NF;i++) { l=tolower($i); if (l=="hobby"||l=="pro"||l=="enterprise") print l } }' | tail -n 1 || true)"
if [[ -n "$plan" && "$plan" != "hobby" ]]; then
  echo "Refusing to deploy: the Vercel team plan is '$plan', not Hobby." >&2
  exit 1
fi
echo "Vercel plan is ${plan:-hobby (assumed)}. Creating or reusing project $PROJECT_NAME…"

if ! "${VC[@]}" project inspect "$PROJECT_NAME" >/dev/null 2>&1; then
  "${VC[@]}" project create "$PROJECT_NAME"
fi

# Pin Node 24 (node:sqlite) and an explicit non-Next framework so web/ is not auto-detected.
"${VC[@]}" project update "$PROJECT_NAME" --node-version 24.x --framework other --yes >/dev/null

# The dashboard on GitHub Pages must be able to call /health without logging in.
if "${VC[@]}" project protection disable "$PROJECT_NAME" --sso --yes; then
  echo "disabled Vercel Authentication so /health is public"
else
  echo "warning: could not toggle deployment protection; will verify /health after deploy" >&2
fi

upsert_env() {
  local name="$1"
  local value="$2"
  local extra=()
  if [[ "${3:-}" == "sensitive" ]]; then
    extra+=(--sensitive)
  fi
  # stdin only: the value never appears on the command line. --force overwrites.
  # CLI 66 wants --environment, not a positional environment argument.
  printf '%s' "$value" | "${VC[@]}" env add "$name" --environment production --project "$PROJECT_NAME" --force --yes "${extra[@]}" >/dev/null
  echo "set production env $name"
}

upsert_env RELAYER_PRIVATE_KEY "$RELAYER_PRIVATE_KEY" sensitive
unset RELAYER_PRIVATE_KEY
upsert_env FACTORY_ADDRESS "$FACTORY_ADDRESS"
upsert_env RPC_URL "$RPC_URL"
upsert_env CHAIN_ID "$CHAIN_ID"
upsert_env EXPLORER_URL "$EXPLORER_URL"
upsert_env DATABASE_PATH "/tmp/relayer.db"
upsert_env TRUSTED_IP_HEADER "x-forwarded-for"

echo "Deploying $PROJECT_NAME to production on the Hobby plan…"
# --create-if-missing is required in non-interactive mode when the --project is new.
# --json so we can print only the URL, not a log that might be noisy.
raw="$("${VC[@]}" deploy --prod --yes --project "$PROJECT_NAME" --create-if-missing --json)"
URL="$(python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
url = data.get("url") or data.get("alias") or ""
if url and not url.startswith("http"):
    url = "https://" + url
aliases = data.get("aliases") or data.get("alias") or []
if isinstance(aliases, str):
    aliases = [aliases]
prod = url
for a in aliases:
    s = a if str(a).startswith("http") else "https://" + str(a)
    if s.endswith(".vercel.app"):
        prod = s
        if "warrant-relayer" in s:
            break
if not prod:
    raise SystemExit("deploy JSON did not include a url")
print(prod)
' <<<"$raw")"
echo "deployed: $URL"
echo "health: ${URL%/}/health"
echo "Set the GitHub Pages config RELAYER_URL to that origin and republish the dashboard."
