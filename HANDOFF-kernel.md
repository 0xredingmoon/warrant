# Handoff: ERC-4337 Kernel v3.1 task (task 3) plus the iOS-style UI pass

Written 2026-11-26 for a fresh session. Read this with `README.md`, `docs/DESIGN.md`, and the current
`deployments/demo-attack.json`. Do not start by re-reading the whole history; everything you need is here.

## Where the project stands (all of this is true and verified on chain, do not redo it)

- Repo `srmohtasham123/warrant`, branch `main` is current and pushed.
- Tasks 1 and 2 are done and live:
  - Factory `0x66687369d9C683aaaaDAe98b747b63eE7e0662E3`, Registry `0xD0442513fd53FA91c411939648F9edbBF2ed747d`, both source-verified.
  - Demo attack vault `0xC3Cd5BEF962C78e5f673386f808046E9812e905e`, verified, mandate #1 (per-tx 2.00, period 10.00, total 50.00, approval 0, 180 days), 1.00 tUSD8, `refusalCount(1) = 2`.
  - Two real refusals: `0xbf60d1765e24e25807f75175974fe3785c87dac92b5b0520a297e2373dea90c6` (ExceedsPerTxCap) and `0xd44e9125d74d4e1dc74e702a0c25e96eb5ec35d1c46fce7a095e4ba09d99498e` (MerchantNotAllowed). Both are **successful** transactions that emit `PaymentRefused`; that is by design, do not "fix" it to revert.
  - Dashboard live at https://srmohtasham123.github.io/warrant/ with the "Try the attack" panel and a five-beat tour.
  - Relayer live at https://warrant-relayer.vercel.app with `DEMO_*` env vars set.
- Tests: `forge test` 162 pass, `pnpm -r test` passes (relayer needs Foundry on PATH or two anvil suites self-skip).
- `.demo/` holds the demo agent key, the demo deployer key, and (EXPIRED-SOON) a Vercel token the user must rotate. Never print these.

## The task you are here for

Run the agent as an ERC-4337 Kernel v3.1 smart account on Aevum, with Warrant as the spending policy, and document it.
The user also wants a full UI redesign in an iOS-like style (see the UI section at the end), mobile and desktop.

### What is already proven on Aevum (do not spend time rediscovering)

| Fact | Value | How it was checked |
| --- | --- | --- |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | `eth_supportedEntryPoints` on the bundler, codesize 16035 |
| Bundler | `https://bundler.qday.info` | answers `eth_chainId`, `eth_supportedEntryPoints`, `eth_estimateUserOperationGas` |
| KernelFactory | `0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419` | creator of a real Kernel account, codesize 989 |
| Kernel implementation | `0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D` | explorer `implementations` on that account, codesize 22784 |
| Root validator | `0x845adb2c711129d4f3966735ed98a9f09fc4ce57` | `rootValidator()` on the account returned `0x01845adb...ec4ce57` |
| A working Kernel account | `0xc0bc2ab048dca250417beaff6b68a222a4ae2d1c` | sent a real UserOp, see below |
| A real UserOp | userOpHash `0x9e6be34406e306851656417238e5938709b6029b140098dbce59541bed899232`, nonce 1, success | decoded `UserOperationEvent` from tx `0xdde4f5aaac0670d846bb41a28293cd81c37526087d428b917f1b39f83bf4c2f9` |
| Gas model | no paymaster (paymaster field is zero); the account pays its own tQDAY | same event |

The account `0xc0bc2ab0...` belongs to another project (Clerk). You cannot and must not use it. It is a reference that the
path works. Build your own account.

### Spike first, then the real thing

1. **Spike (do this before anything else).** Deploy a Kernel account whose owner is a key you control, send one trivial
   UserOp through `bundler.qday.info`, and print the userOpHash plus the explorer link. Stop and report if this fails, with the
   exact bundler error. Do not build the Warrant integration until a bare UserOp succeeds.
   - The owner key: use a fresh throwaway key, fund it from the demo deployer `.demo/demo-deployer.key` (it holds about 4.6 tQDAY left; send 0.05 and note the tx).
   - Tooling: `permissionless` or `@zerodev/sdk` (Kernel v3.1 is ZeroDev's). Pin versions; Aevum is Shanghai with no MCOPY/TSTORE, so any account deployment code must not use Cancun opcodes. The repo's Shanghai opcode test covers `src/` only, not third-party kernel code.
   - Bundler may need a gas price and `preVerificationGas`; Aevum is legacy-transaction oriented on the RPC, but EntryPoint v0.7 UserOps use 1559 fields. If the bundler rejects, try `eth_sendUserOperation` with the bundler's own `eth_gasPrice` values.
2. **Warrant as the policy.** Two defensible shapes, pick the one that works and document why:
   - **a. Warrant pays, account approves.** The UserOp `callData` is `WarrantVault.payOrRefuse(intent, agentSignature)` where the account is the caller. This needs the mandate's agent to be the smart account address, and the account's owner key to also sign the EIP-712 intent. Cleanest story: "the smart account is the agent".
   - **b. Vault owns, account spends.** A new vault whose owner is the smart account, and the smart account's UserOp calls `deposit`/`pay` on it. Do not invent a new contract unless you must; criterion 5 and 7 favour using what exists.
   - Prefer (a). It reuses `buildIntent`/`signIntent` from `@warrant/sdk` unchanged and makes the demo: prompt-injected agent still cannot overspend, now with an AA wallet.
3. **Tests.** Add an anvil-backed vitest like `packages/relayer/test/e2e.test.ts` for whatever you build, and a `forge test` addition only if you touch Solidity. Every claim in the README must map to a test or a tx hash.
4. **Docs.** Update `README.md` (replace the two "No ERC-4337 bundler" lines, which are now wrong), add a section "The agent as a smart account" with the spike tx, the Warrant-limited tx, and the exact commands. No em dashes anywhere; no marketing voice; keep it in the plain style of the rest of the README.

### UI redesign (same session or a second one, user asked for it explicitly)

Constraints:
- Look and feel of iOS 27: large rounded corner cards, generous spacing, SF-like type, frosted/blurred surfaces for sheets and the tour, vibrant but restrained accent colour, tab-like segmented controls, the iOS "grouped list" rhythm (a rounded group of rows with hairline separators inside).
- Mobile first (390 and 430 widths) and desktop (1360+). No horizontal scroll at any width. Touch targets at least 44 by 44 px.
- Applies to every component: `web/components/*`, `web/app/globals.css`, the tour, the attack panel, the header, the mandate sheet, activity list, pending, reputation.
- Keep all current functionality and the accessible labels. Playwright checks in `web/e2e/` must still pass, and the tour must still not cover the Try it buttons.
- No em dashes in any user-facing text.

Verification for the UI: build the static export, serve it with the LAN-IP trick (the app rejects `localhost` relayer URLs; see `.demo/serve-local.mjs`), run `web/e2e/verify-attack-demo.mjs` against it, screenshot at 390, 430, and 1360, and only then publish gh-pages.

## How to run things on this machine

```bash
export PATH="$PATH:$HOME/.foundry/bin"       # forge, cast, anvil
cd /d/claude/warrant
forge test
cd packages/relayer && npx vitest run         # needs Foundry on PATH for the two anvil suites
STATIC_EXPORT=1 NEXT_PUBLIC_BASE_PATH=/warrant npx pnpm --filter @warrant/web exec next build   # MSYS_NO_PATHCONV=1 in Git Bash
```

Deploying the relayer to Vercel: the token in `.demo/vercel.token` belongs to the user's account and was pasted in chat, so it
must be rotated after use. Ask before using it. Publishing gh-pages: a worktree of `origin/gh-pages`, copy `web/out`, commit, push.

## Rules the user has repeated

- Testnet only. Never commit `.env` or keys. Never print secrets.
- Run forge tests and vitest after every change.
- No AI-sounding prose, no em dashes.
- The four live addresses listed at the top must not change.
- Do not leave a half-finished claim in the README. Each claim gets a hash or a test.
