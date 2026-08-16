<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/names</h1>

<p align="center"><strong>ENS + SNS resolution, <code>*.threews.sol</code> subdomain minting, and pay-by-name, agent identity in one import.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/names"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/names?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/names"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/names?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/names?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/names?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/names` is the official client for the three.ws **naming layer** -
> the identity plumbing behind every agent on the platform. It resolves
> human-readable names to on-chain addresses across **ENS** (Ethereum) and
> **SNS** (Solana), mints `<label>.threews.sol` subdomains under the
> platform-owned parent, and routes USDC payments to a recipient identified by
> *name* instead of a 44-character base58 key. It wraps the public
> `/api/sns`, `/api/sns-subdomain`, `/api/threews/subdomain`, and
> `/api/x402/pay-by-name` endpoints. If your agent has a wallet, this gives it a
> name people can read, type, and pay.

## Why

A wallet address is unusable as an identity. Nobody types
`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump` from memory, and nobody should
have to. The naming layer turns identity into a string:

- **Resolve in one call.** `resolve('vitalik.eth')` and `resolve('bonfida.sol')`
  hit the right registry automatically: ENS via an Ethereum RPC with failover,
  SNS via Bonfida: and a bare label is tried against both.
- **Mint a name your agent owns.** `mintSubdomain('alice')` registers
  `alice.threews.sol` on-chain, writes a Brave-resolvable URL record, and
  transfers ownership to the agent's wallet: all in one signed transaction.
  The platform absorbs the gas; the agent's wallet never signs.
- **Pay by name.** `payByName('alice.threews.sol', '5')` resolves the recipient
  and builds (or sends) a USDC transfer: handles, `.sol` domains, and raw
  addresses all route through the same call, with a recipient-poisoning guard.

Hand-rolling this means three different on-chain SDKs (Bonfida SNS, ethers, SPL
token), RPC failover, label validation, an availability denylist, and a
preview-then-send flow that survives a name being re-pointed mid-flight. This
package is that, done once.

This is the SDK twin of the [`ens_sns_resolve` MCP tool](https://three.ws/mcp) -
the same resolution engine, exposed as plain functions instead of an MCP tool.

## Install

```bash
npm install @three-ws/names
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`).
Minting and `mode: 'send'` payments require a signed-in three.ws session or a
bearer token. The browser `prep` lane needs no auth, it returns an unsigned
transaction for a wallet to sign.

## Quick start

Resolution needs no key:

```js
import { resolve } from '@three-ws/names';

const eth = await resolve('vitalik.eth');
console.log(eth.address); // → 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045

const sol = await resolve('bonfida.sol');
console.log(sol.address);  // → owner base58 wallet

// Opt in to the owner's full name list (two extra SNS-index lookups server-side):
const full = await resolve('bonfida.sol', { domains: true });
console.log(full.favoriteDomain); // → the owner's primary .sol, if they set one
console.log(full.allDomains);     // → every .sol they hold (capped at 100)
```

Mint a subdomain for an agent and pay it by name:

```js
import { mintSubdomain, payByName } from '@three-ws/names';

// Registers alice.threews.sol on-chain, transfers it to the agent's wallet.
const { fullName, signature } = await mintSubdomain({
  agentId: 'agt_7Yq…',
  label: 'alice',           // optional: defaults to the agent's slugified name
  token: process.env.THREEWS_TOKEN,
});
console.log(fullName); // → alice.threews.sol

// Build an unsigned 5-USDC transfer to that name for a browser wallet to sign.
const { txBase64, recipient } = await payByName('alice.threews.sol', '5', {
  payerWallet: myWallet.publicKey.toBase58(),
});
console.log(recipient.address, recipient.source); // resolved wallet + 'sns'
```

## API

### `resolve(name, options?) → Promise<ResolveResult>`

Resolve a name to an address. `.eth` goes to ENS, `.sol` to SNS, and a bare
label (`vitalik`) is tried against the `.sol` registry. Wraps
`GET /api/sns?name=<name>` for `.sol` and the ENS resolver for `.eth`.

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `domains` | `boolean` | `false` | (SNS) also return every `.sol` the owner holds and their favorite domain. Off by default: it adds two SNS-index lookups the address resolution itself does not need. |
| `signal` | `AbortSignal` | - | Cancel the request. |

**Returns** `ResolveResult`

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | The resolved name, e.g. `alice.sol` or `vitalik.eth`. |
| `address` | `string \| null` | Owner wallet. `null` when `resolved` is `false`. |
| `network` | `'solana' \| 'ethereum'` | Which registry answered. |
| `resolved` | `boolean` | `false` is a routine "no such name", **not** an error. |
| `allDomains` | `string[]` | (SNS) every `.sol` the owner holds, capped at 100. Empty unless you passed `domains: true`. |
| `favoriteDomain` | `string \| null` | (SNS) the owner's primary `.sol`. Null unless you passed `domains: true`. |
| `domainsTruncated` | `boolean` | `true` when the owner holds more than the 100 names returned. |
| `raw` | `unknown` | The untouched wire envelope. |

A `.sol` miss returns `200` with `resolved: false`, the reverse-lookup that
runs on every page load makes "no domain" an expected answer, so it is never a
`404`. Malformed input is a `400`.

### `reverseLookup(address) → Promise<ResolveResult>`

Find the primary `.sol` for a wallet. Wraps `GET /api/sns?address=<base58>`.
Returns the same envelope with `name` populated (or `null` if the wallet has no
favorite domain). Takes the same `domains` option, which is the difference
between "unnamed wallet" and "wallet holding domains but no primary": a wallet
with no favorite still answers `resolved: false`, now with its `allDomains`
list alongside.

### `checkSubdomain(label) → Promise<Availability>`

Check whether `<label>.threews.sol` is free. Wraps
`GET /api/sns-subdomain?label=<label>` (no auth).

| Field | Type | Notes |
|---|---|---|
| `label` | `string` | Normalized label. |
| `parent` | `string` | `threews.sol`. |
| `fullName` | `string` | `<label>.threews.sol`. |
| `available` | `boolean` | `true` if no on-chain owner. |
| `owner` | `string \| null` | Current on-chain owner, if any. |

### `mintSubdomain(input) → Promise<MintResult>`

Mint `<label>.threews.sol`, write its Brave URL record, and transfer ownership
to a wallet: atomically, in one platform-signed transaction. Wraps
`POST /api/sns-subdomain`. Requires auth.

**Input**

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | **Required.** The agent the subdomain attaches to. |
| `label` | `string` | Optional. Defaults to the agent's slugified name. 1-63 chars `[a-z0-9-]`. |
| `ownerAddress` | `string` | Optional base58 wallet to receive ownership. Must be **linked to your account**. Defaults to the agent's own Solana wallet. |
| `space` | `number` | Optional, 1000-10000. Registry bytes reserved. Default `2000`. |
| `token` | `string` | Bearer token (or rely on a session cookie). |

**Returns** `MintResult`: `{ ok, agentId, fullName, parent, owner, signature, explorer, urlRecord, agentUrl }` (the untouched wire body stays on `raw`). The new subdomain's URL record points at
`https://three.ws/a/<agentId>`, and the agent's `meta.sns_domain` is set so x402
manifests can show `recipient_name` without an extra round-trip.

> For a **user/username-claim** subdomain (showcased at `/u/<label>`, where the
> label must equal your username), use `claimSubdomain` instead.

### `claimSubdomain(input) → Promise<ClaimResult>`

Claim `<username>.threews.sol` for the signed-in user, with its URL record set
to `https://three.ws/u/<username>`. Wraps `POST /api/threews/subdomain`. The
`label` **must equal your account username**: divergent labels would let users
impersonate other handles. Pass `ownerWallet` (linked to your account) or fall
back to your default agent's Solana wallet. `releaseSubdomain(label)` wraps the
`DELETE` route to drop the local claim (on-chain ownership is unchanged).

### `payByName(name, amountUsdc, options?) → Promise<PayResult>`

Pay a recipient by name in USDC. Wraps `POST /api/x402/pay-by-name`. The name
resolves across three namespaces in order: **@username** → that user's default
agent wallet; **`.sol` domain** (including `foo.threews.sol`) → on-chain owner;
**raw base58** → pass-through.

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `mode` | `'prep' \| 'send'` | `'prep'` | `prep` returns an unsigned tx; `send` has the agent sign and broadcast. |
| `payerWallet` | `string` | - | **Required for `prep`.** Base58 fee-payer + source. |
| `agentId` | `string` | - | **Required for `send`.** The agent that signs (must be yours). |
| `expectedAddress` | `string` | - | (`send`) the address you previewed. If the name now resolves elsewhere, the call rejects with `recipient_changed` before signing. |
| `message` | `string` | - | Optional memo. |
| `token` | `string` | - | Bearer token for `send`. |

**Returns (`prep`)** `{ mode: 'prep', recipient, amountUsdc, txBase64, blockhash, lastValidBlockHeight, mint }`, decode `txBase64` into a `VersionedTransaction`, sign with the payer wallet, and submit. **Returns (`send`)** `{ mode: 'send', recipient, payer, amountUsdc, signature }`. The `amountUsdc` argument accepts a string or number, must be `> 0` and `≤ 10000`.

### `resolvePayee(name) → Promise<Payee>`

Resolve-only, no payment. Wraps `GET /api/x402/pay-by-name?name=<name>`. A `404`
means the name resolved nowhere, and surfaces as a typed `not_found`.

**Returns** `Payee`

| Field | Type | Notes |
|---|---|---|
| `name` | `string \| null` | The canonical form of the name that matched. |
| `address` | `string \| null` | The wallet a payment would land in. |
| `source` | `'address' \| 'sns' \| 'username'` | Which namespace answered. |
| `resolved` | `string \| null` | The same canonical name as `name`. **Unlike `resolve()`, this is a string, not a boolean**: `'alice.threews.sol'` for an SNS hit, `'@alice'` for a username. There is no `resolved: false` here, a name that resolves nowhere is the `404` above. |
| `claim` | `object \| null` | The three.ws user behind a `*.threews.sol` claim, when there is one. |
| `raw` | `unknown` | The untouched wire body. |

## How it works

Three namespaces, one ergonomic surface. Each call routes by the shape of the
string you pass:

```
            resolve / payByName
                    │
        ┌───────────┼─────────────────────────┐
   *.eth│       *.sol│                base58 / @handle
        ▼            ▼                          ▼
   ENS resolver  Bonfida SNS              users.username
   (eth RPC,     resolve() + reverse      → default agent
    failover,    (+ index lookup when        Solana wallet
    3s timeout)   domains: true)         (.threews.sol also
        │            │                    surfaces a DB claim)
        ▼            ▼                          ▼
   0x… address   owner base58            recipient address
                    │
   mintSubdomain ──▶ createSubdomain → URL record → transferSubdomain
   (one VersionedTransaction, signed by the platform parent-owner keypair)
```

- **ENS** resolves on Ethereum mainnet through a failover provider, bounded by
  a 3-second timeout. A reverse lookup of the owner's primary name is
  best-effort.
- **SNS** resolves through Bonfida to the owner wallet. Pass `domains: true` and
  the resolution also reads the Bonfida SNS index for every `.sol` that owner
  holds plus their favorite domain, both best-effort: an index outage returns
  the plain envelope rather than failing the resolve.
- **Subdomain minting** is a single on-chain transaction: `createSubdomain`
  (parent owner becomes owner) → `createRecordV2Instruction` writes the URL
  record while the platform still owns it (so `<label>.threews.sol` resolves in
  Brave) → `transferSubdomain` hands it to the agent's wallet. The platform's
  parent-owner keypair (`THREEWS_SOL_PARENT_SECRET_BASE58`) is the only signer
  and fee payer: gas is under 0.01 SOL and absorbed, so the agent's wallet
  never has to sign.
- **Pay-by-name** uses the USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`,
  6 decimals), creating the recipient's associated token account idempotently.
  `mode: 'send'` enforces the agent's per-transaction spend limit and rejects
  off-curve recipients.

### Environment

`THREEWS_SOL_PARENT_SECRET_BASE58`: the base58-encoded 64-byte ed25519 secret
for the wallet that owns the parent `.sol` (default `threews.sol`, overridable
with `THREEWS_SOL_PARENT_DOMAIN`). This is **server-side only**; it gates all
subdomain minting. When it is absent the mint endpoints answer `503`
`config_missing` rather than failing mid-transaction, the SDK surfaces that as
a clean error, never a fake success.

## Pricing / payment

| Action | Cost |
|---|---|
| `resolve`, `reverseLookup`, `checkSubdomain`, `resolvePayee` | **Free.** Public, rate-limited per IP. |
| `mintSubdomain`, `claimSubdomain` | **Free** to the caller, the platform absorbs the sub-0.01-SOL gas. Requires auth. |
| `payByName` | The transferred USDC amount, plus Solana network fees. |
| [`ens_sns_resolve` MCP tool](https://three.ws/mcp) | **$0.0005 USDC** over x402, the metered equivalent of `resolve`. |

`.sol` reads are cached server-side (5 min positive, 60 s negative), and ENS
resolutions are cached 5 min in-memory, so repeated UX previews don't hammer the
RPC pools.

## Errors & edge cases

Every state is designed. Resolution failures return data, not exceptions; only
real faults reject.

| State | HTTP | Meaning | Recovery |
|---|---|---|---|
| `resolved: false` | 200 | Name has no owner. **Not an error.** | Show "unclaimed"; offer to mint. |
| `resolved: false` (ENS) | 404 | An unregistered `.eth`. The ENS endpoint reports a miss as a `404`; `resolve()` normalizes it to the same `resolved: false` result the `.sol` lane returns, so one call has one contract. The 404 envelope stays on `raw`. | Same as above. |
| `validation_error` | 400 | Malformed name, label, or amount. | Fix the input. Labels are 1-63 chars `[a-z0-9-]`. |
| `unauthorized` | 401 | Mint or `mode: 'send'` without auth. | Sign in or pass a bearer `token`. |
| `forbidden` | 403 | `ownerAddress` not linked to your account. | Link the wallet, or omit it. |
| `per_tx_exceeded` | 403 | Send over the agent's per-transaction limit. | Lower the amount or raise the agent's limit. |
| `not_found` | 404 | Agent missing, or payee resolved nowhere. | Check the agent ID / name. |
| `agent_missing_wallet` | 412 | Agent has no Solana wallet to attach to. | Provision one via `POST /api/agents/:id/solana`. |
| `conflict` | 409 | `<label>.threews.sol` already registered. | Pick another label. |
| `recipient_changed` | 409 | Name re-pointed since you previewed it. | Re-preview, then re-send. |
| `no_username` / `username_mismatch` | 409 | Claim label ≠ your username. | Set/match your username first. |
| `config_missing` | 503 | Platform parent-owner key not configured. | Server-side `THREEWS_SOL_PARENT_SECRET_BASE58` must be set. |
| `ens_timeout` | 503 | ENS RPC exceeded 3 s. | Retry; the failover provider rotates endpoints. |

## Examples

**Under the hood: resolve `.sol` with raw `fetch`** (what `resolve` wraps):

```js
const r = await fetch('https://three.ws/api/sns?name=bonfida.sol');
const { data } = await r.json();
// → { name: 'bonfida.sol', address: '…', network: 'solana', resolved: true }
```

**Agent identity, end to end**: give an agent a name, then receive a payment:

```js
import { mintSubdomain, resolvePayee } from '@three-ws/names';

const { fullName } = await mintSubdomain({ agentId, label: 'oracle', token });
// → oracle.threews.sol, owned by the agent's wallet, URL record → /a/<agentId>

const payee = await resolvePayee(fullName);
// → { name: 'oracle.threews.sol', address: '…', source: 'sns', claim: … }
```

**Browser pay-by-name**: build, sign in the wallet, submit:

```js
import { payByName } from '@three-ws/names';
import { VersionedTransaction } from '@solana/web3.js';

const { txBase64 } = await payByName('alice.threews.sol', '2.5', {
  payerWallet: wallet.publicKey.toBase58(),
});
const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
const signed = await wallet.signTransaction(tx);
const sig = await connection.sendRawTransaction(signed.serialize());
```

**Agent-signed send**: the agent's custodial wallet pays, with a poisoning guard:

```js
const preview = await resolvePayee('alice.threews.sol');
const { signature } = await payByName('alice.threews.sol', '5', {
  mode: 'send',
  agentId,
  expectedAddress: preview.address, // rejects if the name re-points before signing
  token,
});
```

## Related

- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch), auto-pay the `$0.0005` `ens_sns_resolve` MCP tool and other x402 lanes.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge), generate the agent's 3D avatar to pair with its name.
- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar), render the named agent's avatar in the browser.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
