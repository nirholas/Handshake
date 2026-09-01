# Claim a *.threews.sol name and get paid by name

By the end of this tutorial you'll own a real Solana Name Service name — `yourname.threews.sol` — that resolves to your three.ws showcase in Brave, and you'll know exactly how another agent or person sends you USDC using that name instead of a 44-character wallet address.

Along the way you'll understand what the subdomain points at on-chain, why the mint is gasless for you, and how the pay-by-name endpoint turns a human-readable name into a signed USDC transfer.

**Prerequisites:** a signed-in three.ws account with a **username set** (the subdomain label must match it) and at least one agent — creating an agent provisions the Solana wallet that receives the name ([create one](/create)). Light JavaScript familiarity for the pay-by-name section; the claim itself is no-code.

---

## What you're building

```
You (once):   claim "nich" at /threews/claim
        ↓     [threews.sol subdomain minted, URL record set, ownership transferred to your wallet]
Anyone, later:  pays  nich.threews.sol  →  USDC lands in your wallet
Brave user:     types nich.threews.sol  →  lands on https://three.ws/u/nich
```

A wallet address is unspeakable, unmemorable, and easy to fat-finger. `nich.threews.sol` is a name a person can read aloud, an agent can resolve in one request, and a browser can navigate to. One claim gives you all three: a resolvable name, a showcase page, and a pay-by-name handle.

---

## How it works (two minutes of theory)

three.ws owns the parent domain `threews.sol`. When you claim a label, the platform mints `<label>.threews.sol` as a **subdomain** under that parent and hands it to you. Three on-chain actions happen inside **one** transaction (so the subdomain is never claimable by a third party in between):

1. **createSubdomain** — the parent owner mints the new registry and is, momentarily, its owner.
2. **createRecordV2Instruction(URL → `https://three.ws/u/<label>`)** — a `URL` record is written while the platform still owns the subdomain. This record is what makes the name resolve in Brave and any SNS-aware client.
3. **transferSubdomain** — ownership (and the attached records) is transferred to your wallet.

The platform keypair is the only signer and fee payer, so **you pay no SOL gas and never sign a wallet transaction** to claim. After the transfer, the name is yours — the platform doesn't retain custody, it just set the URL record on the way out.

What the name resolves *to* depends on the flow:

| Flow | Endpoint | URL record points at |
|---|---|---|
| **User claim** (this tutorial) | [POST /api/threews/subdomain](/api/threews/subdomain) | `https://three.ws/u/<label>` — your showcase |
| **Agent attach** | [POST /api/sns-subdomain](/api/sns-subdomain) | `https://three.ws/a/<agent_id>` — the agent page |

For payments, three.ws resolves any of three name forms to a recipient wallet, in this order: a raw base58 address (pass-through), a `.sol` domain or subdomain (resolved on-chain via Bonfida `resolve()`), or a bare `@username` (looked up to the user's default agent wallet). That's what makes `nich.threews.sol`, `@nich`, and the raw address all valid payment targets.

Two hard rules to know before you start:

- **The label must equal your account username.** `<label>.threews.sol` showcases `/u/<label>`, so allowing divergent labels would let anyone mint a name impersonating another handle. Set your username first if you haven't.
- **Some labels are reserved.** Platform paths and impersonation-risk words (`admin`, `api`, `pay`, `threews`, `wallet`, `official`, and similar) are denied. The availability check tells you immediately.

---

## Step 1: Set your username

The mint endpoint rejects any label that doesn't match `users.username` (HTTP `409 username_mismatch`), so this is the gate.

1. Open your account settings and set a username if you don't have one — it must be lowercase `[a-z0-9-]`, 1–63 characters, and not a reserved word.
2. That username **is** your subdomain label. If your username is `nich`, you can only claim `nich.threews.sol`.

If you skip this, the mint fails with `409 no_username` ("set a username on your account before claiming a subdomain").

---

## Step 2: Open the claim page

Go to **[/threews/claim](/threews/claim)**.

You'll see a single input with a fixed `.threews.sol` suffix and a disabled **Mint subdomain** button. The button stays disabled until the availability check confirms the label is free.

Type your username into the label field. As you type, the page:

- Lowercases the input and strips anything outside `[a-z0-9-]` in real time.
- Debounces for 350ms, then calls `GET /api/threews/subdomain?label=<label>` to check availability.

---

## Step 3: Read the availability result

The check returns a small envelope describing the label's status:

```jsonc
{
  "data": {
    "full": "nich.threews.sol",
    "label": "nich",
    "parent": "threews",
    "available": true,
    "owner": null,
    "on_chain_check": "ok",
    "on_chain_error": null,
    "claim": null,
    "showcase_url": null
  }
}
```

Interpreting it:

- **`available: true`** — nobody has claimed it through three.ws and no on-chain owner was found. The Mint button enables and the status reads `nich.threews.sol is available.`
- **`available: false` with `claim`** — already claimed through three.ws; the status shows `claimed by @<username>`.
- **`available: false` with only `owner`** — registered on-chain to a wallet outside our records; the status shows `owned by <wallet>`.
- **`on_chain_check: "unavailable"`** — a Solana RPC hiccup meant the on-chain side couldn't be verified. The endpoint still answers `200` (it won't `500` the UI) and the response is sent `no-store` so you can retry. If you see this, wait a moment and re-type the last character to re-check.

The availability check is **public and rate-limited** — it needs no auth, so you can verify a label before committing.

---

## Step 4: Mint the subdomain

With an available label, click **Mint subdomain**. The page now does the authenticated write:

1. Fetches a CSRF token from `/api/csrf-token` (your session must be signed in).
2. `POST /api/threews/subdomain` with `{ "label": "nich" }`, sending the `x-csrf-token` header and same-origin credentials.

```jsonc
// POST /api/threews/subdomain
// headers: { "content-type": "application/json", "x-csrf-token": "<token>" }
// credentials: same-origin
{ "label": "nich" }
```

The server then, in order:

1. Confirms minting is configured (the platform parent key is present) — otherwise `503 config_missing`.
2. Loads your user, confirms you have a username, and confirms it **matches the label** — otherwise `409`.
3. Confirms nobody has claimed it through three.ws and nobody owns it on-chain, otherwise `409 conflict`. Unlike the availability check, this on-chain lookup is a hard gate: if Solana RPC cannot answer, the mint stops with a retryable `503 upstream_unavailable` instead of attempting a transaction that would burn rent and fail.
4. Picks the **recipient wallet**: if you pass `owner_wallet` it must be a Solana wallet **linked to your account** (else `403 forbidden`); otherwise it falls back to your **default agent's Solana wallet** (the oldest agent you own). No agent and no linked wallet → `409 no_wallet`.
5. Runs the atomic mint + URL-record + transfer transaction and records the claim in `user_subdomains`.

On success you get a `201` with the receipt:

```jsonc
{
  "data": {
    "id": "…",
    "label": "nich",
    "parent": "threews",
    "owner_wallet": "<your Solana wallet>",
    "url_record": "https://three.ws/u/nich",
    "signature": "<tx signature>",
    "full": "nich.threews.sol",
    "showcase_url": "https://three.ws/u/nich",
    "explorer": "https://solscan.io/tx/<signature>"
  }
}
```

The page renders a green result card with your name, the showcase link, and a Solscan link to the on-chain transaction. The subdomain is yours and already owned by your wallet — the whole thing typically lands in a few seconds.

### Claiming to a specific wallet

To receive the name in a wallet other than your default agent's, link that Solana wallet to your account first, then include it in the POST body:

```jsonc
{ "label": "nich", "owner_wallet": "<your linked base58 wallet>" }
```

If the wallet isn't linked, the mint refuses with `403` — three.ws will not mint a subdomain into a third-party wallet.

---

## Step 5: Verify the name resolves

Two ways to confirm the claim is live.

**Forward resolution (any client):**

```js
const r = await fetch('/api/sns?name=nich.threews.sol');
const { data } = await r.json();
// { name: "nich.threews.sol", address: "<wallet>", network: "solana", resolved: true }
```

`/api/sns` is the public resolver. A miss returns `resolved: false` with `address: null` (a `200`, not a `404`) — so if you see `resolved: false` right after minting, give the RPC cache its short TTL and retry.

Add `&domains=1` to either direction (`?name=` or `?address=`) to also get the owner's full `.sol` holdings: the envelope gains `all_domains`, `favorite_domain`, and `domains_truncated`. It is opt-in because it costs two extra calls to the Bonfida index, and it is best-effort, so an index outage returns the plain envelope rather than an error.

**In Brave:** type `nich.threews.sol` into the URL bar. Because the `URL` record was written at mint time, Brave's SNS resolver redirects you straight to `https://three.ws/u/nich` — your showcase, rendering your public agents, avatars, paid skills, and socials. No extension, no plugin.

---

## Step 6: Resolve the name for a payment

Now the payoff: getting paid by name. Anyone — a human or an agent — can resolve your name to a wallet with a single public GET:

```js
const r = await fetch('/api/x402/pay-by-name?name=nich.threews.sol');
const { data } = await r.json();
// {
//   address: "<your wallet base58>",
//   source: "sns",
//   resolved: "nich.threews.sol",
//   claim: { user_id, username: "nich", display_name }   // present for *.threews.sol
// }
```

The resolver accepts all three name forms, tried in order:

1. A **raw base58 address** → returned as-is (`source: "address"`).
2. A **`.sol` domain or subdomain** like `nich.threews.sol` → resolved on-chain via Bonfida `resolve()` (`source: "sns"`). For `*.threews.sol` names it also attaches the matching three.ws `claim` so the caller can show your showcase link.
3. A bare **`@username`** (3–30 chars) → mapped to that user's default agent Solana wallet (`source: "username"`).

A name that resolves to nothing returns `404 not_found`. This GET is the safe, side-effect-free way to preview *exactly which wallet* a name points at before sending anything.

---

## Step 7: Have someone pay you by name

There are two payment modes on `POST /api/x402/pay-by-name`. Payments are denominated in **USDC** (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals), capped at **10,000 USDC per call**.

### Mode `prep` — browser wallet signs (no auth)

The payer passes their own wallet as `payer_wallet`; the server builds an **unsigned** USDC SPL transfer and returns it base64-encoded for the payer's wallet to sign and broadcast. The transfer includes an idempotent "create associated token account" instruction so it works even if your USDC token account doesn't exist yet.

```js
const r = await fetch('/api/x402/pay-by-name', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'nich.threews.sol',
    amount_usdc: 5,
    payer_wallet: '<payer base58 wallet>',
    // mode defaults to "prep"
  }),
});
const { data } = await r.json();
// {
//   recipient: { address, source: "sns", resolved: "nich.threews.sol", claim },
//   amount_usdc: 5,
//   tx_base64: "<unsigned VersionedTransaction>",
//   blockhash, last_valid_block_height,
//   mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
// }
```

The payer deserializes `tx_base64`, signs with their wallet, and submits it to Solana. No three.ws account needed on the payer's side.

### Mode `send` — an agent pays on the caller's behalf (auth required)

If the payer is a three.ws user paying from one of **their own agents**, `mode: "send"` has the server sign as that agent and broadcast the transfer, returning the signature directly. This requires a signed-in session (or bearer token) and an `agent_id` the caller owns.

```js
const r = await fetch('/api/x402/pay-by-name', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    name: 'nich.threews.sol',
    amount_usdc: 5,
    mode: 'send',
    agent_id: '<your agent uuid>',
    expected_address: '<address you previewed in Step 6>', // recommended
  }),
});
const { data } = await r.json();
// { recipient, payer, amount_usdc: 5, signature: "<tx>", mode: "send" }
```

Two guardrails worth knowing on the send path:

- **`expected_address`** — pass the address you previewed, and the server requires the fresh resolution to still match it before signing. A name can repoint between preview and send (or a lookalike name can resolve to an attacker wallet); this binds the recipient you approved into the signed request. A mismatch returns `409 recipient_changed`.
- **Per-transaction limit** — the agent's configured per-tx USD ceiling applies. A send over the limit returns `403 per_tx_exceeded`. The amount must also be `> 0`, and off-curve targets (PDAs/program addresses) are rejected as invalid recipients.

Either way, the USDC lands in the wallet your `nich.threews.sol` points at — the one the subdomain was transferred to in Step 4.

---

## What you get from one claim

- `nich.threews.sol` **resolves in Brave** to your showcase at `/u/nich` — no extension.
- A **pay-by-name handle** — anyone can `POST /api/x402/pay-by-name` with `nich.threews.sol` to send you USDC, or preview the target wallet with the matching GET.
- **On-chain ownership** in your wallet — three.ws set the URL record and transferred custody; it doesn't hold the name.
- A **verified profile** at [/u/nich](/u/nich).

---

## Troubleshooting

- **`409 no_username` / `409 username_mismatch`** — the label must equal your account username. Set or correct your username, then claim that exact string.
- **Mint button never enables** — availability returned `available: false` (claimed or on-chain owned) or `on_chain_check: "unavailable"` (RPC hiccup). For the latter, retry in a moment; the response is `no-store` precisely so you can.
- **`409 conflict` on mint** — someone claimed or registered the label between your availability check and your click. Pick another label (which must still match your username — in practice this means the name is genuinely taken).
- **`409 no_wallet`** — you passed no `owner_wallet` and have no agent. Create an agent (it provisions a Solana wallet) or link a Solana wallet and pass it as `owner_wallet`.
- **`403 forbidden` on mint** — the `owner_wallet` you passed isn't linked to your account. Link it first; three.ws won't mint into an unlinked wallet.
- **`503 config_missing`** — subdomain minting isn't configured on this deployment (the platform parent key is absent). This is an environment issue, not a request error.
- **`503 upstream_unavailable` on mint**: the pre-mint on-chain ownership check could not reach Solana RPC. Nothing was minted; retry in a moment.
- **`401 unauthorized`** — minting and `mode=send` need a signed-in session or bearer token. The availability check and `mode=prep` preview do not.
- **`/api/sns` says `resolved: false` right after minting** — resolution is cached briefly; the negative cache TTL is short. Wait a few seconds and re-resolve.
- **Pay-by-name `404 not_found`** — the name doesn't resolve. Confirm the exact spelling (`<label>.threews.sol`), or use the GET resolver to see what it points at.
- **`409 recipient_changed` on `mode=send`** — the name now resolves to a different address than the `expected_address` you sent. Re-run the GET preview and confirm the new target before sending.
- **`403 per_tx_exceeded`** — the send exceeds the paying agent's per-transaction USD limit. Lower the amount or raise the agent's limit.

---

## Recap

You claimed a real Solana name and wired it to payments:

- **Claim** ([/threews/claim](/threews/claim)) — type your username, the page checks `GET /api/threews/subdomain?label=…`, and `POST /api/threews/subdomain` mints `<label>.threews.sol` gaslessly, sets its URL record to `/u/<label>`, and transfers ownership to your wallet — all in one transaction.
- **Resolve** — `GET /api/sns?name=<name>.threews.sol` (forward), and the name lands in Brave on your showcase via the URL record.
- **Get paid by name** — `GET /api/x402/pay-by-name?name=…` previews the recipient wallet; `POST` with `mode=prep` returns an unsigned USDC transfer for a browser wallet, or `mode=send` (auth + `agent_id`) has an agent sign and broadcast it, guarded by `expected_address` and a per-tx limit.

One name, three jobs: a browser destination, a verifiable identity, and a USDC pay-by-name handle. For the full SNS surface — agent-attached subdomains, attaching an existing `.sol` you already own, and reverse lookups — see [POST /api/sns-subdomain](/api/sns-subdomain) and the [resolver at /api/sns](/api/sns).

See also:

- [Build a custom skill](/docs/tutorials/custom-skill) — give your named agent new capabilities.
- [Create & edit agent memory](/docs/tutorials/create-and-edit-memory) — make your agent remember to quote in USDC.
