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
 Connect X (OAuth 2.0 PKCE, read scopes only)
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

Three properties fall out of that shape:

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
| `consent_required` | 403 | No live grant; the response carries the disclosure to show |
| `account_mismatch` | 409 | The consent was granted for a different X account |
| rate limited | 429 | One seed per agent per 6 hours |

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
| Consent screen (renders the server's disclosure verbatim) | [public/settings/index.html](../public/settings/index.html) |
| Transform tests | [tests/api/x-memory-seed-transform.test.js](../tests/api/x-memory-seed-transform.test.js), [tests/api/agents-memory-seed.test.js](../tests/api/agents-memory-seed.test.js) |
