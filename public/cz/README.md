# CZ claim page

The CZ agent's claim page, served at `/cz/`. A visitor connects a browser
wallet, signs a one-line message, and the platform hands them ownership of the
pre-registered CZ agent. `/cz/offline` is the static fallback shown when the
page is presented without a network (see `offline/README.md`).

## Files

| File | Role |
|---|---|
| `index.html` | The page: preview avatar, the connect / sign / success / error steps, and the embed snippets shown after a claim. |
| `cz.js` | The whole client flow: wallet connect, nonce fetch, `personal_sign`, claim POST, optional on-chain broadcast. |
| `cz.css` | Page styles. |

The server side is a single handler, `api/cz/claim.js`, backed by the
`cz_claims` table (`api/_lib/migrations/20260812140000_cz_claims.sql`).

## The claim flow

1. **Connect.** `cz.js` asks the injected provider for an account
   (`eth_requestAccounts`), then calls `GET /api/cz/claim?address=0x...`, which
   mints a random 16-byte nonce, stores it against the lowercased address as a
   `pending` row, and returns `{ nonce, expiresInSeconds }`.
2. **Sign.** The user signs `Claim CZ Agent\n\nNonce: <nonce>` with
   `personal_sign`. Nothing is sent on-chain at this point and no gas is spent.
3. **Redeem.** `POST /api/cz/claim` with `{ signerAddress, signature, nonce }`.
   The handler recovers the signer from the signature, requires it to match both
   the claimed address and the address the nonce was issued to, requires the
   nonce to still be `pending` and younger than 15 minutes, and then flips the
   row to `claimed` with an update guarded on `status = 'pending'` so two
   concurrent redemptions cannot both succeed.
4. **Transfer.** The response carries a `txPayload` with
   `transferAgent(agentId, signer)` calldata for the identity registry. The page
   broadcasts it with `eth_sendTransaction` only when a registry address is
   actually configured; with `CZ_REGISTRY_CONTRACT` unset the payload targets the
   zero address and the page skips the transaction, so the claim is recorded
   off-chain and the page still shows the embed snippets.

### Responses

| Status | `error` | When |
|---|---|---|
| 200 | | Nonce issued (GET) or claim recorded (POST) |
| 400 | `validation_error` | Address is not a `0x` + 40 hex string, or a field is missing or not a string |
| 400 | `invalid_nonce` | No row for that nonce |
| 400 | `nonce_expired` | The nonce is older than 15 minutes |
| 400 | `invalid_signature` | The signature bytes do not parse |
| 403 | `forbidden` | Signature recovers to another address, or the nonce belongs to another address |
| 409 | `conflict` | The nonce was already redeemed |
| 429 | `rate_limited` | More than 10 calls in an hour from one IP |

## Configuration

All three are optional; the defaults below are what production runs today.

| Env var | Default | Meaning |
|---|---|---|
| `CZ_AGENT_ID` | `cz-preview` | Agent id encoded into the transfer calldata and the embed snippet |
| `CZ_AGENT_NAME` | `CZ Agent` | Display name on the success step |
| `CZ_REGISTRY_CONTRACT` | zero address | Identity registry to call; the zero address disables the on-chain step |

## Verifying it end to end

```bash
# 1. Issue a nonce
curl -s 'https://three.ws/api/cz/claim?address=0x1111111111111111111111111111111111111111'
# {"nonce":"a8b1...","expiresInSeconds":900}

# 2. Redeem it with a signature over "Claim CZ Agent\n\nNonce: <nonce>"
curl -s -X POST https://three.ws/api/cz/claim \
  -H 'content-type: application/json' \
  -d '{"signerAddress":"0x...","signature":"0x...","nonce":"a8b1..."}'
```

`tests/cz-claim.test.js` covers the same contract with real secp256k1
signatures, including the replay, expiry, and wrong-signer paths.
