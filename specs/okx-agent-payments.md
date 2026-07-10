# OKX Agent Payments Protocol — Seller-Side Contract (three.ws A2MCP)

*Historical record — this Work Order research contract was captured 2026-07-06 and reconciled 2026-07-07, the day three.ws production migrated from Vercel to Google Cloud Run. Its "Set in Vercel" / "not set in Vercel production" notes describe that point-in-time state; production env vars now live on the Cloud Run service `three-ws-api` (`gcloud run services describe/update three-ws-api --region us-central1` — see [docs/ops/gcp-production.md](../docs/ops/gcp-production.md)). The seller-side wire contract (§1) and the spec→code map (§5) remain current.*

> **Status:** Research complete. Green-light for Work Order 02.
> **Chain:** X Layer mainnet, `eip155:196` (chainId 196).
> **Our payTo:** `0x75d00a2713565171f33216e5aa2a375e076ecf69` (agent #2632 owner wallet).
> **Fee token:** USD₮0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (6 decimals, EIP-3009).
> **Why this exists:** Our A2MCP endpoint ([api/mcp-3d.js](../api/mcp-3d.js)) emits x402 accepts for Solana/Base/BSC/Arbitrum only — never `eip155:196`, never the OKX fee token — and on the paid leg it reads/emits **x402 v1 header names** (`X-PAYMENT`/`x-payment-response`) rather than the **x402 v2** names OKX uses (`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`). That is the exact reason agent #2632 was rejected on 2026-07-04. (The HTTP-level 402 gate itself ALREADY exists — see the verification note below.) This spec pins the seller-side contract from **primary sources** so 02 can implement it without opening a browser.
>
> **Header-naming premise correction (important):** `PAYMENT-SIGNATURE` (buyer→seller) and `PAYMENT-RESPONSE` (seller→buyer) are the **vanilla x402 _v2_ standard** header names (Coinbase `x402` `specs/transports-v2/http.md`; `specs/x402-specification-v2.md:77` literally errors `"PAYMENT-SIGNATURE header is required"`). `X-PAYMENT`/`X-PAYMENT-RESPONSE` are **x402 _v1_**. OKX matches x402 v2 exactly on header naming. (The OKX SDK's `extractPayment` reads ONLY `payment-signature` and the subscription `app-payment` — there is NO v1 `x-payment` fallback in it; SDK-REPO `x402HTTPResourceServer.ts:1558-1580`. Do not rely on v1 names on the OKX rail.) The genuine OKX extensions are only: the `aggr_deferred`/`upto` schemes, the HMAC-signed OKX-hosted facilitator, `syncSettle`, `settle/status`, subscriptions, and the parallel `WWW-Authenticate: Payment` MPP rail. **Our own code labels itself "v2" but uses the v1 payment-header names — that is the delta to close for the X-Layer rail.**
>
> **Verification pass (2026-07-06, second session, independent captures — Appendix H):** a parallel WO-01 run re-derived this contract from its own wire captures (Predexon #2143 as a fourth approved seller, a second signed payment leg, on-chain RPC reads, live `x402-check` runs). It CONFIRMS every §2 answer with two corrections, applied inline below: (1) our endpoint's **HTTP-level 402 gate already exists** for non-MCP clients — bare `POST tools/call` returns `HTTP/2 402` + `PAYMENT-REQUIRED`, and `onchainos agent x402-check --endpoint https://three.ws/api/mcp-3d` parses it `valid: true` (Solana-only accepts — the gap is the missing `eip155:196` entry, not a missing gate; original Q6/G9 overstated this); (2) the SDK has no v1 `x-payment` fallback (above). It also STRENGTHENS Q3: `extra.name`/`extra.version` are now cryptographically pinned against the token's on-chain `DOMAIN_SEPARATOR()` (Appendix H.3).

> **Post-implementation reconciliation (2026-07-07, WO-01 close-out session):** the contract below has since been **implemented** by WO-02/03 and **re-validated against still-live primary sources today** — the approved-seller 402 (oklink `get_chain_info`) is byte-identical to Appendix A, the OKX facilitator still returns `HTTP 401 code 50103` requiring `OK-ACCESS-KEY`, and USD₮0 is unchanged. Spec-vs-shipped conformance was checked: [`api/_lib/x402-xlayer-okx.js`](../api/_lib/x402-xlayer-okx.js) `okxXLayerAccept()` byte-matches §1.1 (scheme `exact`, `eip155:196`, USD₮0 asset, `extra{name:"USD₮0",version:"1",transferMethod:"eip3009",decimals:6}`, `maxTimeoutSeconds:86400`), reads `PAYMENT-SIGNATURE`, routes verify/settle through `OKXFacilitatorClient`, and emits `PAYMENT-RESPONSE` per §1.2. **The §4 gap list below is therefore historical — it was 02's work list and is now closed in code**, EXCEPT the runtime is still gated: the X Layer accept is only advertised when `xlayerSettleable()` is true (`X402_PAY_TO_XLAYER` + `X402_ASSET_ADDRESS_XLAYER` + OKX HMAC creds **or** `X402_XLAYER_RELAYER_KEY`). Those env vars are **not set in Vercel production**, so `POST /api/okx/3d/*` still returns a **Solana-only** challenge with no `eip155:196` entry — i.e. the 2026-07-04 rejection cause persists *at runtime* despite the merged code. Unblocking is entirely owner-provisioning (see PROGRESS): set the X Layer env vars + OKX API credentials, fund `0x75d0…cf69` with USD₮0. No further code or research is required from this spec.

This is a load-bearing contract in the sense of `specs/README.md`: 02's implementation is validated against §1 (the challenge shape) and §4 (the gap list). Every claim carries a citation. Anything not verifiable from a primary source is marked **UNRESOLVED**.

**Primary sources used (all cited inline below):**

- **SDK-REPO** — `github.com/okx/payments`, the official **OKX Payments SDK** (Apache-2.0, cloned & read 2026-07-06). Paths below are relative to `typescript/bu-payments/`.
- **WIRE-OKLINK** — live 402 + paid replay from **Onchain Data Explorer** (agent #2023, 174 sales, approvalStatus 4), endpoint `https://www.oklink.com/api/v5/explorer/mcp/x402/get_chain_info`. Captured 2026-07-06 (Appendix A).
- **WIRE-COINANK** — live 402 from **CoinAnk OpenAPI** (agent #2013, 818 sales, approvalStatus 4), `https://open-api.coinank.com/api/etf/getUsBtcEtf` (Appendix B).
- **WIRE-OKB** — live 402 from **OKB Monitoring** (agent #3837, approvalStatus 4), `https://okb.swaper.money/x402/digest` (Appendix C).
- **PAY-LEG1/2** — real `onchainos payment pay` signing + paid replay from our own wallet (Appendix D).
- **SKILL** — repo client-side skill `.claude/skills/okx-agent-payments-protocol/` (buyer constraints).
- **SKILLS-REPO** — `github.com/okx/onchainos-skills` (the `onchainos` CLI + listing validator `cli/…/identity/validate.rs`).
- **X402-SPEC** — `github.com/coinbase/x402` (`specs/x402-specification-v2.md`, `specs/transports-v2/http.md`) — establishes that `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` are the x402 v2 standard, not an OKX invention.

---

## 1. Seller contract — what OUR endpoint must emit

### 1.1 The 402 challenge (concrete, with our values)

On an unpaid request to a paid A2MCP resource, respond `HTTP 402` with:

- Header **`PAYMENT-REQUIRED`**: base64 of the JSON body below.
- Header **`Access-Control-Expose-Headers: PAYMENT-REQUIRED`** (so browser/agent clients behind CORS can read it — WIRE-OKLINK sets this).
- Body: the same JSON (SDK emits the challenge in both the header and, on the resource server, the body).

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://three.ws/api/mcp-3d",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:196",
      "amount": "15",
      "payTo": "0x75d00a2713565171f33216e5aa2a375e076ecf69",
      "maxTimeoutSeconds": 86400,
      "asset": "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      "extra": { "name": "USD₮0", "version": "1", "symbol": "USDT", "transferMethod": "eip3009" }
    },
    {
      "scheme": "aggr_deferred",
      "network": "eip155:196",
      "amount": "15",
      "payTo": "0x75d00a2713565171f33216e5aa2a375e076ecf69",
      "maxTimeoutSeconds": 86400,
      "asset": "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      "extra": { "name": "USD₮0", "version": "1", "symbol": "USDT", "transferMethod": "eip3009" }
    }
  ]
}
```

`amount` is atomic units of USD₮0 (6 decimals). `"15"` = $0.000015 (the exact price Onchain Data Explorer charges for `get_chain_info`; WIRE-OKLINK). Set per-service in 03.

**Field requirement matrix** (present in ALL three approved sellers ⇒ required; present in some ⇒ optional). Diff of WIRE-OKLINK ∩ WIRE-COINANK ∩ WIRE-OKB:

| Field | Required? | Value / notes |
|---|---|---|
| `x402Version` | ✅ required | `2` (OKB uses `1` — legacy still accepted, but emit `2`; SDK hardcodes `2`, SDK-REPO `facilitator/OKXFacilitatorClient.ts:98`). |
| `accepts[].scheme` | ✅ required | `"exact"` present in all three. `"aggr_deferred"` in 2/3 (optional). `"upto"` in **none**. |
| `accepts[].network` | ✅ required | `"eip155:196"` in all three. **This is the field we don't emit — root cause of rejection.** |
| `accepts[].asset` | ✅ required | `0x779ded…713736` (USD₮0) in all three. |
| `accepts[].payTo` | ✅ required | Seller receiving address. Ours: `0x75d00a2713565171f33216e5aa2a375e076ecf69`. |
| `accepts[].amount` (v2) / `maxAmountRequired` (v1) | ✅ required | Atomic USD₮0 string. |
| `accepts[].maxTimeoutSeconds` | ✅ required | Seen `86400` / `300` / `300`. Use `86400` (oklink) or any ≥ a few minutes; it bounds `validBefore`. |
| `accepts[].extra.name` | ✅ required (EIP-3009) | `"USD₮0"` — the token's **EIP-712 domain name**. Must byte-match the on-chain domain separator or the facilitator computes the wrong hash and rejects the signature. |
| `accepts[].extra.version` | ✅ required (EIP-3009) | `"1"` — EIP-712 domain version. |
| `accepts[].extra.symbol` | ⬜ optional | `"USDT"`. Only WIRE-OKLINK emits it. Display hint. |
| `accepts[].extra.transferMethod` | ⬜ optional | `"eip3009"`. Only WIRE-OKLINK emits it. Default is EIP-3009 when absent (SDK `assetTransferMethod` only set for permit2 tokens; `defaultAssets.ts`). |
| `accepts[].extra.decimals` | ⬜ optional | `6`. Only WIRE-OKB (v1) puts it in `extra`; v2 sellers omit it (decimals come from the default-asset registry). |
| `resource.url` | ✅ required | Absolute URL of the paid resource. |
| `resource.mimeType` | ⬜ optional | `"application/json"` (WIRE-OKLINK). WIRE-COINANK omits it. |
| top-level `error` | conditional | Added only on a rejected paid replay (e.g. `"insufficient_balance"`); the full `accepts` is re-emitted so the client can retry. See PAY-LEG2 / Appendix D. |

Notes vs. our current Bazaar-heavy body: OKX sellers emit **no** `extensions.bazaar`, **no** `builder-code`, **no** `offer-receipt`, **no** per-accept `description`. The OKX validator does not require them; keep the body minimal for the `eip155:196` accepts.

### 1.2 Verify → do-work → settle (seller → OKX facilitator)

On a request that carries the payment header, the seller calls the **OKX facilitator** (HMAC-authed, see §Q4) and only does the work after `/verify` passes:

```
1. header = req.header("PAYMENT-SIGNATURE")          // x402 v2 std; also accept v1 `x-payment` for back-compat
2. paymentPayload = JSON.parse(base64url_decode(header))
3. requirement  = the accepts[] entry matching paymentPayload.accepted (network+scheme+asset)
4. POST https://web3.okx.com/api/v6/pay/x402/verify
     headers: OK-ACCESS-KEY / OK-ACCESS-SIGN / OK-ACCESS-TIMESTAMP / OK-ACCESS-PASSPHRASE
     body:    { x402Version: 2, paymentPayload, paymentRequirements: requirement }
   → { code, msg, data: { isValid, invalidReason?, invalidMessage?, payer? } }
   If !isValid → re-emit the 402 with top-level error = invalidReason (see PAY-LEG2).
5. Run the tool / produce the resource body.
6. POST https://web3.okx.com/api/v6/pay/x402/settle   (same auth + body, optional syncSettle)
   → { code, msg, data: { success, status, transaction, network, payer, amount? } }
7. Attach header PAYMENT-RESPONSE = base64(JSON.stringify(settleResponse)) to the 200.
```

Source: SDK-REPO `app-x402-core/src/facilitator/OKXFacilitatorClient.ts` (verify L92-115, settle L124-150), `app-x402-core/src/http/x402HTTPResourceServer.ts` (header read L1560, `PAYMENT-RESPONSE` emit L1663-1676), `app-x402-core/src/http/index.ts` (base64 codecs L17-80). Live-confirmed by PAY-LEG1/2.

### 1.3 The paid-replay header (buyer → seller)

The buyer replays the original request adding **`PAYMENT-SIGNATURE: <base64 PaymentPayload>`**. The decoded payload we must accept (from PAY-LEG1, our real signature):

```json
{
  "x402Version": 2,
  "resource": { "mimeType": "application/json", "url": "https://www.oklink.com/api/v5/explorer/mcp/x402/get_chain_info" },
  "accepted": {
    "scheme": "exact", "network": "eip155:196", "amount": "15",
    "asset": "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    "payTo": "0xa7e37604ebab94408159e405033a455f820fd987",
    "maxTimeoutSeconds": 86400,
    "extra": { "name": "USD₮0", "symbol": "USDT", "transferMethod": "eip3009", "version": "1" }
  },
  "payload": {
    "authorization": {
      "from": "0x75d00a2713565171f33216e5aa2a375e076ecf69",
      "to":   "0xa7e37604ebab94408159e405033a455f820fd987",
      "value": "15", "validAfter": "0", "validBefore": "1783455107",
      "nonce": "0x20ea1abd9c8d9ee9c4e0a861071475061ffebf07076eec8fa6d963f2a8957253"
    },
    "signature": "0x88c64c51…3d37891c"
  }
}
```

The seller passes `payload` + the matching `accepted` (as `paymentRequirements`) straight to the facilitator — it does not re-derive the EIP-712 hash itself. Header name is read case-insensitively (`payment-signature` OR `PAYMENT-SIGNATURE`; SDK `x402HTTPResourceServer.ts:1560`).

### 1.4 Settlement receipt (seller → buyer)

On success attach `PAYMENT-RESPONSE` (base64 of the `SettleResponse`). Shape (SDK `types/facilitator.ts:26-38`):

```json
{ "success": true, "status": "success", "transaction": "0x…", "network": "eip155:196", "payer": "0x75d0…cf69", "amount": "15" }
```

- `status: "success"` when settled with `syncSettle:true` (facilitator waited for on-chain confirmation).
- `status: "pending"` (default, `syncSettle` unset/false) — facilitator accepted, tx settles async; seller may confirm later via `GET /api/v6/pay/x402/settle/status?txHash=…`.
- `status: "timeout"` — on-chain confirmation timed out.

---

## 2. Answer table — the 8 questions

| # | Question | Answer | Citation |
|---|---|---|---|
| 1 | Exact 402 challenge shape the validator accepts | Header **`PAYMENT-REQUIRED`** = base64 JSON `{x402Version:2, resource:{url,mimeType?}, accepts:[…]}`. Per-`accepts` **required**: `scheme, network:"eip155:196", asset(USD₮0), payTo, amount, maxTimeoutSeconds, extra.name, extra.version`. `extra.symbol`/`extra.transferMethod`/`resource.mimeType` optional. No Bazaar/extensions needed. Full matrix §1.1. | WIRE-OKLINK/COINANK/OKB (Appx A-C); SDK `http/index.ts:40`, `x402HTTPResourceServer.ts:1101` |
| 2 | Which scheme(s) mandatory for listing | **`exact` (EIP-3009) is the one required scheme** — present in all 3 approved sellers, and the verification pass adds a fourth: **Predexon #2143 is approved and payment-enforcing with ONLY `exact`** (Appx H.4), so `exact` alone demonstrably passes review. `aggr_deferred` is offered by 2/4 (optional, recommended as a second accept). **`upto` is offered by none** and is NOT needed for approval. `upto` (if ever added) requires `extra.facilitatorAddress`, which the seller must fetch from the facilitator's `/supported.signers` — it cannot be hardcoded. | WIRE-* diff; Appx H.4 (Predexon, exact-only); SDK `upto/facilitator/scheme.ts:29-39`, `upto/client/permit2.ts:32-38`; SKILL `accepts-schemes.md` |
| 3 | Fee token `0x779Ded…713736` on X Layer | **Symbol `USDT`, name `USD₮0`, decimals `6`, EIP-3009 capable** (supports `transferWithAuthorization`). Community-recognized. Not permit2-only — the whole rail uses EIP-3009. **Cryptographically pinned (verification pass):** on-chain `name()` = `symbol()` = `"USD₮0"` (₮ = U+20AE), `decimals()` = 6; `authorizationState(address,bytes32)` answers (EIP-3009 present); and `DOMAIN_SEPARATOR()` == `keccak(EIP712Domain{name:"USD₮0",version:"1",chainId:196,verifyingContract:0x779d…})` — byte-exact, so `extra.name`/`extra.version` are proven, not inferred (Appx H.3). | `onchainos token info` (Appx E); X Layer RPC `eth_call` + domain-separator recomputation (Appx H.3); SDK `defaultAssets.ts` `DEFAULT_STABLECOINS["eip155:196"]` comment "(EIP-3009)"; live EIP-3009 sign accepted structurally by facilitator (PAY-LEG1/2) |
| 4 | OKX facilitator verify/settle URLs, shapes, auth | Base `https://web3.okx.com`. **`POST /api/v6/pay/x402/verify`**, **`POST /api/v6/pay/x402/settle`**, `GET /api/v6/pay/x402/supported`, `GET /api/v6/pay/x402/settle/status?txHash=`. Body `{x402Version:2, paymentPayload, paymentRequirements[, syncSettle]}`. Responses wrapped `{code,msg,data}`. **Auth = OKX REST HMAC-SHA256**: headers `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`(=base64(HMAC-SHA256(secret, timestamp+method+path+body))), `OK-ACCESS-TIMESTAMP`(ISO-8601), `OK-ACCESS-PASSPHRASE`. **⇒ We need an OKX API key/secret/passphrase.** `upto`'s `extra.facilitatorAddress` = `supported.signers[family][0]` via `getExtra()`. | SDK `facilitator/OKXFacilitatorClient.ts` (all endpoints + `createHeaders` L60-76); `upto/facilitator/scheme.ts:39` |
| 5 | The official OKX Payment SDK | **`github.com/okx/payments` = "OKX Payments SDK", Apache-2.0** (monorepo `@okxweb3/payments-sdk-monorepo`; Go/Python/Rust/TS/Java). **Use the `@okxweb3/app-x402-*` family @ v0.2.0** (`-core`, `-evm`, `-express`/`-next`/`-hono`/`-fastify`, `-mpp`) — that's what the runnable demo imports (published 2026-07-03). **⚠️ Avoid the stale `@okxweb3/x402-*` @ v0.1.0** (`x402-core`/`x402-evm`/`mpp`) that the repo's `SELLER.md` still names — last touched 2026-06-08. Pure TypeScript (deps `viem`/`zod`/`axios`/`mppx` — pure JS, `@noble` crypto, `node:crypto` HMAC, no native bindings) ⇒ **runs in Vercel functions**. Seller-side it builds the 402 challenge, reads `PAYMENT-SIGNATURE`, calls facilitator verify/settle, emits `PAYMENT-RESPONSE`, plus lifecycle hooks + metered `setSettlementOverrides`. Weekly downloads low (new pkg): app-x402-core ≈267, -evm ≈204, -express ≈188. | SDK-REPO README + `package.json`; `npm view @okxweb3/app-x402-*`; `api.npmjs.org/downloads/point/last-week`; `app-x402-next/README.md` |
| 6 | HTTP-level 402 vs MCP-level PaymentRequired | OKX expects **HTTP-level 402** on the endpoint URL: real `HTTP/2 402` status + `PAYMENT-REQUIRED` header, paid replay via `PAYMENT-SIGNATURE` header. All approved sellers do HTTP-level; the validator/buyer never inspects JSON-RPC `_meta`. **CORRECTED (verification pass): our endpoint ALREADY has this HTTP-level gate** — a bare (non-MCP) `POST tools/call` gets `HTTP/2 402` + `PAYMENT-REQUIRED`, live-verified for `text_to_3d` and `auto_rig_model`, and `x402-check` parses it `valid: true` (Appx H.1). Only MCP-protocol clients (`mcp-protocol-version` header) are routed to 401/OAuth, which OKX tooling never sends. 02's work on this axis is ONLY: the paid-replay leg must also accept `PAYMENT-SIGNATURE` (G7) and emit `PAYMENT-RESPONSE` (G8); the MCP-level `_meta` flow stays for MCP-native clients. | WIRE-OKLINK (POST→402, GET→405); Appx H.1 (live status matrix + x402-check `valid:true`); [api/mcp-3d.js](../api/mcp-3d.js), [api/_mcp/auth.js](../api/_mcp/auth.js); SDK is HTTP-transport only |
| 7 | How listing review validates the endpoint | Two layers. **(a) Registration-time `validate-listing` is PURE-LOCAL — no HTTP probe** (`onchainos-skills` `cli/…/identity/validate.rs`): it only checks A2MCP has an `endpoint`, the URL is `https://` + publicly reachable (rejects `http`, `localhost`, `127.0.0.1`, RFC-1918, `*.local/.internal`, mock/placeholder, >512 chars), fee is a plain number (USDT implicit), description has no URLs/addresses. It writes the endpoint URL on-chain (ERC-8004). Service-type → rail: **`A2MCP → x402`**. **(b) Approval / rejection** ("A2MCP service has not been integrated with the OKX Agent Payments Protocol") is a **human/off-repo review** — no codified automated probe that asserts the 402 shape exists in `okx/payments` or `onchainos-skills`. To pass it, the live endpoint must emit a v2 `402` whose `accepts` advertise **`eip155:196` + USD₮0** at the registered price. **Self-check tool (manual, not the gate):** `onchainos agent x402-check --endpoint <url>` flags `"Endpoint returned HTTP 200 (not 402); not a valid x402 service"` when the gate is absent (Appx E). **UNRESOLVED:** the exact method/body of any OKX-side automated probe, and whether one exists, are undocumented (dev-portal pages are JS-rendered / 404 to fetch). 02 should register, run `x402-check` against `https://three.ws/api/mcp-3d`, confirm `valid:true`, then resubmit for (human) review. | `onchainos-skills` `identity/validate.rs`, `task-cli-reference.md:396`; `onchainos agent x402-check` (Appx E); rejection email (00-CONTEXT) |
| 8 | Settlement finality — how seller confirms payment | Seller trusts the facilitator's responses, not its own chain read. `/verify` → `isValid:true` gates doing the work (proves the signed authorization is valid + payer funded — a broke payer gets `isValid:false` / `insufficient_balance`, proven by PAY-LEG2). `/settle` → `{success, status}`: `syncSettle:true` ⇒ `status:"success"` (on-chain confirmed before responding); default async ⇒ `status:"pending"` (safe to release; poll `/settle/status?txHash` for finality). The `PAYMENT-RESPONSE` header carries `{success,status,transaction,payer,amount}` to the buyer. | SDK `OKXFacilitatorClient.ts` settle L124-150 + `syncSettle` docstring; `types/facilitator.ts:26-38`; PAY-LEG2 |

---

## 3. SDK decision — adopt `@okxweb3/app-x402-*` (with a thin adapter)

**Decision: ADOPT the OKX Payments SDK for the OKX/X-Layer rail; keep our existing `api/_lib/x402-spec.js` for the Solana/Base/BSC rails.** Do not hand-roll the OKX dialect.

Per CLAUDE.md "Open-source first" checklist:

| Criterion | Finding | Verdict |
|---|---|---|
| Solves the problem | Yes — builds the exact `eip155:196` challenge, HMAC-signs facilitator calls, handles `exact`/`aggr_deferred`/`upto`/`period`, emits `PAYMENT-RESPONSE`. First-party, so it tracks the spec the validator enforces. | ✅ |
| Maintenance / provenance | Official OKX org (`okx/payments`), the SDK the rejection email points to. Multi-language, actively structured. v0.2.0 (early but first-party). | ✅ |
| License | **Apache-2.0** (`@okxweb3/app-mpp` is MIT). Compatible with our commercial use. | ✅ |
| Vercel compatibility | Pure TS, deps are `fetch` + `node:crypto` + `viem`-class EVM libs; no native addons. `@okxweb3/app-x402-next` targets Next/serverless directly. | ✅ |
| Weekly downloads | Low — app-x402-core ≈267/wk, -evm ≈204, -express ≈188 (v0.2.0, published 2026-07-03). Mitigated by first-party status + our own tests. | ⚠️ acceptable |

**⚠️ Package trap:** install the **`@okxweb3/app-x402-*` v0.2.0** family (what the demo imports), NOT the stale **`@okxweb3/x402-*` v0.1.0** family the repo's `SELLER.md` documents (last touched 2026-06-08).

**Adoption shape for 02:** our endpoint is a bare Vercel function (`api/mcp-3d.js`, Node `req/res`), not a Next.js app-router route, so `withX402` (needs `NextRequest`/`NextResponse`) is not a drop-in. Use the framework-agnostic core: `@okxweb3/app-x402-core` (`x402ResourceServer`, `OKXFacilitatorClient`, the `HTTPAdapter` interface, header codecs) + `@okxweb3/app-x402-evm` (`ExactEvmScheme`). Write a ~30-line `HTTPAdapter` over our Node `req`. This gives the OKX 402/verify/settle for `eip155:196` alongside our current multi-chain `paymentRequirements()` for the other rails. Reference seller wiring: SDK `demo/x402/src/index.ts` (Express) and `app-x402-next/README.md` (`withX402`). **Serverless caveat:** `await resourceServer.initialize()` calls the facilitator `/supported` and must run once per cold start (lazily) before the first paid request — it is what populates `upto`'s `facilitatorAddress` and validates scheme support.

**Env we must add:** `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` (facilitator HMAC), plus the payTo already known. **Blocker for 02:** these OKX API credentials must be provisioned by the owner from the OKX Web3 developer console. Without them every `/verify` and `/settle` fails auth. → raised in PROGRESS.

---

## 4. Gap analysis — `paymentRequirements()` today vs. what OKX requires (02's work list)

Reference: [api/_lib/x402-spec.js](../api/_lib/x402-spec.js) `paymentRequirements()` (L162-232) and `buildExactRequirements()` (L362-398).

| # | What we emit today | What OKX requires | Action for 02 |
|---|---|---|---|
| G1 | Accepts for `NETWORK_SOLANA_MAINNET`, `NETWORK_BASE_MAINNET`, `NETWORK_BSC_MAINNET`, `NETWORK_ARBITRUM_MAINNET`. **No `eip155:196`.** | An `accepts` entry with `network:"eip155:196"`. | Add `NETWORK_XLAYER_MAINNET = "eip155:196"` and an X-Layer branch (behind an env like `X402_PAY_TO_XLAYER`). |
| G2 | `asset` = USDC on Solana/Base; `X402_ASSET_ADDRESS_BASE`. | `asset` = `0x779ded0c9e1022225f8e0630b35a9b54be713736` (USD₮0). | Hardcode/env the USD₮0 mint for the X-Layer accept. |
| G3 | `extra: { name, decimals }` (Base) / `{ name, decimals, feePayer }` (Solana). | `extra: { name:"USD₮0", version:"1" }` (+ optional `symbol`,`transferMethod`,`decimals`). **`version` is required.** | New `extra` builder for the X-Layer accept: `name`+`version` mandatory. `decimals: 6` is optional (v2 sellers omit it) but RECOMMENDED: without it `x402-check` emits a `tokenResolveError` ("cannot determine token decimals … does not provide a `decimals` field", Appx H.2) because USD₮0 is outside the task system's supported-token list — harmless for oklink but free to avoid. |
| G4 | Field name `extra.assetTransferMethod` (permit2 path). | OKX exact uses `extra.transferMethod:"eip3009"` (or omit → EIP-3009 default). | Emit `transferMethod` (optional) — do NOT emit `assetTransferMethod` on the X-Layer accept. |
| G5 | Schemes `exact` (EIP-3009/permit2) + `direct` (BSC). **No `aggr_deferred`.** | `exact` mandatory; `aggr_deferred` recommended 2nd accept. | Emit `exact` for X-Layer; optionally add `aggr_deferred` accept (SDK `ExactEvmScheme`/aggr scheme). |
| G6 | Facilitator routing = CDP / PayAI / self / BSC-direct (`facilitatorFor()`). **No OKX facilitator.** | verify/settle at `https://web3.okx.com/api/v6/pay/x402/{verify,settle}` with HMAC auth. | Add an `OKXFacilitatorClient` route for `eip155:196` (adopt SDK, §3). |
| G7 | Payment header read = **`X-PAYMENT`** (x402 v1 name; `decodePaymentHeader`, `verifyPayment`) — despite the file labeling itself "v2". | Buyer sends **`PAYMENT-SIGNATURE`** (the x402 **v2** standard name). | On the X-Layer path read `PAYMENT-SIGNATURE` (case-insensitive; also accept `x-payment` for v1 back-compat). Keep `X-PAYMENT` for the other rails. |
| G8 | Success receipt = **`x-payment-response`** (x402 v1 name; set in `api/mcp-3d.js:107` etc.). | **`PAYMENT-RESPONSE`** (x402 v2 name). | Emit `PAYMENT-RESPONSE` on the X-Layer success reply. |
| G9 | ~~Gating is MCP-level only~~ **CORRECTED:** HTTP-level 402 + `PAYMENT-REQUIRED` already emitted to non-MCP clients ([api/_mcp/auth.js](../api/_mcp/auth.js) `send402` path; live-verified `HTTP/2 402` on bare `tools/call`, Appx H.1). MCP-protocol clients get 401/OAuth — fine, OKX tooling never sends `mcp-protocol-version`. | **HTTP-level 402** on the endpoint URL — already satisfied. | No new gate. Verify with `x402-check` after G1-G8 land; keep the 401/OAuth branch for MCP clients as-is. |
| G10 | Body carries `extensions.bazaar` + `builder-code` + `offer-receipt`. | OKX sellers emit none of these on the `eip155:196` accepts. | Keep the OKX accept body minimal (`x402Version/resource/accepts`); don't attach Bazaar extensions to it. |
| G11 | Facilitator auth = CDP JWT / bearer token. | OKX HMAC needs `OKX_API_KEY`/`OKX_SECRET_KEY`/`OKX_PASSPHRASE`. | Provision + wire the three env vars (owner blocker). |
| G12 | `maxTimeoutSeconds: 60`. | Approved sellers use `86400`/`300`. | Use ≥ ~300 on X-Layer (bounds `validBefore`); `86400` matches oklink. |

**Non-goals for 02** (explicitly out of scope): the WWW-Authenticate `charge`/`session` MPP rail (CoinAnk offers it, but `exact` alone passes approval) and `period`/subscription. `upto` is unnecessary and adds a Permit2 approve step. Ship `exact` (+ optional `aggr_deferred`) only.

---

## 5. Implementation (Work Order 02 — landed 2026-07-07)

The OKX/X Layer rail was implemented as an **addition** to the existing multi-rail
`x402-spec.js` seams — not a parallel payment stack. The `eip155:196` accept, the OKX
facilitator verify/settle route, and the x402-v2 receipt header names all flow through
the same `paymentRequirements()` / `verifyPayment()` / `settlePayment()` /
`encodePaymentResponseHeader()` functions every other rail uses, selected by the network
of the presented payment. Spec → code map (file:line at landing commit `05de055d6`):

| Spec / Gap | Requirement | Code |
|---|---|---|
| §1.1, G1–G5, G12 | The `eip155:196` accept, byte-shaped to the approved-seller wire (`scheme:exact`, USD₮0 asset, `extra.{name,version,symbol,transferMethod,decimals}`, `maxTimeoutSeconds:86400`) | [`okxXLayerAccept()`](../api/_lib/x402-xlayer-okx.js#L190-L210) — the domain constants `USDT0_DOMAIN_NAME='USD₮0'` (₮ = U+20AE) / `USDT0_DOMAIN_VERSION='1'` are [pinned + commented](../api/_lib/x402-xlayer-okx.js#L59-L65) against Appx H.3 |
| §1.1 | Advertise the accept only when settlement is actually possible (never 402-then-502) | [`xlayerSettleable()`](../api/_lib/x402-xlayer-okx.js#L179-L185); wired into [`paymentRequirements()`](../api/_lib/x402-spec.js#L239-L246) after the Solana/Base/BSC accepts (multi-rail coexistence, requirement 4) |
| §1.1 amount | Advertised == verified == settled, all from `priceBatch`/`studioX402Amount` (requirement 6) | The X Layer accept takes `common.amount` (the per-tool price) unchanged — USD₮0 shares USDC's 6-decimal atomic scale, so `150000` = $0.15 across every rail. [x402-spec.js#L245](../api/_lib/x402-spec.js#L245) |
| §1.2 step 3, G6 | Route verify/settle to the OKX rail by network | [`facilitatorFor()` → `{okxXLayer:true}`](../api/_lib/x402-spec.js#L287-L292) for `eip155:196` |
| §1.2 step 4, requirement 2 | Verify BEFORE work — real EIP-712 recovery (ERC-1271-aware for smart-account wallets), recipient/amount/time-window checks, unused-nonce + `balanceOf` on-chain, then the OKX facilitator `/verify` when credentialed | [`verifyOkxXLayerPayment()`](../api/_lib/x402-xlayer-okx.js#L272-L416); dispatched from [`verifyPayment()`](../api/_lib/x402-spec.js#L1014-L1022). Invalid/underpaid/expired throws `X402Error` 402 → fresh challenge, tool does not run |
| §1.2 step 6, §1.4, requirement 3 | Settle only after tool success; OKX facilitator `/settle` (`syncSettle:true`) primary, direct EIP-3009 redemption fallback; return `{success,status,transaction,payer,amount}` | [`settleOkxXLayerPayment()`](../api/_lib/x402-xlayer-okx.js#L442-L530); dispatched from [`settlePayment()`](../api/_lib/x402-spec.js#L1110-L1120). Called only after `anySuccess` in [mcp-3d.js](../api/mcp-3d.js#L103-L119) and [okx/3d/[service].js](../api/okx/3d/%5Bservice%5D.js#L377-L392) |
| §1.3, G7 | Read the buyer's `PAYMENT-SIGNATURE` (x402 v2) header; parse the OKX `{accepted, payload:{authorization,signature}}` dialect | [auth.js reads `payment-signature`](../api/_mcp/auth.js#L94-L97); [`selectRequirement()` matches `paymentPayload.accepted.network`](../api/_lib/x402-spec.js#L786-L792); [`extractAuthorization()`](../api/_lib/x402-xlayer-okx.js#L237-L249) |
| §1.4, G8 | Emit `PAYMENT-RESPONSE` (x402 v2) receipt with `status`+`amount`; keep `x-payment-response` (v1) as an alias | [`encodePaymentResponseHeader()`](../api/_lib/x402-spec.js#L1169-L1186) now passes through `status`/`amount`; both header names set in [mcp-3d.js#L108-L116](../api/mcp-3d.js#L108-L116) and [service].js; both added to the [CORS expose list](../api/_lib/http.js#L383-L386) |
| §Q4/§Q5, G6/G11 | OKX facilitator client (HMAC-SHA256 auth) | Adopt the official SDK [`OKXFacilitatorClient` from `@okxweb3/app-x402-core@^0.2.0`](../api/_lib/x402-xlayer-okx.js#L51) behind our seams (SDK decision §3) — no hand-rolled dialect |
| G9 | HTTP-level 402 gate | Already present (Appx H.1); unchanged. The `send402`/`sendAuthChallenge` non-MCP branch emits the challenge to bare `tools/call` |
| G10 | Keep the OKX accept minimal | The X Layer accept carries no per-accept Bazaar extension; `sendOkx402()` ([x402-xlayer-okx.js#L218-L232](../api/_lib/x402-xlayer-okx.js#L218-L232)) emits the minimal `{x402Version,resource,accepts}` for the decomposed `/api/okx/3d/*` services. (The `/api/mcp-3d` MCP endpoint keeps its Bazaar body for its non-OKX discovery role; the X Layer accept inside it is still minimal.) |

**Config / env (all through `api/_lib/env.js`, never hardcoded):**

| Var | Purpose | Set in Vercel? |
|---|---|---|
| `X402_PAY_TO_XLAYER` | Seller receiving address on X Layer (owner wallet `0x75d0…cf69`) | ✅ Preview + Production (owner set 2026-07-07) |
| `X402_ASSET_ADDRESS_XLAYER` | USD₮0 mint; defaults to `0x779ded…713736` in [env.js](../api/_lib/env.js#L752-L754) so it needs no explicit set | default |
| `X402_XLAYER_RELAYER_KEY` | Relayer key for the direct-redemption settle fallback (no OKX creds) | ✅ Preview + Production |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | OKX facilitator HMAC — enables the official `/verify`+`/settle` route | ❌ **owner action** (see PROGRESS) |

With `X402_PAY_TO_XLAYER` + `X402_XLAYER_RELAYER_KEY` set, `xlayerSettleable()` is true and the rail is advertised and settleable via direct redemption today. The OKX facilitator creds are the preferred settle route (gasless, first-party) and remain the one owner blocker for WO-04's funded run.

**Verification captured this session (local, real module over `node:http`):** unpaid `POST tools/call text_to_3d` → `HTTP/1.1 402` whose `accepts[1]` is the `eip155:196` USD₮0 entry with every §1.1 field byte-exact (`extra.name` bytes = `555344e282ae30`, confirmed). `onchainos payment pay --selected-index 1` ACCEPTED it and returned a `PAYMENT-SIGNATURE` header signing `value:"150000"` to our payTo on `eip155:196`. Replaying that header against our endpoint (wallet holds 0 USD₮0) ran the real on-chain verify and returned `402 error:"insufficient_balance"` with a fresh full challenge — the tool did not run. Field-validated captures in `prompts/okx-ai/e2e-evidence/`.

---

## Appendix — raw captures (verbatim, dated 2026-07-06)

### A. WIRE-OKLINK — Onchain Data Explorer #2023 (174 sales), `get_chain_info`

`GET` → `HTTP/2 405 {"code":"405","msg":"Method Not Allowed"}`. `POST {}` → `HTTP/2 402`:

```
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly93d3cub2tsaW5rLmNvbS9hcGkvdjUvZXhwbG9yZXIvbWNwL3g0MDIvZ2V0X2NoYWluX2luZm8iLCJtaW1lVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1OjE5NiIsImFtb3VudCI6IjE1IiwicGF5VG8iOiIweGE3ZTM3NjA0ZWJhYjk0NDA4MTU5ZTQwNTAzM2E0NTVmODIwZmQ5ODciLCJtYXhUaW1lb3V0U2Vjb25kcyI6ODY0MDAsImFzc2V0IjoiMHg3NzlkZWQwYzllMTAyMjIyNWY4ZTA2MzBiMzVhOWI1NGJlNzEzNzM2IiwiZXh0cmEiOnsic3ltYm9sIjoiVVNEVCIsInZlcnNpb24iOiIxIiwidHJhbnNmZXJNZXRob2QiOiJlaXAzMDA5IiwibmFtZSI6IlVTROKCrjAifX0seyJzY2hlbWUiOiJhZ2dyX2RlZmVycmVkIiwibmV0d29yayI6ImVpcDE1NToxOTYiLCJhbW91bnQiOiIxNSIsInBheVRvIjoiMHhhN2UzNzYwNGViYWI5NDQwODE1OWU0MDUwMzNhNDU1ZjgyMGZkOTg3IiwibWF4VGltZW91dFNlY29uZHMiOjg2NDAwLCJhc3NldCI6IjB4Nzc5ZGVkMGM5ZTEwMjIyMjVmOGUwNjMwYjM1YTliNTRiZTcxMzczNiIsImV4dHJhIjp7InN5bWJvbCI6IlVTRFQiLCJ2ZXJzaW9uIjoiMSIsInRyYW5zZmVyTWV0aG9kIjoiZWlwMzAwOSIsIm5hbWUiOiJVU0Tigq4wIn19XX0=
access-control-expose-headers: PAYMENT-REQUIRED
```

Decoded body:

```json
{"x402Version":2,"resource":{"url":"https://www.oklink.com/api/v5/explorer/mcp/x402/get_chain_info","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"eip155:196","amount":"15","payTo":"0xa7e37604ebab94408159e405033a455f820fd987","maxTimeoutSeconds":86400,"asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","extra":{"symbol":"USDT","version":"1","transferMethod":"eip3009","name":"USD₮0"}},{"scheme":"aggr_deferred","network":"eip155:196","amount":"15","payTo":"0xa7e37604ebab94408159e405033a455f820fd987","maxTimeoutSeconds":86400,"asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","extra":{"symbol":"USDT","version":"1","transferMethod":"eip3009","name":"USD₮0"}}]}
```

### B. WIRE-COINANK — CoinAnk OpenAPI #2013 (818 sales), `getUsBtcEtf`

`GET` → `HTTP/2 402`. Emits BOTH `payment-required` (v2, 4 accepts) AND four `WWW-Authenticate: Payment` headers (MPP charge+session). The seller offers each scheme in TWO currencies: the USD₮0 fee token AND a second X-Layer stablecoin. Only the **USD₮0** accepts matter for our contract; the second currency's mint/name are omitted here (not load-bearing, out of our USD₮0-only scope). USD₮0 accepts, decoded verbatim:

```json
{"x402Version":2,"accepts":[
 { "…second-stablecoin exact accept — identifiers omitted…" },
 {"x402Version":2,"scheme":"exact","network":"eip155:196","amount":"1000","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","payTo":"0xb1257e75791baa36646113d8b1fdfc83b3e2d0b7","maxTimeoutSeconds":300,"extra":{"name":"USD₮0","version":"1"}},
 { "…second-stablecoin aggr_deferred accept — identifiers omitted…" },
 {"x402Version":2,"scheme":"aggr_deferred","network":"eip155:196","amount":"1000","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","payTo":"0xb1257e75791baa36646113d8b1fdfc83b3e2d0b7","maxTimeoutSeconds":300,"extra":{"name":"USD₮0","version":"1"}}],
 "resource":{"url":"https://open-api.coinank.com/api/etf/getUsBtcEtf"}}
```

Structural takeaways (same across both currencies): each accept nests its own `x402Version:2`; `extra` is `{name, version}` only (no `symbol`/`transferMethod`/`decimals`); `resource` is `{url}` with no `mimeType`.

`WWW-Authenticate` charge `request` (USD₮0) decoded: `{"amount":"1000","currency":"0x779ded…713736","recipient":"0xb1257e…d0b7","methodDetails":{"chainId":196,"feePayer":true}}`.
Session `request` decoded: adds `"escrowContract":"0x5E550002e64FaF79B41D89fE8439eEb1be66CE3b","minVoucherDelta":"10000"` and `"suggestedDeposit":"100000"`. (MPP rail — out of scope for 02.)

### C. WIRE-OKB — OKB Monitoring #3837, `/x402/digest`

Both `GET` and `POST` → `HTTP/2 402`, body (note **`x402Version:1`**, `maxAmountRequired`, per-accept `decimals`/`description`):

```json
{"x402Version":1,"accepts":[{"scheme":"exact","network":"eip155:196","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","decimals":6,"maxAmountRequired":"10000","payTo":"0x0921f7fcbc93984c2a4d29b4079f97840184365b","resource":"https://okb.swaper.money/x402/digest","description":"OKB X Layer monitor — OKB X Layer daily anomaly digest (alerts + metrics + report)","mimeType":"application/json","maxTimeoutSeconds":300,"extra":{"name":"USD₮0","version":"1"}}]}
```

### D. PAY-LEG1/2 — real payment from our wallet `0x75d0…cf69`

**Leg 1** — `onchainos payment pay --payload <oklink 402> --selected-index 0` →
`{ok:true, data:{ header_name:"PAYMENT-SIGNATURE", scheme:"exact", wallet:"0x75d00a2713565171f33216e5aa2a375e076ecf69", authorization_header:"<base64>" }}`. Decoded payload in §1.3 (EIP-3009 `transferWithAuthorization`, value "15", from our wallet, to oklink's payTo, signed).

**Leg 2** — replay `POST get_chain_info` with `PAYMENT-SIGNATURE: <header>` → `HTTP/2 402`, body:

```json
{"x402Version":2,"error":"insufficient_balance","resource":{"url":"https://www.oklink.com/api/v5/explorer/mcp/x402/get_chain_info","mimeType":"application/json"},"accepts":[ …same two accepts as Appx A… ]}
```

**Interpretation:** signing succeeded (leg 1 real), and the seller's facilitator did an on-chain balance check and rejected because our X-Layer wallet holds **0 USD₮0** — proving (a) the seller→facilitator verify path is live, (b) rejection re-emits the full 402 with a top-level `error`. **Funding blocker (DoD):** to capture a fully-successful paid leg the owner must fund `0x75d00a2713565171f33216e5aa2a375e076ecf69` on **X Layer (chainId 196)** with **USD₮0** (`0x779ded…713736`). Minimum to pay oklink `get_chain_info` = **15 atomic (0.000015 USD₮0)**; recommend **~1.0 USD₮0 (1,000,000 atomic)** for buffer across test calls + the pfp-wedge work. `exact`+EIP-3009 is gasless for the payer (facilitator broadcasts, `feePayer:true`), so no OKB gas is strictly required; a small OKB dust (~0.5 OKB) is optional insurance for any self-broadcast path. `onchainos portfolio all-balances --chain xlayer --chains 196 --address 0x75d0…cf69` currently returns `data:[]`.

### E. CLI validator + token info

```
$ onchainos agent x402-check --endpoint https://x402.dappos.com/healthz
{"ok":true,"data":{"reason":"Endpoint returned HTTP 200 (not 402); not a valid x402 service.","statusCode":200,"valid":false}}

$ onchainos token info --chain xlayer --address 0x779ded0c9e1022225f8e0630b35a9b54be713736
{"chainIndex":"196","decimal":"6","tokenName":"USD₮0","tokenSymbol":"USDT","tagList":{"communityRecognized":true},
 "tokenContractAddress":"0x779ded0c9e1022225f8e0630b35a9b54be713736"}
```

### F. `onchainos agent service-list` — how a service is registered (shape)

Each A2MCP service row (from Onchain Data Explorer #2023): `{ serviceType:"A2MCP", serviceName, endpoint:"https://…", fee:"0.000015", contractAddress:"0x779ded…713736", chainIndex:196 }`. The registered `endpoint` + `fee` + fee-token `contractAddress` + `chainIndex` are what the buyer/validator matches the live 402 against.

### G. OKX Payments SDK — seller wiring (SDK-REPO `demo/x402/src/index.ts`, trimmed)

```ts
import { OKXFacilitatorClient } from "@okxweb3/app-x402-core";
import { x402ResourceServer } from "@okxweb3/app-x402-express";
import { ExactEvmScheme } from "@okxweb3/app-x402-evm/exact/server";

const facilitator = new OKXFacilitatorClient({
  apiKey: process.env.OKX_API_KEY!, secretKey: process.env.OKX_SECRET_KEY!,
  passphrase: process.env.OKX_PASSPHRASE!, baseUrl: "https://web3.okx.com",
});
const server = new x402ResourceServer(facilitator).register("eip155:196", new ExactEvmScheme());
const routes = { "POST /api/mcp-3d": {
  accepts: { scheme: "exact", network: "eip155:196",
             payTo: "0x75d00a2713565171f33216e5aa2a375e076ecf69", price: "$0.000015" },
  mimeType: "application/json" } };
// USD price → USD₮0 atomic auto-converted via DEFAULT_STABLECOINS["eip155:196"] (6 dp).
```

### H. Verification-pass captures (second WO-01 session, 2026-07-06 — independent evidence)

#### H.1 Our endpoint's live HTTP-level gate (disproves original G9)

Status matrix, live against production `https://three.ws/api/mcp-3d`:

```
POST tools/call text_to_3d      (bare curl, no MCP headers)  → HTTP/2 402
POST tools/call auto_rig_model  (bare curl, no MCP headers)  → HTTP/2 402
POST tools/call text_to_3d  + header mcp-protocol-version: 2025-06-18 → HTTP/2 401 (OAuth branch)
```

The 402 carries `payment-required: <base64>` (decoded: v2 challenge, `resource` object with
url/description/mimeType/serviceName/tags/iconUrl, Solana USDC `amount "1000"` + Solana
THREE `amount "10000000"` accepts, `bazaar` extension) and
`access-control-allow-headers` ALREADY includes `payment-signature`;
`access-control-expose-headers: PAYMENT-REQUIRED, x-payment-response, …` (needs
`PAYMENT-RESPONSE` added — G8).

#### H.2 `x402-check` against our endpoint and oklink

Ours: `{"valid": true, "x402Version": 2, "scheme": "exact", "network":
"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "asset": "EPjFWdd5…TDt1v", "amountMinimal":
"1000", "amountHuman": 0.001, "decimals": 6, "tokenSymbol": "UNKNOWN", …}` — parses clean;
**no `eip155:196` entry to select** (the rejection, isolated).

oklink (`--body '{"chainIndex":"196"}'`): `"valid": true` plus
`"tokenResolveError": "cannot determine token decimals: token-info lookup failed (asset
0x779ded0c…3736 is not in the task system's supported token list (checked: USDT, USDG)) and
the accepts entry does not provide a 'decimals' field"` — non-fatal; basis for the G3
`extra.decimals` recommendation.

#### H.3 Fee-token on-chain reads (X Layer RPC `https://rpc.xlayer.tech`)

```
name()     → "USD₮0"  (returned bytes 555344e282ae30 = "USD" + U+20AE + "0")
symbol()   → "USD₮0"
decimals() → 6
DOMAIN_SEPARATOR()                        → 0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d
authorizationState(0x75d0…cf69, 0x00…00)  → 0x00…00  (function exists → EIP-3009 implemented)
eip712Domain()                            → empty (no ERC-5267; domain params come from the recomputation below)
```

Recomputation (ethers v6): `keccak256(abiEncode(keccak256("EIP712Domain(string name,string
version,uint256 chainId,address verifyingContract)"), keccak256("USD₮0"), keccak256("1"),
196, 0x779ded0c9e1022225f8e0630b35a9b54be713736))` =
`0xd591d9ba…599d` — **byte-exact match** with the on-chain `DOMAIN_SEPARATOR()`.
`extra.name = "USD₮0"` / `extra.version = "1"` are therefore cryptographically proven.
A mis-transcribed ₮ (U+20AE) produces invalid signatures — copy the string from this spec.

#### H.4 WIRE-PREDEXON — Predexon #2143 (approved, enforcing, `exact`-only)

`curl -si "https://a2mcp.predexon.com/v1/markets/search?query=btc"` → `HTTP/2 402`, body
`{"error":"payment_required","service":"Predexon Market Search","price":"0.01 USDT0",…}`,
decoded `payment-required`:

```json
{"x402Version":2,"error":"Payment required","resource":{"url":"https://a2mcp.predexon.com/v1/markets/search?query=btc","description":"Search prediction markets across supported venues.","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"eip155:196","amount":"10000","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","payTo":"0xb5c8bbeb50b913ab99e3ff74987405c1de4ea736","maxTimeoutSeconds":300,"extra":{"name":"USD₮0","version":"1"}}]}
```

$0.01 → `"10000"` re-confirms 6-decimal scaling on a third price point. Note
`resource.url` includes the query string of the probed request.

#### H.5 Facilitator auth requirement (live) + second signed leg

`curl -si https://web3.okx.com/api/v6/pay/x402/supported` (no auth) → `HTTP/2 401`
`{"msg":"Request header OK-ACCESS-KEY can not be empty.","code":"50103"}` — HMAC credentials
are required in practice, not just per SDK source.

A second independent `payment pay` + unfunded replay against oklink reproduced PAY-LEG1/2
exactly (`header_name: "PAYMENT-SIGNATURE"`, fresh nonce, `validBefore` = now + 86400;
replay → 402 `"error":"insufficient_balance"` with full fresh challenge). The flow is
deterministic, not a one-off.

#### H.6 XBubbleAI #2087 — cautionary non-example

Both `https://x402.dappos.com/healthz` AND the priced
`/okx/a2mcp/bubble-image` answer `HTTP/2 200` to unpaid requests (the latter generated and
returned a real image URL, unpaid). Approved but non-enforcing, 0 sales — approval evidently
predates or ignores runtime enforcement; do NOT copy its behavior, and it explains why
`x402-check` against its healthz returns `valid:false` (Appx E).
