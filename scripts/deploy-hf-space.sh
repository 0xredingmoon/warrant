#!/usr/bin/env bash
# Create or update the public Hugging Face Docker Space that runs the Warrant relayer.
#
#   HF_TOKEN=… HF_SPACE=<hf-username>/warrant-relayer ./scripts/deploy-hf-space.sh
#
# Reads RELAYER_PRIVATE_KEY from .demo/hosted-relayer.key (or RELAYER_KEY_FILE) and
# sets it as a Space secret without printing it. Does not commit or log the key.
set -euo pipefail

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "HF_TOKEN is not set. Create a token at https://huggingface.co/settings/tokens and export it." >&2
  exit 1
fi
if [[ -z "${HF_SPACE:-}" ]]; then
  echo "HF_SPACE is not set. Example: export HF_SPACE=yourname/warrant-relayer" >&2
  exit 1
fi
if [[ "$HF_SPACE" != */* ]]; then
  echo "HF_SPACE must be in the form <username>/<space-name>, e.g. alice/warrant-relayer" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="${RELAYER_KEY_FILE:-$ROOT/.demo/hosted-relayer.key}"
if [[ ! -f "$KEY_FILE" ]]; then
  echo "Relayer key file not found: $KEY_FILE" >&2
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2
  exit 1
fi

# huggingface_hub in a user venv (system Python may be PEP 668 managed).
HF_VENV="${WARRANT_HF_VENV:-$HOME/.cache/warrant-hf-venv}"
if [[ ! -x "$HF_VENV/bin/python" ]] || ! "$HF_VENV/bin/python" -c "import huggingface_hub" >/dev/null 2>&1; then
  echo "Installing huggingface_hub into $HF_VENV…" >&2
  python3 -m venv "$HF_VENV"
  "$HF_VENV/bin/pip" install -q -U pip "huggingface_hub>=0.26"
fi
HF_PY="$HF_VENV/bin/python"


# All Hugging Face API work happens in Python so the key stays in a local variable
# and is never echoed, logged, or passed on a command line.
export WARRANT_ROOT="$ROOT"
export WARRANT_KEY_FILE="$KEY_FILE"
"$HF_PY" - <<'PY'
import os, stat, tempfile, shutil
from pathlib import Path
from huggingface_hub import HfApi, SpaceHardware, create_repo

token = os.environ["HF_TOKEN"]
space = os.environ["HF_SPACE"]
root = Path(os.environ["WARRANT_ROOT"])
key_path = Path(os.environ["WARRANT_KEY_FILE"])

key = key_path.read_text().strip()
if not key.startswith("0x") or len(key) != 66:
    raise SystemExit("Relayer key file is not a 32-byte 0x-prefixed hex key")

api = HfApi(token=token)
url = create_repo(
    space,
    repo_type="space",
    space_sdk="docker",
    private=False,
    exist_ok=True,
    token=token,
)
print(f"space {url}")
# Never use paid hardware. cpu-basic is the free CPU tier.
try:
    runtime = api.get_space_runtime(space)
    current = getattr(runtime, "hardware", None)
    print(f"current hardware: {current}")
    paid = current not in (None, SpaceHardware.CPU_BASIC, "cpu-basic") and str(current) != "cpu-basic"
    if paid:
        raise SystemExit(f"refusing to use paid Space hardware: {current}")
except Exception as e:
    if "refusing to use paid" in str(e):
        raise
    print(f"runtime not ready yet ({e.__class__.__name__}); requesting cpu-basic")
api.request_space_hardware(repo_id=space, hardware=SpaceHardware.CPU_BASIC)
print("hardware pinned to cpu-basic (free CPU)")

# Secret first, so a build that starts after the upload already has the key.
api.add_space_secret(repo_id=space, key="RELAYER_PRIVATE_KEY", value=key)
variables = {
    "FACTORY_ADDRESS": "0x66687369d9C683aaaaDAe98b747b63eE7e0662E3",
    "RPC_URL": "https://rpc-test.qday.info",
    "CHAIN_ID": "44005",
    "TRUSTED_IP_HEADER": "x-forwarded-for",
    "HOST": "0.0.0.0",
    "PORT": "7860",
    "DATABASE_PATH": "/tmp/relayer.db",
}
for k, v in variables.items():
    api.add_space_variable(repo_id=space, key=k, value=v)
print("set Space secret RELAYER_PRIVATE_KEY and variables:", ", ".join(variables))

# Stage a clean tree: the Space Dockerfile plus the files it COPYs. Never include keys or .env.
staging = Path(tempfile.mkdtemp(prefix="warrant-hf-"))
try:
    shutil.copyfile(root / "deploy/hf-space/Dockerfile", staging / "Dockerfile")
    shutil.copyfile(root / "deploy/hf-space/README.md", staging / "README.md")
    for rel in (
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.base.json",
    ):
        shutil.copyfile(root / rel, staging / rel)
    for pkg in ("sdk", "store", "relayer", "merchant", "demo", "mcp"):
        src = root / "packages" / pkg
        dst = staging / "packages" / pkg
        shutil.copytree(
            src,
            dst,
            ignore=shutil.ignore_patterns("node_modules", "dist", ".turbo", "coverage", "*.tsbuildinfo"),
        )
    web_dst = staging / "web"
    web_dst.mkdir(parents=True)
    shutil.copyfile(root / "web/package.json", web_dst / "package.json")

    # Double-check no key material slipped into the staging tree.
    for p in staging.rglob("*"):
        name = p.name.lower()
        if name in {".env", "hosted-relayer.key", "hosted-relayer.key.nonl"} or name.endswith(".key"):
            raise SystemExit(f"refusing to upload {p}")

    api.upload_folder(
        repo_id=space,
        repo_type="space",
        folder_path=str(staging),
        commit_message="Deploy Warrant relayer Space",
        ignore_patterns=[".git", ".demo", ".env", "*.key"],
    )
finally:
    shutil.rmtree(staging, ignore_errors=True)

user, name = space.split("/", 1)
hf_url = f"https://{user}-{name}.hf.space".replace("_", "-")
print(f"uploaded. public URL (once the Space is built): {hf_url}")
print(f"space page: https://huggingface.co/spaces/{space}")
print("Then set the GitHub Actions variable RELAYER_URL to that public URL and re-run the pages workflow.")
PY
