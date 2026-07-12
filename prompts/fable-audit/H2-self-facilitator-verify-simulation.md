# H2 — High: Self-facilitator `/verify` does no balance check → deliver-before-settle burns provider money

**Severity:** High · **Area:** Payments (x402 self-facilitator) · **Commit-gate:** no

## Context
For paid endpoints, x402 verification and settlement are two phases. The flow in
[api/_lib/x402-paid-endpoint.js:837-882](../../api/_lib/x402-paid-endpoint.js) is:
**verify → handler runs → settle**. The Solana settlement broadcast happens at
`settle`, not `verify`.

## The defect
`verifyRingPayment` in
[api/_lib/x402/self-facilitator.js](../../api/_lib/x402/self-facilitator.js) only
calls `validateRingTransaction`, a **static decode** — it checks amount, mint,
destination, and authority, but **never the payer's token-account balance**.

An attacker signs a valid `TransferChecked` for `amount >= required` from a source
ATA holding **zero** USDC:
1. Static validation passes → `verifyPayment` returns valid.
2. The expensive handler executes (llm-proxy → Anthropic/OpenAI spend; embody/forge
   → GPU; etc.).
3. `settleRingPayment` broadcasts → fails `insufficient funds` → buyer gets 502.

The response body is withheld, but **the platform already paid the upstream provider
for work the attacker never funded.** The external PayAI facilitator simulates on
`/verify` and catches this; the in-house one is strictly weaker. Rate limits bound
the rate but each allowed request still costs real money.

## The fix
Make `verifyRingPayment` prove the payment can actually settle before returning
valid. Either:

```js
// In verifyRingPayment, before returning { isValid: true }:
const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
if (sim.value.err) {
  return { isValid: false, reason: 'simulation_failed' };
}
```
or check the source ATA balance ≥ required amount via `getTokenAccountBalance`.

**Alternative / complementary:** reorder so expensive, side-effecting lanes settle
**before** delivering (settle → then run handler). If you take this route, do it
only for the side-effecting endpoints and keep cheap idempotent ones as-is to avoid
latency regressions.

## Verification
1. Sign a transfer from a zero-balance ATA → `/verify` must reject (no handler run,
   no provider spend).
2. A properly funded payment → verifies, handler runs, settles.
3. Confirm the simulation adds acceptable latency (log p50/p95 on a warm path).

## Done checklist
- [ ] `verifyRingPayment` simulates or balance-checks before returning valid.
- [ ] Zero-balance payment no longer reaches the handler.
- [ ] Funded happy path unchanged.
- [ ] Latency impact measured and acceptable.
