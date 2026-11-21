---
title: Warrant Relayer
emoji: 🪪
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Gas-paying relayer for Warrant mandates on Aevum testnet
---

# Warrant relayer (Hugging Face Space)

This Space runs the Warrant gas-paying relayer and x402 facilitator for the
[Aevum testnet](https://explorer-test.qday.info) dashboard. It binds `0.0.0.0:7860`.

Required Space **secret**: `RELAYER_PRIVATE_KEY` — a throwaway testnet key holding
a little tQDAY (never a key that holds real funds).

Required Space **variables**: `FACTORY_ADDRESS`, `RPC_URL`, `CHAIN_ID`,
`TRUSTED_IP_HEADER`, `HOST`, `PORT` (the deploy script sets these).

Create and upload with, from the repo root (do not print the key):

```bash
HF_TOKEN=… HF_SPACE=<your-hf-username>/warrant-relayer ./scripts/deploy-hf-space.sh
```

Then set the GitHub Actions variable `RELAYER_URL` to this Space's URL
(`https://<your-hf-username>-warrant-relayer.hf.space`) so the GitHub Pages
dashboard talks to it.
