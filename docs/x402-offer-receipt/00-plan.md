# x402 Signed Offers & Receipts — Integration Plan

Wire the x402 Offer & Receipt extension into every paid endpoint in this repo so every `402` response carries one signed offer per accepted network, and every `200` response carries one signed receipt — without changing any handler's business logic.

## Why this exists (one paragraph)

The x402 Offer & Receipt extension produces portable, cryptographically signed artifacts that prove (a) the server committed to specific payment terms, and (b) the client received the service it paid for. Today the upside for `$0.001`-priced endpoints is mostly positioning: being early on a spec that reputation aggregators may eventually crawl. The cost is modest and the surface is contained, so this plan ships it cleanly with a single signer module and two hook points in the existing `paidEndpoint` wrapper.

## Locked-in decisions

These are decided up front so prompts don't re-litigate them. If a prompt encounters a reason to change one of these, stop and surface it before deviating.

| Decision | Value | Reason |
|---|---|---|
| Signing format | **EIP-712** (`did:pkh`) | secp256k1 only is fine — the *receipt signing key* is independent of how payers pay. No DID document to host. |
| Signing key env var | `X402_RECEIPT_SIGNING_KEY` | Hex-encoded 32-byte private key, `0x`-prefixed. **Must be a dedicated key**, not `X402_PAY_TO_*`. |
| KID format | `did:pkh:eip155:1:${signerAddress}#key-1` | Chain `1` (Ethereum mainnet) is conventional for `did:pkh` identity. The signing identity is independent of the payment chain. |
| Extension scope | **Global** in [api/_lib/x402-paid-endpoint.js](../../api/_lib/x402-paid-endpoint.js) | All 9 paid endpoints are symmetric; one toggle beats 9 per-file edits. |
| Extension placement on 402 body | Sibling under top-level `extensions["offer-receipt"]`, **not** nested under `bazaar` | The agentic.market validator mirrors `@x402/extensions/bazaar` exactly; nesting risks failing their schema check. |
| Receipt placement on `200` | Inside `x-payment-response` header payload's `extensions["offer-receipt"]` | Matches the spec's wire format — clients call `extractReceiptFromResponse` on the response. |
| `includeTxHash` default | `false` | Privacy-preserving default; payer address is already in the receipt. |
| Offer `validUntil` | `now + 60s` | Matches existing `maxTimeoutSeconds: 60` in every accept entry. |
| BSC `direct` scheme handling | Sign the offer with `offerType: 'direct'` | The field is a free-form string per spec. Third-party verifiers expecting `'exact'` won't accept it, which is fine — BSC users aren't the target audience for portable receipts yet. |
| Signer module location | [api/_lib/x402-offer-receipt.js](../../api/_lib/x402-offer-receipt.js) (new) | Sits next to `x402-paid-endpoint.js` and `x402-spec.js` so the hook points import it cleanly. |
| DID document hosting | **Out of scope for v1** | Not required for EIP-712 (`did:pkh` is self-describing). Add later if a verifier requires it. |

## Files touched

- [api/_lib/x402-offer-receipt.js](../../api/_lib/x402-offer-receipt.js) — **new**, exports a singleton issuer + offer/receipt sign helpers.
- [api/_lib/x402-spec.js](../../api/_lib/x402-spec.js) — wire offers into `build402Body`, wire receipts into `encodePaymentResponseHeader`.
- [api/_lib/x402-paid-endpoint.js](../../api/_lib/x402-paid-endpoint.js) — pass payer/network through to settle so the receipt payload has what it needs.
- [api/_lib/env.js](../../api/_lib/env.js) — surface `X402_RECEIPT_SIGNING_KEY` as a typed env field.
- [.env.example](../../.env.example) — document the new env var.
- [package.json](../../package.json) — add `@x402/extensions` and (if missing) `viem`.
- All 9 endpoints in [api/x402/](../../api/x402/) — **no edits needed**. The global wrapper handles it.
- [scripts/verify-x402-receipts.js](../../scripts/verify-x402-receipts.js) — **new**, smoke test that hits a paid endpoint and verifies the signed offer + receipt round-trip.

## Prompt sequence

Each prompt is self-contained and assumes only that prior prompts in the sequence completed successfully. Run them in order.

1. [01-foundation.md](01-foundation.md) — install deps, add env var, create the signer module.
2. [02-offer-signing.md](02-offer-signing.md) — wire offer signing into the `402` response path.
3. [03-receipt-signing.md](03-receipt-signing.md) — wire receipt signing into the `200` response path.
4. [04-bazaar-declaration.md](04-bazaar-declaration.md) — declare the extension in the discovery envelope so bazaar crawlers know we sign.
5. [05-verification-script.md](05-verification-script.md) — build the end-to-end smoke test that proves offers and receipts verify.
6. [06-completionist-and-push.md](06-completionist-and-push.md) — final audit pass and push to both remotes.

## Definition of done (whole feature)

All of these must be verifiable, not asserted:

- [x] `X402_RECEIPT_SIGNING_KEY` is set in `.env.example` (placeholder), `.env` (real value), and configured in Vercel for `production` + `preview`.
- [x] `npm test` passes.
- [x] Hitting any paid endpoint without a payment header returns `402` with `body.extensions["offer-receipt"].signedOffers[]` containing one entry per accepted network.
- [x] Hitting any paid endpoint with a valid payment returns `200` with `x-payment-response` decoding to an envelope whose `extensions["offer-receipt"].signedReceipt` verifies under the signer's recovered address.
- [x] The verification script at `scripts/verify-x402-receipts.js` runs against a deployed (or `vercel dev`) instance, verifies both artifacts, and exits `0`.
- [x] No handler in `api/x402/*.js` was modified — the wiring is purely in the shared lib.
- [x] Completionist agent run against the diff returns clean.
- [x] Pushed to **both** `origin` and `threews` remotes.

## Risks & caveats

- **Key compromise.** `X402_RECEIPT_SIGNING_KEY` is the single point of failure. If it leaks, an attacker can forge offers and receipts in your name. Provision it via Vercel encrypted env, never commit it, and rotate by updating env + bumping the KID's `#key-1` → `#key-2`.
- **Settle-failure ordering.** Receipts must only be signed *after* `settlePayment` succeeds, never before. The wiring in prompt 03 must enforce this.
- **`vercel.json` collapse.** Recent commit `36dfec9a` collapsed functions config to a single wildcard. The new signer module is a `_lib` helper, not a function entry, so no `vercel.json` change is needed. Verify this assumption holds before claiming done.
- **`bazaar` schema strictness.** Per [api/_lib/x402-spec.js](../../api/_lib/x402-spec.js#L457), the bazaar extension must mirror `@x402/extensions/bazaar` exactly. The new `offer-receipt` extension is a **sibling** to `bazaar`, not nested under it. Do not modify `bazaarExtension()` or `buildBazaarSchema()`.

## Rollback

Single env-var toggle controls the feature: if `X402_RECEIPT_SIGNING_KEY` is unset, the signer module exports a no-op issuer, the offer/receipt arrays are omitted from responses, and the feature degrades gracefully to current behavior. To roll back: unset the env var in Vercel and redeploy. Code does not need to be reverted.
