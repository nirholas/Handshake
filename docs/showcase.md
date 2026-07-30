# The showcase: on-chain agents that have a body

`/showcase` is the public directory of **ERC-8004 agents that registered a 3D avatar**. It is not a curated editorial list and nothing here is hand-picked. An agent appears because it registered on-chain and its metadata resolved to a real 3D model, which is a fact the crawler checks rather than a claim anyone makes.

That filter is the whole point of the surface. The ERC-8004 registries hold plenty of agents that are only an address and a URI. The showcase answers a narrower question: which of them can actually be seen and embedded.

Live at [three.ws/showcase](https://three.ws/showcase). Related reading: [ERC-8004](./erc8004.md) for the identity standard itself, [on-chain deployments](./deployments.md) for the live feed of every registration as it lands (with no avatar filter), and [on-chain agents](./onchain-agents.md) for registering one yourself.

Code: [api/showcase.js](../api/showcase.js). Data comes from `erc8004_agents_index`, populated by the `erc8004-crawl` cron.

---

## What qualifies an agent

Two conditions, both checked against indexed on-chain data:

1. The agent is registered in an ERC-8004 Identity Registry the crawler indexes.
2. `has_3d` is true, meaning its resolved metadata carries a usable 3D model.

Nothing else. There is no ranking score, no editorial pass, and no way to buy a slot. Ordering is purely chronological by registration time.

## API

`GET /api/showcase` is public, needs no key, and is rate-limited per IP.

```bash
# Newest registrations with a 3D avatar, across mainnet chains
curl -s 'https://three.ws/api/showcase?limit=5'

# Oldest first
curl -s 'https://three.ws/api/showcase?sort=oldest'

# One or more specific chains, by numeric chain id
curl -s 'https://three.ws/api/showcase?chain=8453'
```

| Parameter | Default | Accepts | Notes |
|---|---|---|---|
| `sort` | `newest` | `newest`, `oldest` | Anything else is a `400 validation_error` |
| `limit` | `24` | 1 to 60 | Values above 60 clamp to 60; unparseable values fall back to 24 |
| `chain` | all mainnet chains | comma-separated numeric chain ids | An unknown id is a `400`, naming the offending value |
| `cursor` | none | opaque string from `next_cursor` | An unparseable cursor is a `400`, not a silent first page |

Omitting `chain` selects every mainnet chain the crawler knows. Testnet chains are excluded unless you ask for them explicitly.

### Pagination is keyset, not offset

Paging uses a keyset cursor over `(registered_at, chain_id, agent_id)` rather than an offset. That matters here because the crawler inserts continuously: with an offset, a registration landing between two requests shifts every later page and you would see duplicates or skip agents. The keyset cursor is stable under concurrent inserts.

Follow `next_cursor` until it comes back `null`:

```bash
curl -s 'https://three.ws/api/showcase?limit=24'
# then, with next_cursor from that response:
curl -s 'https://three.ws/api/showcase?limit=24&cursor=<NEXT_CURSOR>'
```

Do not construct a cursor by hand. It encodes the sort key triple, and a malformed one is rejected rather than guessed at.

### Response

Each agent carries its on-chain identity plus explorer links resolved from the chain's metadata: the chain id and name, the agent id, its owner and registry addresses, and its agent URI. Because every field is derived from indexed chain state, anything the showcase shows can be checked independently on that chain's explorer.

## Related

- [ERC-8004](./erc8004.md): the identity standard behind every row here.
- [On-chain deployments](./deployments.md): the same registration stream without the 3D filter, including Solana Metaplex Core mints.
- [Deploy agents on-chain](./onchain-agents.md): how to register an agent so it can appear here.
- [Agent manifest](./agent-manifest.md): the metadata format whose 3D model field decides `has_3d`.
