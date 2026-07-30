# Minted 3D Assets: the public gallery of on-chain avatars

[three.ws/minted](https://three.ws/minted) is the live, public gallery of every generated or owned avatar that a creator chose to mint as a **Metaplex Core NFT** through three.ws. It is the NFT counterpart of the `/launches` coin directory: real on-chain property, listed the moment it mints. Every card renders the actual model in a live, auto-rotating 3D viewer (not a flat thumbnail), and every asset carries baked provenance and an enforced, capped creator royalty. Minting is always opt-in: the free text-to-3D lane never mints anything on its own.

This doc covers the gallery surface and the mint flow as a user-facing feature. The provenance internals live in their own docs: [content credentials for AI-generated models](provenance.md) (signed credentials, Solana anchoring, the free verify endpoint) and [the three.ws mint mark](mint-mark.md) (the `3ws` address branding on coin launches).

## The gallery

Open [/minted](https://three.ws/minted) with no account and no wallet. What you get:

- **A live 3D card per mint.** Each card is a `<model-viewer>` streaming the asset's GLB, slowly rotating, with the rendered thumbnail as its loading poster. Clicking the model opens it in the full interactive viewer.
- **Royalty chip.** The enforced on-chain creator royalty, as a percentage, on every card.
- **Remix badges.** An asset that names a `parent_mint` (a derivative of another creator's mint) is tagged `remix`; if the parent creator's royalty was actually paid out of the mint fee, the badge upgrades to `remix · royalty paid`.
- **Prompt line.** When the mint carries a generation prompt in its provenance, the card quotes it.
- **Mint link.** Every card links its mint address to Solscan (devnet assets link to the devnet cluster view).
- **Network toggle.** Mainnet is the default feed; a tab switches to devnet, where free test mints land.
- **Counters.** Assets on the page, average royalty, remixes with a paid-out royalty, and the selected network.
- **Continuous feed.** The grid paginates automatically as you scroll, and the top of the feed refreshes every 30 seconds while the tab is visible, so fresh mints appear without a reload.

An empty network shows an honest empty state pointing you at `/forge` to generate a model and at Agent Identity Studio to mint one. There are no synthetic entries.

### The feed API

The gallery reads a free, public, paginated endpoint that anyone (or any agent) can use:

```bash
curl "https://three.ws/api/v1/tokenized/launches?network=mainnet&offset=0&limit=24"
```

- Optional `agent_id=<uuid>` filters to one agent's mints.
- `limit` caps at 100; responses carry `has_more` for pagination.
- Rate-limited to 60 requests/min per IP, with a 15-second CDN cache so polling agents stay current without hammering the database.
- Like every `/api/v1` endpoint, the payload is wrapped in `{ "data": ... }` and the endpoint is discoverable via `GET /api/v1`.

## How a mint works

Minting runs through the `mint_3d_asset` tool on the [3D Studio MCP server](mcp.md). It is priced per call via x402 (USDC); an OAuth bearer token bypasses payment. A creator supplies:

- **The model:** an owned `avatar_id`, or any absolute `glb_url`.
- **The recipient:** an explicit `owner_wallet` (base58), or the OAuth-linked Solana wallet by default.
- **Royalty terms:** `seller_fee_basis_points`, hard-capped at 10% (1000 bps; a higher request is clamped and the response says so), and an optional `royalty_recipient` (defaults to the owner).
- **The network:** `devnet` by default for free testing; `mainnet` is explicit and is a real, disclosed on-chain write.
- **Optional lineage and provenance:** `parent_mint` (this is a remix), plus `prompt`, `generation_model`, and `generation_provider` overrides.

The server then:

1. **Claims an idempotency row before touching the chain.** Repeating a call for the same asset returns the same mint instead of minting twice; a failed attempt can be retried under the same key.
2. **Promotes the media to durable storage.** The GLB and a freshly rendered thumbnail are copied to a permanent first-party key (the NFT media never moves, even if the source avatar is later deleted), and pinned to IPFS when a pinning provider is configured (best-effort; a pin failure never fails the mint).
3. **Builds Metaplex-compliant metadata** with the GLB under `animation_url`, so wallets and marketplaces that render glTF show the live model, and everything else falls back to the rendered image.
4. **Mints the Core asset with an enforced Royalties plugin.** The recipient wallet owns the asset outright; the three.ws collection authority pays the rent and holds update authority (so the platform can curate on-chain metadata, but never move or take the asset).
5. **Records the launch** so the asset appears on `/minted` and in the feed API, with explorer and viewer links in the response.

### Baked provenance

Every mint carries its provenance twice:

- **In the NFT metadata itself:** creator, prompt, generation model and provider, parent lineage, and timestamp travel with the asset wherever it goes.
- **As a signed record on the platform's append-only agent-actions ledger** (when the source avatar has a provisioned agent to sign as): an independently verifiable entry, referenced in the mint response and queryable via the MCP action tools. This write is best-effort and never blocks a mint that already succeeded on-chain.

For how signed credentials, canonical hashing, and on-chain anchoring work under the hood, read [provenance.md](provenance.md). For the `3ws` address mark that brands coin launches, read [mint-mark.md](mint-mark.md).

### Remix royalties: paid the moment a remix mints

Naming another creator's mint as `parent_mint` makes your mint a remix, and that lineage is durable in both the metadata and the launch record. On mainnet, when a real per-call x402 fee was collected for the mint, the parent creator's royalty slice is routed out of that fee as a **real on-chain USDC transfer the moment the mint confirms**, and the settlement (amount, recipient, transaction) comes back in the mint response and shows on the gallery card.

Every non-paying outcome is reported with an honest reason rather than a fake "pending": devnet mints record lineage but settle nothing (the payout wallet holds real mainnet funds only), an OAuth-bypassed call collected no fee to split, a split can fall below the dust floor, or the parent may have no royalty wallet.

## Reading a mint back

The companion MCP tool `get_3d_asset_onchain` resolves any Core mint address to its live state: the current holder and enforced royalty terms read from the chain (authoritative over the platform record), the baked provenance, the GLB and viewer link with a liveness check, and, for assets minted through three.ws, the platform launch record and any remix settlement. It works on any Metaplex Core mint, not just ours.

## Related

- [Verifiable 3D provenance](provenance.md): signed content credentials and free verification for generated models
- [The three.ws mint mark](mint-mark.md): the `3ws` address brand on coin launches
- [MCP servers](mcp.md): the `mint_3d_asset` and `get_3d_asset_onchain` tools
- [Custody you can verify](custody.md): the wallet rails behind agent-held assets
