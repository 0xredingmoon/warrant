# Business model

This is what Warrant charges for, what the numbers look like, and what is not proven yet.

## The product

Agents that spend money need a limit that holds even when the agent is wrong, hijacked or leaked. Warrant is
the owner-side control: a vault, a mandate per agent, an approval queue, a freeze. Merchants get something in
return: a payment they can verify from chain data, with a fixed invoice reference, and a reputation signal tied to
receipts rather than reviews.

## Who pays

| Payer | For | How |
| --- | --- | --- |
| Merchant | Settlement through a vault | Protocol fee, set on the factory. Deployed at 10 bps (0.10%), hard cap 1% in the contract. Taken out of the merchant's receipt; the owner never pays it, and caps count the gross amount. |
| Agent platform or merchant that does not want to run infrastructure | Hosted relayer and verification | Per-transaction fee above gas cost, or a monthly plan with a volume allowance. The open-source relayer and `@warrant/merchant` stay free to self-host. |
| Merchant | Receipt-bound reputation and reconciliation | Later: webhook delivery, exports, a ratings API. Ratings are only possible against a paid receipt, which is what makes them worth buying. |

## Numbers, with the limits stated

- At 10 bps, 1,000,000 tUSD8 of monthly merchant volume earns 1,000. The fee is not the business at small scale.
  Hosted relaying and verification have to carry the early revenue, and the fee becomes meaningful with volume.
- Payment gas on Aevum is 151k to 203k. On a mainnet where gas costs real money, a 10 bps fee on a 0.10 payment
  (0.0001) would be below the cost of submitting it. The model works for payments of a few dollars and up at 10 bps.
  Sub-dollar payments need either a minimum fee, a higher bps for that tier, or batched settlement. Batching is not built.
- Demo run on testnet: 0.90 gross, 0.0009 fee, 14 transactions in total, of which 3 were payments from the agent.

## Where it fits

The 402 flow in the demo is x402-shaped but is not wire-compatible with x402. Warrant does not compete with
a payment rail; it sits between an owner and whatever rail the agent uses, and a rail adapter (x402, card, bank)
is the obvious next integration. Merchants adopt it because the agent's owner asks for it, so the first customers are
the owners (teams running agents with budgets), and the merchant-side fee follows the volume they bring.

## Not proven

- No real users. The only evidence is the scripted scenario and the tests.
- tUSD8 is a testnet token with no value, on a testnet. There is no mainnet deployment and no stablecoin we control.
- Contracts are not audited. The factory owner (who can change the fee, up to the 1% cap, and the treasury) is a single
  key; before real money it must be a multisig with a timelock on fee changes.
- No compliance work: custody, KYC and sanctions screening for a hosted relayer have not been looked at.
- The hosted relayer's economics (gas float, abuse, key custody) are untested outside rate limits and unit tests.

## Next steps that would show demand

1. Put the MCP server in front of two real agent frameworks and record owners setting mandates.
2. Ship an x402 adapter so merchants already speaking x402 can accept mandate payments.
3. Run a hosted relayer with metering for a handful of API merchants and measure real gas and abuse.
4. Audit, then deploy on whichever chain has a stablecoin people hold.
