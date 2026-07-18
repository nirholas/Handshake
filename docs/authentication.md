# Authentication

Authentication is how three.ws knows who you are: it protects your agents, your avatars, and your dashboard, and it is required for anything that writes data. Sign in at [three.ws/login](https://three.ws/login) with a crypto wallet or a plain email/social account; developers can also mint API keys for scripts and servers.

three.ws supports three authentication methods. Which one you need depends on how you're building:

| Method | Best for |
|--------|----------|
| **Sign-In With Ethereum (SIWE)** | Users with a browser wallet (MetaMask, Coinbase Wallet, etc.) |
| **Privy** | Users without a wallet — email, Google, Twitter, Discord login |
| **API keys** | Server-to-server and programmatic access |

Authentication controls who can edit or publish an agent, which agents a user owns (for on-chain operations), rate limiting and usage tracking, and access to the dashboard and API.

---

## Sign-In With Ethereum (SIWE)

SIWE ([EIP-4361](https://eips.ethereum.org/EIPS/eip-4361)) lets users authenticate by signing a message with their Ethereum wallet — no password, no email required.

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

> **Security note:** Never submit the SIWE message to a domain other than where the nonce was issued. The backend validates that `domain` and `uri` in the message match the deployment's `APP_ORIGIN`. Replaying a valid signature from a phishing page is rejected.

### Terms of Service acceptance

Every auth endpoint accepts an optional `tosAccepted: true` body field. Send it whenever your UI showed the user the [Terms of Service](https://three.ws/legal/tos) agreement (a checkbox, a "By signing in you agree" notice, or the agreement sentence inside the signed wallet statement). The server writes a durable acceptance record (audit log + the accepted Terms version on the user row). Two rules:

- `POST /api/auth/register` **requires** `tosAccepted: true`; account creation without it fails with `400 tos_required`. Registration UIs must show a real agreement control.
- Wallet and Privy verifies (`/api/auth/siwe/verify`, `/api/auth/siws/verify`, `/api/auth/privy/verify`) and `POST /api/auth/login` treat it as an affirmation: acceptance is recorded on every sign-in, so users converge onto the current Terms version over time.

An already-signed-in user can also record acceptance directly with `POST /api/legal/tos-ack { version?, context? }`, which mirrors the risk-acknowledgment endpoint (`/api/legal/risk-ack`).

---

## Privy (Social / Email Auth)

Privy lets users log in with email, Google, Twitter, or Discord. Each Privy account gets a wallet managed by Privy's MPC system, so users get wallet-based identity without needing MetaMask or any browser extension.

### Why use Privy

Not every user has a crypto wallet. If your audience includes non-web3 users, Privy removes the wallet prerequisite while still giving those users an Ethereum address they can use for on-chain operations later.

### How it works

1. The frontend initiates login via the Privy client SDK (using `VITE_PRIVY_APP_ID`).
2. Privy handles the OAuth UI — email magic link, Google OAuth, etc.
3. On success, Privy issues an identity token (a JWT signed with Privy's ES256 key).
4. Your frontend posts that token to `POST /api/auth/privy/verify`.
5. The backend fetches Privy's JWKS, verifies the token signature and audience, and finds-or-creates the user record (keyed on the Privy DID).
6. Linked wallets are synced best-effort from Privy's server API into the user's wallet list; a login with no wallet still succeeds.
7. A session cookie is issued; from this point the user is authenticated identically to a SIWE user.

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

A `401` response means no valid session exists.

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
which retries a failed upstream call once after exchanging `cc_rt` for a fresh
access token and re-setting both cookies on the response. Callers only appear
signed out when the 30-day refresh token itself is missing or expired, so an
open `/play` tab no longer kicks you out after the first hour.

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
