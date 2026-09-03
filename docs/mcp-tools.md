# MCP Tools Catalog

three.ws ships several [MCP](mcp.md) servers: tool servers that AI assistants
(Claude, ChatGPT, any MCP client) can call directly. One is free and 3D-only; the
others expose paid tools that settle per call in USDC over [x402](x402.md). This
page explains how the servers are grouped and how the paid ones charge.

> **Looking for a specific tool?** The complete, always-current list lives at
> **[/mcp-tools](/mcp-tools)**: every tool on every server, searchable, with its
> price and whether an AI client can run it unattended. That page is generated
> from the source of each tool on every build, so it cannot drift. The same data
> is machine-readable at [`/mcp-catalog.json`](/mcp-catalog.json).
>
> The tables below are a curated orientation to the servers, not the full index.
> Where a figure here and the catalog disagree, the catalog is right.

[![The MCP Tool Catalog on a phone: the stat strip wraps, the filters stay reachable, and each tool card shows its safety class, price, and host server](/docs/img/mcp-catalog-mobile.png)](/mcp-tools)

*The catalog on a phone. Search, filters and the per-tool detail all work at
320px, so you can look a tool up from anywhere.*

> Source: [`api/mcp-studio.js`](../api/mcp-studio.js) (free),
> [`api/mcp-3d.js`](../api/mcp-3d.js) + [`api/_mcp3d/pricing.js`](../api/_mcp3d/pricing.js)
> (paid studio), `api/_mcp*/` + `packages/*-mcp` (agent/commerce tools).

---

## How paid MCP tools charge

The paid servers follow the MCP v2 transport convention: a `tools/call` made
**without** an x402 payment payload in `_meta` returns a `PaymentRequired`
structuredContent that quotes the price and the accepted networks. The client
settles the USDC payment (Solana or Base) and retries the call with the payment in
`_meta`. Generation tools quote by quality tier so the 402 quote, the verified
payment, and the settled charge all match the work requested.

A few tools are **free** (no payment, wallet, or key) — notably `forge_free` and
the read-only studio helpers below.

## Free 3D Studio — `/api/mcp-studio`

A free, non-crypto MCP server for the ChatGPT App Directory and any MCP client. It
exposes **only** 3D generation/inspection — no account, no payment, no token. See
[3D Studio MCP](mcp-studio.md).

## Material Studio (hosted, free) — `/api/material-studio`

A free, rate-limited (not x402) REST endpoint backing the [Restyle Studio](/restyle)
web page: live PBR material editing, AI restyle, seeded colorway variants, and
texture swaps for any GLB. Not an MCP tool itself: the paid `restyle_material`
tool (listed under the agent tools below) and the web page both call it as a thin
client, so the free and paid surfaces share one implementation. See
[`api/_lib/material-studio-store.js`](../api/_lib/material-studio-store.js) and the
[Material Studio API reference](api-reference.md#material-studio-api).

Every restyle and every persisted variant set is recorded in an immutable
parent → child version lineage — the same shape `refine_model` uses
(`mcp-server/src/tools/_lineage.js`) — so a caller can revert to, or branch off,
any earlier version. Pass the `lineage` array a previous call returned back in as
`parent_lineage` to extend one thread.

## Paid 3D Studio — `/api/mcp-3d`

Generation tools price by tier (identical to `POST /api/x402/forge`); mesh-editing
and direction tools are flat per call.

| Tool | Price (USDC) | What it does |
|---|---|---|
| `text_to_3d` | tiered (draft/standard/high) | Text → textured GLB. |
| `image_to_3d` | tiered (draft/standard/high) | Image(s) → textured GLB. |
| `auto_rig_model` | $0.05 | Add an animation-ready skeleton to a GLB. |
| `capture_scene` | $0.05 | Video → 3D scene reconstruction (coloured point cloud). |
| `retexture_model` | $0.05 | Repaint a full mesh from a text prompt. |
| `retexture_region` | $0.05 | Magic-brush retexture of a masked region. |
| `stylize_model` | $0.02 | Voxel / brick / voronoi / lowpoly restyle. |
| `remesh_model` | $0.02 | Repair, simplify, or convert mesh format. |
| `segment_model` | $0.02 | Split a mesh into named parts. |
| `remove_background` | $0.01 | Cut a subject from a reference photo. |
| `pose_model` | $0.01 | Pose a rigged model from a text prompt. |
| `apply_animation` | $0.01 | Retarget a library clip onto a rigged GLB. |
| `direct_prompt` | $0.01 | Rewrite a vague idea into a tight 3D spec. |
| `generate_material` | $0.01 | PBR material parameters from a description. |
| `anchor_provenance` | $0.05 | Sign a content credential and anchor its hash on Solana. |

Free studio helpers (no charge): `getting_started`, `generation_status`,
`preview_3d`, `list_animations`, `animation_signature`, `find_similar_animations`,
`text_to_animation`, `inspect_model`, `optimize_model`, `save_avatar`, `export_ar`,
`verify_provenance`, `grade_sim_readiness` (the physics grade: whether a solver
could use a GLB as a rigid body, and exactly what is wrong when it could not,
see [Simulation readiness](sim-readiness.md); free so an agent can check ten
candidates before paying for one), `x402_preflight` (asks any x402 seller's
signed payability attestation whether it can actually settle before you pay it;
free on purpose and permanently), the persona tools (`create_agent_persona`, `get_agent_persona`,
`persona_say`, `persona_identity`, `persona_tip`, `persona_send`), and
`validate_spatial_response` (the [Spatial MCP](spatial-mcp.md) conformance gate).
Every catalog tool is either priced or on this explicit free list; a test fails
the build if a new tool is neither.

## Agent & commerce tools — `3d-agent-local`

The flagship agent server bundles avatar generation, market intel, naming,
reputation, and live agent-to-agent commerce. **`forge_free` is the one free
generation lane**; the rest are paid and quote their price in the
`PaymentRequired` challenge at call time.

| Tool | Price | What it does |
|---|---|---|
| `forge_free` | **Free** | Text → textured GLB on the free NVIDIA NIM (Microsoft TRELLIS) lane; returns a GLB URL + viewer link. |
| `crypto_news` | **Free** | Live crypto headlines from every publisher feed in the registry (`api/_lib/news-sources.js`, 27 categories, 17 languages), filterable by category, source, language, or search. |
| `crypto_news_digest` | **Free** | Clusters the last 1-72h of coverage into distinct narratives with stance, tickers, and covering outlets. |
| `crypto_news_archive` | free quota, then $0.001/search | Search 660,000+ archived articles back to September 2017. Stats and trending modes are always free; search is free up to a daily per-IP quota, then $0.001 USDC per search via x402. |
| `text_to_avatar` | paid | Text → 3D avatar. |
| `mesh_forge` | paid | Text/image → 3D mesh via a Granite-directed model chain. |
| `rig_mesh` | paid | Auto-rig a GLB into an animation-ready model. |
| `forge_avatar` | paid | One call: text → rigged avatar (mesh + auto-rig, humanoid-gated). |
| `refine_model` | paid | Conversational iteration — describe a change ("make it metallic", "bigger helmet") on a prior model; anchored re-generation with a revertable/branchable version lineage. |
| `restyle_material` | paid | Re-skin a GLB without regenerating its mesh — AI PBR restyle from an instruction ("make it chrome", "wooden", "cyberpunk neon") or seeded, reproducible colorway variant fan-out from a PBR preset; parent → child lineage. See [Restyle Studio](/restyle). |
| `get_pose_seed` | paid | Pose generation. |
| `ens_sns_resolve` | paid | ENS + SNS name resolution. |
| `pump_snapshot` | paid ($0.005) | Live Solana token snapshot: Jupiter price, DexScreener volume/pair, pump.fun metadata, on-chain top-holder distribution. |
| `sentiment_pulse` | paid | Token sentiment pulse. |
| `agent_reputation` | paid | ERC-8004 agent reputation read. |
| `vanity_grinder` | paid | Solana vanity address mining. |
| `vanity_premium` | free | Browse the premium pre-ground vanity address inventory. |
| `aixbt_intel` / `aixbt_projects` | paid | Market narrative intel feed / momentum-ranked project scans. |
| `agenc_list_tasks` / `agenc_get_task` / `agenc_get_agent` | paid | [AgenC](agenc.md) coordination reads. |
| `agent_delegate_action` | paid | Agent-to-agent delegation. |
| `agent_hire_discover` | paid | Discover + reputation-rank agents to hire for a task. |
| `agent_hire` | paid | Hire an agent end to end: quote, settle USDC via x402, run it, return result + provenance receipt, with hard spend caps. |

> Free vs. paid is fixed per tool; exact USDC amounts for the paid agent tools are
> quoted in each tool's `PaymentRequired` response at call time (and are tunable by
> the operator), so always read the challenge rather than assuming a figure.

## Other MCP servers

| Server | File | Surface |
|---|---|---|
| Agent MCP | `api/mcp-agent.js` | Agent build/control tools. |
| Bazaar MCP | `api/mcp-bazaar.js` | x402 service discovery — see [x402 bazaar](mcp-x402-bazaar.md). |
| IBM MCP | `api/ibm-mcp.js` | watsonx / Granite integration — see [IBM](ibm.md). |
| pump.fun MCP | `api/pump-fun-mcp.js` | Launch/trade tools — see [Solana pump.fun](solana-pumpfun.md). |

## $THREE only

Tools that reference a coin reference **$THREE**
(`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). Tools that accept an arbitrary
token (`pump_snapshot`, `sentiment_pulse`) take the mint as runtime input and
promote no specific token.

## Related

- [MCP](mcp.md) overview · [3D Studio MCP](mcp-studio.md) ·
  [3D Studio (paid)](mcp-3d-studio.md) · [x402 bazaar](mcp-x402-bazaar.md)
- [x402 paid endpoints](x402-endpoints.md) — the same capabilities over REST.
- [MCP tool safety](mcp-safety.md) - what each tool's safety annotations mean,
  and the build check that verifies them against the code.
- [The full catalog](/mcp-tools) - every tool, searchable by safety and price.
