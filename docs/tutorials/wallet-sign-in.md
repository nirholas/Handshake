# Add Wallet Sign-In to Your App

By the end of this tutorial a visitor will click one button, approve a signature in Phantom, and land on your page authenticated as a three.ws user, with a session cookie your backend calls can rely on. No password, no email, no transaction, and no fee. The signature is free and off-chain: it proves the visitor controls the wallet, nothing more.

You will build it on **Sign-In with Solana** first, because Solana is the home chain and the wallet most three.ws users already have. The Ethereum path is the same shape and gets its own step at the end.

**What you'll build:**

- A working sign-in button that produces a real three.ws session
- The [CAIP-122](https://chainagnostic.org/CAIPs/caip-122) message construction, done the way that survives being served from a dev origin
- Correct CSRF handling on the verify call
- A session check that handles both signed-out shapes, not just the obvious one
- Error handling that tells a developer what to change instead of showing a raw code

**Prerequisites:**

- A Solana wallet extension: [Phantom](https://phantom.app), Backpack, or Solflare. You do not need any SOL: nothing here touches the chain.
- A page that can make same-origin requests to `/api/*` on three.ws. Running `npm run dev` in this repo gives you that, because the dev server proxies `/api/*` to production.
- No API key and no account are required up front. Signing in with a new wallet creates the account.

The finished code is [examples/wallet-sign-in/index.html](https://github.com/nirholas/three.ws/blob/main/examples/wallet-sign-in/index.html), and you can run it right now:

```bash
npm run dev   # port 3000
# open http://localhost:3000/examples/wallet-sign-in/
```

Read on for why each piece is shaped the way it is.

---

## Step 1 - Understand the three round trips

Wallet sign-in is three HTTP calls and one wallet interaction. Everything else is detail.

| # | Call | Why it exists |
|---|---|---|
| 1 | `GET /api/auth/siws/nonce` | Server issues a single-use nonce (5 minute TTL), a CSRF token, and the canonical `domain`/`uri` you must sign against |
| 2 | *(wallet)* `signMessage` | The visitor proves control of the address by signing a message containing that nonce |
| 3 | `POST /api/auth/siws/verify` | Server checks domain, URI, chain, time window, nonce, and signature, then sets a session cookie |

The nonce is what makes the signature un-replayable: it is burned on first use, so a captured message cannot be submitted twice.

---

## Step 2 - Get a nonce

```js
const res = await fetch('/api/auth/siws/nonce', { credentials: 'include' });
const { nonce, csrf, domain, uri } = await res.json();
```

`credentials: 'include'` matters: the endpoint sets a `__Host-csrf-siws` cookie that the verify call is checked against. Drop it and step 4 fails with `invalid_request`.

A real response:

```json
{
  "nonce": "cZ80BjC39R47lSY8mo3T0P",
  "issuedAt": "2026-07-30T22:42:54.093Z",
  "expiresAt": "2026-07-30T22:47:54.093Z",
  "csrf": "k7ixNoodRVLBhXwgLxVihxY_KFZ5twjqETCzHKNHbww",
  "ttl": 300,
  "domain": "three.ws",
  "uri": "https://three.ws"
}
```

Note `domain` and `uri`. Step 3 explains why they are in there.

Do not take that sample on faith. Run the call yourself, from this page, against the live API:

```live
{ "step": "siws-nonce" }
```

That is a real nonce, minted for you a moment ago, expiring five minutes from when you pressed the button. It signs you into nothing: a nonce only becomes a session once a matching signature reaches `verify`. The `csrf` field is hidden in the card because a page that displays a live CSRF token is a page you should not screenshot; your own call receives the real value.

---

## Step 3 - Build the message (the step everyone gets wrong)

The verify endpoint checks that the `domain` and `URI` lines inside the signed message match the deployment's own origin. The obvious implementation reaches for `location.host`:

```js
// Wrong when your page is not served from three.ws itself
const message = `${location.host} wants you to sign in with your Solana account:` /* ... */;
```

Served from `localhost:3000` while `/api/*` proxies to production, that signs `localhost:3000`, and the server rejects it with `invalid_domain`. Everything else about your integration can be perfect and it will still fail.

Use the values the nonce response gave you:

```js
const statement =
  'Sign in to three.ws. This request will not trigger any blockchain transaction or cost ' +
  'any fees. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and ' +
  'Privacy Policy (https://three.ws/legal/privacy).';

const message = [
  `${domain} wants you to sign in with your Solana account:`,
  address,
  '',
  statement,
  '',
  `URI: ${uri}`,
  'Version: 1',
  'Chain ID: mainnet',
  `Nonce: ${nonce}`,
  `Issued At: ${new Date().toISOString()}`,
  `Expiration Time: ${new Date(Date.now() + 5 * 60 * 1000).toISOString()}`,
].join('\n');
```

Three rules about this block:

- **The blank lines are structural.** One after the address, one after the statement. The parser relies on them; lose them and you get `invalid_message`.
- **`Chain ID` must be `mainnet`, `devnet`, or `testnet`.** A numeric EVM-style chain id gets `invalid_chain`.
- **Put the Terms agreement inside the statement.** The signature then evidences acceptance, which is what lets you send `tosAccepted: true` on verify honestly.

Here is that assembly running on the nonce you just minted. Paste your own address if you want to see the exact bytes your wallet would be handed, or leave it blank and read the shape:

```live
{ "step": "siws-message" }
```

Count the blank lines in the output. Line 3 and line 5 are empty, and they are the two most common reasons a first integration returns `invalid_message`.

---

## Step 4 - Sign it, then verify

```js
const provider = window.phantom?.solana ?? window.solana;
const { publicKey } = await provider.connect();
const address = publicKey.toString();

// ...build `message` from step 3 using `address`...

const { signature: sigBytes } = await provider.signMessage(
  new TextEncoder().encode(message),
  'utf8',
);
const signature = btoa(String.fromCharCode(...sigBytes)); // base58 also accepted

const verify = await fetch('/api/auth/siws/verify', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
  body: JSON.stringify({ message, signature, tosAccepted: true }),
});
```

The `x-csrf-token` header is mandatory, and its value is the `csrf` string from the nonce response. The server compares it against the `__Host-csrf-siws` cookie it set alongside it. Omitting the header returns `403 invalid_request` no matter how good the signature is.

On success the response sets `__Host-sid`, a 30-day rolling session cookie, and returns the user. From here the visitor is authenticated exactly like someone who signed in with an email and password.

---

## Step 5 - Read the session back, correctly

```js
const res = await fetch('/api/auth/me', { credentials: 'include' });
const { user } = res.ok ? await res.json() : {};
if (!user) showSignedOut();
```

This looks like a formality and is not. `GET /api/auth/me` has **two** signed-out shapes:

| Situation | Status | Body |
|---|---|---|
| No session cookie at all | `200` | `{"user":null}` |
| Cookie present but expired or revoked | `401` | `{"error":"invalid_session"}` |

A client that checks only `res.status === 401` treats the first case as signed in and renders an empty account panel to every signed-out visitor. Check `!res.ok || !body.user`.

A signed-in response carries `id`, `email`, `display_name`, `plan`, `is_admin`, and `sid`. Render the first few; **never render `sid`**, which is the live session identifier and should not end up in a screenshot or a copied DOM node.

For a wallet-created account, `email` is a synthetic placeholder like `sol-8a447018a12183be@wallet.local` and `display_name` is the truncated address. Treat both as display fallbacks, not as a real inbox.

Run it against your own browser. The card sends your cookies, so what comes back depends on whether you are signed in to three.ws right now, and either answer is the lesson:

```live
{ "step": "auth-me" }
```

If you are signed out you should see `200` with `{"user": null}`, which is exactly the shape that fools a `status === 401` check. If you are signed in, note that `sid` comes back redacted in this view for the reason above.

---

## Step 6 - Turn error codes into instructions

The API answers failures with `{ "error": "<code>", "error_description": "<prose>" }`. The machine-readable code is in `error`, not in a `code` field, which is an easy thing to get backwards.

Map the codes a developer will actually hit onto sentences that name the fix:

```js
const CODES = {
  invalid_domain: 'Build the message from the nonce response, not location.host.',
  invalid_uri: 'Use the uri the nonce response returned.',
  invalid_chain: 'Chain ID must be mainnet, devnet, or testnet.',
  invalid_message: 'The message is not parseable. Check the line order and the blank lines.',
  invalid_nonce: 'That nonce is unknown to the server. Request a fresh one.',
  nonce_reused: 'Nonces are single use. Request a fresh one.',
  nonce_expired: 'The nonce expired. They last five minutes.',
  expired: 'The message expiration time has passed.',
  invalid_signature: 'The signature does not verify against that address.',
  invalid_request: 'CSRF: send the csrf value from the nonce response as x-csrf-token.',
  account_deleted: 'That wallet belongs to a deleted account.',
};

const describe = (data) =>
  CODES[data?.error] || data?.error_description || 'Sign-in failed.';
```

Separately, catch the user simply declining in their wallet. That is not an error worth a red banner:

```js
if (/reject|denied|cancel|refused/i.test(err.message)) return 'Signature cancelled.';
```

---

## Step 7 - One-tap sign-in on Seeker

Wallets implementing the [Sign In With Solana](https://github.com/phantom/sign-in-with-solana) wallet feature merge authorization and signing into a single approval. The three.ws mobile wallet advertises this with `supportsSignIn`:

```js
if (provider.supportsSignIn && typeof provider.signIn === 'function') {
  const siws = await provider.signIn({
    domain, statement, uri, version: '1', chainId: 'mainnet',
    nonce, issuedAt, expirationTime,
  });
  // Forward the EXACT bytes the wallet signed, not a message you rebuilt.
  await postVerify(siws.signedMessageText, btoa(String.fromCharCode(...siws.signature)), csrf);
}
```

Two things to get right: forward `signedMessageText` verbatim, because a message you reconstruct will differ by a character somewhere and fail signature verification. And if the one-tap attempt fails for any reason other than the user cancelling, **request a fresh nonce** before falling back to the two-step path: the first nonce may already be burned.

---

## Step 8 - Add the Ethereum button

Same three round trips, different endpoints and a different signing call:

| Solana | Ethereum |
|---|---|
| `GET /api/auth/siws/nonce` | `GET /api/auth/siwe/nonce` |
| `POST /api/auth/siws/verify` | `POST /api/auth/siwe/verify` |
| `provider.signMessage(bytes, 'utf8')` | `window.ethereum.request({ method: 'personal_sign', params: [message, address] })` |
| `Chain ID: mainnet` | `Chain ID: 1` (the numeric EIP-155 id) |
| `... sign in with your Solana account:` | `... sign in with your Ethereum account:` |

The SIWE nonce endpoint returns `domain` and `uri` too, so the step 3 rule is unchanged. Note that this is the platform's **own** SIWE rail. The quick "connect wallet" button on the three.ws login page runs SIWE through Privy instead, which is a different integration with its own CAPTCHA requirement, documented in the [Authentication guide](/docs/authentication).

---

## Step 9 - Sign out

```js
await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
```

This revokes the session server-side and clears the cookie. To drop every session for the account, for example after a suspected compromise, use `POST /api/auth/logout-everywhere`.

---

## What you built

A wallet sign-in that works from any origin that can reach the API, survives the domain check, handles CSRF, distinguishes both signed-out states, and explains its own failures. The running version is [examples/wallet-sign-in/](https://github.com/nirholas/three.ws/tree/main/examples/wallet-sign-in).

## Related

- [Authentication](/docs/authentication) - the complete contract: SIWS, SIWE, Privy, sessions, API keys, OAuth
- [API reference](/docs/api-reference) - every endpoint, including the auth routes
- [Give an agent a spending envelope](/docs/tutorials/agent-spending-envelope) - what an authenticated account can hand to an agent
