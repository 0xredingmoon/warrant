# Demo run on Aevum testnet

The public dashboard is [https://srmohtasham123.github.io/warrant/](https://srmohtasham123.github.io/warrant/). The
gasless relayer is [https://redingmoonq-warrant-relayer.hf.space](https://redingmoonq-warrant-relayer.hf.space) (free
CPU; may take about a minute to wake when idle). The transactions below were recorded against the same factory and token.


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

## Demo video run (2026-11-20, 20:32 to 20:44 Asia/Tehran)

The recording in the demo video was a live dashboard session, not the scripted scenario above. Vault
[`0xf864d54a695D48b3b222bff935018f2a779acd7c`](https://explorer-test.qday.info/address/0xf864d54a695D48b3b222bff935018f2a779acd7c) (source-verified on the explorer), owner `0x27D7f61864CDf8bC6AAa0D157D8Ed3FDCCeb432d`,
mandate #1 for a freshly generated agent key. The owner deposited through the gasless path (EIP-3009, relayer pays the gas), the
relayer also paid for the payments, approval and refusals.

14 vault events, 3 of them refusals recorded on-chain.

| Block | What happened | Transaction |
| --- | --- | --- |
| 3678160 | Vault created, no guardian | [0x8200900095b5caa35fa2e0c2442c079b09a63bd5c3833323b34d3bfc1f295130](https://explorer-test.qday.info/tx/0x8200900095b5caa35fa2e0c2442c079b09a63bd5c3833323b34d3bfc1f295130) |
| 3678182 | 1.25 tUSD8 deposited by 0x27D7…432d | [0x4a0c9cb1c1842433c44e6d21a35c996201ab9089fbd85f65e2235a1b9639b32d](https://explorer-test.qday.info/tx/0x4a0c9cb1c1842433c44e6d21a35c996201ab9089fbd85f65e2235a1b9639b32d) |
| 3678237 | Mandate #1 created for agent 0xF9Fc…9583 (≤ 1.00 per payment, 1.00 per period, 3.00 total) | [0x6d92ddfb088ce25ee064d25b075b15967a8fc164838c9a14bfff310e2f7dc79a](https://explorer-test.qday.info/tx/0x6d92ddfb088ce25ee064d25b075b15967a8fc164838c9a14bfff310e2f7dc79a) |
| 3678237 | Mandate #1: merchant 0xf2b0…b4Ae allowed | [0x6d92ddfb088ce25ee064d25b075b15967a8fc164838c9a14bfff310e2f7dc79a](https://explorer-test.qday.info/tx/0x6d92ddfb088ce25ee064d25b075b15967a8fc164838c9a14bfff310e2f7dc79a) |
| 3678258 | Paid 0.15 tUSD8 to 0xf2b0…b4Ae under mandate #1 (fee 0.00015) | [0xa0b0e5bd36567bd9f8be1a0d105b7d253618c3896870b992662e3eb39b4dbbdc](https://explorer-test.qday.info/tx/0xa0b0e5bd36567bd9f8be1a0d105b7d253618c3896870b992662e3eb39b4dbbdc) |
| 3678269 | Paid 0.25 tUSD8 to 0xf2b0…b4Ae under mandate #1 (fee 0.00025) | [0xa9fc85a3af3acc867b7a772e153cf4936df2362aaf07879b697be266c4accdf9](https://explorer-test.qday.info/tx/0xa9fc85a3af3acc867b7a772e153cf4936df2362aaf07879b697be266c4accdf9) |
| 3678298 | Refused 0.40 tUSD8 to 0x276D…2f33 under mandate #1: That recipient is not on this mandate's merchant allowlist. The agent may only pay merchants the owner approved. | [0x03e320c8396faaa03f95a2dde28669a68336366da525de3592bc0171165ed55f](https://explorer-test.qday.info/tx/0x03e320c8396faaa03f95a2dde28669a68336366da525de3592bc0171165ed55f) |
| 3678699 | Queued 0.50 tUSD8 to 0xf2b0…b4Ae for owner approval (#1) | [0x3426deaaba760646e6c3f6eb7f59d87bba61cbcd5eb7134f9accabd6e991f0ca](https://explorer-test.qday.info/tx/0x3426deaaba760646e6c3f6eb7f59d87bba61cbcd5eb7134f9accabd6e991f0ca) |
| 3678728 | Queued payment #1 approved by 0x27D7…432d | [0x726649a605900c4db1f96f84f8a1ebd1ba69fc50548041c276e4480daa4e326d](https://explorer-test.qday.info/tx/0x726649a605900c4db1f96f84f8a1ebd1ba69fc50548041c276e4480daa4e326d) |
| 3678728 | Paid 0.50 tUSD8 to 0xf2b0…b4Ae under mandate #1 (fee 0.0005) | [0x726649a605900c4db1f96f84f8a1ebd1ba69fc50548041c276e4480daa4e326d](https://explorer-test.qday.info/tx/0x726649a605900c4db1f96f84f8a1ebd1ba69fc50548041c276e4480daa4e326d) |
| 3678745 | Refused 0.20 tUSD8 to 0xf2b0…b4Ae under mandate #1: This payment would exceed the mandate's spending limit for the trailing period. | [0xbb8ba73dd26f7c6c6f9194a519ce21a0d5b9f915f9cacc2326ef6e6fa4d6a424](https://explorer-test.qday.info/tx/0xbb8ba73dd26f7c6c6f9194a519ce21a0d5b9f915f9cacc2326ef6e6fa4d6a424) |
| 3678767 | Mandate #1 revoked by 0x27D7…432d | [0x4a6c3b82d8e849c5a14516616e9f783a941e39a936f47b1aa5f16383fd449068](https://explorer-test.qday.info/tx/0x4a6c3b82d8e849c5a14516616e9f783a941e39a936f47b1aa5f16383fd449068) |
| 3678774 | Refused 0.15 tUSD8 to 0xf2b0…b4Ae under mandate #1: The owner revoked this mandate. No further payments are possible. | [0xdd948a1b50501c03e0f3a58b9b4c686b081151605d45e8a1f248f1544a55238d](https://explorer-test.qday.info/tx/0xdd948a1b50501c03e0f3a58b9b4c686b081151605d45e8a1f248f1544a55238d) |
| 3678787 | 0.35 tUSD8 withdrawn to 0x27D7…432d | [0x9152e50bfb06d05914d88d8920e087b4d1d73d52a7b1c8ef1d885e4223b9d118](https://explorer-test.qday.info/tx/0x9152e50bfb06d05914d88d8920e087b4d1d73d52a7b1c8ef1d885e4223b9d118) |

The agent registration (ERC-721 identity #11 and the wallet binding) and the vault creation are on the factory and registry
pages: [AgentRegistry](https://explorer-test.qday.info/address/0xD0442513fd53FA91c411939648F9edbBF2ed747d), [WarrantFactory](https://explorer-test.qday.info/address/0x66687369d9C683aaaaDAe98b747b63eE7e0662E3).
Regenerate this table for any vault with `WARRANT_NETWORK=aevum VAULT=0x… pnpm --filter @warrant/demo exec tsx src/video-log.ts`.
