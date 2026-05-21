# Persona Hub

## Overview

Persona Hub is three.ws's cross-app sign-in: a user creates and stores their three.ws avatar once, then any tenant site embedding the `<three-ws-signin>` widget can request a short-lived JWT that bears the user's avatar URL. three.ws itself **issues** the token — from a popup served on `three.ws`, against the user's session cookie — and tenants **verify** it server-side, either offline against the published JWKS (when the deployment is running in ES256 mode) or by calling the public `/api/auth/persona/verify` endpoint. ES256 is the preferred algorithm because the public key is published at [/.well-known/jwks.json](https://three.ws/.well-known/jwks.json) and tenants can verify without a network round-trip.

The pattern is one avatar, many sites — redesigned around three.ws's own auth stack.

---

## How it works

```
   tenant site                three.ws (popup)               three.ws backend
        │                            │                              │
   1.   ├── <three-ws-signin> ───────┤                              │
        │     button clicked         │                              │
        │                            │                              │
   2.   ├── window.open() ──────────►│ /persona/authorize.html      │
        │                            │  (consent screen)            │
        │                            │                              │
   3.   │                            │ GET /api/auth/persona/me ───►│
        │                            │  ◄────────── user + avatars  │
        │                            │                              │
   4.   │                            │ user picks avatar, clicks    │
        │                            │ "Authorize"                  │
        │                            │                              │
   5.   │                            │ POST /api/auth/persona/issue►│
        │                            │  body { tenant_origin,       │
        │                            │         avatar_id }          │
        │                            │  ◄──── { token, avatar }     │
        │                            │                              │
   6.   │◄── postMessage ────────────┤  closes popup                │
        │  { token, avatar }         │                              │
        │                            │                              │
   7.   ├── (optional) verify        │                              │
        │   GET /api/auth/persona/verify?token=…&audience=…  ──────►│
        │   ◄────────────── { sub, avatar, exp }                    │
```

The cookie carrying the user's three.ws session is `__Host-sid` — locked to the exact host. The popup runs on `three.ws` so the consent screen can read it; the tenant never sees it. Cross-site avatar sharing happens entirely via the postMessage-delivered JWT.

---

## Embedding the widget

```html
<script src="https://three.ws/persona/widget.js" defer></script>

<three-ws-signin
    client-origin="https://coolgame.three.ws"
    label="Sign in with three.ws">
</three-ws-signin>
```

Listen for the result:

```js
const el = document.querySelector('three-ws-signin');
el.addEventListener('three-ws:authorized', (e) => {
  const { token, avatar, expires_in } = e.detail;
  // avatar: { id, url, thumbnail_url, name }
  // token: 24h JWT — verify server-side before trusting
});
el.addEventListener('three-ws:cancelled', () => {
  // user closed the popup or hit Cancel
});
```

### Programmatic API

```js
const result = await window.ThreeWsPersona.signIn({
  clientOrigin: 'https://coolgame.three.ws',
});
// result.token, result.avatar
```

---

## Key generation

Run [scripts/generate-persona-key.mjs](../scripts/generate-persona-key.mjs) once per deployment to produce an ES256 (P-256) keypair:

```bash
node scripts/generate-persona-key.mjs
# or pin a custom key id:
node scripts/generate-persona-key.mjs --kid=persona-2026-05
```

The script writes nothing to disk. It prints a copy-pasteable block to stdout:

```
PERSONA_JWKS_KID=persona-2026-05-20
PERSONA_JWKS_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\nMIGH…\n-----END PRIVATE KEY-----"
# Optional — derived from private key if omitted:
# PERSONA_JWKS_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----\nMFkw…\n-----END PUBLIC KEY-----"
```

followed by the public JWK that `/.well-known/jwks.json` will publish once the env vars take effect. Three env vars are involved:

| Variable | Required | Purpose |
|---|---|---|
| `PERSONA_JWKS_PRIVATE_KEY_PEM` | yes (to enable ES256) | PKCS8 PEM with `\n` escaped. The server signs persona tokens with this key. Without it, the server falls back to HS256. |
| `PERSONA_JWKS_KID` | no (defaults to `persona-es256-1`) | Key id published in the JWK and embedded in the JWT header so tenants can pick the right key after rotation. |
| `PERSONA_JWKS_PUBLIC_KEY_PEM` | no | SPKI PEM. If omitted, the public JWK is derived from the private key at runtime. Set this only if you want to publish a different public key (rare). |

Paste the block into the deployment's environment (Vercel project settings, `.env.local` for dev), redeploy, and confirm the new key is live with:

```bash
curl https://three.ws/.well-known/jwks.json
```

The response should contain one entry under `keys` whose `kid` matches `PERSONA_JWKS_KID`. The private key must never leave the server — it is the sole signer for every persona token issued by this deployment.

---

## Issuing a token

`POST /api/auth/persona/issue` — defined in [api/auth/persona/\[action\].js](../api/auth/persona/%5Baction%5D.js) (`handleIssue`).

| | |
|---|---|
| Method | `POST` |
| Auth | three.ws session: a valid `__Host-sid` cookie sent with `credentials: 'include'` |
| Body | `{ "tenant_origin": "<https origin>", "avatar_id"?: "<uuid>" }` |
| Success | `200` with `{ token, expires_in, avatar, tenant_origin, alg }` |
| Errors | `401 unauthorized` — no session. `400 invalid_request` — `tenant_origin` is not a `three.ws` subdomain or `localhost`. `404 no_avatar` — user has no avatar yet. |

`tenant_origin` must be a bare origin (no path, no query, no fragment), `https://*.three.ws` or `https://three.ws`, or — for dev — `http://localhost[:port]` / `http://127.0.0.1[:port]`. Anything else is rejected with `400 invalid_request`. The validator is `validateTenantOrigin()` in [api/auth/persona/\[action\].js](../api/auth/persona/%5Baction%5D.js); add a subdomain by editing that function.

When `avatar_id` is omitted, the user's most recently created avatar is used. Pass `avatar_id` from the consent UI's picker to bind a specific avatar to the token.

### curl

The endpoint requires a real session, so this only succeeds when the caller is signed in to `three.ws` (the cookie value below is illustrative — copy yours from the browser's devtools after signing in):

```bash
curl -sS -X POST https://three.ws/api/auth/persona/issue \
  -H 'content-type: application/json' \
  -H 'cookie: __Host-sid=<your session cookie value>' \
  --data '{"tenant_origin":"https://coolgame.three.ws"}'
```

Without a session you get `401 unauthorized`:

```json
{ "error": "unauthorized", "error_description": "sign in to three.ws first" }
```

A successful response looks like:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsImtpZCI6ImsxIiwidHlwIjoiSldUIn0…",
  "expires_in": 86400,
  "avatar": {
    "id": "a-1",
    "name": "My Avatar",
    "url": "https://cdn.three.ws/u/<user>/avatar.glb",
    "thumbnail_url": "https://cdn.three.ws/u/<user>/avatar.png"
  },
  "tenant_origin": "https://coolgame.three.ws",
  "alg": "ES256"
}
```

`alg` reflects the signing mode this deployment is currently in (`ES256` when a persona keypair is configured, `HS256` otherwise — see [ES256 vs HS256 fallback](#es256-vs-hs256-fallback)).

### fetch (from the consent popup)

```js
const res = await fetch('/api/auth/persona/issue', {
  method: 'POST',
  credentials: 'include',          // sends __Host-sid
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tenant_origin: 'https://coolgame.three.ws',
    avatar_id: 'a-1',              // optional — defaults to newest
  }),
});
if (!res.ok) {
  const { error, error_description } = await res.json();
  throw new Error(`${error}: ${error_description}`);
}
const { token, avatar, expires_in, alg } = await res.json();
```

### Decoded JWT claims

The base64url payload of the issued token decodes to:

```json
{
  "scope": "persona:read avatar:read",
  "token_use": "persona",
  "avatar": {
    "id": "a-1",
    "name": "My Avatar",
    "url": "https://cdn.three.ws/u/<user>/avatar.glb",
    "thumbnail_url": "https://cdn.three.ws/u/<user>/avatar.png"
  },
  "iss": "https://three.ws",
  "sub": "<three.ws user id>",
  "aud": "https://coolgame.three.ws",
  "iat": 1747699200,
  "exp": 1747785600,
  "jti": "<16-byte random hex>"
}
```

Header:

```json
{ "alg": "ES256", "kid": "persona-2026-05-20", "typ": "JWT" }
```

`alg` is `ES256` in ES mode and `HS256` in fallback. `kid` is `PERSONA_JWKS_KID` in ES mode and `JWT_KID` (defaults to `k1`) in fallback. Both modes set the same payload claims — the only thing that changes is how the signature is produced and verified.

---

## Verifying a token (tenant side)

A persona token must always be verified before the tenant trusts any claim on it. There are two paths:

1. **Offline against the JWKS** (`ES256` only). The tenant fetches [https://three.ws/.well-known/jwks.json](https://three.ws/.well-known/jwks.json) once, caches it, and verifies the signature locally.
2. **Online against the verify endpoint** (works for both `ES256` and `HS256`). The tenant calls `GET /api/auth/persona/verify?token=…&audience=…` and trusts the response.

Use path 1 in production when ES256 is active — it's free, cache-friendly, and doesn't depend on three.ws being reachable on the verify path. Use path 2 as a universal fallback.

### Node.js (offline, JWKS) — recommended

```js
import { jwtVerify, createRemoteJWKSet } from 'jose';

// createRemoteJWKSet fetches the JWKS once and caches it in memory.
// The cache invalidates on `kid` miss so key rotation is automatic.
const JWKS = createRemoteJWKSet(
  new URL('https://three.ws/.well-known/jwks.json'),
);

export async function verifyPersonaToken(token, tenantOrigin) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: 'https://three.ws',
    audience: tenantOrigin,        // must match what you embedded with
    algorithms: ['ES256'],
  });
  // payload.sub        — three.ws user id (stable across sessions)
  // payload.avatar     — { id, name, url, thumbnail_url }
  // payload.scope      — "persona:read avatar:read"
  // payload.exp        — unix timestamp
  return payload;
}
```

Install `jose` (`npm install jose`) — that's the only dependency. The JWKS handle is reusable across requests; do not construct a new one per call.

### Browser (offline, JWKS via ESM CDN)

```html
<script type="module">
  import { jwtVerify, createRemoteJWKSet } from 'https://esm.sh/jose@5';

  const JWKS = createRemoteJWKSet(
    new URL('https://three.ws/.well-known/jwks.json'),
  );

  async function verify(token, tenantOrigin) {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: 'https://three.ws',
      audience: tenantOrigin,
      algorithms: ['ES256'],
    });
    return payload;
  }

  // example wiring against the widget
  document.querySelector('three-ws-signin')
    .addEventListener('three-ws:authorized', async (e) => {
      const claims = await verify(e.detail.token, 'https://coolgame.three.ws');
      console.log('signed in as', claims.sub, claims.avatar);
    });
</script>
```

If you bundle (Vite / webpack / esbuild), drop the CDN URL and import from `jose` directly — same API. Browser-side verification is only safe for UI hints — anything privileged on the tenant must still re-verify on the tenant's server. The browser cannot keep an audience binding honest if the calling page is compromised.

### Online verify (works for ES256 *and* HS256)

```js
const url = new URL('https://three.ws/api/auth/persona/verify');
url.searchParams.set('token', token);
url.searchParams.set('audience', 'https://coolgame.three.ws');
const res = await fetch(url);
if (!res.ok) {
  const { error, error_description } = await res.json();
  throw new Error(`${error}: ${error_description}`);
}
const claims = await res.json();
// claims: { ok, sub, aud, scope, exp, avatar }
```

The verify endpoint applies the same checks as `jose.jwtVerify` — signature, issuer (`https://three.ws`), audience match, expiry — and additionally rejects tokens whose `token_use` claim is not `"persona"`.

---

## ES256 vs HS256 fallback

The signing algorithm is decided at issue time by [api/auth/persona/\[action\].js:158-161](../api/auth/persona/%5Baction%5D.js):

```js
const es = await esKeys();                      // null if PERSONA_JWKS_PRIVATE_KEY_PEM is unset
const alg = es ? 'ES256' : 'HS256';
const kid = es ? es.kid : env.JWT_KID;
const signingKey = es ? es.privateKey : hsKey();
```

- **ES256 (preferred).** Active when `PERSONA_JWKS_PRIVATE_KEY_PEM` is set. The server signs with the EC P-256 private key; the public key is published at `/.well-known/jwks.json` so tenants verify offline.
- **HS256 (fallback).** Active when `PERSONA_JWKS_PRIVATE_KEY_PEM` is **unset**. The server signs with the `JWT_SECRET` HMAC secret. `/.well-known/jwks.json` returns `{"keys": []}` and includes a diagnostic header `x-three-ws-status: no PERSONA_JWKS_PRIVATE_KEY_PEM configured; persona tokens are HS256, verify via /api/auth/persona/verify`.

Verification accepts both algorithms in either order — the `/verify` endpoint tries ES256 first and falls back to HS256 — so tokens minted just before a key rollover keep working until they expire. The `alg` field in the issue response tells the client which mode was used; tenants do not need to branch on it (the offline path simply requires `ES256`).

**What tenants should do in an HS256 deployment.** Skip JWKS entirely — the HMAC secret cannot be published, so offline verification is impossible. Always call `GET /api/auth/persona/verify?token=…&audience=…` from your server. If a tenant's runtime requires offline verification (e.g. an edge worker that must not call out to three.ws on the hot path), file an issue against the deployment owner to install a persona keypair before launch.

---

## Tokens in practice

- **TTL.** 24 hours (`PERSONA_TTL_SEC = 60 * 60 * 24`, [api/auth/persona/\[action\].js:42](../api/auth/persona/%5Baction%5D.js#L42)). Tenants that need a longer-lived session must mint their own session from the persona token's `sub` after verifying — do not extend the persona JWT itself.
- **Rotation.** Generate a new keypair with `node scripts/generate-persona-key.mjs`, deploy with a new `PERSONA_JWKS_KID`, and the JWKS publishes the new key. Old tokens continue to verify against `/api/auth/persona/verify` while they live; once the longest possible token TTL has elapsed (24h), no token in the wild still references the old `kid`. The deployment can serve both old and new keys side by side by adding extra entries to the `keys` array — the current handler emits a single key but the verifier accepts any matching `kid` from the published set.
- **Revocation.** There is **no** revocation list. Defense is the short TTL: 24 hours. If a token must be invalidated sooner, the tenant should treat its own server-issued session as the source of truth and invalidate that. If a private key is leaked, rotate `PERSONA_JWKS_PRIVATE_KEY_PEM` and `PERSONA_JWKS_KID`; verification of any token signed with the old key will fail as soon as the old JWK is removed from the published set.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| `jwks_uri unreachable` (browser console / fetch failure) | Confirm `https://three.ws/.well-known/jwks.json` returns `200`. If it returns `{"keys":[]}` *and* the response carries `x-three-ws-status: …HS256…`, the deployment is in HS256 fallback — offline verification cannot work, switch to the `/api/auth/persona/verify` path. |
| `JWKSNoMatchingKey` / `kid not found` | The token was signed with a key the JWKS no longer publishes (key was rotated and the old entry removed). Either redeploy with the old key added back to the published set, or have the user re-authorize so a fresh token is minted under the current `kid`. |
| `alg mismatch` from `jwtVerify` | The token's `alg` header doesn't match `algorithms: ['ES256']`. If the issue response returned `alg: "HS256"`, the deployment is in fallback — call `/api/auth/persona/verify` instead. Never pass `algorithms: ['HS256']` to a remote-JWKS verifier; HS256 is symmetric and the secret cannot be published. |
| `JWTClaimValidationFailed: "aud" claim check failed` | The `audience` you passed to `jwtVerify` (or to `/verify`) doesn't match the token's `aud`. Audience is the exact `tenant_origin` used at issue time — case-sensitive, no trailing slash. |
| `JWTExpired: "exp" claim timestamp check failed` | Token is older than 24 h. Have the user re-authorize through the widget. There is no refresh endpoint — persona tokens are not refreshable by design. |
| `invalid_token: token is not a persona token` from `/verify` | The token validates cryptographically but its `token_use` claim is not `"persona"`. Tokens issued by the main three.ws auth stack are not accepted on this endpoint. |
| `400 invalid_request` on `/issue` with `tenant_origin must be a https three.ws subdomain or localhost dev origin` | The origin contains a path / query / fragment, is not `https`, or is not a `three.ws` subdomain. Pass a bare origin like `https://coolgame.three.ws`. Add a new subdomain by editing `validateTenantOrigin()` in [api/auth/persona/\[action\].js](../api/auth/persona/%5Baction%5D.js). |

---

## Allowed tenant origins

`/api/auth/persona/issue` accepts these origins for `tenant_origin`:

- `https://three.ws`
- `https://<anything>.three.ws`
- `http://localhost[:port]` and `http://127.0.0.1[:port]` (dev only)

Other origins return `400 invalid_request`. This is the chokepoint that prevents arbitrary sites from minting tokens claiming any user's three.ws avatar.

---

## Endpoint reference

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| [/api/auth/persona/me](../api/auth/persona/%5Baction%5D.js) | `GET` | three.ws session | Lists the user's avatars for the consent UI. |
| [/api/auth/persona/issue](../api/auth/persona/%5Baction%5D.js) | `POST` | three.ws session | Mints a 24h persona JWT for `{ tenant_origin, avatar_id }`. |
| [/api/auth/persona/verify](../api/auth/persona/%5Baction%5D.js) | `GET` | none | Verifies a token's signature, issuer, audience, expiry, and `token_use`. |
| [/.well-known/jwks.json](https://three.ws/.well-known/jwks.json) | `GET` | none | Publishes the active persona public key (empty array in HS256 fallback). |

JWT claims:

| Claim | Value |
|---|---|
| `iss` | `https://three.ws` (the deployment's `PUBLIC_APP_ORIGIN`) |
| `sub` | three.ws user id |
| `aud` | tenant origin (validated against the issued audience on verify) |
| `scope` | `persona:read avatar:read` |
| `token_use` | `persona` |
| `avatar` | `{ id, name, url, thumbnail_url }` |
| `iat` / `exp` | issued at / expires at (24h TTL) |
| `jti` | unique token id (16 random bytes) |

---

## Threat model notes

- **Origin spoofing.** The popup posts back only to the `tenant_origin` it was opened with. The browser enforces this via the second argument to `postMessage`, so a malicious script on another tab cannot receive the token.
- **Replay between tenants.** Each token's `aud` is bound to the issuing tenant. `verify` requires the caller to supply the audience — if a token issued for `coolgame.three.ws` is replayed against `evilgame.three.ws`, verification fails.
- **State CSRF.** The widget generates a per-popup `state` nonce; the popup echoes it back in the postMessage payload. The widget rejects messages whose `state` doesn't match.
- **Token theft via XSS on tenant.** A compromised tenant could leak tokens, but the blast radius is limited to that user's avatar URL (already publicly fetchable in most flows) plus their three.ws user id. No write scopes are granted by a persona token.
