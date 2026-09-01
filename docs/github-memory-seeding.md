# GitHub memory seeding

Give an agent your work: your public GitHub profile and the repositories and
READMEs you pick, distilled and written into the agent's long-term memory, so
it can speak concretely about what you build instead of guessing.

This lane is built around one constraint. Connecting your GitHub account is
permission to read it. It is **not** permission to read all of it. The
connection unlocks the consent screen, and the consent screen is a per-item
catalog: your profile, your pinned repositories, your recent public
repositories, and a separate README tick per repository. **A seed reads exactly
the items you ticked and nothing else**, and the server enforces that by
refusing any selection that names an item the catalog never showed you.

There are two ways to connect and they meet immediately: OAuth, one click,
available when the deployment has a GitHub OAuth app registered; or a personal
access token you mint yourself, available always, which is the way in when no
OAuth app exists and which is refused outright if it carries more access than
seeding can use. Both write the same encrypted connection record and lead to
the same consent screen.

- **Surface**: Settings, Connected accounts, GitHub card at [/settings#connected-accounts](https://three.ws/settings#connected-accounts)
- **API**: `/api/agents/:id/memory/seed/github`, `/api/auth/github/token`
- **Related**: [Memory system](./memory.md), [X memory seeding](./x-memory-seeding.md), [Farcaster memory seeding](./farcaster-memory-seeding.md)

---

## How it fits together

```
 Connect GitHub (OAuth, or a personal access token you paste)
        │   either way the token is stored encrypted, and the
        │   connection alone reads and stores nothing
        ▼
 GET /api/agents/:id/memory/seed/github
        │   builds the consent catalog live from GitHub:
        │   your profile, pinned repos first, then recent public repos
        ▼
 you tick the profile, the repos, and per-repo READMEs
        │
        ▼
 POST … { include_profile, repos: [...], readmes: [...] }
        │   every key is validated against the catalog you were shown;
        │   one unknown key rejects the whole run, nothing is seeded
        ▼
 only the ticked items are read, distilled into up to 20 short facts,
 written to agent_memories tagged github_seed with the exact selection
 recorded on every row
        │
        ▼
 DELETE /api/agents/:id/memory/seed/github   (or disconnect GitHub entirely)
        │   deletes every GitHub-seeded memory
        ▼
 nothing distilled from your account survives
```

Three properties fall out of that shape:

- **Nothing is stored before the tick.** The GET reads GitHub and writes
  nothing; the POST reads only the keys the body names, and only after each
  one matched the catalog. The per-agent seed budget (one seed per 6 hours)
  is consumed only after ownership, connection, and selection validity all
  pass, so a rejected call never burns your window.
- **The narrowing is server-side, not UI-side.** The same catalog the consent
  screen rendered is rebuilt on POST and intersected with your selection
  (`resolveSelection`). A hand-crafted request for a repo you were never
  shown answers `400 invalid_selection` and seeds nothing.
- **Revocation is total.** Every seeded row carries `source: 'github_seed'`
  in its context. Revoking per agent deletes exactly those rows;
  disconnecting GitHub from Settings deletes them across **all** of your
  agents, drops the connection, and revokes the grant on GitHub's side too.

## What is read, and what is not

The consent catalog shows each item before it can be selected. The same module
(`api/_lib/github-seed.js`) both renders the catalog and enforces the
selection, so the promise and the code cannot drift apart.

| Read | Never read |
|---|---|
| Your public profile: handle, name, bio, company, location, site, follower count | Private repositories (filtered out of the catalog, so they can never be selected) |
| Repos you pinned to your profile, and up to 40 of your most recently pushed public repos | Repos owned by organizations, forks you did not tick, starred repos, your commit history |
| The README markdown of a repo, only when its README box is also ticked | READMEs of repos you did not tick, or repos ticked without their README box |

| Stored on the agent | Never stored |
|---|---|
| Up to 20 short distilled facts (max 600 characters each) about what you build, your stack, and how you describe your work | Repository file contents beyond the README excerpt (the first 8,000 characters of a ticked README) |
| Your GitHub handle and the exact selection manifest (profile on/off, repo keys, README keys) on every seeded row | Any GitHub credential; the access token stays HKDF-encrypted in the connection record and is never copied into a memory |

## What lands in memory

Each fact becomes one row in `agent_memories`:

- `type: 'reference'`, tagged `github` and `github_seed`.
- Salience from `0.7` down, one step per rank, so the order the distiller
  emitted survives into retrieval. Chat keeps only the ten highest-salience
  memories per reply, and a flat score would cut that list arbitrarily.
- `tier`: the top five facts are `working`, the rest `recall`. The working tier
  is what the agent always carries, so those five ground an open question like
  "what do you know about my work?" without needing the message to match them.
  The `recall` remainder still surfaces through semantic and lexical search
  when a message is about that repository.
- `context` carries `source: 'github_seed'`, your handle, the seed timestamp,
  the fact's `rank`, and the selection manifest, so every memory can be audited
  back to the exact set of checkboxes that produced it.

Re-seeding the same agent replaces the previous GitHub batch atomically: the
old rows and the new rows swap inside one transaction, so a failure mid-run
never leaves the agent half-seeded, and the 6-hour limiter never strands you
behind a broken replacement.

---

## Connecting with a personal access token

OAuth needs an operator to register a GitHub OAuth app (see Configuration
below). Until that exists, `/api/auth/github/connect` can only answer `501`, so
the Settings card offers the token path instead, and offers it as a secondary
option even where OAuth works.

You mint the token on GitHub, which is where consent happens exactly as it does
on the OAuth screen. Tick **`read:user`** and nothing else: seeding reads a
public profile, public repositories, and their READMEs, none of which needs
more than that.

```bash
curl -s https://three.ws/api/auth/github/token --cookie "$JAR" \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"token":"ghp_your_token_here"}'
```

```json
{
  "connected": true,
  "connect_method": "token",
  "token_kind": "classic",
  "username": "you",
  "connected_at": "2026-08-16T16:53:49.030Z",
  "scopes": ["read:user"]
}
```

**An over-privileged token is refused, not stored.** The endpoint reads the
token's grants from GitHub's `x-oauth-scopes` response header and checks them
against an allowlist (`ALLOWED_TOKEN_SCOPES` in
[api/_lib/github-token.js](../api/_lib/github-token.js)): `read:user`,
`user:email`, `user:follow`, `user`, `public_repo`, `repo:status`, `read:org`.
Anything else, `repo` and `delete_repo` and every `admin:` scope included, comes
back as `400 token_scope_refused` naming the offending scopes, and nothing is
written. It is an allowlist rather than a denylist so a scope GitHub invents
later is refused by default. `repo` is excluded deliberately: it reaches private
repositories, and the catalog is public-only by construction, so it is strictly
more access than the feature can ever use.

Fine-grained tokens (`github_pat_…`) and GitHub App user tokens omit the scope
header entirely; their permissions were already narrowed by whoever minted them,
so they are accepted as they are and reported as `token_kind: "fine_grained"`.

Disconnecting destroys our encrypted copy and deletes every seeded memory, the
same as OAuth. It cannot revoke the token on GitHub's side, because GitHub
exposes no way to delete a personal access token using that same token, so the
response says so plainly (`grant_revoked: false`) and returns
`revoke_url: "https://github.com/settings/tokens"` for you to finish the job.

## Configuration

OAuth is optional. Without it the token path above still works, and the whole
lane (catalog, seed, revoke) behaves identically. To offer the one-click
button, register an OAuth app at
[github.com/settings/developers](https://github.com/settings/developers) with
the authorization callback URL set to `<your origin>/api/auth/github/callback`
(production: `https://three.ws/api/auth/github/callback`), then set two
variables on the API service:

| Variable | Purpose |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | The OAuth app's client ID, sent on the authorize redirect |
| `GITHUB_OAUTH_CLIENT_SECRET` | The client secret, used for the code exchange and for revoking the grant on disconnect |

The app requests `read:user` and `public_repo`, both read-only, and the access
token is encrypted with a key derived from `JWT_SECRET` before it is stored, so
rotating `JWT_SECRET` invalidates stored tokens (users reconnect) rather than
decrypting them into garbage.

Until both variables are present, `GET /api/auth/github/status` answers
`configured: false` and `/api/auth/github/connect` answers `501 not_configured`.
The Settings card then leads with the token form rather than a button that
cannot work. `status` always reports `token_connect.available: true` alongside
the `create_url` that pre-selects the right scopes, which is how the card knows
an unconfigured deployment is not a dead end. Everything else on the lane is
unaffected: no other feature depends on these variables.

---

## API

All three calls are owner-only: the session (or bearer) user must own the
agent. The two mutations (POST and DELETE) additionally require the standard
CSRF token in `x-csrf-token` when the caller authenticates with a session
cookie: without it they answer `403 csrf_missing` and change nothing. Bearer
callers are exempt, because a bearer token is not attached automatically by a
browser the way a cookie is. Mint one from `GET /api/csrf-token`; the shared
front-end client attaches it for you.

### `GET /api/agents/:id/memory/seed/github`

Connection state, the consent catalog, and current seed stats. With no GitHub
connection it returns `connected: false` plus the `connect_url` to start OAuth.

```bash
curl -s https://three.ws/api/agents/$AGENT_ID/memory/seed/github --cookie "$JAR"
```

```json
{
  "connected": true,
  "username": "you",
  "connected_at": "2026-08-12T10:00:00.000Z",
  "catalog": {
    "profile": { "login": "you", "name": "You", "bio": "…" },
    "repos": [
      { "key": "you/agent-kit", "pinned": true, "language": "TypeScript", "stars": 312, "topics": ["agents"], "url": "https://github.com/you/agent-kit" }
    ]
  },
  "fact_count": 0,
  "seeded_at": null,
  "selection": null
}
```

### `POST /api/agents/:id/memory/seed/github`

Seed from a selection. `repos` and `readmes` are `owner/name` keys from the
catalog, at most 12 in each list; a README key must also appear in `repos`. An
empty selection is refused (`400 empty_selection`).

```bash
curl -s https://three.ws/api/agents/$AGENT_ID/memory/seed/github --cookie "$JAR" \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"include_profile":true,"repos":["you/agent-kit"],"readmes":["you/agent-kit"]}'
```

```json
{
  "username": "you",
  "seeded": 7,
  "facts": ["The owner builds 3D agent tooling in TypeScript …"],
  "seeded_at": "2026-08-12T16:00:00.000Z",
  "selection": { "profile": true, "repos": ["you/agent-kit"], "readmes": ["you/agent-kit"] },
  "readmes_read": ["you/agent-kit"]
}
```

Rate-limited to one seed per agent per 6 hours, matching the X and Farcaster
lanes. A run that stores nothing does not spend the window: see the two
refunding errors below.

### `DELETE /api/agents/:id/memory/seed/github`

Revoke for this agent: deletes every GitHub-seeded memory on it and returns
the count. Idempotent.

```json
{ "deleted": 7 }
```

Disconnecting GitHub from Settings (`DELETE /api/auth/github/disconnect`)
performs the same deletion across **all** of your agents in one transaction
with the connection row itself. For an OAuth connection it then asks GitHub to
revoke the grant (best effort; the local deletion does not wait on GitHub). For
a token connection it reports `grant_revoked: false` with a `revoke_url`,
because no API can delete a personal access token using that token.

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Sign-in required |
| `csrf_missing` / `csrf_invalid` | 403 | A cookie-authenticated POST or DELETE arrived without a valid `x-csrf-token` |
| `not_found` | 404 | No such agent, or it is not yours (a malformed id also answers 404, never a 500) |
| `not_connected` | 412 | Connect GitHub first; the response carries `connect_url` |
| `validation_error` | 400 | The body failed schema validation: more than 12 `repos` or `readmes`, a key that is not `owner/name`, or (on `/api/auth/github/token`) a pasted string that is not shaped like a GitHub token |
| `invalid_token` | 400 | GitHub rejected the pasted token (mistyped, truncated, or expired) |
| `token_scope_refused` | 400 | The pasted token carries scopes outside the allowlist; `refused_scopes` names them |
| `invalid_selection` | 400 | A selected key is not in the catalog you were shown; `rejected` names each one |
| `empty_selection` | 400 | Pick your profile or at least one repository |
| `distill_error` | 502 | The selected material yielded no usable facts; add a README or another repository. Carries `window_refunded` |
| `distill_unavailable` | 503 | Every model provider was busy, so nothing was read into memory and the existing memories are untouched. Carries `window_refunded`, `providers_tried`, and `retry_at` (null when the window was refunded) |
| rate limited | 429 | One seed per agent per 6 hours |

Only `distill_error` and `distill_unavailable` are reachable after the seed
budget has been charged: the budget is taken once the selection is known good,
immediately before the README reads and the distilling pass. Every other
refusal above happens before that point and leaves your window intact, so a
mistyped or stale pick costs you nothing but the retry.

Both of those two also hand the window back. Neither one read anything into
memory or changed a single stored fact, and in the provider-outage case the
failure is the platform's, not yours, so the charge is reversed and the next
attempt is allowed immediately (`window_refunded: true`). Refunding is only
safe because this is a single-use window: see `refundLimit` in
[api/_lib/rate-limit.js](../api/_lib/rate-limit.js), which refuses any bucket
with a ceiling above one. If the refund itself cannot reach the limiter store,
the reply says so (`window_refunded: false`) and carries the real `retry_at`
rather than inviting a retry that would only earn a 429.

## Source

| Piece | File |
|---|---|
| HTTP surface (status, consent catalog, seed, revoke) | [api/agents/[id]/memory-seed-github.js](../api/agents/%5Bid%5D/memory-seed-github.js) |
| Catalog, selection narrowing, seed document, memory rows (pure, tested) | [api/_lib/github-seed.js](../api/_lib/github-seed.js) |
| GitHub REST/GraphQL client (profile, repos, pins, README, grant revoke) | [api/_lib/github-api.js](../api/_lib/github-api.js) |
| HKDF token encryption and the personal-access-token scope policy | [api/_lib/github-token.js](../api/_lib/github-token.js) |
| Connect (OAuth and token), callback, status, disconnect | [api/auth/github/[action].js](../api/auth/github/%5Baction%5D.js) |
| Consent screen (renders the catalog with per-item checkboxes) | [public/settings/index.html](../public/settings/index.html) |
| Transform tests | [tests/github-memory-seed.test.js](../tests/github-memory-seed.test.js) |
| Route tests for the seed endpoint | [tests/github-memory-seed-endpoint.test.js](../tests/github-memory-seed-endpoint.test.js) |
| Scope policy and token-connect tests | [tests/github-token-connect.test.js](../tests/github-token-connect.test.js) |
