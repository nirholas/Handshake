# Remix economy — provenance + creator royalties for 3D assets

Every model generated on three.ws carries its provenance, and creators can opt a
finished model into the **remix bazaar**: when another agent builds on it, a
creator-set royalty routes back to the original creator on-chain. This turns the
generator into a creative economy — build on someone's asset, value flows to them.

Conversational iteration (`refine_model`) is free on both tracks; the remix +
royalty surface below is **Claude / paid track only** and never appears in the
free OpenAI 3D Studio app.

## The pieces

| Surface | Auth | What it does |
|---|---|---|
| `POST /api/forge-iterate` | `x-forge-client` | Conversational iteration, ownership-preserving (see below) |
| `GET /api/remix-feed` | none (free) | Browse remixable assets with provenance + royalty terms; supports `category`, `q`, `sort` |
| `POST /api/remix-feed` `{action:'publish'}` | `x-forge-client` | Opt your own finished model into the bazaar, set license/royalty/payout wallet |
| `GET /api/remix-feed?action=lineage&root=<id>` | none (free) | Reconstruct a model's full refinement thread |
| `GET /api/remix-feed?action=trending` | none (free) | The most-remixed published assets, platform-wide |
| `GET /api/creations-leaderboard` | none (free) | Top creators by remix count + real on-chain royalty earned |
| `POST /api/x402/remix-asset` | x402 ($0.25 USDC) | Pay to remix a source; a royalty routes to its creator on-chain |

## The Creator Gallery — [/creations](https://three.ws/creations)

The discovery + remix front door (roadmap prompt 09): search, filter, and sort
the bazaar with a live `<model-viewer>` preview per card, a **Trending
remixes** strip and a **Top creators** leaderboard, a one-click "Remix — $0.25"
action wired to the same `window.X402.pay()` flow as Forge Studio, a lineage
viewer per card, and a publish form for opting your own creation in without
leaving the page. It reuses every endpoint on this page — no parallel data
store — and links out to `/minted` (tokenized mints) and an agent's `/agents/:id`
profile, which now surfaces a **3D Creations** card (every asset that agent has
minted as an NFT, via `GET /api/v1/tokenized/launches?agent_id=`) when the
creator behind a listing is an on-chain-identified agent.

Provenance is stored on the existing `forge_creations` rows — no parallel store:
`parent_creation_id`, `refine_instruction`, `lineage_index`, `remixable`,
`remix_royalty_bps`, `creator_wallet_solana`, `remix_settlement_ref`.

## In the browser — Forge Studio

[/forge-studio](https://three.ws/forge-studio) wires both halves of this doc
into the UI directly, so nothing here is API-only:

- **Iterate panel** (below every result) — a text box: describe a change
  ("make it metallic", "bigger helmet", "add wings") and Apply regenerates a
  new version anchored to the one on screen. A version-strip renders once a
  second version exists — click any earlier chip to revert the viewer to it
  instantly (no network call, the GLB is already known) or Apply again from
  that point to branch a new line of versions off it. The viewer cross-fades
  between versions, never a pop or a frozen frame.
- **Remix economy panel** — publish the model on screen as remixable (license,
  royalty rate up to 20%, payout wallet), and browse everyone else's
  published, remixable models with provenance + royalty terms shown before
  you commit. "Remix — $0.25" opens the real x402 payment widget
  (`window.X402.pay`); on settlement the panel shows the paid-fee receipt and,
  when a royalty routed, the creator's on-chain settlement receipt inline —
  both link out to Solscan.

The Iterate panel calls `POST /api/forge-iterate`, not the free
`/api/mcp-studio` `refine_model` tool. The two run the exact same
`composeRefinement` + version-lineage core
(`mcp-server/src/tools/_lineage.js`, so wording behaves identically
everywhere), but `/api/mcp-studio` is a server-to-server call with no
forwarded client identity — its results can't be attributed to a browser
session, so they can never be published to the bazaar. `/api/forge-iterate`
forwards this browser's `x-forge-client` header through to `/api/forge`, so
an iteration is a normal owned creation: gallery-listed, downloadable, and
eligible to publish as remixable. It carries no payment surface of its own —
iteration itself stays free.

`/api/forge` holds the connection open while a saturated generator queues the
job, so an accept can legitimately take minutes. `/api/forge-iterate` therefore
waits up to `FORGE_ITERATE_SUBMIT_MS` (default 60000) for it, and when that
window runs out it answers the way the generator itself would, `429 busy` with
`retryAfter: 20`, rather than a `504` that both iterate UIs used to read as a
wording problem and answer with "rephrase your instruction".

## Publish a model as remixable

You must own the creation (same `x-forge-client` that generated it). Only finished
models with a stored GLB can be published.

```bash
curl -X POST https://three.ws/api/remix-feed \
  -H 'content-type: application/json' \
  -H 'x-forge-client: <your-browser-id>' \
  -d '{
    "action": "publish",
    "creation_id": "<YOUR_CREATION_ID>",
    "license": "remix-royalty",
    "royalty_bps": 1000,
    "creator_wallet": "<YOUR_SOLANA_ADDRESS>"
  }'
```

- `license` — `remix-royalty` (remix allowed, royalties on remix), `remix-cc`
  (remix freely), `remix-nc` (remix, non-commercial), or `all-rights` (display
  only, not remixable).
- `royalty_bps` — basis points, `0`–`2000` (0–20%). Clamped to the cap; the
  remixer always keeps the majority of the fee.
- `creator_wallet` — Solana address that receives royalties. Optional at publish
  time, but no royalty can route without one.

## Browse the feed

```bash
curl https://three.ws/api/remix-feed
```

```json
{
  "enabled": true,
  "items": [
    {
      "id": "…",
      "prompt": "a friendly round robot mascot, glossy white plastic",
      "glbUrl": "https://…/model.glb",
      "viewerUrl": "https://three.ws/viewer?src=…",
      "royaltyBps": 1000,
      "royaltyPercent": 10,
      "royaltyPayable": true,
      "isDerived": false,
      "lineageIndex": 0
    }
  ],
  "next": "2026-07-07T11:40:00.000Z"
}
```

Terms are visible **before** remixing. The raw payout wallet is never exposed —
only `royaltyPayable` (whether a royalty can route).

## Remix a published asset (paid, with royalties)

`POST /api/x402/remix-asset` is an x402 endpoint. Pay the fixed $0.25 USDC fee
(via any x402 client), and the platform:

1. Generates a NEW model anchored to the source (`composeRefinement` +
   image→3D off the source's reference image when present).
2. Records the durable `parent → child` provenance edge.
3. Routes the creator's royalty slice on-chain from the platform payout wallet —
   a real second USDC transfer, capped at 20%.

Request body:

```json
{ "source_creation_id": "<SOURCE_ID>", "instruction": "make it metallic" }
```

Response (after settlement):

```json
{
  "ok": true,
  "remix": { "glbUrl": "https://…/remixed.glb", "viewerUrl": "…", "creationId": "…", "anchored": true },
  "source": { "id": "<SOURCE_ID>", "royaltyBps": 1000, "royaltyPercent": 10 },
  "royalty": {
    "paid": true,
    "royaltyBps": 1000,
    "capped": false,
    "creatorUsd": 0.025,
    "platformUsd": 0.225,
    "creatorTx": "<on-chain settlement signature>"
  },
  "fee": { "usd": 0.25, "atomics": "250000" }
}
```

`royalty.creatorTx` is the real on-chain settlement reference. When a source has
no payout wallet, or the royalty is below the 0.01 USDC dust floor, `paid` is
`false` with an honest `reason` — never a fake pending.

When the source belongs to a signed-in creator (anonymous `forge_creations`
rows have no `user_id`), a settled remix also publishes a `remix` event to that
creator's notification feed, folding "you were remixed" and the royalty outcome
into one line, and awards the first-remix-received badge once. Both are
fire-and-forget and never delay the response. A validation failure (bad source
id, empty instruction) is answered before settlement with the error's own
status and code, so the buyer is never charged for a request that could not run.

### Split math + caps

Pure and unit-tested (`api/_lib/remix-royalty.js`,
`tests/remix-royalty.test.js`, `tests/remix-settlement.test.js`):

- Creator royalty = `floor(fee × bps / 10000)`, clamped to the 20% cap.
- `creatorAtomics + platformAtomics === fee` for every input — no value created
  or lost.
- Sub-dust royalties (< 0.01 USDC) are recorded but not paid (the transfer would
  cost more than it moves).

USDC is the settlement asset only. No other coin is referenced anywhere in the
remix surface.

## Configuration

| Env var | Purpose |
|---|---|
| `REMIX_ROYALTY_PAYOUT_KEY` | Base58 64-byte Solana secret for the platform royalty payout wallet (holds USDC). Falls back to `CLUB_SOLANA_TREASURY_SECRET_KEY_B64`. |
| `REMIX_ASSET_TIMEOUT_MS` | Poll budget for the remix generation. Default 180000. |

When no payout wallet is configured, remixes still generate and provenance is
still recorded — the royalty leg reports `payout_unconfigured` instead of paying.

## Related

- [3D Studio (free) MCP](./mcp-studio.md) — the `refine_model` iteration tool.
- [The 3D pipeline](./3d-pipeline.md) — how generation itself works.
