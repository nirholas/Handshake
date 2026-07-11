# Discover and Pay for an x402 Service

By the end of this tutorial you'll be able to find a paid API in the [Bazaar](/bazaar), pay for one call in USDC, and get back real work — no API key, no account, no subscription. You'll do it four ways: from the Bazaar UI with a wallet, from the hosted [/pay](/pay) checkout, programmatically with `window.X402.pay`, and by letting an autonomous agent shop the catalog for you on [/shopper](/shopper).

This is the **consume** side of x402. If you want to *build* an endpoint that takes these payments, see [paid-x402-endpoint](/tutorials/paid-x402-endpoint) — this tutorial is everything on the other side of that handshake.

**Prerequisites:**

- A browser wallet: **Phantom** (or Solflare) for Solana, or **MetaMask** / **Coinbase Wallet** for Base (EVM). The checkout detects whichever is installed.
- A small USDC balance on the network you'll pay from. Most calls are $0.001–$0.01, so ~$1 USDC funds thousands of them. On Solana you also need a little SOL for the account; on Base the signature is gasless from your side.
- Light JavaScript familiarity for the programmatic path (Steps 5–6). The UI paths (Steps 2–4) need none.

---

## What you're building

Paying for an x402 service is two HTTP round trips and one wallet signature:

```
You → GET  /api/some-paid-thing            (no payment)
    ← 402 Payment Required  { accepts: [ { network, asset, amount, payTo } ] }
You → sign a USDC payment for one of the `accepts`
You → GET  /api/some-paid-thing            (X-PAYMENT: <signed payload>)
    ← 200  { ...the actual work... }        (X-PAYMENT-RESPONSE: <on-chain receipt>)
```

The price, the recipient, and the network all come from the seller's 402 challenge — you never type them. Your wallet signs exactly that amount to exactly that address, the platform settles it on-chain, and the original request is retried automatically. You either get what you paid for or you pay nothing.

---

## How discovery and payment fit together (two minutes of theory)

There are two distinct problems: **finding** an endpoint and **paying** it.

**Finding.** The [Bazaar](/bazaar) is a discovery surface. Server-side, `/api/bazaar/list` (`api/bazaar/list.js`) and `/api/bazaar/search` (`api/bazaar/search.js`) call each configured facilitator's `/discovery/resources` route, merge the catalogs, dedupe (HTTP by resource URL, MCP by `resource + toolName`), normalize the shape, and apply your filters. The default facilitators are PayAI (`facilitator.payai.network`, Base + Solana) and Coinbase CDP (`api.cdp.coinbase.com/platform/v2/x402`, Base + EVM L2s), wired in `api/_lib/x402/bazaar-client.js`. An endpoint shows up here once it has answered a discovery probe with a valid 402 — there is no submission form. (How three.ws gets *its own* endpoints into those catalogs is the build-side concern covered in [paid-x402-endpoint](/tutorials/paid-x402-endpoint).)

**Paying.** Every payment runs through the same drop-in module, `public/x402.js`, exposed as `window.X402.pay(...)`. It does the 402 → sign → retry dance for you:

- For **Solana**, the wallet can only sign serialized transactions, so the module posts the challenge's `accept` to `/api/x402-checkout?action=prepare` (`api/x402-checkout.js`), gets back a partially-signed SPL `transferChecked`, has Phantom add the buyer's signature, then `?action=encode`s it into the `X-PAYMENT` header.
- For **Base / EVM**, the wallet signs an EIP-3009 `transferWithAuthorization` typed-data message locally — no server prep needed.

Either way the signed payload is base64-encoded into `X-PAYMENT`, the gated request is retried once, and the unlocked result plus the decoded `X-PAYMENT-RESPONSE` receipt come back.

---

## Step 1: Browse the Bazaar

Open [/bazaar](/bazaar). You'll see a searchable, filterable grid of every paid service the facilitators currently advertise.

The sidebar filters map directly to the catalog query:

- **Type** — `http` (paid REST endpoints) or `mcp` (paid MCP tools). HTTP is the default.
- **Network** — Base, Arbitrum, Optimism, Polygon, Solana, or Base Sepolia.
- **Max price** — a USDC ceiling; entered in dollars, sent to the API as 6-decimal atomic units.
- **Extension** — narrow to endpoints advertising a specific x402 extension (e.g. `sign-in-with-x`).
- **Sort** — including by price, ascending.

Type a query (e.g. `weather`, `reputation`, `model`) and the page switches from `/api/bazaar/list` to `/api/bazaar/search`, ranking results against your terms. The footer shows which facilitators answered and which failed, so a single down source never blanks the page.

Each card shows the service name, description, price (minimum USDC across its `accepts`), supported networks, the provider host (links to its [/providers](/providers) profile), and — when several listings do the same job — a **peer hint** comparing prices across them. That last one matters: the same capability is often sold by multiple providers at different prices.

---

## Step 2: Pay for a service from the Bazaar

Find an HTTP service you want and click **Try it** on its card.

1. The drop-in payment modal opens, having already re-fetched the live 402 challenge to confirm the current price (prices can change; the card is a cached hint, the modal is the source of truth).
2. The modal shows the **price**, the **network**, and **who you're paying** — the on-chain `payTo` address, linked to a block explorer so you can verify the recipient before committing.
3. Pick your wallet. The modal only offers wallets that match a network in the challenge's `accepts` and are actually detected in your browser; undetected ones render disabled with an "install" hint.
4. Approve the payment in your wallet. Before prompting you, the modal does a fail-open balance pre-check — if it can positively read that your wallet is short, it shows an insufficient-funds state with the exact shortfall and an explorer link, instead of letting you sign a doomed transaction.
5. The platform settles on-chain and retries the call. The card's receipt area fills in with the result and a link to the on-chain transaction.

What you signed is exactly what the challenge declared — the modal never invents an amount or a recipient. If the seller configured optional charity / round-up giving on a Solana checkout, you'll see a pre-checked, opt-out box that rides the *same* transaction, so you still pay once.

> **MCP tools** can't be paid through this modal — they need a JSON-RPC `tools/call` envelope the modal doesn't speak. Clicking a `mcp`-type card opens the details panel instead, with the schema you'd wire into an MCP client. To call MCP tools by paying per-call, see [mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent).

---

## Step 3: Read the 402 challenge yourself

To understand what the modal is doing, hit a paid endpoint by hand. Any x402 endpoint answers an unpaid request with a 402:

```bash
curl -i https://three.ws/api/x402/model-check
```

You get back a `402 Payment Required` whose JSON body (and a base64 mirror in the `payment-required` response header) contains an `accepts` array. One entry looks like:

```jsonc
{
  "scheme": "exact",
  "network": "solana",                                  // or "eip155:8453" for Base
  "amount": "1000",                                     // 6-decimal atomic USDC → $0.001
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
  "payTo": "<recipient address>",
  "maxTimeoutSeconds": 60,
  "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "<sponsor>" }
}
```

Read it like a receipt-in-advance:

- **`amount`** is in atomic units of **`asset`**. With `decimals: 6`, `"1000"` is $0.001. (Spec-strict sellers may name this field `maxAmountRequired`; the client coerces both to `amount`.)
- **`network`** tells you which wallet you need. `solana` / `solana:*` → Phantom/Solflare; `eip155:8453` → Base; other `eip155:*` are the EVM L2s in `EVM_NETWORKS` (`public/x402-pay-core.js`).
- **`payTo`** is exactly where your USDC goes. Nothing else moves.
- **`maxTimeoutSeconds`** bounds how long your signed authorization is valid — your one safety net against a stale payment lingering.

A single endpoint can list several `accepts` (e.g. Base *and* Solana). You — or your wallet — pick whichever network you hold funds on.

---

## Step 4: Pay through the /pay surface

[/pay](/pay) is the platform's own pay-per-call surface — a live demo that pays $0.001 USDC on Solana to call MCP tools and render 3D assets, with a settlement timeline you can watch step by step. Use it to see a real settlement end to end before wiring your own.

Two related routes sit under it:

- **[/pay/calls](/pay/calls)** — the public ledger of paid x402 calls to the platform. Each settled call gets a permalink (`/pay/calls/<tx-signature>`) showing the tool invoked and the on-chain transaction. This is your audit trail: every payment you make here is verifiable on-chain by anyone.
- **`/pay/c/<slug>`** — a *hosted checkout link*. A provider creates a SKU in their dashboard (see `api/x402-skus.js`) and shares the URL; the page hydrates from `/api/x402-skus?slug=<slug>` and opens the same drop-in modal pre-wired to that endpoint. If someone hands you a `/pay/c/...` link, paying it is identical to Step 2 — open it, pick a wallet, approve.

The point of the `/pay` surface: the *exact same* payment core (`public/x402.js` and its sibling `public/x402-pay-core.js`) drives the Bazaar's "Try it", the hosted checkout, the full-page paywall, and the programmatic call below. Learn it once.

---

## Step 5: Pay programmatically with window.X402.pay

When you want to trigger a paid call from your own page or script, skip the UI and call the module directly. Load it once:

```html
<script type="module" src="https://three.ws/x402.js"></script>
```

Then pay for any endpoint:

```js
const out = await window.X402.pay({
  endpoint: 'https://three.ws/api/x402/model-check?url=' +
            encodeURIComponent('https://three.ws/avatar/character-studio/sample.glb'),
  method: 'GET',
  merchant: 'three.ws',
  action: 'Model Check',
});

if (out.ok) {
  console.log('result:', out.result);        // the work product
  console.log('paid on:', out.payment.network);
  console.log('tx:', out.payment.transaction); // on-chain settlement
}
```

`pay()` opens the modal, runs discovery → connect → sign → verify → retry, and resolves with `{ ok, result, payment, response }`. On a user cancel it rejects with an error whose `code === 'cancelled'` — handle that distinctly from a real failure.

Useful options:

- **`body`** — a JSON object for `POST` endpoints (method defaults to `POST` when a body is present).
- **`headers`** — extra request headers forwarded on the paid retry.
- **`networks`** — an allowlist to force a single rail, e.g. `['solana']` for a Solana-only checkout, or `['evm']` / `['eip155:8453']`. The modal drops every `accept` outside the allowlist before rendering the wallet picker. If the filter would empty the list, it keeps the original accepts so a misconfigured allowlist never breaks a live checkout.

For a declarative trigger, any element with `data-x402-endpoint` is auto-bound on load and fires an `x402:result` (or `x402:error`) CustomEvent when done:

```html
<button
  data-x402-endpoint="https://three.ws/api/x402/model-check"
  data-x402-method="GET"
  data-x402-merchant="three.ws"
  data-x402-action="Model Check"
>Pay &amp; Run</button>
```

To wire paid calls into an **agent's** conversation (so it buys mid-chat when the user asks), put the same pattern in a skill handler via `ctx.x402.fetch` — covered in [custom-skill](/tutorials/custom-skill) and the caller half of [paid-x402-endpoint](/tutorials/paid-x402-endpoint).

---

## Step 6: Let an agent shop the Bazaar for you

When you don't know *which* endpoint you need, the [Endpoint Shopper](/shopper) does the discovery, payment, and synthesis for you. Describe a task, set a USDC budget, and the agent searches the Bazaar for relevant endpoints, pays for each call it decides to make (capped at your budget), and returns a synthesized answer with a per-step cost breakdown.

```
Task:   "What is the current price of ETH?"
Budget: $0.50
        ↓  [discover → plan → call (pays per endpoint) → synthesize]
Answer: "ETH is trading around $3,180." — total spent: $0.012 USDC across 2 paid steps
```

The page posts to `/api/agents/endpoint-shopper-run` with `{ task, maxCostUsd }`. The agent itself charges a small base fee and spends up to your budget downstream — set the budget at or above $0.01 so it can fund at least one paid call (the UI gates the button below that). The timeline shows each step's action (discover / plan / call / synthesize), the endpoint it hit, and what that step cost; the final row sums the spend, showing **"Free (no paid calls executed)"** when the task needed none.

If running the Shopper itself returns a 402, the page hands you off to the wallet paywall to unlock it — the same payment core as every other path here.

This is the autonomous consumer pattern: you express intent and a budget; the agent turns the Bazaar into a tool it pays for on demand. To coordinate multiple agents around a buying flow, see [multi-agent-coordination](/tutorials/multi-agent-coordination).

---

## Step 7: Verify what you paid for

Every successful payment returns an on-chain receipt — make a habit of checking it:

- **In the UI** — the Bazaar receipt and the modal both link the settlement transaction to a block explorer (Solscan for Solana, Basescan/Arbiscan/etc. for EVM).
- **Programmatically** — `out.payment.transaction` is the on-chain tx; `out.payment.network` and `out.payment.payer` tell you which rail settled and from which wallet.
- **On the public ledger** — platform calls land on [/pay/calls](/pay/calls) with a permalink anyone can audit.

If the result looks wrong but you were charged, note: x402 has **single-shot, no-refund** semantics — you pay for the *attempt*, not a guaranteed *result*. A failed call after settlement is not auto-refunded; retrying means a fresh payment. That's why the verify-then-work-then-settle ordering on the seller side (see [paid-x402-endpoint](/tutorials/paid-x402-endpoint)) matters to you as a buyer: a correctly built endpoint never settles when its work failed, so you don't pay for nothing.

---

## Troubleshooting

- **"Payment module failed to load (x402.js)"** on a Bazaar card — the drop-in script 404'd or didn't evaluate, so `window.X402` is undefined. Reload the page; check the network tab for the `/x402.js` request.
- **Wallet button is disabled** — that wallet isn't detected, or no `accept` matches its network. Install the extension (Phantom for Solana, MetaMask/Coinbase for Base) and reload, or pick the other rail.
- **"Not enough USDC — you need X but your wallet holds Y"** — the balance pre-check caught a shortfall before you signed. Top up the wallet on the shown network (the error links your address on the explorer) and retry. The check is fail-open: if your balance can't be read, payment still proceeds.
- **"Endpoint did not return 402 (got 200/404…)"** — you pointed `pay()` at a free or non-x402 URL. Confirm the endpoint actually challenges with `curl -i <url>` (Step 3).
- **402 but "no `accepts` array could be found"** — a proxy stripped the body *and* the `payment-required` header, or the seller's challenge is malformed. Try the endpoint's own canonical URL; if it's third-party, the seller's 402 is non-compliant.
- **Signature rejected at settle on Base** — almost always a wrong EIP-712 domain. Base USDC's domain name is `"USD Coin"` at version `"2"`; a seller advertising anything else produces a payload the facilitator rejects. Nothing you can fix as a buyer — report it to the provider.
- **Solana checkout fails at "Authorize"** — usually a stale blockhash on a flaky RPC; the prepare endpoint fails open to a recent cached blockhash, so simply retry. A too-stale blockhash never confirms and never double-charges.
- **Clicking an MCP card doesn't open a payment modal** — by design; MCP tools open the details panel. Wire them through an MCP client ([mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent)).
- **Endpoint Shopper button stays disabled** — the budget is below $0.01 or the task is empty; the hint under the button names the exact unmet precondition.

---

## Recap

You learned four ways to consume an x402 paid service:

- **The Bazaar** ([/bazaar](/bazaar)) — search and filter the merged facilitator catalog, then **Try it** to pay with a wallet through the drop-in modal.
- **The /pay surface** ([/pay](/pay), [/pay/calls](/pay/calls), `/pay/c/<slug>`) — the platform's live pay-per-call demo, public on-chain ledger, and hosted checkout links — all driven by the same payment core.
- **`window.X402.pay`** — pay for any endpoint from your own code; resolves with the result plus an on-chain receipt, with a `networks` allowlist to pin the rail.
- **The Endpoint Shopper** ([/shopper](/shopper)) — describe a task and a budget; an agent discovers, pays for, and synthesizes results from Bazaar endpoints autonomously.

The throughline: discovery and payment are decoupled, the 402 challenge is the single source of truth for price and recipient, every payment settles on-chain in USDC, and one module (`public/x402.js`) drives every surface.

**Use it from your own project (npm)**

Outside the browser — in a Node service, an agent runtime, or a CLI — install the
standalone buyer package instead of the hosted module:

```bash
npm i @three-ws/x402-fetch
```

```js
import { withX402, privateKeyToWallet } from '@three-ws/x402-fetch';

// Wrap fetch once with a wallet; paid endpoints settle automatically in USDC.
const pay = withX402(privateKeyToWallet(process.env.WALLET_PRIVATE_KEY), { maxPaymentUsd: 0.05 });
const res = await pay('https://api.example.com/paid', { method: 'POST', body });
```

Full API, wallet/signer options, and examples are in the
[`@three-ws/x402-fetch` README](https://github.com/nirholas/x402-fetch); the whole
package family is listed under [x402 → Open-source packages](/x402#open-source-packages).

**See also**

- [paid-x402-endpoint](/tutorials/paid-x402-endpoint) — the build side: ship your own endpoint that takes these payments.
- [mcp-server-for-your-agent](/tutorials/mcp-server-for-your-agent) — pay-per-call MCP tools.
- [custom-skill](/tutorials/custom-skill) — give an agent a tool that pays for a service mid-conversation.
- [multi-agent-coordination](/tutorials/multi-agent-coordination) — coordinate agents around a buying flow.
