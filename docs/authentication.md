# Authentication

Authentication is how three.ws knows who you are: it protects your agents, your avatars, and your dashboard, and it is required for anything that writes data. Sign in at [three.ws/login](https://three.ws/login) with a crypto wallet or a plain email/social account; developers can also mint API keys for scripts and servers.

three.ws supports four authentication methods. Which one you need depends on how you're building:

| Method | Best for |
|--------|----------|
| **Sign-In With Solana (SIWS)** | Users with a Solana wallet (Phantom, Backpack, Solflare, Seeker). Solana is the home chain; this is the default wallet sign-in. |
| **Sign-In With Ethereum (SIWE)** | Users with an EVM browser wallet (MetaMask, Coinbase Wallet, etc.) |
| **Privy** | Users without a wallet: email code sign-in, plus Privy-managed wallet login |
| **API keys** | Server-to-server and programmatic access |

Authentication controls who can edit or publish an agent, which agents a user owns (for on-chain operations), rate limiting and usage tracking, and access to the dashboard and API.

---

## Sign-In With Solana (SIWS)

SIWS ([CAIP-122](https://chainagnostic.org/CAIPs/caip-122)) lets users authenticate by signing a message with their Solana wallet. No password, no email, no transaction, no fees. This is the platform's own rail: the nonce and the session both come from three.ws, with no third-party auth service in the path.

### Supported wallets

- **Phantom** (`window.phantom.solana`)
- **Backpack** (`window.backpack.solana`)
- **Solflare** (`window.solflare`)
- **Solana Seeker / Seed Vault** (the three.ws mobile app injects a one-tap wallet; see below)
- Any wallet exposing the standard `connect()` + `signMessage()` provider interface

### How the flow works

1. Your frontend calls `GET /api/auth/siws/nonce`. The response carries a one-time nonce (valid 5 minutes), a CSRF token, and the canonical `domain` and `uri` to sign against. The endpoint also sets a `__Host-csrf-siws` cookie.
2. You build a CAIP-122 message using the nonce and the server-provided domain and URI.
3. The user signs the message in their wallet (a free, off-chain ed25519 signature).
4. You `POST /api/auth/siws/verify` with the raw message and the signature (base58 or base64 encoded), plus the CSRF token as an `X-CSRF-Token` header.
5. The backend parses the message, checks domain and URI against the deployment, checks the chain id (`mainnet`, `devnet`, or `testnet`), checks the time window, burns the nonce (single use), verifies the ed25519 signature recovers the claimed address, and issues a session cookie.

Always build the message from the `domain` and `uri` the nonce endpoint returns rather than `location.host`: that keeps dev frontends that proxy `/api/*` to a remote upstream (Codespaces tunnels, preview deploys) producing messages that pass the server's domain check.

### API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/auth/siws/nonce` | Generate a nonce + CSRF token; returns canonical domain/uri |
| `POST` | `/api/auth/siws/verify` | Verify signed message, issue session |
| `POST` | `/api/auth/logout` | Revoke session cookie |

### Raw SIWS flow

This is the exact flow the [three.ws login page](https://three.ws/login) runs (see [public/login.html](../public/login.html) and [src/privy-login.js](../src/privy-login.js), Solana branch):

```js
// 1. Get nonce + CSRF token + canonical domain/uri
const { nonce, csrf, domain, uri } = await fetch('/api/auth/siws/nonce', {
  credentials: 'include',
}).then((r) => r.json());

// 2. Connect the wallet
const provider = window.phantom?.solana ?? window.solana;
const { publicKey } = await provider.connect();
const address = publicKey.toString();

// 3. Build the CAIP-122 message. Put the Terms agreement in the signed
//    statement so the signature itself evidences acceptance.
const statement =
  'Sign in to three.ws. This request will not trigger any blockchain transaction or cost any fees. ' +
  'By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and Privacy Policy (https://three.ws/legal/privacy).';
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

// 4. Sign (ed25519 over the utf8 bytes) and encode the 64-byte signature
const { signature: sigBytes } = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
const signature = btoa(String.fromCharCode(...sigBytes)); // base58 also accepted

// 5. Verify: CSRF token in the header, tosAccepted because the statement
//    carries the agreement
const res = await fetch('/api/auth/siws/verify', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
  body: JSON.stringify({ message, signature, tosAccepted: true }),
});
const { user } = await res.json();
```

### One-tap sign-in (Seeker / Seed Vault)

Wallets that implement the [Sign In With Solana wallet feature](https://github.com/phantom/sign-in-with-solana) expose `signIn()`, which merges authorization and the sign-in signature into a single wallet interaction. The three.ws mobile wallet advertises this with a `supportsSignIn` flag. When available, call `signIn()` with the same fields (domain, statement, uri, nonce, timestamps), then POST the wallet's `signedMessageText` and signature to the same verify endpoint. The server accepts the exact bytes the wallet signed. Wallets without `signIn()` fall through to the two-step `connect()` + `signMessage()` flow above.

### Verify errors

| Status | Code | Meaning |
|--------|------|---------|
| `400` | `invalid_message` | Message is not parseable CAIP-122 |
| `400` | `invalid_domain` / `invalid_uri` | Domain or URI does not match this deployment |
| `400` | `invalid_chain` | Chain ID is not `mainnet`, `devnet`, or `testnet` |
| `400` | `expired` / `not_yet_valid` | Outside the message's time window |
| `400` | `invalid_nonce` / `nonce_reused` / `nonce_expired` | Nonce unknown, already burned, or past its 5-minute TTL |
| `401` | `invalid_signature` | Signature does not verify against the claimed address |
| `403` | `invalid_request` | CSRF header missing or does not match the `__Host-csrf-siws` cookie |
| `403` | `account_deleted` | Wallet belongs to a deleted account |

---

## Sign-In With Ethereum (SIWE)

SIWE ([EIP-4361](https://eips.ethereum.org/EIPS/eip-4361)) lets users authenticate by signing a message with their Ethereum wallet — no password, no email required.

Note that the login page has two EVM sign-in paths: the quick "connect wallet" button at the top runs SIWE through Privy (see the [Privy section](#privy-social--email-auth) below), while the "Using on-chain features?" section runs the platform's own SIWE rail documented here. Both end in the same three.ws session; the own rail is the one to integrate against if you are building outside the Privy SDK.

### Supported wallets

- **MetaMask** — browser extension, `window.ethereum`
- **WalletConnect v2** — mobile wallets (Trust, Rainbow, MetaMask Mobile, and any WC-compatible wallet)
- **Coinbase Wallet** — browser extension or mobile
- Any **EIP-1193** compliant provider

### How the flow works

1. Your frontend calls `GET /api/auth/siwe/nonce` to get a one-time nonce (valid for 5 minutes) and a CSRF token.
2. You build an EIP-4361 message using the nonce, the user's address, and the current domain.
3. The user signs the message in their wallet — this is a free, off-chain signature.
4. You `POST /api/auth/siwe/verify` with the raw message and signature, plus the CSRF token as an `X-CSRF-Token` header.
5. The backend verifies the signature recovers the claimed address, checks the nonce hasn't been used, validates the domain, and issues a session cookie.

The CSRF token is mandatory on the verify call. The nonce endpoint sets a `__Host-csrf-siwe` cookie and returns the CSRF value in the response body. Pass it as `X-CSRF-Token` on the verify POST to prevent cross-site attacks.

### API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/auth/siwe/nonce` | Generate a nonce + CSRF token |
| `POST` | `/api/auth/siwe/verify` | Verify signed message, issue session |
| `POST` | `/api/auth/logout` | Revoke session cookie |

### Using the built-in controller

The `ConnectWalletController` class in [src/wallet/connect-button.js](../src/wallet/connect-button.js) handles the full SIWE flow including chain switching:

```js
import { createConnectWalletButton } from '/src/wallet/connect-button.js';

const ctrl = createConnectWalletButton(document.getElementById('wallet-mount'), {
  onSuccess(data) {
    console.log('Signed in as', data.wallet.address);
  }
});
```

This mounts a `<button class="cwb-btn">` that steps through connecting, chain validation, signing, and verification. The controller fires `change` CustomEvents on state transitions.

For lower-level control, use `ConnectWalletController` directly:

```js
import { ConnectWalletController } from '/src/wallet/connect-button.js';

const ctrl = new ConnectWalletController({
  nonceUrl: '/api/auth/siwe/nonce',
  verifyUrl: '/api/auth/siwe/verify',
  allowedChainIds: [1, 8453, 10],
  onSuccess(data) { /* ... */ }
});

ctrl.addEventListener('change', (e) => {
  console.log('State:', e.detail.status, e.detail.address);
});

await ctrl.connect();      // request accounts
await ctrl.signAndVerify(); // sign message + post to backend
```

The state machine states (from [src/wallet/state.js](../src/wallet/state.js)) are: `idle` → `detecting` → `requesting_accounts` → `connected` → `signing` → `verifying` → `success` (or `error` / `wrong_chain` at any point).

### WalletConnect (mobile wallets)

For mobile wallet support without Privy, use the WalletConnect bridge:

```js
import { signInWithWalletConnect } from '/src/auth/walletconnect-bridge.js';

const { user, address } = await signInWithWalletConnect();
```

This opens the WalletConnect QR modal, handles the SIWE sign flow, and sets the session cookie. Requires `VITE_WALLETCONNECT_PROJECT_ID` in your environment — get a project ID at [cloud.walletconnect.com](https://cloud.walletconnect.com).

### Raw SIWE flow (without the controller)

```js
import { SiweMessage } from 'siwe';

// 1. Get nonce + CSRF token
const { nonce, csrf, expiresAt } = await fetch('/api/auth/siwe/nonce', {
  credentials: 'include'
}).then(r => r.json());

// 2. Build the EIP-4361 message. Put the Terms agreement in the signed
//    statement so the signature itself evidences acceptance.
const message = new SiweMessage({
  domain: window.location.host,
  address: walletAddress,
  statement: 'Sign in to three.ws. This does not cost anything and proves wallet ownership. By signing, you agree to the Terms of Service (https://three.ws/legal/tos) and Privacy Policy (https://three.ws/legal/privacy).',
  uri: window.location.origin,
  version: '1',
  chainId: 1,
  nonce,
  expirationTime: expiresAt,
}).prepareMessage();

// 3. Sign
const signature = await provider.getSigner().signMessage(message);

// 4. Verify: include the CSRF token in the header. Send tosAccepted: true
//    when your UI displayed the Terms agreement (statement above or a notice
//    next to the sign-in control); the server records the acceptance and the
//    Terms version on the user record.
const res = await fetch('/api/auth/siwe/verify', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrf,
  },
  body: JSON.stringify({ message, signature, tosAccepted: true }),
});
const { user, wallet } = await res.json();
```

> **Security note:** Never submit the SIWE message to a domain other than where the nonce was issued. The backend validates that `domain` and `uri` in the message match the deployment's `APP_ORIGIN`. Replaying a valid signature from a phishing page is rejected. A localhost `domain` is accepted only by a deployment whose own `APP_ORIGIN` is localhost, never by three.ws itself.
>
> A wallet whose account was closed through `DELETE /api/auth/me` gets `403 account_deleted`. Signing in again does not revive it: the same answer the [SIWS](#verify-errors) and SAML paths give.

### Terms of Service acceptance

Every auth endpoint accepts an optional `tosAccepted: true` body field. Send it whenever your UI showed the user the [Terms of Service](https://three.ws/legal/tos) agreement (a checkbox, a "By signing in you agree" notice, or the agreement sentence inside the signed wallet statement). The server writes a durable acceptance record (audit log + the accepted Terms version on the user row). Two rules:

- `POST /api/auth/register` **requires** `tosAccepted: true`; account creation without it fails with `400 tos_required`. Registration UIs must show a real agreement control.
- Wallet and Privy verifies (`/api/auth/siwe/verify`, `/api/auth/siws/verify`, `/api/auth/privy/verify`) and `POST /api/auth/login` treat it as an affirmation: acceptance is recorded on every sign-in, so users converge onto the current Terms version over time.

An already-signed-in user can also record acceptance directly with `POST /api/legal/tos-ack { version?, context? }`, which mirrors the risk-acknowledgment endpoint (`/api/legal/risk-ack`).

---

## Privy (Social / Email Auth)

Privy lets users log in with an email code, or with a wallet through Privy's auth service. Each Privy account gets a wallet managed by Privy's MPC system, so users get wallet-based identity without needing MetaMask or any browser extension.

### Why use Privy

Not every user has a crypto wallet. If your audience includes non-web3 users, Privy removes the wallet prerequisite while still giving those users an Ethereum address they can use for on-chain operations later.

### How it works

The three.ws login and register pages run Privy **headless**: our own UI drives `@privy-io/js-sdk-core` directly (see [src/privy-login.js](../src/privy-login.js)), so there is no Privy-hosted modal.

1. The frontend reads the app id from `GET /api/config` (`privyAppId`) and constructs the SDK client.
2. **Email**: `privy.auth.email.sendCode(email, captchaToken)` sends a 6-digit code; `privy.auth.email.loginWithCode(email, code)` exchanges it for an identity token (a JWT signed with Privy's ES256 key).
3. **EVM wallet**: the page runs Privy's SIWE ceremony (`siwe/init` for a nonce and message, `personal_sign` in the wallet, `loginWithSiwe` to finish) and gets the same kind of identity token.
4. The frontend posts that token to `POST /api/auth/privy/verify`.
5. The backend fetches Privy's JWKS, verifies the token signature and audience, and finds-or-creates the user record (keyed on the Privy DID).
6. Linked wallets are synced best-effort from Privy's server API into the user's wallet list; a login with no wallet still succeeds.
7. A session cookie is issued; from this point the user is authenticated identically to a SIWS or SIWE user.

Solana wallet sign-in does not go through Privy at all: it uses the platform's own [SIWS rail](#sign-in-with-solana-siws) above.

### CAPTCHA (Cloudflare Turnstile)

When CAPTCHA is enabled for the Privy app (Privy dashboard, Security tab), Privy rejects both `passwordless/init` (the email code send) and `siwe/init` (the wallet nonce) with `401 invalid_credentials` unless the request carries a Turnstile token. Three things follow for anyone integrating headless:

- Fetch the app config (`GET https://auth.privy.io/api/v1/apps/{appId}` with a `privy-app-id` header) to read `captcha_enabled` and `captcha_site_key` (Turnstile keys are prefixed `t:`), and load the Turnstile widget from `https://challenges.cloudflare.com/turnstile/v0/api.js`. Run it in `interaction-only` appearance so users only see it when Cloudflare requires an interaction.
- `email.sendCode` accepts the token as its second argument.
- `siwe.init` in `@privy-io/js-sdk-core` has no token parameter, so the login page calls the init endpoint directly with `{ address, token }`, builds the standard EIP-4361 message from the returned nonce, and hands the wallet's signature plus that message to `loginWithSiwe(signature, wallet, message)`. A `401` with code `invalid_captcha` means the token was read but failed verification; `invalid_credentials` means no token reached Privy at all.

If the app config declares a `custom_api_url` (three.ws uses `https://privy.three.ws`), every auth call above goes to that domain instead of `auth.privy.io`.

The discovery step is factored into [src/auth/privy-captcha.js](../src/auth/privy-captcha.js), and the login page treats "CAPTCHA required" and "could not find out" as different answers: when the app config probe fails, the page refuses to send a code without a token Privy might require, and tells the user to reload rather than surfacing Privy's opaque `401 invalid_credentials`. The same distinction applies to `/api/config` itself: if that probe fails (it is bounded to six seconds), the email and wallet controls are hidden with an explanation and the password form still signs the visitor in, instead of the whole block silently vanishing as it does when the deployment genuinely has no Privy app.

### Configuration

```env
# Client-side (Vite / browser)
VITE_PRIVY_APP_ID=your-privy-app-id

# Server-side (for token verification)
PRIVY_APP_ID=your-privy-app-id
```

Get both values from [dashboard.privy.io](https://dashboard.privy.io). The server uses PRIVY_APP_ID to validate the JWT audience claim and to fetch the JWKS from `https://auth.privy.io/api/v1/apps/{appId}/jwks.json`.

### Verify endpoint

```js
// After the Privy client gives you an auth token. Send tosAccepted: true when
// your UI displayed the Terms of Service agreement next to the sign-in control;
// the server records the acceptance and the Terms version on the user record.
const res = await fetch('/api/auth/privy/verify', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, tosAccepted: true }),
});
const { user } = await res.json();
// user: { id, email, display_name, plan, avatar_url, created_at }
// Any wallets Privy has linked are synced onto the account automatically;
// list them afterwards with GET /api/auth/wallets.
```

A Privy identity attached to an account that was closed through `DELETE /api/auth/me` gets `403 account_deleted` instead of a session. Signing in again never revives a deleted account on any path.

### Linking additional wallets

Once a user is signed in via Privy, they can connect a browser wallet and link it to their account via `POST /api/auth/wallets`. See the [Multi-wallet section](#multi-wallet-support) below.

---

## Session Management

Sessions are stored server-side in Postgres. The browser receives an opaque token in a secure cookie.

### Session cookie

```
__Host-sid
HttpOnly; Secure; SameSite=Lax; Path=/
Max-Age: 2592000  (30 days)
```

The `__Host-` prefix enforces `Path=/; Secure` at the browser level — no subdomain can set or override it.

Sessions are rolling: if a session is accessed after not being used for 24 hours and has fewer than 7 days remaining, the server issues a fresh token transparently. Most users never see an expiry prompt.

### Checking the current session

```js
const res = await fetch('/api/auth/me', { credentials: 'include' });
if (res.ok) {
  const { user } = await res.json();
  // user: { id, email, display_name, plan, avatar_url, wallet_address, sid }
}
```

There are two distinct signed-out shapes, and a client that checks only one of them will get it wrong:

| Situation | Status | Body |
|---|---|---|
| No session cookie at all | `200` | `{"user":null}` |
| Cookie present but expired or revoked | `401` | `{"error":"invalid_session"}` |

So treat "signed out" as `!response.ok || !body.user`, not as `response.status === 401`.

### Logging out

```js
await fetch('/api/auth/logout', {
  method: 'POST',
  credentials: 'include',
});
```

This revokes the current session in the database and clears the session cookie. The user must sign in again on all devices that were using this session.

To revoke **all sessions** for the current user (e.g. after a suspected account compromise):

```js
await fetch('/api/auth/logout-everywhere', {
  method: 'POST',
  credentials: 'include',
});
```

### Deleting the account

`DELETE /api/auth/me` closes an account for good. It is the endpoint behind the
Danger Zone on [/settings](https://three.ws/settings), and it has three gates:
a live session, a single-use CSRF token, and the literal confirmation phrase in
the body (case-insensitive). Miss the phrase and it answers
`400 confirmation_required` without writing anything.

```js
import { apiFetch } from '/src/api.js'; // attaches the x-csrf-token for you

const res = await apiFetch('/api/auth/me', {
  method: 'DELETE',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirm: 'delete my account' }),
});
const { deleted } = await res.json(); // { avatars, agents, widgets } counts
```

What it does, in order: retires the account's avatars, agent identities, and
embed widgets (so nothing of theirs keeps serving publicly), marks the user
row deleted, releases the `/u/<username>` handle back to the pool, revokes
every session and OAuth refresh token, and clears the session cookie. The row
itself is kept, which is what lets every sign-in path answer honestly
afterwards: password login fails as if the account never existed, and the
wallet/SAML paths return `account_deleted` rather than minting a fresh account
for the same wallet. The deletion is recorded in the audit log with the
released username, so support can restore a handle on an appeal.

### Coin-community sessions (Town, `/play` worlds)

The coin-community surfaces (Town posting, holder passes, world gates) ride a
separate session from the main site: an X-OAuth sign-in against the
CoinCommunities upstream, kept in two httpOnly cookies scoped to
`Path=/api/community` so page scripts never see them:

| Cookie  | Lifetime | Role                          |
| ------- | -------- | ----------------------------- |
| `cc_at` | 1 hour   | Access token (a JWT)          |
| `cc_rt` | 30 days  | Refresh token                 |

Expiry is handled transparently: every authenticated community endpoint runs
through `withAuthRefresh()` ([api/_lib/coin-communities.js](../api/_lib/coin-communities.js)),
which exchanges `cc_rt` for a fresh access token and re-sets both cookies on the
response. It fires on both ways a session goes stale:

1. **The `cc_at` cookie is gone.** This is the ordinary case an hour after
   sign-in, since the cookie and the JWT inside it share the same 1h lifetime,
   so the request arrives carrying only `cc_rt`. The refresh runs first and the
   call proceeds on the new token.
2. **The cookie is still there but the upstream answers 401** (a revoked or
   early-expired JWT). The call is retried once on the refreshed token.

Handlers must therefore test "is this user signed in?" with `hasUserSession(req)`,
which accepts either cookie, rather than `userAuthHeaders(req)`, which only sees
`cc_at` and would call an hours-old but perfectly valid session a stranger.
Callers only appear signed out when the 30-day refresh token itself is missing or
expired, so an open `/play` tab no longer kicks you out after the first hour.

## API Keys

API keys are for server-to-server access where session cookies don't apply — CI pipelines, backend integrations, CLI tools.

### Key format

Keys are prefixed `sk_live_` and are shown exactly once at creation. They are stored as a SHA-256 hash; if you lose the key, create a new one.

### Creating a key

Via the dashboard at `/dashboard` → **API Keys** → **Create Key**, or via the API while authenticated:

```js
const res = await fetch('/api/api-keys', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'My Integration',
    scope: 'avatars:read avatars:write',
    expires_at: '2027-01-01T00:00:00Z', // optional
  }),
});
const { data } = await res.json();
// data.token = "sk_live_xxxxx" — store this; it won't be shown again
```

### Using a key

Pass it as a Bearer token:

```js
const res = await fetch('/api/agents', {
  headers: { 'Authorization': 'Bearer sk_live_xxxxx' }
});
```

### Available scopes

| Scope | Access |
|-------|--------|
| `avatars:read` | Read avatar data |
| `avatars:write` | Create and update avatars |
| `avatars:delete` | Delete avatars |
| `agents:read` | Read agent data |
| `agents:write` | Create and update agents |
| `memory:read` | Read agent memory |
| `memory:write` | Write agent memory |
| `profile` | Read/write profile data; required to manage API keys themselves |
| `herald:announce` | Post announcements through the [Herald](herald.md) (`POST /api/herald/announce`); the scope the `herald-mcp` package's `THREE_WS_API_KEY` needs |

Scopes are space-separated in the `scope` field. Default when unspecified: `avatars:read avatars:write`.

> **Security:** Treat API keys as passwords. Never commit them to source control. Set the minimum scope your integration actually needs. Set an `expires_at` on keys that don't need to be permanent. Rotate keys after personnel changes.

### Revoking a key

```js
await fetch(`/api/api-keys/${keyId}`, {
  method: 'DELETE',
  credentials: 'include',
});
```

Or revoke via the dashboard. Revocation takes effect immediately — the key will start returning `401`.

---

## OAuth 2.1 (Third-Party App Integration)

If you're building a third-party app that users authorize to access their three.ws account — similar to how OAuth works with GitHub or Google — use the OAuth 2.1 endpoints. This is distinct from API keys (which you create for yourself).

| Endpoint | Description |
|----------|-------------|
| `GET /api/oauth/authorize` | Render consent screen |
| `POST /api/oauth/authorize` | Submit consent |
| `POST /api/oauth/token` | Exchange code for tokens |
| `POST /api/oauth/revoke` | Revoke a token |
| `POST /api/oauth/introspect` | Inspect a token |
| `POST /api/oauth/register` | Dynamic client registration (RFC 7591) |

PKCE (S256) is mandatory. The authorization server metadata is at `/.well-known/oauth-authorization-server`.

### Client authentication

Public clients (`token_endpoint_auth_method: "none"`, the default from dynamic registration) get no secret and identify themselves with a `client_id` form field.

Confidential clients present their secret the same way at `/api/oauth/token`, `/api/oauth/revoke`, and `/api/oauth/introspect`, using whichever method they registered:

```bash
# client_secret_basic: credentials in the Authorization header, nothing in the form
curl -X POST https://three.ws/api/oauth/revoke \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "token=$REFRESH_TOKEN"

# client_secret_post: credentials in the form body
curl -X POST https://three.ws/api/oauth/revoke \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "token=$REFRESH_TOKEN"
```

Registration returns `client_secret_expires_at: 0` alongside an issued secret: three.ws secrets do not expire, so rotate one by registering a new client. It also echoes back every optional field you registered (`client_uri`, `logo_uri`, `software_id`, `software_version`), so the response is the authoritative record of what was stored (RFC 7591 section 3.2.1). Do not re-register to "fix" a field you sent; a second registration issues a second `client_id`.

A rejected secret returns `401` with `{"error": "invalid_client"}`. If you sent the credentials in the `Authorization` header, the response also carries a `WWW-Authenticate: Basic realm="oauth", error="invalid_client"` challenge, as RFC 6749 section 5.2 requires. Treat it as a permanent credential failure, not a retryable one.

### Resource indicators (RFC 8707)

three.ws issues access tokens for exactly one resource, its MCP server. If you pass `resource`, it must name that server; anything else is rejected with `invalid_target` at both `/api/oauth/authorize` and `/api/oauth/token`, rather than handing you a token whose audience is something you did not ask for. A trailing slash is ignored, and omitting the parameter entirely is fine.

```bash
# The canonical value, also published as `resource` in
# /.well-known/oauth-protected-resource
curl -X POST https://three.ws/api/oauth/token \
  -d "grant_type=authorization_code" \
  -d "client_id=$CLIENT_ID" \
  -d "code=$CODE" \
  -d "redirect_uri=$REDIRECT_URI" \
  -d "code_verifier=$VERIFIER" \
  -d "resource=https://three.ws/api/mcp"
```

For most use cases, API keys are simpler. OAuth is the right choice when you're building a product where your users grant your app access to their three.ws data.

---

## Multi-Wallet Support

A user can link multiple Ethereum addresses to one account. All linked addresses authenticate as the same user.

### Linking a wallet

Linking requires the user to sign a SIWE (EIP-4361) challenge with the wallet they want to add. `POST /api/auth/wallets/nonce` returns the exact message to sign; sign it and submit:

```js
// 1. Get the link message (must be signed in already; the nonce is bound to
//    your session). POST with the wallet address and its chain id.
const { nonce, message } = await fetch('/api/auth/wallets/nonce', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: walletAddress, chainId: 8453 }),
}).then(r => r.json());
// message is a full EIP-4361 text: "three.ws wants you to sign in… Link this
// wallet to three.ws account <email> … Nonce: … Expiration Time: …"

// 2. Sign the message with the new wallet
const signature = await signer.signMessage(message);

// 3. Submit the signed message
await fetch('/api/auth/wallets', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message, signature }),
});
```

(`GET /api/auth/wallets/nonce` also works: it returns `{ nonce, domain, uri }` for clients that build the SIWE message themselves. Solana wallets use the parallel `nonce-solana` + `link-solana` actions with a Sign-In-With-Solana message.)

### Listing linked wallets

```js
const { wallets } = await fetch('/api/auth/wallets', {
  credentials: 'include'
}).then(r => r.json());
// wallets: [{ address, chain_id, chain_type, created_at, is_primary }, ...]
```

### Removing a wallet

Unlinking is a state-changing call, so it needs a CSRF token (one-time, from `GET /api/csrf-token`) in the `X-CSRF-Token` header:

```js
const { token } = await fetch('/api/csrf-token', { credentials: 'include' }).then(r => r.json());
await fetch(`/api/auth/wallets/${address}`, {
  method: 'DELETE',
  credentials: 'include',
  headers: { 'X-CSRF-Token': token },
});
```

You cannot remove a wallet if it is the only one linked.

---

## Auth in Embedded Widgets

The `<agent-3d>` web component does **not** require authentication to load and display an agent. Unauthenticated users can view any public agent.

Authentication is only needed for:

- **Editing** an agent (the agent edit UI)
- **Publishing** / on-chain registration
- **Writing to persistent memory** (IPFS mode)
- **API key-protected endpoints** you've configured for your agent

For embedded widgets with read-only access, ship without any auth plumbing.

---

## Self-Hosting: Required Environment Variables

```env
# Session signing + key derivation — required
# Generate with: openssl rand -base64 64
JWT_SECRET=

# Active key ID (for future rotation)
JWT_KID=k1

# Canonical app origin — used to validate SIWE domain/URI
PUBLIC_APP_ORIGIN=https://yourdomain.com

# Database
DATABASE_URL=postgresql://...

# Privy (optional — needed only if you want social/email login)
VITE_PRIVY_APP_ID=
PRIVY_APP_ID=

# WalletConnect (optional — needed only for mobile wallet QR flow)
VITE_WALLETCONNECT_PROJECT_ID=
```

> **JWT_SECRET is critical.** It signs all session tokens and is used (via HKDF) to derive the AES-256-GCM key that encrypts agent wallet private keys. Generate it with `openssl rand -base64 64`. Never commit it. Rotate it by appending to the key set — never remove the old key while active sessions exist.

Password hashing cost is configurable via `PASSWORD_ROUNDS` (default: `11` bcrypt rounds).

---

## Related

- [API reference](/docs/api-reference): every endpoint, including the auth routes above
- [ERC-8004 identity](/docs/erc8004): what a connected wallet unlocks on-chain
- [Embedding guide](/docs/embedding): embeds work unauthenticated; auth is only for editing and publishing
- [Architecture overview](/docs/architecture): where sessions and the API server fit
