# Warrant design notes

## Roles and trust

| Role | Can | Cannot |
|---|---|---|
| Owner | create mandates, edit merchant rules, revoke, freeze/unfreeze, set guardian, approve queued payments, withdraw, rescue other tokens | widen a mandate after creation (create a new one) |
| Guardian (optional) | `freezeAll`, `revokeMandate` | unfreeze, withdraw, create or edit anything |
| Agent | sign payment intents inside its mandate; cancel its own queued request or burn its own nonces | move funds itself, approve its own queue entries |
| Anyone | submit a signed intent, expire an overdue queue entry, deposit | change any field of a signed intent |

## Mandate

`MandateParams` is immutable after creation: `agent`, optional `agentId`, `perTxCap <= periodCap <= totalCap`,
`periodLength`, `validAfter`, `expiry` (exclusive, max lifetime 365 days from the later of now/`validAfter`),
`approvalThreshold` (amount >= threshold needs the owner; 0 = never; must be <= `perTxCap`) and
`approvalWindow`. Merchants are an allowlist (at least one at creation) with optional per-merchant `perTxCap`
and `totalCap`; the owner can change the allowlist later (narrowing is instant).

Caps are checked against the **gross** amount that leaves the vault. The fee is taken out of what the merchant
receives.

### Spend window

`periodCap` bounds spending in **any** rolling `periodLength`, not in a calendar-aligned period. Spending is booked
into 8 buckets of `ceil(periodLength / 8)` seconds kept in a ring of 9 slots. A payment is checked against every
bucket that overlaps the trailing window and the sum, including the new payment, must stay within `periodCap`. A
payment therefore counts for at least `periodLength` and at most one bucket longer: the cap is never exceeded in
any window, and spend frees up at most one bucket late. `periodSpent(mandateId)` and `nextRelease(mandateId)`
(the oldest counted bucket's amount and when it stops counting) feed the dashboard's meter. This replaces an earlier fixed-window version, which
allowed up to 2x `periodCap` across a window edge.

## Reason codes (`IWarrantVault.Reason`)

`Ok, ApprovalRequired, MandateNotFound, MandateRevoked, VaultFrozen, NotYetValid, MandateExpired,
MerchantNotAllowed, ZeroAmount, ExceedsPerTxCap, ExceedsMerchantPerTxCap, ExceedsPeriodCap,
ExceedsMerchantTotalCap, ExceedsTotalCap, InvoiceAlreadyUsed, IntentExpired, NonceUsed, BadSignature,
InsufficientBalance`. `check()` returns one; `pay()` reverts with `PaymentRejected(reason)` for anything but
`Ok` / `ApprovalRequired`.

Check order: mandate exists, intent deadline, nonce, signature, mandate revoked, vault frozen, validity window,
amount, merchant, per-tx, merchant per-tx, period, merchant total, total, invoice, balance, approval threshold.

## Refusals on-chain

`pay()` reverts for a refused payment, and a reverted transaction leaves no log. `payOrRefuse(intent, signature)` is for
relayers: when a rule fails after the signature has proven the intent is authentic it emits
`PaymentRefused(mandateId indexed, agent indexed, merchant indexed, amount, reason, invoiceRef, intentHash)` and
returns without moving funds. Intents that were not signed by the mandate's agent are not recorded (anyone could
otherwise fill the log), the nonce is consumed so one signed intent logs once, and a mandate logs at most
`MAX_LOGGED_REFUSALS` = 1,000 (`RefusalLogFull` after that). Problems with the intent itself (`MandateNotFound`,
`IntentExpired`, `NonceUsed`, `BadSignature`) revert instead of logging. The SDK reads these events into
the same audit log as payments, so the dashboard shows "Refused on-chain" with a link to the transaction.

Each vault stores `createdAtBlock`, which lets clients start reading logs at the vault's creation instead of at the
factory's deployment.

## EIP-712

Domain: `name="Warrant"`, `version="1"`, `chainId`, `verifyingContract = vault` (signatures can't be replayed on
another vault or chain).

- `PaymentIntent(uint256 mandateId,address merchant,uint256 amount,bytes32 invoiceRef,bytes32 intentHash,bytes32 nonce,uint256 deadline)` signed by the mandate's agent (EOA or ERC-1271).
- `ApprovePayment(uint256 pendingId,uint256 deadline)` signed by the owner (EOA or ERC-1271).

## Idempotency and replay

- `nonce` is single use per mandate and is only consumed when the call succeeds (a reverted call burns nothing).
- `(merchant, invoiceRef)` can be `None -> Pending -> Paid` once per vault. A rejected or expired queue entry
  returns it to `None`. This is what makes agent retries safe.

## Queue

A payment at or above the threshold is stored with `expiresAt = now + approvalWindow` and its invoice is
reserved. Nothing is booked until approval. `approve` / `approveBySig` re-run all checks against the current
state (so revoke, freeze, merchant removal, expiry, spent caps and balance all apply at approval time).

## Fee

`WarrantFactory.feeBps` (hard cap `MAX_FEE_BPS = 100` = 1%), `treasury`. Charged to the merchant:
`merchant gets amount - fee`. Changeable by the factory owner within the cap; a user who dislikes it can't be
hurt by it because users never pay it, and the vault always sends exactly the signed gross amount.

## AgentRegistry (ERC-8004-shaped)

Identity follows the ERC-8004 identity interface: `register(...)` (ERC-721), `setAgentURI`, `setMetadata` /
`getMetadata`, `setAgentWallet` (new wallet proves control with an EIP-712 signature), `getAgentWallet`
(cleared on transfer). Reputation vocabulary (`value`, `valueDecimals`, `tag1`, `tag2`, URI, hash) is kept, but
feedback is bound to a **receipt** recorded by a registered vault, given only by the paid merchant, once per
payment, and never by the agent's own owner or wallet. `getSummary` returns active feedback count, the average
(18 decimals), verified payment count and verified volume.

A mandate bound to an `agentId` requires `registry.getAgentWallet(agentId) == mandate.agent` at creation. A
failing registry never blocks a payment (`ReceiptNotRecorded` is emitted instead).

## Threat notes

- Relayer cannot alter a signed intent; at worst it censors (anyone else can submit).
- A leaked agent key is bounded by the mandate; the owner/guardian can revoke or freeze in one transaction.
- Reentrancy: all state-changing paths are `nonReentrant`; effects precede interactions; tested with a token
  that re-enters from `transfer`.
- Standing allowances: `depositWithPermit` never lets a third party spend someone's existing approval.
- Front-running a payment cannot redirect it (merchant and amount are signed); it can only execute it earlier.
