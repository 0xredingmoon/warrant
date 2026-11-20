# Demo run on Aevum testnet

Recorded 2026-11-20T12:32:58.272Z. 17 transactions, 3 of them refusals the vault recorded on-chain (PaymentRefused events): no money moved in those.

| | |
| --- | --- |
| Chain | 44005 |
| WarrantFactory | `0x66687369d9C683aaaaDAe98b747b63eE7e0662E3` |
| AgentRegistry | `0xD0442513fd53FA91c411939648F9edbBF2ed747d` |
| Vault | `0x363E657fc8c8Df213AC35f675AeCA0C3E6805a16` |
| Agent key (signs only, holds no tQDAY) | `0xC53B6958b1e7D2BA8d3473Cb4a7D85FA3c276AE9` |
| Merchant (Ledgerline Data) | `0xf2b01C5b12DaAe6adAa0a876065D303302F4b4Ae` |
| Attacker address from the injected page | `0x276DF79D3f59b2a496D1D01a4F167307f2ca2f33` |
| Mandate | #1 |

| Step | Result | What happened | Transaction |
| --- | --- | --- | --- |
| 01 | Setup | sent 0.0016602372 tQDAY to relayer for gas | [0xd10b6a6932e473dc88686477ef05c34d9df93d85a5625b545655169f281d5fcc](https://explorer-test.qday.info/tx/0xd10b6a6932e473dc88686477ef05c34d9df93d85a5625b545655169f281d5fcc) |
| 01 | Setup | sent 0.000190998 tQDAY to Ledgerline (merchant) for gas | [0x371c91a67359ade7514c11cfc5cb68ee0b2ba58f5ff9f1a8bfedb9b8e8331e28](https://explorer-test.qday.info/tx/0x371c91a67359ade7514c11cfc5cb68ee0b2ba58f5ff9f1a8bfedb9b8e8331e28) |
| 02 | Setup | vault 0x363E657fc8c8Df213AC35f675AeCA0C3E6805a16 | [0x18b65ee9c2e12bdb292a07d98dad2e729f0c27e45fecf3771671d5fbac69ca07](https://explorer-test.qday.info/tx/0x18b65ee9c2e12bdb292a07d98dad2e729f0c27e45fecf3771671d5fbac69ca07) |
| 03 | Setup | agent #1 registered (ERC-721, owner 0x462E1FcE506B5067cb46531659195C0417f9e86f) | [0xec7c45ea70cd3e937b534e276399c497f2ae855579a6e5c1c2a2774a53fe7309](https://explorer-test.qday.info/tx/0xec7c45ea70cd3e937b534e276399c497f2ae855579a6e5c1c2a2774a53fe7309) |
| 03 | Setup | agent wallet 0xC53B6958b1e7D2BA8d3473Cb4a7D85FA3c276AE9 signed its own binding | [0x234f02968655a3111c1f68ea4d37621ddcdd23bbee56d46c3af4a96c02ee8a92](https://explorer-test.qday.info/tx/0x234f02968655a3111c1f68ea4d37621ddcdd23bbee56d46c3af4a96c02ee8a92) |
| 04 | Done | 2.00 tUSD8 in the vault | [0xda49ff0955d424d97bcbb5ec5b3b90e7c9f1c90a83f93cd9c3511bad1d20a201](https://explorer-test.qday.info/tx/0xda49ff0955d424d97bcbb5ec5b3b90e7c9f1c90a83f93cd9c3511bad1d20a201) |
| 05 | Setup | mandate #1: Ledgerline only, 1.00 per payment, 1.00 per day, 3.00 total, owner approval from 0.50, 7 days | [0x2d090bc68a7d568cb15b310f7fc71f3f227325f4b34f14f3d2a35998f836b64e](https://explorer-test.qday.info/tx/0x2d090bc68a7d568cb15b310f7fc71f3f227325f4b34f14f3d2a35998f836b64e) |
| 06 | Paid | 0.15 tUSD8 → Ledgerline, got revenue 4120.5M (+11.4%) | [0x09031352675833bc63a44abda0c833bd4560d20e12bdbd965b0270b3ff750456](https://explorer-test.qday.info/tx/0x09031352675833bc63a44abda0c833bd4560d20e12bdbd965b0270b3ff750456) |
| 07 | Paid | 0.25 tUSD8 → Ledgerline over x402 v2, 9812 words of transcript | [0x7ef172a7d13c502b7fc2e15a08fa5a823f8bee62f59adbce0939370a21f2413c](https://explorer-test.qday.info/tx/0x7ef172a7d13c502b7fc2e15a08fa5a823f8bee62f59adbce0939370a21f2413c) |
| 08 | Refused | 0.40 tUSD8 → 0x276DF79D3f59b2a496D1D01a4F167307f2ca2f33: That recipient is not on this mandate's merchant allowlist. The agent may only pay merchants the owner approved. | [0x7cf3b23f984efa39030753c18a424a03c1df1f9d8e6e82db896f0b79c20427dd](https://explorer-test.qday.info/tx/0x7cf3b23f984efa39030753c18a424a03c1df1f9d8e6e82db896f0b79c20427dd) |
| 09 | Queued | 0.50 tUSD8 → Ledgerline waits for the owner (pending #1) | [0xf71ccbbddfb29ea3f0599de4a1c1f23d6bf1a592da817debc155227e45cb3c0f](https://explorer-test.qday.info/tx/0xf71ccbbddfb29ea3f0599de4a1c1f23d6bf1a592da817debc155227e45cb3c0f) |
| 10 | Done | approved; the same x402 payment now settles and Ledgerline delivered 63 documents (148 MB) | [0xeac5a522f8658422ad8c0714c5a11241751dd748e5229bc63b2939b9891e532d](https://explorer-test.qday.info/tx/0xeac5a522f8658422ad8c0714c5a11241751dd748e5229bc63b2939b9891e532d) |
| 11 | Refused | 0.20 tUSD8 → Ledgerline: This payment would exceed the mandate's spending limit for the trailing period. | [0x4a2fe8722b7f88b58d07f58e2acf538ae7dfdf044ed441f2e90c63826573ff28](https://explorer-test.qday.info/tx/0x4a2fe8722b7f88b58d07f58e2acf538ae7dfdf044ed441f2e90c63826573ff28) |
| 12 | Done | mandate #1 revoked | [0xa3a3a310d9a90a6a5189278e79eff85e48e5b5041a69327c8016c9dfd11f4dec](https://explorer-test.qday.info/tx/0xa3a3a310d9a90a6a5189278e79eff85e48e5b5041a69327c8016c9dfd11f4dec) |
| 12 | Refused | 0.15 tUSD8 → Ledgerline: The owner revoked this mandate. No further payments are possible. | [0x7510df5e9ed2811812bc739e02220e63bd367fd56c3f9a7aeeb4a0ecfaa0cbc9](https://explorer-test.qday.info/tx/0x7510df5e9ed2811812bc739e02220e63bd367fd56c3f9a7aeeb4a0ecfaa0cbc9) |
| 13 | Done | Ledgerline → agent: 96/100, tag delivery | [0xdde3068090766c01cffe8c91b9e6e0d0b4ff0a455072139f09b2d2ab62b3935b](https://explorer-test.qday.info/tx/0xdde3068090766c01cffe8c91b9e6e0d0b4ff0a455072139f09b2d2ab62b3935b) |
| 14 | Done | owner withdrew the remaining 1.10 tUSD8 | [0xb45fd6b6c1b9996c30a04ce1b218dafbeb761b5052821ecbd3fd868c578e0e61](https://explorer-test.qday.info/tx/0xb45fd6b6c1b9996c30a04ce1b218dafbeb761b5052821ecbd3fd868c578e0e61) |
