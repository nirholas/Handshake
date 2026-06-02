# Autonomous Drive Report

Started: 2026-04-20
Scope: full project, no commits (user handles), uncommitted changes untouched.

## Baseline

- Branch: `main`, clean against origin/main per `git status`.
- Heavy WIP: 60+ modified files + several untracked tests (api-keys, validator,
  widget-types). Did not modify any of these.
- Pre-run test count: 220 passing, 1 failing in `tests/api/api-keys.test.js`
  (pre-existing; see "Findings" below).

## Actions taken

### 1. New OAuth authorize tests — `tests/api/oauth-authorize.test.js`

22 tests covering the security-critical authorization endpoint:

- **Validation**: response_type, client_id, redirect_uri, code_challenge,
  code_challenge_method (PKCE mandatory, S256 only — rejects `plain`).
- **Strict redirect_uri matching (RFC 6749 §3.1.2.2)**: different host, extra
  path segment, different protocol, different port, query string, fragment —
  all rejected.
- **Unauthenticated flow**: bounce to `/login?next=…` preserving consent URL.
- **Consent page**: HTML render, CSP/frame-options headers, hidden inputs
  for PKCE round-trip.
- **POST consent**: code issuance, deny path, CSRF rejection, cross-site
  Origin rejection, scope intersection (drops scopes not in client.scope).
- **Method handling**: 405 on DELETE, 204 on OPTIONS preflight.

### 2. New OAuth token tests — `tests/api/oauth-token.test.js`

24 tests covering the token endpoint:

- **Client auth**: missing client_id, rate limit, unknown client, bad
  confidential secret, HTTP Basic credentials.
- **authorization_code grant**: missing fields, unknown code, replay defence
  (consumed code → revokes refresh chain), expired code, client mismatch,
  redirect_uri mismatch, PKCE failure, success path issues access+refresh
  with correct scope, omits refresh when client lacks the grant type.
- **refresh_token grant**: missing token, success rotation, scope narrowing
  on subset, **scope-widening attempt rejected with `invalid_scope`**,
  unknown-scope rejection, propagation of `invalid_grant` and
  `refresh_reuse_detected` errors.

### 3. New LLM proxy tests — `tests/api/llm-anthropic.test.js`

22 tests covering the we-pay LLM proxy:

- **Policy gating**: missing agent param (400), policy not found (404),
  brain.mode != we-pay (402), surface.script disabled (403).
- **Origin enforcement**: attacker origin rejected, server-to-server
  allowed, first-party localhost allowed.
- **Rate limiting**: per-IP and per-agent (when policy declares limit).
- **Monthly call quota**: enforced via Redis counter, `quota_exceeded` 429.
- **Monthly token budget**: enforced before forwarding (default
  1,000,000 tokens; `cost_limit_cents` overrides), debits actual usage on
  success, does NOT debit on upstream error.
- **Body + model**: empty messages rejected, model allowlist enforced,
  policy-default model used when omitted, caller override accepted.
- **Upstream**: success proxied unchanged, errors sanitized to generic 502
  (no leaking of upstream error body), usage event recorded with token
  counts.

### 4. ENS dedup TODO — re-examined and replaced with rationale

The TODO at `api/agents/ens/[name].js:45` suggested deduping with
`/api/agents/by-address/[addr].js`. After reading both endpoints, they
return very different shapes:

- ENS endpoint returns a full agent profile (name, description, avatar*id,
  erc8004*\*, etc.).
- by-address returns a minimal NFT-style shape ({id, chainId, agentURI,
  manifestUrl, onChain, source}) with chain enumeration fallback.

Extracting a shared helper would add abstraction without removing real
duplication (only ~6 lines of SQL overlap). Replaced the TODO with a
comment explaining the divergence so a future reader doesn't repeat the
investigation.

### 5. Removed-deps verification

`grep -r "fbx-parser|tweakpane"` across `src/`, `api/`, `public/`,
`scripts/` returned zero hits. `npm run build` succeeded (5.47s, 138 PWA
precache entries). The package.json removal of these two deps is clean.

## Test summary

| Suite           | Tests  | Status                       |
| --------------- | ------ | ---------------------------- |
| OAuth authorize | 22     | ✅                           |
| OAuth token     | 24     | ✅                           |
| LLM proxy       | 22     | ✅                           |
| **Newly added** | **68** | **✅**                       |
| Full suite      | 289    | 288 ✅ / 1 ❌ (pre-existing) |

## Findings requiring your decision

### 1. Pre-existing test failure (not caused by this session)

`tests/api/api-keys.test.js:166` expects:

```js
expect(body.data.token).toMatch(/^sk_live_[a-f0-9]+$/);
```

But `randomToken()` in `api/_lib/crypto.js` returns base64url, which uses
`-` and `_` and mixed case. The actual token format is, e.g.,
`sk_live_3pmN4jIKEd_eeKm4VFdvge_j8K1s_QeVcbLJlKNuTCY`. The regex was
written against a hex assumption that doesn't match the implementation.

**Suggested fix** (one-line): change the regex to
`/^sk_live_[A-Za-z0-9_-]+$/`. Did not edit because this test file is in
your untracked WIP and I don't want to step on in-progress work.

### 2. Coverage gaps still open

Areas with significant uncommitted security logic but no tests yet:

- `api/auth/register.js` — unified error-message changes (now returns
  `conflict` instead of `username_taken` / `email_taken`).
- `api/_lib/auth.js` — session rotation logic in `getSessionUser` (rolling
  refresh window).
- `api/oauth/introspect.js` and `api/oauth/revoke.js` — both modified, no
  dedicated test files.

These are good candidates for a follow-on session.

### 3. Things I deliberately did NOT touch

- All 60+ files in your `git status` modified list.
- All other untracked files (`tests/api/api-keys.test.js`,
  `tests/src/validator.test.js`, `tests/src/widget-types.test.js`).
- `package.json` (already in your WIP).
- `CLAUDE.md` and other docs in your WIP.

Nothing was committed or pushed. All changes from this session are:

- New: `tests/api/oauth-authorize.test.js`
- New: `tests/api/oauth-token.test.js`
- New: `tests/api/llm-anthropic.test.js`
- Edited: `api/agents/ens/[name].js` (TODO → rationale comment, ~6 lines)
- Edited: this report.

---

# Second pass — formatting + broken refs (parallel session)

This appears to be a second autonomous session running in parallel with the
one above. Different scope; appending so neither is lost. Heads up: another
session wrote the section above, then commits `84e5249` and `b6cb561`
absorbed all in-progress work into git.

## Verification at end-of-session

- `npm test` → 18 files / 355 tests / 0 failures.
- `npm run build` → clean, no warnings, 138 PWA precache entries.
- `npx prettier --check .` → clean.
- `npm audit` → 0 vulnerabilities.

## Edits made

1. **`3d-demo/.prettierrc`** — `jsxBracketSameLine` → `bracketSameLine`
   (Prettier 3 deprecated the old name; was emitting a warning on every
   format run).
2. **`api/auth/wallets/_link-nonces.js:4`** — import path was `../_lib/crypto.js`
   which resolves to `api/auth/_lib/crypto.js` (does not exist). Corrected
   to `../../_lib/crypto.js` → `api/_lib/crypto.js`. This file is imported
   by `wallets/index.js` and `wallets/nonce.js`, so the wallet-link flow
   would have thrown at module load.
3. **`public/skills/subscription/skill.js:78`** — dynamic import path was
   `'../../src/permissions/grant-modal.js'`, which resolves to
   `public/src/permissions/grant-modal.js` and 404s in production. Changed
   to absolute `'/src/permissions/grant-modal.js'` to match the sibling
   `public/skills/tip-jar/skill.js:223` pattern.
4. **`public/dashboard/usage.html:7`** — removed `<link rel="stylesheet"
href="/assets/dashboard.css" />`. The file does not exist anywhere in
   the repo and was producing a guaranteed 404. Inline `<style>` block in
   the same file already covers all styling.
5. **`public/artifact/index.html:142`** — `<script src="artifact.js">`
   resolved to `/artifact/artifact.js` under the Vercel rewrite, which
   404s. The actual bundle is at `/public/artifact.js` (served at
   `/artifact.js`). Made the path absolute.
6. **Whole-repo `prettier --write`** — formatted ~80 files. All edits are
   formatting-only; no semantic changes.

## Findings requiring your decision

### 🔴 P0 — Live API key committed to git

`.mcp.json:6` contains:

```
"Authorization": "Bearer sk_live_…REDACTED — rotate this key"
```

The file is in `.gitignore` now but **was committed previously** (`git
ls-files .mcp.json` confirms it's tracked; `git log` shows commits
`0b745eb` and `a1109b9`). Anyone with read access to the repo (including
forks/clones) has this key.

Required action — not safe to do without you:

1. Revoke + rotate this API key immediately.
2. `git rm --cached .mcp.json` then commit the removal.
3. Rewrite history with `git-filter-repo` or BFG to scrub the key from
   past commits, then force-push (coordinate with anyone who has clones).

I did **not** delete the file or rewrite history.

### 🟡 P2 — `res.end(JSON.stringify(...))` deviations from `api/CLAUDE.md`

The convention says use `json(res, status, body)` from `api/_lib/http.js`.
Five spots ship raw `res.end(JSON.stringify(...))`:

- `api/agent-oembed.js:79`, `:160` — both intentional (special
  `application/json+oembed` content type); `json()` hardcodes
  `application/json`. Leave as-is or extend the helper.
- `api/widgets/oembed.js:86` — same oEmbed reason.
- `api/mcp.js:74`, `:703`, `:709` — JSON-RPC framing; leave as-is.
- `api/permissions/verify.js:80` — could migrate to `error()`. Trivial.

Only `permissions/verify.js` is a real cleanup candidate.

### 🟡 P2 — Sweep scripts

The auto-commit at `b6cb561` ("chore: add HTTP and page sweep scripts for
resource validation") committed two scratch scripts I'd written to drive
the page sweep:

- `tmp-http-sweep.mjs` — fetch HTML pages + sub-resource probes
- `tmp-page-sweep.mjs` — playwright variant (blocked: missing `libatk1.0`,
  no sudo)

If you want to keep them, move under `scripts/` and reinstall `cheerio`
(I uninstalled it because the script wasn't intended to land). If they
were committed by mistake, `git rm` them.

## What I checked and found nothing

- `npm audit` — 0 vulns.
- All JSON files (`vercel.json`, `package.json`, manifests, etc.) parse.
- HTTP sub-resource sweep across 28 built pages — every `<script src>`,
  `<link href>`, `<img src>` resolved to a 2xx. (Runtime JS errors NOT
  checked — playwright would not launch.)
- `forEach(async ...)` patterns — none.
- Static checks for unhandled `JSON.parse`, hardcoded sk-/AKIA-/ghp-
  prefixed secrets in `*.js`/`*.json` — only the one in `.mcp.json`.

## Coverage gaps observed (not addressed)

- No JS-runtime error sweep — chromium needs system libs that need sudo.
  Worth a follow-up on a machine where `npx playwright install --with-deps`
  works, or in CI.
- `knip` reports 600+ "unused" files but it has no config and treats every
  Vercel function entry + every HTML script as orphaned. Real dead-code
  audit needs a `knip.json` describing entry points.
