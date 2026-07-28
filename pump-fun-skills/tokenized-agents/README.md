# pumpfun-tokenized-agents

Skill that lets a three.ws agent charge users for actions with on-chain Solana
token payments. It wraps the platform's agent-payments API
(`/api/agents/payments`): one tool builds an unsigned payment transaction and
an invoice intent, the other verifies that the signed transaction landed
on-chain and marks the invoice paid. The skill never touches keys; the user's
wallet signs and broadcasts.

This is coin-agnostic plumbing: the payment currency mint, amount, and payer
are supplied at runtime by the caller.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | Skill identity (`pumpfun-tokenized-agents` v1.1.0), `sandboxPolicy: "trusted-main-thread"`, provided tools. |
| [tools.json](./tools.json) | JSON-Schema definitions for the two tools. |
| [handlers.js](./handlers.js) | Thin fetch wrappers over `/api/agents/payments/pay-prep` and `/api/agents/payments/pay-confirm` (same-origin, `credentials: 'include'`). |
| [SKILL.md](./SKILL.md) | The full skill doc: `@three-ws/agent-payments` SDK signatures, currency decimals, env vars, safety rules. |
| [SCENARIOS.md](./SCENARIOS.md) | Worked end-to-end payment scenarios. |
| [WALLET_INTEGRATION.md](./WALLET_INTEGRATION.md) | Solana wallet-adapter integration for React/Next.js clients. |
| [references/](./references/) | Copies of the scenario and wallet docs packaged for skill loaders that read a references folder. |

## Tools

### `pumpfun_build_payment`

Required args: `agent_id`, `currency_mint`, `amount` (smallest units, e.g.
6 decimals for USDC so `1000000` = 1 USDC), `wallet_address` (payer pubkey).
Optional: `memo` (integer invoice id), `cluster` (`mainnet` default, or
`devnet`). Calls `POST /api/agents/payments/pay-prep` and returns a
base64-encoded unsigned transaction plus an `intent_id`.

### `pumpfun_verify_payment`

Required args: `intent_id`, `tx_signature`, `wallet_address`. Calls
`POST /api/agents/payments/pay-confirm` to confirm the transaction landed
on-chain and mark the invoice paid. Always run this server-side verification
before delivering any paid service; the client alone can be spoofed.

## Flow

```js
// 1. Build: agent asks for payment
const prep = await skill.invoke('pumpfun_build_payment', {
	agent_id: agentId,
	currency_mint: usdcMint,
	amount: 1000000,          // 1 USDC (6 decimals)
	wallet_address: payerPubkey,
}, ctx);
// -> { transaction: '<base64 unsigned tx>', intent_id: '...' }

// 2. The user's wallet signs and broadcasts prep.transaction.

// 3. Verify: confirm on-chain and mark the invoice paid
const paid = await skill.invoke('pumpfun_verify_payment', {
	intent_id: prep.intent_id,
	tx_signature: signature,
	wallet_address: payerPubkey,
}, ctx);
```

## Safety rules (from SKILL.md)

- Never log, print, or return private key material.
- Never sign on behalf of a user; build the instruction, the user signs.
- Validate `amount > 0` and use the correct decimals (6 for USDC, 9 for wrapped SOL).
- Verify payments server-side with `validateInvoicePayment` before delivering anything.

## Related

- The `@three-ws/agent-payments` SDK this skill's docs build on: [../../agent-payments-sdk/](../../agent-payments-sdk/).
- Sibling skills: [../README.md](../README.md).
