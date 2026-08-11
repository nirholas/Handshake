# The x402 flow, as this modal drives it

A reference for what happens between `pay()` and the resolved receipt. Useful
when debugging an integration or building the server side.

## The four steps

```
┌── 1. DISCOVER ──────────────────────────────────────────────────────────┐
│  The modal sends the request you described (endpoint/method/body/headers) │
│  with NO payment. It expects one of:                                      │
│    • HTTP 402 with a JSON body containing `accepts[]`, or                  │
│    • HTTP 401 with a base64-JSON `payment-required` header (MCP 2025-06-18)│
│  Anything else (200, etc.) is surfaced as an error — pointing the modal at │
│  a free endpoint must not silently "succeed".                             │
└───────────────────────────────────────────────────────────────────────────┘
                                   │  accepts[] = [{ scheme, network, asset,
                                   │                payTo, amount, extra… }, …]
                                   ▼
      Step 1 is exported on its own as `discover({ endpoint, … })`: it runs
      exactly this probe, returns the parsed envelope with `accepts[]`
      normalized, and touches neither the DOM nor a wallet. Use it to price a
      call, or to check which networks an endpoint takes, before opening the
      modal (or from a server / CLI / agent that has no modal at all).
                                   ▼
┌── 2. CONNECT ───────────────────────────────────────────────────────────┐
│  The modal picks accepts it can satisfy:                                  │
│    • Solana (`solana:*`)  → Phantom (`window.solana` / `window.phantom`)  │
│    • EVM    (`eip155:*`)  → `window.ethereum` (EIP-3009 entries only;      │
│                              Permit2 siblings are skipped)                 │
│  >1 viable → wallet picker.  Exactly 1 + `autoConnect` → straight through. │
│  Spending caps (if set) are checked here, before any signature prompt.    │
└───────────────────────────────────────────────────────────────────────────┘
                                   ▼
┌── 3. AUTHORIZE ─────────────────────────────────────────────────────────┐
│  Solana:                                                                  │
│    POST {apiOrigin}/api/x402-checkout?action=prepare {accept,buyer}        │
│        → tx_base64   (built server-side; fee payer = facilitator)         │
│    Phantom signs the VersionedTransaction                                 │
│    POST …?action=encode {accept, signed_tx_base64, resource_url, …}        │
│        → x_payment   (base64 paymentPayload)                              │
│  EVM:                                                                      │
│    wallet signs an EIP-3009 TransferWithAuthorization (typed data v4)     │
│    the modal assembles x_payment locally — no backend, no gas, no tx       │
└───────────────────────────────────────────────────────────────────────────┘
                                   ▼
┌── 4. VERIFY & SETTLE ───────────────────────────────────────────────────┐
│  Re-send the original request with header `X-PAYMENT: <x_payment>`.        │
│  The server VERIFIES the payment, RUNS the work, SETTLES on-chain, and     │
│  returns 200 with an `x-payment-response` header (base64 receipt:          │
│  network, payer, transaction). The modal renders the receipt + result.    │
└───────────────────────────────────────────────────────────────────────────┘
```

## Why settlement-after-work makes retries safe

x402 servers verify and *settle* the payment only **after** the protected work
succeeds. So if the merchant returns a transient `429` (an upstream rate-limit
hit *before* settlement), the exact same signed `X-PAYMENT` can be re-sent once
the window resets with **no risk of a double charge**. The modal auto-retries a
`429` up to twice, honoring `Retry-After`, with a live countdown, before falling
back to a manual **Try again**.

## SIWX re-entry (optional)

If the `402` body includes an `extensions['sign-in-with-x']` block, the modal
leads with **"Sign in with wallet"**: a buyer who already paid for this resource
can re-enter by signing a CAIP-122 challenge (submitted via the
`SIGN-IN-WITH-X` header) instead of paying again. If the server responds that
this wallet hasn't actually paid (`401/402` + `siwx_not_paid`), the modal
transparently falls back to the normal payment flow with a one-line notice.

The message string the modal signs is byte-compatible with the
[siwe](https://github.com/spruceid/siwe) (EVM) and SIWS (Solana) formats so the
server's recovered signer matches `payload.address`. See `buildSiwxMessage` in
`src/util.js`.

## ERC-8021 builder codes

When the `402` declares a builder code under
`extensions['builder-code'].info.a`, the modal echoes it back (anti-tamper: the
server checks the echoed `a` equals what it declared) and self-attributes its
own wallet (`w`) and service (`s`) codes from
[`configure({ builderCode })`](./CONFIGURATION.md). Set `builderCode: null` to
disable the echo.

## The `accept` object

| field | meaning |
|---|---|
| `scheme` | payment scheme — `exact` for a fixed price |
| `network` | CAIP-2 id: `solana:<genesis>` or `eip155:<chainId>` |
| `asset` | token: SPL mint (Solana) or ERC-20 address (EVM) |
| `payTo` | recipient wallet |
| `amount` | atomic amount (the modal also reads spec-canonical `maxAmountRequired`) |
| `maxTimeoutSeconds` | EVM EIP-3009 `validBefore` window (default 600) |
| `extra.name` | display + stablecoin detection (`USDC`, `USDT`, `DAI`…) |
| `extra.decimals` | token decimals (default 6) |
| `extra.version` | EVM EIP-712 domain version (Base USDC = `"2"`) |
| `extra.feePayer` | Solana facilitator fee-payer pubkey (Solana only) |
| `extra.assetTransferMethod` | `eip3009` (default) or `permit2` (skipped by this modal) |

## Spec references

- x402 — <https://x402.org>
- CAIP-2 network ids — <https://chainagnostic.org/CAIPs/caip-2>
- EIP-3009 `transferWithAuthorization` — <https://eips.ethereum.org/EIPS/eip-3009>
- CAIP-122 / Sign-In-With-X — <https://chainagnostic.org/CAIPs/caip-122>
