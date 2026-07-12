# 19 — USDG checkout: `hood-pay`

Read `prompts/robinhood-chain/_shared.md` first. Wave 3: requires core SDK (`usdg` module);
complements hood402 (machine payments) — this is HUMAN commerce. If hood402 exists, share its
verification primitives where sensible; do not duplicate protocol code.

## Mission
Build `robinhood/hood-pay/` — Stripe-Checkout-grade payments in USDG on Robinhood Chain:
an embeddable checkout widget, hosted payment links, and a merchant verification library.
USDG is the chain's dollar rail (>$260M week one) and no commerce tooling exists for it.
npm `hood-pay` (fallbacks: `hoodpay`, `usdg-checkout`).

## Deliverables

1. **`hood-pay/widget`** — embeddable checkout (vanilla JS, one `<script>` + one div):
   merchant configures `{ payTo, amount | dynamic, memo, onSuccess }`; buyer flow = connect
   wallet (reuse hood-connect if built — check `robinhood/hood-connect/`; else EIP-6963
   inline) → ensure chain 4663 → pay USDG (direct transfer with a unique on-chain memo/
   reference scheme you design — document it; if USDG lacks memo support, use a minimal
   payment-router contract you deploy that emits `PaymentReceived(reference, payer, amount)` —
   Foundry project in `contracts/`, verified on Blockscout, testnet-deployed for real;
   mainnet deploy documented for owner) → confirmation state with receipt link.
   Every visual state designed; ≤ 30 kB gzipped self-contained.
2. **Payment links** — a static-capable link page (`docs/pay.html#<encoded-request>`): encode
   payTo/amount/memo in the fragment, render a full-page checkout — works entirely on GitHub
   Pages (client-side only), so ANY merchant gets hosted payment links for free by linking to
   our Pages site. CLI helper `npx hood-pay link --to 0x… --amount 25 --memo "invoice 7"`.
3. **`hood-pay/verify`** (merchant side, Node) — `awaitPayment({ reference, amount, timeout })`
   watching transfer/router events with reorg-safe confirmation depth; webhook emitter;
   idempotent ledger (SQLite) for shops. Express example in `examples/shop/` — a tiny real
   demo store selling one digital good, exercised E2E on testnet.
4. **Refund + partial-payment semantics** — documented and implemented in verify (underpayment
   → designed state, overpayment → flagged, refund helper for the merchant wallet).

## Requirements
- Security page in docs: exactly what the widget can and cannot do (it never holds keys, never
  custodies, amounts verified on-chain not in the DOM), reorg depth policy, reference-collision
  math.
- Vitest: reference scheme (collision, encoding), verify state machine (under/over/exact/
  timeout/reorg via anvil fork manipulation), widget config validation. Foundry tests for the
  router contract.
- E2E on testnet 46630: full purchase through the widget in a real browser + merchant verify
  firing the webhook — tx hashes and transcript in the report. (Testnet USDG: verify whether
  it exists; if not, the router contract works with any ERC-20 — run the E2E with a faucet
  Stock Token and state this plainly; mainnet USDG config documented.)
- `docs/` static site per `_shared.md`: landing = a LIVE demo checkout (testnet) visitors can
  actually complete, integration quickstart (copy-paste embed), payment-links generator UI
  (client-side), verify/webhook docs, security page.

## Done checklist
- [ ] Real testnet purchase completed browser-to-webhook; hashes in report.
- [ ] Payment links work from the local static docs (fragment-only, no server).
- [ ] Router contract (if needed) verified on testnet Blockscout; Foundry tests green.
- [ ] Size budget printed; `npm pack` clean; report: mainnet go-live steps for owner.
