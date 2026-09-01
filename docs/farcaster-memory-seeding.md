# Farcaster memory seeding

Give an agent your Farcaster voice: your public profile and casts, distilled and
written into the agent's long-term memory, so it can talk the way you talk.

The whole surface is built around one constraint. Farcaster has no OAuth, and we
deliberately never ask for a Farcaster signer, so the usual "log in with" flow
does not exist. Anyone can read anyone's casts from a public hub, which means a
naive seeder would happily pull a stranger's posts into your agent. This lane
refuses to do that: **the account has to be proved yours before a single cast is
read into memory**, and the proof is a wallet signature against the protocol's
own verification records.

- **Surface**: the Farcaster panel in the agent persona editor at [/dashboard/agents](https://three.ws/dashboard/agents)
- **API**: `/api/agents/:id/memory/seed/farcaster`
- **Related**: [Memory system](./memory.md), [`@three-ws/agent-memory`](https://www.npmjs.com/package/@three-ws/agent-memory)

---

## How ownership is proved

A Farcaster ID (fid) publishes the wallets it controls as **verification
messages** on the protocol. They are public, they are signed by the fid's own
key, and they name a chain: Solana (`PROTOCOL_SOLANA`) or Ethereum. That list is
the allowlist for consent.

```
 you enter @handle
        │
        ▼
 resolve fid  ──▶  read the fid's verified wallets  ──▶  none? stop, nothing read
        │
        ▼
 server issues a one-time challenge naming the agent, the fid, the wallet,
 the scope, and an expiry — and stores the exact text
        │
        ▼
 you sign it in Phantom (ed25519)              ← Solana leads; an EVM
        │                                        verification signs with
        ▼                                        personal_sign instead
 server re-reads the verifications, checks the wallet is still in the set,
 verifies the signature against ITS copy of the message, burns the nonce
        │
        ▼
 consent row written  ──▶  casts read  ──▶  memories written
```

Three properties fall out of that shape:

- **Nothing is stored before the signature verifies.** The lookup step reads
  public data and writes only a challenge row; no memory exists until consent does.
- **A tampered message cannot be signed into a different grant.** The server
  compares against the copy it issued, so changing the fid, the agent, or the
  scope in transit invalidates the signature.
- **A revoked wallet stops working immediately.** Verifications are re-read at
  grant time, not trusted from the challenge.

Solana leads because it is the home chain and the wallet our users already have
connected. When a fid has verified both a Solana and an Ethereum wallet, the
Solana one is offered first and is what the wallet prompt defaults to.

## What is read, and what is not

The scope string on every consent record is:

```
farcaster:profile.read farcaster:casts.read
```

| Read | Never touched |
|---|---|
| Public profile: display name, bio, pfp, username | Direct casts / private data |
| Up to 100 recent top-level casts | Anything requiring a Farcaster signer |
| The fid's public verification records | Posting, recasting, following on your behalf |

## What lands in memory

A seed writes three kinds of row into `agent_memories`, all tagged `farcaster`
and all stamped with the consent id that produced them:

| Kind | Type | Salience | Content |
|---|---|---|---|
| `profile` | `user` | 0.80 | One identity memory: display name, handle, fid, bio, follower count |
| `fact` | `user` | 0.70 | Up to 15 distilled facts: recurring topics, opinions, projects, style |
| `cast` | `reference` | 0.62 decaying by rank | Up to 12 of the strongest casts, verbatim, dated |

The profile and cast rows are derived without a model, so a seed still produces
real memory when the distillation lane is down: the run degrades, it does not
fail. Casts are filtered before they are ranked. Replies, near-empty posts, and
link-only posts are dropped, duplicate text is collapsed, and what remains is
ranked by engagement when the data source reports it and by recency when it
does not.

## Where the data comes from

Two rungs, tried in order:

1. **Neynar** (`@neynar/nodejs-sdk`, MIT) when `NEYNAR_API_KEY` is set. Indexed
   data, so casts carry reaction counts and profiles carry follower counts. That
   is what makes engagement ranking possible.
2. **Public Farcaster hubs over their HTTP API, keyless.** Every hub serves
   the same replicated set, so the lane walks a list rather than pinning one
   host: `FARCASTER_HUB_URL` (if set) first, then any comma-separated
   `FARCASTER_HUB_URLS`, then the built-in defaults (`https://hub.pinata.cloud`,
   `https://hub.farcaster.standardcrypto.vc:2281`,
   `https://nemes.farcaster.xyz:2281`). An unreachable hub or a non-2xx answer
   moves to the next rung; a "no such user" answer ends the walk immediately,
   because that is the network's verdict, not one hub's. Hubs serve raw
   protocol messages, so there are no reaction counts, but they need no vendor
   key and do not go dark when a billing plan lapses.

Neither key is required for the feature to work. The SDK is imported lazily and
only when a key is configured, so the keyless lane carries no dependency on the
vendor package being installed.

---

## API

All four calls are owner-only: the session (or bearer) user must own the agent.
Browser calls also carry the standard CSRF token.

### `GET /api/agents/:id/memory/seed/farcaster`

Current link and consent status.

```bash
curl -s https://three.ws/api/agents/$AGENT_ID/memory/seed/farcaster \
  -H "authorization: Bearer $THREE_WS_TOKEN"
```

```json
{
  "connected": true,
  "fid": 987654,
  "fname": "threewsdemo",
  "scope": "farcaster:profile.read farcaster:casts.read",
  "consent": {
    "id": "22222222-2222-4222-8222-222222222222",
    "proof_chain": "solana",
    "proof_address": "So1anaAddressPlaceholder1111111111111111111",
    "granted_at": "2026-08-11T12:00:00.000Z",
    "memories_seeded": 15,
    "casts_ingested": 31
  },
  "memory_count": 15,
  "cast_limit": 100
}
```

### `POST … { "intent": "challenge" }`

Resolve the account and get the text to sign. Send `fid` or `fname`; add
`address` to pick a different one of the fid's verified wallets.

```bash
curl -s https://three.ws/api/agents/$AGENT_ID/memory/seed/farcaster \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"intent":"challenge","fname":"threewsdemo"}'
```

The response carries `nonce`, `message` (sign this verbatim), `chain`, `address`,
`scope`, `cast_limit`, `expires_at` (10 minutes), the resolved `profile`, and
`wallets` split into `solana` and `ethereum`.

A fid with no verified wallet answers `409 no_verified_wallet`, because there is
no way to establish it is yours.

### `POST … { "intent": "grant" }`

Sign the message and hand back the signature. Solana signatures may be base58
(Phantom) or base64; Ethereum uses `personal_sign`.

```js
const challenge = await post(url, { intent: 'challenge', fname: 'threewsdemo' });

const signed = await window.solana.signMessage(
  new TextEncoder().encode(challenge.message),
  'utf8',
);

const result = await post(url, {
  intent: 'grant',
  nonce: challenge.nonce,
  address: challenge.address,
  chain: challenge.chain,
  signature: btoa(String.fromCharCode(...signed.signature)),
});
// → { granted: true, consent_id, seeded: 15, casts_ingested: 31, facts: [...] }
```

### `POST … { "intent": "reseed" }`

Re-run the ingest under the existing grant, replacing that grant's memories.
Rate-limited to one seed per agent per 6 hours, matching the X and GitHub lanes.
Issuing a challenge is deliberately outside that budget, so retrying the wallet
step never burns the window.

### `DELETE /api/agents/:id/memory/seed/farcaster`

Revoke. This marks the consent revoked, clears the agent's Farcaster link, and
**deletes every Farcaster-seeded memory on the agent**, including rows a
superseded grant left behind. Asking to be forgotten means all of it.

```json
{ "revoked": true, "consent_id": "2222…", "deleted": 15 }
```

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `no_verified_wallet` | 409 | The fid has verified no wallet, so ownership cannot be proved |
| `address_not_verified` | 403 | The signing wallet is not in the fid's verification set |
| `challenge_not_found` | 404 | No such nonce for this agent and user |
| `challenge_used` | 409 | Nonce already burned |
| `challenge_expired` | 410 | Older than 10 minutes; request a new one |
| `address_mismatch` | 400 | The challenge was issued for a different wallet |
| `invalid_signature` | 401 | Signature does not verify against the stored message |
| `not_connected` | 412 | `reseed` with no live grant |
| `farcaster_user_not_found` | 404 | No such fid or fname |
| `farcaster_upstream` | 502 | The hub or indexer is unavailable |

## Storage

Two tables, created by
`api/_lib/migrations/20260811130000_farcaster_memory_consent.sql`:

- `farcaster_seed_challenges` holds the one-time nonce and the exact signable
  text. Storing the message server-side is what lets verification compare against
  what we issued rather than a client-supplied copy.
- `farcaster_memory_consents` is the durable grant: fid, scope, proof chain,
  proof address, signature, message, and revocation timestamp. At most one live
  grant per agent.

Every seeded row in `agent_memories` carries `context->>'source' =
'farcaster_seed'` and `context->>'consent_id'`, which is how a re-seed replaces
only its own rows and a revoke deletes exactly what was granted.

## Source

| Piece | File |
|---|---|
| HTTP surface | [api/agents/[id]/memory-seed-farcaster.js](../api/agents/%5Bid%5D/memory-seed-farcaster.js) |
| Pure transforms (message, normalisation, selection, memory rows) | [api/_lib/farcaster-seed.js](../api/_lib/farcaster-seed.js) |
| Read lane with failover | [api/_lib/farcaster-client.js](../api/_lib/farcaster-client.js) |
| Consent panel | [src/dashboard-next/farcaster-seed.js](../src/dashboard-next/farcaster-seed.js) |
| Tests | [tests/api/farcaster-memory-seed.test.js](../tests/api/farcaster-memory-seed.test.js) |
