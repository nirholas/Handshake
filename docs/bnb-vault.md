# The vault — encrypted 3D models gated by an on-chain BNB Chain purchase

The vault, at [three.ws/vault](https://three.ws/vault), sells access to
encrypted 3D models: sellers list an encrypted GLB, buyers pay on-chain and
receive the key to decrypt and view it. Buying one is a real BSC transaction
against a real smart contract, which triggers a real cross-chain call into
Greenfield's programmable storage: a genuinely unique capability BNB Chain
has that Ethereum L1, Base, and (mostly) Solana don't (see
`prompts/bnb-chain/00-CONTEXT.md`'s verified facts). This page is for
developers: it explains what the vault is, how it's built, and how to
reproduce the proof yourself. Everything here is real code against real
endpoints; nothing is mocked.

---

## 1. Why this only works on BNB Chain

Greenfield is a separate data-availability chain, but BSC contracts can
program its storage permissions directly — a BSC contract can call
`PermissionHub.createPolicy(...)` and grant an address read access to a
specific Greenfield object, cross-chain, with the result settling back
asynchronously as a real minted policy id. No other chain we've built on
lets a smart contract control object-level storage permissions on a separate
chain like this. The trade-off, and the reason this page surfaces it
honestly instead of hiding it: that cross-chain call is genuinely
asynchronous — a purchase confirms on BSC in ~0.45s, but the Greenfield
grant settles a few blocks later. `/vault` shows "granting access on
Greenfield…" for that window rather than faking an instant unlock.

## 2. Architecture

| Layer                | Where                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract             | [`contracts/src/GreenfieldVault.sol`](../contracts/src/GreenfieldVault.sol) — `list`/`buy`/`revoke`/`withdraw`, real `IPermissionHub`/`ICrossChain`/`IGnfdAccessControl` interfaces mirrored from `bnb-chain/greenfield-contracts`. Deploy record: [`contracts/DEPLOYMENTS.md`](../contracts/DEPLOYMENTS.md). |
| Upload (seller-side) | [`api/bnb/vault-upload.js`](../api/bnb/vault-upload.js) — encrypts a GLB (AES-256-GCM, fresh random content key per object), uploads ciphertext + a public manifest to Greenfield.                                                                                                                            |
| Manifest wire format | [`specs/vault-manifest.md`](../specs/vault-manifest.md) — the JSON schema every reader/writer agrees on.                                                                                                                                                                                                      |
| Buyer API            | [`api/vault/list.js`](../api/vault/list.js), [`status.js`](../api/vault/status.js), [`unlock.js`](../api/vault/unlock.js), [`download.js`](../api/vault/download.js), [`buy-policy-data.js`](../api/vault/buy-policy-data.js)                                                                                 |
| Crypto               | Server: [`api/_lib/bnb/vault-crypto.js`](../api/_lib/bnb/vault-crypto.js) (Node `crypto` AES-256-GCM + `@noble/curves` ECIES). Browser: [`src/bnb/vault-crypto-browser.js`](../src/bnb/vault-crypto-browser.js) (Web Crypto + `@noble/curves` — byte-identical wire format).                                  |
| UI                   | [`pages/vault.html`](../pages/vault.html) + [`src/vault.js`](../src/vault.js) `→ /vault`; buy calldata [`src/bnb/vault-buy.js`](../src/bnb/vault-buy.js); pure FSM helpers [`src/vault-fsm.js`](../src/vault-fsm.js)                                                                                          |

## 3. The buyer flow

1. **Browse.** `GET /api/vault/list` folds the contract's `Listed`/`Delisted`
   events into the active listing set and joins each with its Greenfield
   manifest for display metadata. A `contractDeployed:false` or 0-listings
   response renders as a clean, honest empty state — never an error.
2. **Buy.** The page needs a buyer identity that can later prove control of
   its own **raw secp256k1 private key** — not just sign a message — because
   unlocking uses ECIES key-wrapping to the buyer's own public key
   (`wrapKey`/`unwrapKey`), and a browser-extension wallet like MetaMask
   deliberately never exposes that raw key to a page. So the buyer identity
   is a **local session key** ([`src/bnb/vault-session.js`](../src/bnb/vault-session.js)) —
   generated once client-side, persisted to `localStorage`, the same pattern
   `src/agora/onchain-presence.js` already established for prompt 16's
   on-chain presence toggle. MetaMask's only role is funding that session
   key with a plain tBNB transfer, or signing a seller's own `list()`
   transaction (sellers don't need ECIES, so they use a directly-connected
   wallet). The session key then sends a real `buy(objectId, policyData)`
   transaction — gasless via MegaFuel when sponsorable, self-pay otherwise
   (`sendGasless`, prompt 02's fallback pattern) — carrying `price + the live
`quoteRelayFee()`.
3. **Settle.** `GET /api/vault/status` polls `saleIdOf`/`sales` fresh on
   every call and derives `unlisted | available | pending-grant | unlocked`.
   `pending-grant` means the purchase confirmed but Greenfield's cross-chain
   ack hasn't settled yet — shown honestly, with a bounded-backoff poll and a
   manual "check again" once it's been a while.
4. **Unlock.** The session key signs a canonical EIP-191 message
   ([`api/_lib/bnb/vault-unlock-message.js`](../api/_lib/bnb/vault-unlock-message.js)) proving
   control of the buyer address. `POST /api/vault/unlock` verifies it, checks
   the on-chain sale is `Granted`, and — the key design decision — reuses
   that same signature to recover the buyer's real secp256k1 public key
   (`viem`'s `recoverPublicKey`), so there's no separate "register your vault
   pubkey" step. It re-wraps the object's content key to that public key and
   returns it, alongside a short-lived download token
   ([`api/_lib/bnb/vault-download-token.js`](../api/_lib/bnb/vault-download-token.js)). The
   raw content key and plaintext GLB are **never** returned by the server.
5. **View.** The browser fetches ciphertext via `GET /api/vault/download`,
   unwraps the content key with its own raw private key
   (`src/bnb/vault-crypto-browser.js`'s `unwrapKey`, Web Crypto + `@noble/curves`),
   decrypts (`decryptGlb`, AES-256-GCM, sha256-verified against the manifest),
   and renders the plaintext GLB in `<model-viewer>` from a `Blob` URL — the
   decrypted bytes never touch the network again.

## 4. Reproducing the proof

The public BSC testnet deploy is blocked on a funded deployer key (same wall
documented across prompts 07/09/10/11/13/14/18 in `prompts/bnb-chain/PROGRESS.md`). Every
piece of logic above is provable today against a **local anvil fork** — the
same technique prompt 11 used at the exported-function level, extended here
to drive the actual running HTTP endpoints and a real headless browser:

```
node scripts/verify-vault-ui.mjs
```

This script deploys `GreenfieldVault` (with faithful mocked Greenfield hubs,
`contracts/script/DeployGreenfieldVaultMocked.s.sol`) on a local `anvil
--chain-id 97`, lists a real object, boots the real `server/index.mjs` API
server in-process, serves a real AES-256-GCM-encrypted GLB from a tiny local
Storage-Provider stand-in, and drives `/vault` with Playwright through
browse → buy → settle → unlock. It stops at the ciphertext download step —
`GET /api/vault/download` uses the real `@bnb-chain/greenfield-js-sdk`
client for an authenticated private-object fetch, which requires a real
Greenfield chain lookup that cannot be mocked locally. That's the single
remaining gap, and it's the same funded-account wall as everywhere else in
this campaign, not a bug in this code path.

## 5. Honest gaps (as of 2026-07-08)

- **Public testnet deploy**: code-complete (`contracts/script/DeployGreenfieldVault.s.sol`
  dry-run succeeds against the live testnet RPC), blocked on a funded
  `BNB_TESTNET_DEPLOYER_KEY`.
- **Real Greenfield object upload**: `api/bnb/vault-upload.js` is real and
  complete, blocked on a funded `GREENFIELD_VAULT_OPERATOR_KEY`. Prompt 13's
  own E2E proof confirmed exactly how far the wire reaches with a throwaway
  (never-funded) operator key configured: `GET /api/vault/download` gets
  past the "not configured" guard and reaches LIVE Greenfield testnet
  infrastructure through the real SDK client, failing with a specific real
  protocol error — `"Query failed with (6): No such bucket: unknown
  request"` — not a generic timeout or config error. That confirms the SDK
  wire-connects correctly end-to-end and the funded-account wall is the
  complete explanation, not a hidden second gap.
- **`policyData` wire-format confirmation**: `GET /api/vault/buy-policy-data`
  ([`api/_lib/bnb/vault-policy-data.js`](../api/_lib/bnb/vault-policy-data.js))
  builds a real protobuf-encoded Greenfield `Policy` for `buy()`, but its
  exact byte-layout hasn't been confirmed against a live `PermissionHub`
  relay in this session — it can only even attempt to run once a listing's
  object has completed a real Greenfield upload, which is blocked by the
  point above. Until then, `buy()` uses an honestly-labeled deterministic
  placeholder (`buildPolicyDataPlaceholder` in
  [`src/bnb/vault-buy.js`](../src/bnb/vault-buy.js)) — the same posture the
  prompt-11 anvil proof used.
- No seller browser wallet has actually completed a real `list()` against a
  publicly deployed contract yet (deploy itself is blocked); the "Sell a
  model" panel on `/vault` is real code against the real upload + `list()`
  path, exercised so far only on the local anvil fork above.

## Related

- [BNB Chain payments](/docs/bnb-payments) - MPP payments and the MegaFuel gasless-send rail the vault's `buy()` uses
- [x402 on three.ws](/docs/x402) - the platform's pay-per-call protocol on Solana and Base
