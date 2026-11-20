# Demo run on Aevum testnet

Recorded 2026-11-20T11:44:33.027Z. 14 transactions, 3 payments refused by the vault before any transaction was sent.

| | |
| --- | --- |
| Chain | 44005 |
| WarrantFactory | `0x9D2CF5776359fD502a1a09862D8Ef03F41446442` |
| AgentRegistry | `0x5Efd32A5BC15880CCa0bF2E19346316E3C00762a` |
| Vault | `0x927d8b1030E90d94039b3281A3E4b415E11c6aba` |
| Agent key (signs only, holds no tQDAY) | `0xC53B6958b1e7D2BA8d3473Cb4a7D85FA3c276AE9` |
| Merchant (Ledgerline Data) | `0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae` |
| Attacker address from the injected page | `0x276DF79D3f59b2a496D1D01a4F167307f2ca2f33` |
| Mandate | #1 |

| Step | Result | What happened | Transaction |
| --- | --- | --- | --- |
| 01 | Setup | sent 0.03 tQDAY to relayer for gas | [0xbbb7c301abbe3437b8778b974b5c8582d74482cdf337e047097e4677475fa64b](https://explorer-test.qday.info/tx/0xbbb7c301abbe3437b8778b974b5c8582d74482cdf337e047097e4677475fa64b) |
| 01 | Setup | sent 0.005 tQDAY to Ledgerline (merchant) for gas | [0x38ef7070c7a3374ae290632b95c2f2ff16c74a70f67ed0b57504acdd29daefca](https://explorer-test.qday.info/tx/0x38ef7070c7a3374ae290632b95c2f2ff16c74a70f67ed0b57504acdd29daefca) |
| 02 | Setup | vault 0x927d8b1030E90d94039b3281A3E4b415E11c6aba | [0x29e5b3c27131293934016b9d4ef465a6c094527d64e7fb5890f017858c86570a](https://explorer-test.qday.info/tx/0x29e5b3c27131293934016b9d4ef465a6c094527d64e7fb5890f017858c86570a) |
| 03 | Setup | agent #1 registered (ERC-721, owner 0x462E1FcE506B5067cb46531659195C0417f9e86f) | [0x7c20430e2f3cb8c8d2314faca8723b2a4f411ca44ee3da12e3add62f71274a5a](https://explorer-test.qday.info/tx/0x7c20430e2f3cb8c8d2314faca8723b2a4f411ca44ee3da12e3add62f71274a5a) |
| 03 | Setup | agent wallet 0xC53B6958b1e7D2BA8d3473Cb4a7D85FA3c276AE9 signed its own binding | [0x969b446b6c06b5b18d91b45475f2c08efc77be0fa85388269ad5a827f87e6654](https://explorer-test.qday.info/tx/0x969b446b6c06b5b18d91b45475f2c08efc77be0fa85388269ad5a827f87e6654) |
| 04 | Done | 2.00 tUSD8 in the vault | [0x96352defcb7392f449d80811d9ab2ee907afaa3f816f09ff285c1d09dc01c29a](https://explorer-test.qday.info/tx/0x96352defcb7392f449d80811d9ab2ee907afaa3f816f09ff285c1d09dc01c29a) |
| 05 | Setup | mandate #1: Ledgerline only, 1.00 per payment, 1.00 per day, 3.00 total, owner approval from 0.50, 7 days | [0x43452087c1c75d9a9059c79101cccbe16c159740a5a6da875a194a1c4991cced](https://explorer-test.qday.info/tx/0x43452087c1c75d9a9059c79101cccbe16c159740a5a6da875a194a1c4991cced) |
| 06 | Paid | 0.15 tUSD8 → Ledgerline, got revenue 4120.5M (+11.4%) | [0xe301737072d5351cece73da80d7c157f86d0955f80921627398720c3c2f7aea2](https://explorer-test.qday.info/tx/0xe301737072d5351cece73da80d7c157f86d0955f80921627398720c3c2f7aea2) |
| 07 | Paid | 0.25 tUSD8 → Ledgerline, 9812 words of transcript | [0xa37a0c6c9d32555c98c5014dea4d67285b4c5277b3eefecd0fe0de2f3ad9cf62](https://explorer-test.qday.info/tx/0xa37a0c6c9d32555c98c5014dea4d67285b4c5277b3eefecd0fe0de2f3ad9cf62) |
| 08 | Refused | 0.40 tUSD8 → 0x276DF79D3f59b2a496D1D01a4F167307f2ca2f33: That recipient is not on this mandate's merchant allowlist. The agent may only pay merchants the owner approved. | none: refused by the vault's dry run, nothing sent |
| 09 | Queued | 0.50 tUSD8 → Ledgerline waits for the owner (pending #1) | [0x4c42a7edeca2037e2d80786e33a8fc4418bef4b0dc7d31adddd2db25834dc118](https://explorer-test.qday.info/tx/0x4c42a7edeca2037e2d80786e33a8fc4418bef4b0dc7d31adddd2db25834dc118) |
| 10 | Done | approved; Ledgerline delivered 63 documents (148 MB) | [0x654585a4d29e3ddadb11f8d5edaee4c8c46f9925b136ae20f4d9f47253aed33a](https://explorer-test.qday.info/tx/0x654585a4d29e3ddadb11f8d5edaee4c8c46f9925b136ae20f4d9f47253aed33a) |
| 11 | Refused | 0.20 tUSD8 → Ledgerline: This payment would exceed the mandate's spending limit for the current period. | none: refused by the vault's dry run, nothing sent |
| 12 | Done | mandate #1 revoked | [0x5e137c342722d64c64f3ddf127a7f2a91a3f78147c9a15956eb6310d1f332e5f](https://explorer-test.qday.info/tx/0x5e137c342722d64c64f3ddf127a7f2a91a3f78147c9a15956eb6310d1f332e5f) |
| 12 | Refused | 0.15 tUSD8 → Ledgerline: The owner revoked this mandate. No further payments are possible. | none: refused by the vault's dry run, nothing sent |
| 13 | Done | Ledgerline → agent: 96/100, tag delivery | [0xe30cdf04d23e38f94aedd3e080853b05d21aa5bb4b93177667f0d9a9b1108d5b](https://explorer-test.qday.info/tx/0xe30cdf04d23e38f94aedd3e080853b05d21aa5bb4b93177667f0d9a9b1108d5b) |
| 14 | Done | owner withdrew the remaining 1.10 tUSD8 | [0xf3be878529689487c4f7185f21d6d6c105705abc4fbbf33f906ccad00b5a1a65](https://explorer-test.qday.info/tx/0xf3be878529689487c4f7185f21d6d6c105705abc4fbbf33f906ccad00b5a1a65) |
