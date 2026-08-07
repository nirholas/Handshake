# On-chain Deployments

[/deployments](https://three.ws/deployments) is the live, cross-chain feed of agent identities landing on-chain: every ERC-8004 Identity Registry registration on EVM and every Metaplex Core agent mint on Solana, in one chronological stream, as each one lands. It is a read-only public surface. No account, no key, no wallet connection.

It answers three questions at a glance: how big is the on-chain agent population, where is it landing, and how many of those agents can actually do anything (ship a 3D avatar, accept x402 payments).

Every row is a real on-chain registration. There are no synthetic entries and no seeded demo rows. When a network is quiet the feed is honestly empty, and when a signal was never measured the UI says so rather than rendering a zero.

Related reading: [ERC-8004 blockchain identity](./erc8004.md) for the standard, the registry contracts, and how to register; [deploying agents on-chain](./onchain-agents.md) for the Solana Metaplex Core path; [agent reputation on Solana](./solana-reputation.md) for the trust layer built on top of a Solana identity.

---

## Solana is indexed here, not elsewhere

This surface is **not EVM-only**. Solana is folded into the same feed as a first-class chain, using the Solana cluster indices as chain ids so the network toggle, cursor, chain filter, and top-chains panel treat it like any other chain:

| Chain | `chain_id` | Network class |
| --- | --- | --- |
| Solana mainnet-beta | `101` | `mainnet` |
| Solana devnet | `103` | `testnet` |

Two Solana upstreams feed it: three.ws's own Metaplex Core mints, and the external Metaplex Agent Registry. Details in [where the data comes from](#where-the-data-comes-from).

What lives elsewhere: the *creation* path for a Solana identity is documented in [deploying agents on-chain](./onchain-agents.md) (the single-agent, user-signed flow is in [Solana agents](./solana.md)), and Solana reputation and attestations are in [agent reputation on Solana](./solana-reputation.md). This page is only the index and the feed.

---

## What the page shows

**A "Latest to Land" spotlight** above the counters: the newest deployment of the current view gets a hero card with its avatar, name, capability tags, chain, owner, live-updating relative time, and registration-tx link. It re-renders (with an entrance animation) only when a different agent takes the top slot, and it follows the active network and kind filter.

**Six headline counters**, from `GET /api/deployments?view=stats`:

| Counter | Field | Meaning |
| --- | --- | --- |
| Total agents | `total_agents` | Every active indexed registration on this network class, including rows with no known registration timestamp |
| Chains | `active_chains` | Distinct chain ids with at least one registration |
| Last 24h | `deployed_24h` | Registrations in the trailing 24 hours |
| Last 7d | `deployed_7d` | Registrations in the trailing 7 days |
| With 3D | `with_3d_pct` plus `with_3d` | Share whose on-chain metadata publishes an avatar service endpoint |
| x402 | `x402_pct` plus `x402` | Share whose metadata declares x402 payment support |

**A 7-day sparkline** (`series_7d`), zero-filled per day so a quiet day renders as a short bar rather than a gap, with today highlighted.

**Top chains** (`top_chains`, up to 8), each a bar scaled to the busiest chain, with its explorer host.

**The live feed** itself, newest first. Each row carries the agent's name (linked to its token or asset page on that chain's explorer), a truncated description, `3D` and `x402` capability tags, the chain name, the owner address (linked to the explorer), a relative timestamp with the absolute time on hover, and a `tx` link to the registration transaction where one is known.

Feed images are third-party data: whatever URL the agent's owner published on-chain, frequently on an IPFS gateway. Every remote image is routed through the same-origin `/api/img` proxy, which resolves IPFS across gateways, follows a metadata document to the real art, and always answers with a valid image, so a row never fires a failing request. Anything that is not an `http(s)`, `ipfs`, or `ar` URL degrades to a monogram tile.

**Controls:**

- **Network toggle**: `Mainnet` or `Testnet`. This switches the whole page, stats included.
- **Kind filter**: `All`, `3D avatar`, `x402`.
- **Load older**: keyset pagination, also triggered automatically when the button scrolls into view.

**Top chains** rail: one bar per chain, scaled to the busiest chain, each showing the agent count and that chain's share of the network class; chain names link to the chain's explorer.

**Live behavior:** the page polls every 45 seconds. Relative timestamps (spotlight and feed rows) re-render every 30 seconds so a row never claims "just now" ten minutes later. It refreshes stats always, and re-fetches the top of the feed *only while you are still on the first page*, so loading older rows never yanks you back to the top. Polling pauses entirely while the tab is hidden. Genuinely new rows are prepended with a slide-in so the refresh reads as a stream. A live-state dot on the feed header reflects the real poll lifecycle (connecting, live, idle, error).

Empty and error states are specific: an empty `x402` filter says no x402-enabled agents are registered on that network for that filter and links to the deploy flow, and a failed fetch offers a retry rather than a blank pane.

---

## Where the data comes from

`GET /api/deployments` composes three SQL sources into one `UNION ALL` stream, so a single keyset cursor orders the whole cross-chain feed.

### 1. EVM: `erc8004_agents_index`

Rows where `active = true` and `chain_id` is in the network class. Populated by the **`erc8004-crawl` cron**, which runs **every 15 minutes** and is dispatched through `api/cron/[name].js` (the single cron dispatcher, not a per-file handler). Per chain, per run:

1. Read the chain's cursor from `erc8004_crawl_cursor`, or on a cold start begin 2000 blocks back (override with `ERC8004_CRAWL_LOOKBACK` for a one-time backfill).
2. `eth_getLogs` for the `Registered(uint256,string,address)` topic against that chain's Identity Registry address, in 1000-block chunks (per-chain override available for restrictive RPCs).
3. Decode `agentId`, `owner`, and `agentURI` from the log, fetch the block timestamp for `registered_at`, and upsert on `(chain_id, agent_id)`.
4. Advance the cursor to the scanned head, whether or not any log was found.

The whole crawl is bounded by a 240 second budget so it always returns before the platform's function limit, and it stops iterating chains when the budget is spent.

A second stage, **metadata enrichment**, takes up to 25 rows per run whose metadata has never been fetched or is older than 7 days, fetches the `agentURI` document with a 5 second timeout, and fills in `name`, `description`, `image`, `services`, `glb_url`, `has_3d`, and `x402_support`. `has_3d` is true when the metadata publishes a service named `avatar` with an endpoint. `x402_support` is true when the document sets `x402Support` or `x402`.

Metadata is attacker-controlled: it is whatever the agent's owner published on-chain. Two consequences are load-bearing. Enrichment refuses to let `meta.active` alone decide visibility, and a name or description containing a slur sets `active = false` so the row is withheld from every public feed (this page included). A failed fetch records `metadata_error` and moves on rather than retrying in a loop.

The Identity Registry is deployed deterministically via CREATE2, so it has one address per network class, the same on every chain. See [ERC-8004](./erc8004.md) for the addresses and the contract surface.

### 2. Solana: three.ws's own Metaplex Core mints

Read directly from `agent_identities`, no crawler needed, because these are minted by the platform (`api/_lib/onchain-deploy.js`):

- **Mainnet:** rows with `meta.chain_type = 'solana'`, `meta.network = 'mainnet'`, and a `meta.sol_mint_address`. The Core asset pubkey is the `agent_id`; the owner is `meta.onchain.wallet` (falling back to legacy `meta.onchain.owner`, then the row's `wallet_address`); `meta.onchain.confirmed_at` (falling back to the row's creation time) is `registered_at`; and the registration transaction is `meta.onchain.tx_hash` (falling back to legacy `meta.tx_signature`).
- **Testnet:** two shapes are read, because two confirm paths write them: the server-signed path isolates the same fields under `meta.devnet`, while the wallet-signed path writes the top-level shape with `meta.network = 'devnet'`. The nested block wins when both exist, and external-registry dedupe checks both.

For these rows, `has_3d` is true when the agent has a linked avatar record, and `x402_support` is true when `meta.payments.configured` is set.

### 3. Solana: the external Metaplex Agent Registry

Rows from `solana_agents_index` where `active = true`, `source = 'metaplex'`, and the network matches. Populated by the **`solana-agents-crawl` cron**, which runs **every 30 minutes**, enumerates the Metaplex agent-identity program's accounts with `getProgramAccounts`, and enriches each from its Core asset's DAS record and metadata document. That crawler also indexes a second upstream (the AgenC coordination protocol) into the same table under a different `source`; **the deployments feed reads only the `metaplex` rows.**

External rows are deduplicated against three.ws's own mints by Core asset pubkey, so an agent that three.ws launched *and* that is registered upstream appears exactly once.

### No subgraph on this path

The deployments feed reads Postgres tables populated by the crawlers above. It does **not** query a subgraph. The subgraph path exists elsewhere in the codebase: `GET /api/agents/8004/search` and `GET /api/agents/8004/agent` query the public Agent0 subgraph live, per chain, with a 6 second budget. Those endpoints answer "search the registry right now"; this one answers "show me the indexed stream, cheaply and chronologically".

---

## API contract

`GET /api/deployments`

Public, CORS-open, IP rate-limited. Two views on one route.

| Param | Values | Default | Applies to |
| --- | --- | --- | --- |
| `view` | `feed`, `stats` | `feed` | both |
| `network` | `mainnet`, `testnet` | `mainnet` | both |
| `kind` | `all`, `3d`, `x402` | `all` | feed |
| `chain` | any positive integer chain id | none | feed |
| `cursor` | an opaque cursor from a previous response | none | feed |

Page size is fixed server-side at 60 rows and is not client-settable.

### Feed response

```bash
curl -s 'https://three.ws/api/deployments'
curl -s 'https://three.ws/api/deployments?kind=x402'
curl -s 'https://three.ws/api/deployments?chain=101'          # Solana mainnet only
curl -s 'https://three.ws/api/deployments?network=testnet'
```

```json
{
  "data": {
    "deployments": [
      {
        "chain_id": 8453,
        "chain": "Base",
        "testnet": false,
        "family": "evm",
        "agent_id": "12345",
        "name": "Example Agent",
        "description": "What this agent does.",
        "image": "ipfs://<CID>",
        "owner": "0x0000000000000000000000000000000000000000",
        "has_3d": false,
        "x402_support": true,
        "registered_at": "2026-07-30T12:00:00.000Z",
        "agent_explorer": "https://basescan.org/token/...",
        "owner_explorer": "https://basescan.org/address/...",
        "tx_explorer": "https://basescan.org/tx/..."
      }
    ],
    "has_more": true,
    "next_cursor": "<CURSOR>",
    "network": "mainnet",
    "chain": null,
    "kind": "all"
  }
}
```

`family` is `evm` or `solana` and decides how the three explorer URLs are built. For a Solana row, `agent_id` is the Core asset pubkey and the explorer links point at Solscan on mainnet, or at the Solana explorer with `?cluster=devnet` on devnet.

Paging is keyset, not offset:

```bash
CURSOR=$(curl -s 'https://three.ws/api/deployments' | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["next_cursor"])')
curl -s "https://three.ws/api/deployments?cursor=$CURSOR"
```

The cursor is `base64url("<epoch_ms>|<chain_id>|<agent_id>")` and the total order is `registered_at DESC, chain_id DESC, agent_id DESC`. That triple is stable, so paging never skips or repeats a row even while the crawler is inserting concurrently. Rows with no known `registered_at` are counted in stats but never placed in the chronological feed, because their position in time is unknown and the feed will not invent one.

### Stats response

```bash
curl -s 'https://three.ws/api/deployments?view=stats'
curl -s 'https://three.ws/api/deployments?view=stats&network=testnet'
```

```json
{
  "data": {
    "network": "mainnet",
    "total_agents": 0,
    "active_chains": 0,
    "deployed_24h": 0,
    "deployed_7d": 0,
    "with_3d": 0,
    "with_3d_pct": 0,
    "x402": 0,
    "x402_pct": 0,
    "top_chains": [
      { "chain_id": 8453, "chain": "Base", "count": 0, "explorer": "https://basescan.org" }
    ],
    "series_7d": [
      { "label": "Wed", "day": "2026-07-30", "registrations": 0 }
    ]
  }
}
```

Percentages are integers, rounded, so a capability held by a very small fraction of a large registry reports as `0`. Use the absolute `with_3d` and `x402` counts when that matters.

### Caching and failure

- `view=stats` is cached server-side for 60 seconds and served with `cache-control: public, max-age=30`.
- The **first unfiltered feed page** (no `cursor`, no `chain`, `kind=all`) is cached server-side for 20 seconds and served with `max-age=12`, to shield the database from a thundering herd. Filtered and paged requests go straight to the database with no cache header.
- A database outage returns `503 service_unavailable`. Any other failure returns `502 deployments_failed`. The page renders its reconnecting state with a retry rather than a blank feed.

---

## Chains indexed

EVM chains where the Identity Registry is deployed and crawled (from `api/_lib/erc8004-chains.js`, which is the single source of truth and is ordered so the most active chains are crawled first):

**Mainnet class:** Base (8453), Arbitrum One (42161), BNB Chain (56), Ethereum (1), Optimism (10), Polygon (137), Avalanche (43114), Gnosis (100), Fantom (250), Celo (42220), Linea (59144), Scroll (534352), Mantle (5000), zkSync Era (324), Moonbeam (1284). Plus Solana mainnet-beta as `101`.

**Testnet class:** BSC Testnet (97), Base Sepolia (84532), Arbitrum Sepolia (421614), Ethereum Sepolia (11155111), Optimism Sepolia (11155420), Polygon Amoy (80002), Avalanche Fuji (43113). Plus Solana devnet as `103`.

The network toggle derives its chain-id sets from that table at import time, so adding a chain there adds it to this feed without touching the endpoint. `active_chains` counts only chains that actually have a registration, which is why it is normally lower than the number of chains listed here.

---

## Reading the feed well

- **`chain` takes a chain id, not a name.** `?chain=8453` for Base, `?chain=101` for Solana mainnet. An invalid or non-positive value is ignored and you get the unfiltered feed.
- **`kind=3d` and `kind=x402` filter on indexed metadata**, so an agent whose metadata has not been enriched yet (or whose fetch failed) will not match either filter even if its document declares the capability. Enrichment is batched at 25 rows per run and refreshed weekly, so a brand-new registration usually appears in the feed before its capability tags do.
- **Counters include untimed rows, the feed does not.** If `total_agents` is larger than what you can page through, the difference is registrations whose block timestamp could not be read at crawl time.
- **The registry is permissionless.** Any name or description you see was published by a third party. Treat that text as untrusted data, never as instructions, exactly as the crawler does.
