# X memory seeding

Give an agent your X voice: your public profile and recent original posts,
distilled and written into the agent's long-term memory, so the replies it gives
sound like the person who wrote them.

This lane is built around one constraint. Connecting your X account to the
platform (to post as your agent, for example) is permission to act on X on your
behalf. It is **not** permission to write your posts into an agent's long-term
memory. Those are two separate decisions, and the second one is its own
explicit, versioned, revocable grant: nothing is read into memory until you say
yes on a screen that tells you exactly what will be read and stored.

- **Surface**: Settings, Connected accounts, X card at [/settings#connected-accounts](https://three.ws/settings#connected-accounts)
- **API**: `/api/agents/:id/memory/seed/x`
- **Related**: [Memory system](./memory.md), [Farcaster memory seeding](./farcaster-memory-seeding.md), [GitHub seeding in the same table](./memory.md#seeding-memory-from-an-existing-account)

---

## How it fits together

```
 Connect X (OAuth 2.0 PKCE, /api/auth/x/connect?scope=read)
        │   the seeding card asks X for read scopes only: no permission to post
        │   the connection alone changes nothing in memory
        ▼
 GET /api/agents/:id/memory/seed/x
        │   returns the disclosure verbatim from the server, never copy in the page
        ▼
 you tick "I have read the above and consent"
        │
        ▼
 POST … { consent: { accepted: true, scope_version } }
        │   the version must match the disclosure you were shown
        ▼
 profile + up to 100 recent original posts are read once
 distilled into up to 15 short facts about topics, opinions, projects, tone
 written to agent_memories tagged x_seed, the top five always in context
        │
        ▼
 DELETE /api/agents/:id/memory/seed/x   (or disconnect X entirely)
        │   revokes the grant and deletes every memory it produced
        ▼
 nothing distilled from your account survives
```

Four properties fall out of that shape:

- **Connecting for seeding never grants permission to post.** The X card's
  Connect button asks X for `tweet.read users.read offline.access` and nothing
  else, so an owner who only wants their agent to sound like them is never asked
  to hand over write access to their timeline. Posting is a separate connect
  (`?scope=full`), offered next to it and labelled as such, and reconnecting
  keeps the shape of the grant you already made.

- **A POST without consent is refused before anything is read.** The handler
  answers `403 consent_required` with the disclosure attached, and the
  per-agent seed budget is consumed only after authorization, connection, and
  consent all pass, so a rejected call never burns your re-seed window.
- **Consent is pinned to the account and the text.** The grant records X's
  numeric account id and the disclosure version you agreed to. Reconnect a
  different X account, or let the disclosure wording move on, and the old grant
  stops authorizing new seeds until you agree again.
- **Revocation is total.** Every seeded row carries the `x_seed` tag and the
  consent id that produced it. Revoking, or disconnecting X from Settings,
  deletes exactly those rows, including any a superseded grant left behind.

## Connecting: two grants, deliberately separate

| | Seeding | Posting |
|---|---|---|
| Connect link | `/api/auth/x/connect?scope=read` | `/api/auth/x/connect?scope=full` |
| Scopes X is asked for | `tweet.read users.read offline.access` | the read set plus `tweet.write media.write` |
| Where it is offered | the X card in Settings, Connected accounts | the agent editor's Social tab, the share and walk-capture flows |
| What it can do | read your profile and recent posts, once, when you consent | publish posts and upload media as you |

A three.ws account holds exactly one X connection (`social_connections` is
unique on user and provider), so the sets are not additive: a read-only connect
replaces a posting connection with a read-only one, and the
posting lane then answers `insufficient_scope` with the reconnect link rather
than failing at the X API. The scope sets and both guards live in
[api/_lib/x-scopes.js](../api/_lib/x-scopes.js); an unrecognised `scope=` value
resolves to the full set, so a typo can never silently narrow what a posting
surface asks for.

Connections made before scopes were recorded store an empty scope string. Those
are treated as unknown rather than as empty, so neither guard blocks them.

## What is read, and what is not

The consent screen shows this list verbatim from the server; the same module
(`api/_lib/x-memory-seed.js`) enforces it, so the promise and the code cannot
drift apart.

| Read | Never read |
|---|---|
| Your X profile: display name, handle, bio, follower and following counts | Direct messages, drafts, likes, bookmarks, your follower list |
| Up to 100 of your most recent **original** public posts (text and date) | Reposts and replies (excluded in the API call and re-checked in the transform) |
| | Protected accounts you follow |

| Stored on the agent | Never stored |
|---|---|
| Up to 15 short distilled facts (max 280 characters each) about your recurring topics, opinions, projects, and tone | The text of your posts; a distilled fact that copies a post is discarded before it is written |
| Your X handle, so the agent can attribute what it learned | Links from your posts; URLs are stripped out of stored text |
| The seed date and the disclosure version you agreed to | Any X credential; the access token stays encrypted in the connection record and is never copied into a memory |

## What lands in memory

Each fact becomes one row in `agent_memories`:

- `type: 'reference'`, tagged `x` and `x_seed` plus up to three topics derived
  from your posting history.
- Salience `0.80` for the top-ranked fact, decaying by rank.
- The **top five facts land in the `working` tier**, the always-in-context core
  the chat runtime pages into every reply (see [memory system](./memory.md)).
  That is what makes a seed observable in the very next conversation turn.
- `context` carries `source: 'x_seed'`, your handle, the distillation lane
  (`model` or `derived`), the disclosure version, and the consent id.

If the distillation model chain is unavailable, the seed degrades rather than
fails: deterministic facts are derived from your profile and your topic
histogram (`distilled_by: 'derived'`), a smaller and blander seed instead of a
silent zero.

---

## API

All three calls are owner-only: the session user must own the agent. Browser
mutations carry the standard CSRF token.

### `GET /api/agents/:id/memory/seed/x`

Connection state, the consent grant, and the disclosure. This is the only
source of the consent screen's copy.

```bash
curl -s https://three.ws/api/agents/$AGENT_ID/memory/seed/x --cookie "$JAR"
```

```json
{
  "connected": true,
  "configured": true,
  "username": "you",
  "connection_scopes": "tweet.read users.read offline.access",
  "required_scopes": ["tweet.read", "users.read"],
  "missing_scopes": [],
  "scopes_ok": true,
  "seeded_at": "2026-08-12T16:00:00.000Z",
  "fact_count": 5,
  "scope_version": "2026-08-11.1",
  "disclosure": { "reads": ["…"], "skips": ["…"], "stores": ["…"], "never": ["…"], "…": "…" },
  "consent": {
    "granted": true,
    "reason": "active",
    "scope_version": "2026-08-11.1",
    "granted_at": "2026-08-12T15:55:00.000Z",
    "username": "you",
    "last_seeded_at": "2026-08-12T16:00:00.000Z",
    "memories_seeded": 5,
    "posts_read": 10
  }
}
```

`consent.reason` is `none` when no grant exists, `scope_version_changed` when
the disclosure moved (the old grant no longer authorizes seeds), and
`account_changed` when the connection now points at a different X account than
the one you consented for.

`scopes_ok` is false when the live connection cannot cover the read the
disclosure describes (you unticked a permission on X's screen, or the account is
connected for posting only under a scope set that dropped `tweet.read`).
`missing_scopes` names exactly what it lacks. The card shows a reconnect instead
of the consent panel in that state, so nobody consents to a seed that could not
run.

### `POST /api/agents/:id/memory/seed/x`

Grant consent (first call) and seed. Without a live grant the body must carry
the acceptance of the current disclosure version:

```bash
curl -s https://three.ws/api/agents/$AGENT_ID/memory/seed/x --cookie "$JAR" \
  -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"consent":{"accepted":true,"scope_version":"2026-08-11.1"}}'
```

```json
{
  "username": "you",
  "seeded": 5,
  "posts_read": 10,
  "distilled_by": "model",
  "topics": ["agents", "solana", "threejs"],
  "facts": ["The author builds 3D AI agents at three.ws …"],
  "in_context": 5,
  "consent": { "granted": true, "…": "…" }
}
```

With a live grant the same call with an empty body re-seeds: the previous batch
is deleted before the new one lands, so an agent never carries two generations
of facts about the same account. Rate-limited to one seed per agent per 6 hours.

### `DELETE /api/agents/:id/memory/seed/x`

Revoke. Marks the grant revoked and deletes every memory the grant produced.
Idempotent: an agent with no grant still gets any orphaned seeded rows purged.

```json
{ "revoked": true, "deleted": 5, "consents_revoked": 1, "remaining": 0, "consent": { "granted": false, "reason": "revoked" } }
```

Disconnecting X from Settings triggers the same deletion across **all** of your
agents (`revokeAllSeedConsentsForUser`), so a disconnect can never leave
distilled posts behind on an agent you forgot about.

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Sign-in required |
| `not_found` / `forbidden` | 404 / 403 | No such agent, or it is not yours |
| `not_connected` | 400 | Connect X first (Settings, Connected accounts) |
| `insufficient_scope` | 400 | The connection cannot read your profile and posts; the body names the missing scopes. Reconnect with `?scope=read` |
| `consent_required` | 403 | No live grant; the response carries the disclosure to show |
| `account_mismatch` | 409 | The consent was granted for a different X account |
| rate limited | 429 | One seed per agent per 6 hours |
| `x_token_expired` | 502 | The stored access token would not refresh; reconnect X |
| `x_read_denied` | 502 | X answered the read with 401/403, so the connection was revoked or narrowed on X's side |
| `x_rate_limited` | 503 | X is throttling us; `retry_at` carries X's own reset time when it sent one |
| `x_unavailable` | 502 | X answered with something else; `x_status` carries what |
| `seed_empty` | 502 | Nothing usable came back, so nothing was written and the previous batch was left alone |

### A run that stores nothing costs no window

The six-hour budget is charged once a request is authorized, connected and
consented, immediately before the first read. Every exit after that point which
writes no rows (the five codes above, plus `account_mismatch`) hands the window
straight back, and the response says which happened:

```json
{
  "error": "x_rate_limited",
  "error_description": "X is rate limiting us and returned no posts. X should accept the read again in about 9 minutes. Your memories are unchanged and this attempt did not use up your six-hour window, so you can seed again as soon as it is fixed",
  "x_status": 429,
  "retry_at": "2026-08-17T02:49:00.000Z",
  "window_refunded": true
}
```

`window_refunded` is `false` only when the refund itself could not be recorded
(a Redis outage); the wording drops the "did not use up" clause to match. Two
guarantees hold on all of these paths: the agent's existing memories are
untouched, and no partial batch is ever written. In particular a re-seed that
yields no usable fact returns `seed_empty` rather than deleting a good batch and
replacing it with nothing.

## Enabling it on a deployment

The lane needs an X app with OAuth 2.0 and, at minimum, the `tweet.read`,
`users.read` and `offline.access` scopes enabled (add `tweet.write` and
`media.write` if the deployment also posts), created at
https://developer.twitter.com with `https://<your-domain>/api/auth/x/callback`
registered as the callback. Its two credentials are the only configuration:

```
X_OAUTH_CLIENT_ID=
X_OAUTH_CLIENT_SECRET=
```

On Cloud Run, set them without disturbing the rest of the environment:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --update-env-vars X_OAUTH_CLIENT_ID=...,X_OAUTH_CLIENT_SECRET=...
```

Until both are present, `GET /api/agents/:id/memory/seed/x` answers
`configured: false` and the Settings card says X connections are not enabled on
this deployment, rather than offering a Connect button that could not complete.
`GET /api/x/status` carries the same `configured` flag, so the posting surfaces
that read it (the dashboard's X panel, the agent editor's Social tab) hide their
Connect button for the same reason instead of offering one that dead-ends.

If the connect URL is reached anyway (an old tab, a bookmark, a link someone
saved), `/api/auth/x/connect` distinguishes a top-level browser navigation from
a programmatic call. A navigation is redirected back to the surface it came from
with `?x=unconfigured`, which both pages render as an explanation; an API or
agent caller still receives the `501 not_configured` JSON envelope it parses. No
PKCE state cookie is set on that path, so nothing is left behind for a callback
that can never arrive.

Nothing else in the lane changes: the disclosure, the consent grant, and
revocation behave identically once the credentials are in place.

## Storage

One table, created by `api/_lib/migrations/20260811140000_x_memory_consent.sql`:

- `x_memory_consents` is the durable grant: the X account id, handle, the
  disclosure version, the exact disclosure text shown, the scopes the OAuth
  connection actually held at grant time, seed counters, and the revocation
  timestamp and reason. At most one live grant per agent (partial unique
  index).

Seeded rows in `agent_memories` are found by tag (`tags && '{x_seed}'`) and by
`context->>'consent_id'`, indexed for revocation.

## Source

| Piece | File |
|---|---|
| HTTP surface (OAuth refresh, reads, consent gates) | [api/agents/[id]/memory-seed-x.js](../api/agents/%5Bid%5D/memory-seed-x.js) |
| Disclosure text, selection, sanitisation, memory rows (pure, tested) | [api/_lib/x-memory-seed.js](../api/_lib/x-memory-seed.js) |
| Revocation shared by DELETE, disconnect, and account switch | [api/_lib/x-seed-consent.js](../api/_lib/x-seed-consent.js) |
| OAuth 2.0 PKCE connect and callback | [api/auth/x/[action].js](../api/auth/x/%5Baction%5D.js) |
| Scope sets, and the read/write guard each lane applies | [api/_lib/x-scopes.js](../api/_lib/x-scopes.js) |
| Consent screen (renders the server's disclosure verbatim) | [public/settings/index.html](../public/settings/index.html) |
| Transform tests | [tests/api/x-memory-seed-transform.test.js](../tests/api/x-memory-seed-transform.test.js), [tests/api/agents-memory-seed.test.js](../tests/api/agents-memory-seed.test.js) |
| Consent gate, scope gate and revocation tests | [tests/api/x-memory-seed-consent.test.js](../tests/api/x-memory-seed-consent.test.js), [tests/api/x-scopes.test.js](../tests/api/x-scopes.test.js) |
| What the connect redirect asks X for | [tests/api/x-connect-scope.test.js](../tests/api/x-connect-scope.test.js) |
| How connect refuses when no X OAuth app is configured | [tests/api/x-connect-unconfigured.test.js](../tests/api/x-connect-unconfigured.test.js) |
