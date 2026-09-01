# The agent index

three.ws keeps its own index of what happens to agents on-chain, Solana first,
EVM alongside it. This page explains what it records, how to read it, and how to
tell whether what you are reading is current.

Without an index, "show me this agent's history" means scanning a chain from a
browser: slow on Solana, impossible on twenty-two EVM chains at once, and
unreliable on every free RPC. So the platform crawls once, on a schedule, into
one table, and serves the result to everyone.

## What it records

One row per on-chain event, one table for every chain. Each row carries the
**absolute on-chain timestamp** the event happened at (EVM block timestamp,
Solana `blockTime`), never the time the crawler saw it. An event whose on-chain
time cannot be read is rejected rather than stamped with the current time,
because a fabricated timestamp corrupts every timeline and every freshness
number computed from the table.

Strings that came off a chain are arbitrary bytes, and Postgres refuses two of
the code points they can carry: a NUL fails a jsonb insert outright and a lone
surrogate fails it with an escape error. `sanitizeText()` and
`sanitizePayload()` in the same module strip the NUL and replace the lone
surrogate with U+FFFD in every text column and every payload string (keys
included) before the row is written. Without that, one such byte in one log
wedged the chain that produced it: the insert threw before the cursor advanced,
so every tick re-read the same range and hit the same log.

Seven event classes:

| Class | What it means | Where it comes from |
| --- | --- | --- |
| `registration` | An agent was minted or registered in a registry | ERC-8004 `Registered`; Metaplex `RegisterIdentityV1`, `UnregisterIdentityV1` |
| `metadata` | The agent URI or a metadata key changed | ERC-8004 `URIUpdated`, `MetadataSet`; `SetAgentUriV1`, Core `UpdateV1` |
| `transfer` | Ownership moved between accounts | ERC-8004 `Transfer`; Metaplex Core `TransferV1`, `BurnV1` |
| `token_launch` | An SPL or ERC-20 token was bound to the agent | Metaplex `SetAgentTokenV1` |
| `reputation` | Feedback, stake, or a review attestation | ERC-8004 `NewFeedback`, `FeedbackRevoked`, `ResponseAppended`; `threews.feedback.v1`, `threews.stake.v1`, `threews.review.v1` memos |
| `validation` | A validation request or response | `threews.validation.v1` memos |
| `delegation` | Execution rights delegated to another account | Metaplex `DelegateExecutionV1`, `RevokeExecutionV1` |

Adding a class means adding it to `EVENT_CLASSES` in
[`api/_lib/onchain-events.js`](../api/_lib/onchain-events.js) first, so the API
filter, the history UI, and the freshness monitor all learn about it at once. A
crawler that emits an unlisted class has its event rejected, not silently stored
under a new name.

## Reading it

`GET /api/agents/onchain-history` is public, read-only, and cached for a minute.
Identify the agent one of three ways:

```bash
# Solana, by agent account
curl 'https://three.ws/api/agents/onchain-history?asset=ANeykUs3hCNb9B9hVx4sQg7D8hD6MzAyRPJ2M1ays18'

# EVM, by chain and agent id
curl 'https://three.ws/api/agents/onchain-history?chain=8453&id=63521'

# Either, by the index's own key
curl 'https://three.ws/api/agents/onchain-history?ref=8453:63521'
```

Optional `&class=token_launch` filters to one class, and `&limit=` takes 1 to
500 (default 100).

```json
{
  "ref": "ANeykUs3hCNb9B9hVx4sQg7D8hD6MzAyRPJ2M1ays18",
  "chain": "solana",
  "count": 2,
  "counts": { "token_launch": 1, "registration": 1 },
  "indexLag": {
    "lastIndexedAt": "2026-08-13T23:41:02.000Z",
    "lagMinutes": 6,
    "crawled": true,
    "error": null
  },
  "events": [
    {
      "chain": "solana",
      "network": "mainnet",
      "eventClass": "token_launch",
      "eventName": "SetAgentTokenV1",
      "tx": "5WtcSn4jJubQnEu71nnjKZJZawtgGNeVayiDgG4QsDsCZreJN2W3MQiJpPWszCFcanFRDMVfojNwrPC7SBumRqw8",
      "blockNumber": 438961707,
      "occurredAt": "2026-08-13T05:55:41.000Z",
      "indexedAt": "2026-08-13T23:41:02.000Z",
      "actor": "3NHMeZPXXZVgArbgE6hJU3fq72fR9UsgbmH9zFvQiGC1",
      "payload": { "mint": "X8k6vcAvvmkavecwAGk7U4JVoKdntDSNfBZsq6KPLEX" },
      "explorerUrl": "https://solscan.io/tx/5WtcSn4jJubQ"
    }
  ]
}
```

Two fields deserve attention.

**`occurredAt` vs `indexedAt`.** The first is when the chain says it happened.
The second is when we saw it. Both are always present, so you never have to
guess which one you are sorting by.

**`indexLag`.** An empty `events` array means one of two very different things,
and this field is how you tell them apart. `crawled: false` means this agent has
never been looked at, so "no history" is not a claim about the agent.
`crawled: true` with a small `lagMinutes` means we looked recently and there
genuinely is nothing. `error` carries the crawler's last failure for that agent,
when it had one.

Every event also carries `explorerUrl`, so nothing here has to be taken on
trust: follow the link and check the transaction against the chain.

Human-readable version: the **On-chain history** panel on any agent's page under
`/discover/a/` renders the same data as a timeline.

## How current it is

Two crawls fill the index, and they fail in a way that has no other symptom: the
site keeps answering 200, `/agents` keeps rendering, and the directory just
quietly stops learning about the world. So freshness is published as a number
rather than a green dot, on [/status](https://three.ws/status) and
`/api/healthz` under the `agent_index` subsystem.

| Cron | Period | Covers |
| --- | --- | --- |
| `/api/cron/solana-attestations-crawl` | 10 min | Solana: per-agent signature walk over platform agents and the external registry directory |
| `/api/cron/erc8004-crawl` | 15 min | EVM: identity and reputation registry log ranges on every configured chain |

The monitor reports both legs. Read them differently:

- **Solana** is per-agent, so the honest measure is the **median cursor age**
  plus the **full sweep cycle**: agents divided by the per-tick batch, times the
  cron period. A queue drained oldest-first sits at half its cycle time, so a
  growing directory raises the floor until someone changes the batch. The cycle
  is published for exactly that reason.
- **EVM** is per-chain block ranges, so cursor age is the wrong measure on its
  own: it proves the cron ran, not that the index caught up. A chain producing
  blocks faster than the crawl consumes them keeps a fresh cursor forever while
  falling further behind every tick. The monitor therefore reports **blocks
  behind head**, and the crawl grows its block window while a chain is behind
  (halving it when a provider rejects the range) so a fast chain can actually
  close the gap. One window per chain per tick holds a slow chain but cannot
  drain a fast one, so after the first pass over every chain the cron spends
  whatever is left of its budget on a **catch-up pass**: it re-picks the chain
  furthest behind head each round and feeds it another window, stops far enough
  from the deadline that metadata enrichment still runs, drops a chain whose
  provider refused even the floor window rather than spinning on it, and does
  nothing on a tick where every chain is current. The first pass itself walks
  chains worst backlog first, with a never-crawled chain ahead of everything
  and a caught-up chain ranked by how long its cursor has stood still, so a
  chain that errors on every tick (which keeps reporting the zero backlog its
  last good crawl left) is not sorted to the back of the sweep forever.

A leg that is reaching every agent and recording nothing counts as `down`, not
as fresh. That shape (every cursor current, zero events) is what a crashing
crawler looks like from the outside, and it is invisible to any check that only
asks whether the job ran.

## Where the code lives

| Piece | File |
| --- | --- |
| Event shape, validation, read and write | [`api/_lib/onchain-events.js`](../api/_lib/onchain-events.js) |
| Solana classification and per-agent crawl | [`api/_lib/solana-agent-events.js`](../api/_lib/solana-agent-events.js) |
| ERC-8004 identity log decoder | [`api/_lib/erc8004-registry-events.js`](../api/_lib/erc8004-registry-events.js) |
| ERC-8004 reputation log decoder | [`api/_lib/erc8004-reputation-events.js`](../api/_lib/erc8004-reputation-events.js) |
| Freshness monitor | [`api/_lib/ops/index-lag.js`](../api/_lib/ops/index-lag.js) |
| Public read endpoint | [`api/agents/onchain-history.js`](../api/agents/onchain-history.js) |
| Both crawl crons | [`api/cron/`](../api/cron/) |
| Regression cover | [`tests/agent-index.test.js`](../tests/agent-index.test.js) |

Related: [Trust primitives](./trust-primitives.md) scores an agent from on-chain
evidence, and [Custody you can verify](./custody.md) covers the attestations the
`reputation` and `validation` classes carry.
