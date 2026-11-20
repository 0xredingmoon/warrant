# Third-party notices

Warrant is MIT licensed (see `LICENSE`). All Solidity in `src/`, `test/` and `script/` was written for this
project during the Aevum Builder Challenge #1 build window (from 16 Nov 2026).

## Dependencies (git submodules in `lib/`, original LICENSE files are kept inside each folder)

| Dependency | Version | License |
|---|---|---|
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | v5.1.0 | MIT |
| [forge-std](https://github.com/foundry-rs/forge-std) | v1.x | MIT OR Apache-2.0 |

## Standards implemented (specifications, no code copied)

- EIP-712 typed data, EIP-1271 contract signatures, EIP-2612 `permit`, EIP-3009 `receiveWithAuthorization`.
- ERC-8004 "Trustless Agents": `AgentRegistry` follows the identity registry interface and the reputation
  vocabulary; it is our own deployment.

## Aevum Starter Kit (MIT, (c) 2026 PQA Labs)

https://github.com/qday-io/aevum-starter-kit was used as a **reference for platform facts only** (Shanghai
EVM, 1,000-block `eth_getLogs` limit, legacy transactions, tUSD8 EIP-712 domain). No code or files were copied
from it. If a later phase reuses any snippet (for example the chunked log reader), it will be listed here with
a source comment above it in the file.
