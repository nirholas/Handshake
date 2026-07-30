# Wallet sign-in

A single-page, no-build demo of the two wallet authentication rails three.ws runs itself: **Sign-In with Solana (SIWS)** and **Sign-In with Ethereum (SIWE)**. It talks to the real auth API, shows you the exact message your wallet signed, logs every HTTP call with its real status code, and then reads the session back from `GET /api/auth/me`.

Use it as the reference when you wire wallet sign-in into your own surface. The full contract lives in [docs/authentication.md](../../docs/authentication.md); the guided walkthrough is [docs/tutorials/wallet-sign-in.md](../../docs/tutorials/wallet-sign-in.md).

## What it demonstrates

- The complete SIWS round trip: nonce, CAIP-122 message, `signMessage`, verify, session cookie
- The complete SIWE round trip on the platform's own EIP-4361 rail (not the Privy one)
- Building the signed message from the **server's** `domain` and `uri` rather than `location.host`, which is what lets a proxied dev page produce a message the deployment accepts
- Passing the CSRF token from the nonce response as `x-csrf-token` on verify
- Reading the session back, and the two different shapes a signed-out response can take
- Turning the API's machine error codes into messages that say what to change

## Run it

The page is same-origin by default, so it works anywhere `/api/*` reaches three.ws.

```bash
npm run dev   # from the repo root, port 3000
# then open http://localhost:3000/examples/wallet-sign-in/
```

The repo's dev server proxies `/api/*` to production, so the demo signs you into the real site. Install [Phantom](https://phantom.app), Backpack, or Solflare for the Solana button, or MetaMask for the EVM button.

To open the file directly from disk instead, point it at an API origin explicitly:

```
file:///path/to/examples/wallet-sign-in/index.html?api=https://three.ws
```

That mode needs the origin to be allowed by the API's CORS policy; the `npm run dev` path above avoids the issue entirely and is the recommended way to run it.

## The one thing that catches everyone

`POST /api/auth/siws/verify` checks that the `domain` and `URI` lines inside the signed message match the deployment's own origin. A dev page served from `localhost:3000` that builds the message from `location.host` therefore signs `localhost:3000` and gets rejected with `invalid_domain`, even though everything else is correct.

The nonce response exists to solve exactly this. It returns the canonical values to sign against:

```json
{
  "nonce": "cZ80BjC39R47lSY8mo3T0P",
  "csrf": "k7ixNoodRVLBhXwgLxVihxY_KFZ5twjqETCzHKNHbww",
  "domain": "three.ws",
  "uri": "https://three.ws",
  "issuedAt": "2026-07-30T22:42:54.093Z",
  "expiresAt": "2026-07-30T22:47:54.093Z",
  "ttl": 300
}
```

Always build the message from `domain` and `uri` as returned. [index.html](./index.html) does this for both chains.

## Signed-out has two shapes

`GET /api/auth/me` does not simply return `401` when you are signed out:

| Situation | Status | Body |
|---|---|---|
| No session cookie at all | `200` | `{"user":null}` |
| Cookie present but expired or revoked | `401` | `{"error":"invalid_session"}` |

So the check is `!response.ok || !body.user`, not `response.status === 401`. A client that only tests for `401` renders an empty signed-in panel to signed-out visitors.

## Error codes you will actually hit

The API returns `{ "error": "<code>", "error_description": "<prose>" }`. The machine code is in `error`, not in a `code` field. The demo maps the ones worth explaining:

| `error` | What to change |
|---|---|
| `invalid_domain` / `invalid_uri` | Build the message from the nonce response, not `location.host` |
| `invalid_chain` | Chain ID must be `mainnet`, `devnet`, or `testnet` |
| `invalid_message` | Check the line order and the two blank lines |
| `invalid_nonce` / `nonce_reused` / `nonce_expired` | Nonces are single use and last five minutes; request a fresh one |
| `expired` | The message's `Expiration Time` has passed |
| `invalid_signature` | The signature does not verify against that address |
| `invalid_request` | CSRF: send the nonce response's `csrf` as the `x-csrf-token` header |
| `account_deleted` | That wallet belongs to a deleted account |

## Files

| File | What it is |
|---|---|
| [index.html](./index.html) | The whole demo: markup, styles, and both sign-in flows. No dependencies, no build step. |

## Related

- [docs/authentication.md](../../docs/authentication.md) - the complete auth contract: SIWS, SIWE, Privy, sessions, API keys
- [docs/tutorials/wallet-sign-in.md](../../docs/tutorials/wallet-sign-in.md) - step-by-step walkthrough of this flow
- [docs/api-reference.md](../../docs/api-reference.md) - every endpoint including the auth routes
