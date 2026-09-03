# MCP Integration

Model Context Protocol (MCP) lets Claude and other MCP-compatible AI systems interact with your three.ws account directly. When connected, Claude can list your avatars, render them as interactive 3D viewers, validate and inspect glTF files, and generate optimization suggestions — all through natural language.

This document covers the MCP server's tools, authentication, client configuration, and how to test locally.

---

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that connects AI assistants to external tool servers via JSON-RPC 2.0. Once your MCP client points at the three.ws server, the LLM sees a curated set of tools it can call autonomously during a conversation.

For three.ws specifically, this means Claude can:

- Browse and search your avatar library without you copy-pasting URLs
- Render any avatar inline as an interactive `<model-viewer>` HTML artifact
- Run the Khronos glTF-Validator against any public GLB or glTF URL
- Inspect mesh/texture/animation counts and geometry stats
- Get actionable optimization suggestions (compression, LOD, texture transcoding)

---

## Server details

| Property          | Value                                        |
|-------------------|----------------------------------------------|
| **URL**           | `https://three.ws/api/mcp`         |
| **Transport**     | Streamable HTTP (`POST /api/mcp`)            |
| **Protocol**      | MCP `2025-06-18`, JSON-RPC 2.0               |
| **Auth**          | OAuth 2.1 (end-user) or API key (server-to-server) |

For local development:

```bash
npm run dev
# MCP endpoint: http://localhost:3000/api/mcp
# Auth is still enforced — use an API key or OAuth token.
```

The MCP server configuration is at `.mcp.json` in the project root, which Claude Code auto-discovers.

---

## The full three.ws MCP ecosystem

This page documents the hosted avatar/3D server at `/api/mcp`, but it's one of **50 three.ws MCP servers** — all listed in the [official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas), so any MCP-compatible client can discover them by name.

The hosted servers are also self-describing: [`https://three.ws/.well-known/mcp.json`](https://three.ws/.well-known/mcp.json) is a machine-readable directory of every hosted endpoint with its transport, auth model, and a one-line description, so an agent can enumerate all of them with a single fetch.

There are two kinds. **Hosted remote servers** run over Streamable HTTP with nothing to install — add them by URL. **Install-and-run servers** are published on npm under the `@three-ws` scope and run locally over stdio — add them in one line with `npx`.

**Seven hosted remote servers** (Streamable HTTP, no install):

| Server | Endpoint | What it does |
|--------|----------|--------------|
| three.ws | `/api/mcp` | Avatars, glTF/GLB validation, agent data, memory, copy-trading, a connected home (this page) |
| 3D Studio | `/api/mcp-3d` | Paid text/image→3D, rigging, retexture, optimization |
| 3D Studio (free) | `/api/mcp-studio` | Free text/image→3D and rigged avatars — no auth, no payment |
| Agent wallet | `/api/mcp-agent` | The agent's custodial wallet: balance, find + pay services, and `monetize_endpoint` |
| x402 Bazaar | `/api/mcp-bazaar` | Discover and price paid agent services across the facilitator network |
| pump.fun | `/api/pump-fun-mcp` | Free pump.fun + Solana token tools; `get_new_tokens` and `get_trending_tokens` read the live pump.fun feed with no indexer needed; `pumpfun_upload_metadata` needs a key |
| IBM x402 | `/api/ibm-mcp` | Pay-per-use IBM Granite AI |

**Forty install-and-run servers** on npm under the `@three-ws` scope, each running over stdio with one command:

```bash
# 3D & avatars
npx -y @three-ws/scene-mcp        # speak a 3D diorama into being from one sentence
npx -y @three-ws/assistant-mcp    # generate a 3D avatar assistant widget embed for any site
npx -y @three-ws/avatar-mcp       # drop a live 3D avatar into any chat
npx -y @three-ws/concierge-mcp    # ask any site's AI concierge; generate the 3D chat-widget embed
npx -y @three-ws/avatar-agent     # turn any GLB into a riggable 3D AI agent
npx -y @three-ws/mcp-server       # full 3D + agent toolkit, paid per call in USDC

# Payments & the agent economy
npx -y @three-ws/x402-mcp         # self-custodial wallet: find, inspect & pay any x402 service in USDC
npx -y @three-ws/three-token-mcp  # price, hold, and burn $THREE on Solana
npx -y @three-ws/mcp-bridge       # bridge that pays any x402 endpoint on the open web
npx -y @three-ws/ibm-x402-mcp     # pay-per-use IBM Granite AI
npx -y @three-ws/agentcore-payments-mcp # pay x402 endpoints from a governed budget, no private key

# On-chain identity
npx -y @three-ws/metaplex-agent-mcp # mint + register on-chain agents in the Metaplex Agent Registry (deploy fee funds $THREE buybacks, waived for holders)

# Market data, intel & discovery
npx -y @three-ws/intel-mcp        # smart-money, signal feeds, KOL & copy-trade intel
npx -y @three-ws/pumpfun-mcp      # free pump.fun + Solana token discovery
npx -y @three-ws/vanity-mcp       # Solana vanity-address bounty market + rarity gallery
npx -y @three-ws/marketplace-mcp  # browse the agent marketplace + skills catalog

# Naming & AI
npx -y @three-ws/naming-mcp       # resolve .sol names + check *.threews.sol identity availability
npx -y @three-ws/ibm-watsonx-mcp  # IBM watsonx.ai on your own account

# Autonomous agent control plane
npx -y @three-ws/autopilot-mcp     # set scopes + daily $THREE spend caps, then propose/execute/undo
npx -y @three-ws/portfolio-mcp     # portfolio value, PnL, balances, trade feed & signed transfers
npx -y @three-ws/provenance-mcp    # append-only, signed, on-chain-verifiable agent action log

# Trading, signals & alerts
npx -y @three-ws/copy-mcp          # manage copy-trade follows, sizing & guard rules
npx -y @three-ws/signals-mcp       # discover signal feeds by proven edge; rank publishers
npx -y @three-ws/alerts-mcp        # pump.fun alert rules across in-app / webhook / Telegram
npx -y @three-ws/kol-mcp           # per-wallet KOL portfolio + trade analytics

# Autonomous sniper (runs locally against your own wallet/RPC)
npx -y @three-ws/agent-sniper mcp   # arm pump.fun snipe strategies, fire manual buys, manage positions
npx -y @three-ws/agent-sniper serve # the same engine as an x402-paid HTTP API (POST /strategies, /snipe)

# Account, inbox & discovery
npx -y @three-ws/notifications-mcp # inbox, read state, delivery prefs & Web Push devices
npx -y @three-ws/herald-mcp        # tell your human in person: your avatar walks on and says it
npx -y @three-ws/billing-mcp       # plan quotas, metered usage, invoices & receipts
npx -y @three-ws/activity-mcp      # trending agents/coins, $THREE holder board & activity ticker

# More AI & capability
npx -y @three-ws/vision-mcp        # analyze & describe images via the three.ws vision pipeline
npx -y @three-ws/brain-mcp         # run any LLM through the multi-provider router
npx -y @three-ws/audio-mcp         # TTS, STT, audio-to-face lipsync & motion-capture clips
npx -y @three-ws/alibaba-cloud-mcp  # Qwen chat + embeddings on your own DashScope key

# The physical world
npx -y @three-ws/home-mcp          # run a real Home Assistant house: rooms, scenes, gated service calls

# Coordination, gaming & learning
npx -y @three-ws/agenc-mcp         # AgenC on-chain task marketplace + agent registry
npx -y @three-ws/agora-mcp         # join Agora's agent economy: browse the board, claim & complete real work, earn $THREE
npx -y @three-ws/clash-mcp         # Coin Clash faction battles
npx -y @three-ws/tutor-mcp         # itemized learning-session ledger
npx -y @three-ws/loom-mcp          # browse & contribute to the Loom 3D-creation gallery
```

Every one is also registered in the MCP registry under the `io.github.nirholas/*` namespace.

### Find these servers across MCP directories

The same servers surface in the major MCP directories and aggregators, so any MCP-compatible client can discover three.ws by name:

- **Official MCP Registry** — [registry.modelcontextprotocol.io/?q=io.github.nirholas](https://registry.modelcontextprotocol.io/?q=io.github.nirholas) (the source of truth; PulseMCP and Glama ingest from here)
- **Smithery** — [smithery.ai/search?q=three.ws](https://smithery.ai/search?q=three.ws)
- **Glama** — [glama.ai/mcp/servers?query=three.ws](https://glama.ai/mcp/servers?query=three.ws)
- **PulseMCP** — [pulsemcp.com/servers?q=three.ws](https://www.pulsemcp.com/servers?q=three.ws)
- **mcp.so** — [mcp.so/?q=three.ws](https://mcp.so/?q=three.ws)

Ready-to-submit listing packages for each directory, plus the canonical metadata source they all derive from, live in [`prompts/store-submissions/_generated/`](../prompts/store-submissions/_generated/mcp-directories/).

### Per-server guides

Deep dives — every tool, argument, env var, and example:

- **Hosted remote:** [3D Studio (free)](./mcp-studio.md) · [3D Studio (paid)](./mcp-3d-studio.md) · [Agent wallet](./mcp-agent.md) · [x402 Bazaar](./mcp-x402-bazaar.md) · [IBM x402](./ibm-x402-mcp.md)
- **Install-and-run:** each npm server ships its usage guide (tools, arguments, env vars, examples) in its package README on [npmjs.com/org/three-ws](https://www.npmjs.com/org/three-ws). The [MCP Tools Catalog](./mcp-tools.md) maps every tool to its server and price.

---

## Authentication

### OAuth 2.1 (recommended for Claude Desktop / Claude Code)

Claude handles the OAuth handshake automatically via dynamic client registration (RFC 7591). When you first connect, it will:

1. Register a client at `POST /oauth/register`.
2. Open `GET /oauth/authorize?...` in your browser for login and consent.
3. Exchange the authorization code at `POST /oauth/token` with PKCE (S256).
4. Cache the resulting JWT and refresh it automatically.

The access token carries scopes (`avatars:read`, `avatars:delete`, etc.) that gate which tools Claude can call. Metadata discovery endpoints follow RFC 8414 and RFC 9728:

```
GET /.well-known/oauth-authorization-server
GET /.well-known/oauth-protected-resource
```

On a `401`, the `WWW-Authenticate` header points clients at the protected-resource metadata URL so they can begin the flow.

### API key (server-to-server)

For scripts, CI, and server agents, generate a key at **Dashboard → API Keys** and pass it as a bearer token:

```bash
curl -X POST https://three.ws/api/mcp \
  -H "Authorization: Bearer 3da_live_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Keys are tied to a single user account and inherit that user's plan quotas.

---

## Connecting Claude Code

Claude Code auto-discovers `.mcp.json` at the project root. Add your key to that file:

```json
{
  "mcpServers": {
    "3d-agent": {
      "url": "https://three.ws/api/mcp",
      "headers": {
        "Authorization": "Bearer 3da_live_xxxxx"
      }
    }
  }
}
```

Or add it globally in `~/.claude/settings.json` under `mcpServers` with the same shape.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent path on your OS:

```json
{
  "mcpServers": {
    "3dagent": {
      "command": "npx",
      "args": ["-y", "@three-ws/mcp-server", "--url", "https://three.ws/"]
    }
  }
}
```

This uses the standalone npm package, which handles OAuth locally. The `--url` flag lets you point at a local dev server.

### Any MCP-compatible client

Send `POST /api/mcp` with valid JSON-RPC 2.0 messages and a bearer token. The server is stateless — no session setup needed beyond the `initialize` handshake.

---

## Available tools

All tools return `{ content: [{ type, text }], structuredContent: {...} }`. On error, `isError: true` is set and `content[0].text` contains the message.

The tools below are the core avatar, validation, minting, and market-data set. The server registers more beyond this page (memory `remember`/`recall`/`forget`, `register_agent`, oracle and pump.fun intel reads, trader analytics, copy-trading); call `tools/list` for the complete live catalog with schemas.

---

### `list_my_avatars`

Paginated list of the authenticated user's avatars.

**Scope required:** `avatars:read`

```json
{
  "type": "object",
  "properties": {
    "limit":      { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
    "cursor":     { "type": "string", "description": "Opaque pagination cursor from previous response." },
    "visibility": { "type": "string", "enum": ["private", "unlisted", "public"] }
  },
  "additionalProperties": false
}
```

Returns each avatar's `id`, `name`, `slug`, `size`, `visibility`, and `model_url` (when publicly accessible).

---

### `get_avatar`

Fetch a single avatar by `id` (UUID) or by your `slug`.

**Scope required:** `avatars:read`

```json
{
  "type": "object",
  "properties": {
    "id":   { "type": "string", "format": "uuid" },
    "slug": { "type": "string" }
  },
  "additionalProperties": false
}
```

For private avatars, returns a short-lived signed URL (1-hour expiry). Public and unlisted avatars return a permanent CDN URL.

---

### `search_public_avatars`

Full-text search over the public avatar gallery. No authentication required for the search itself.

```json
{
  "type": "object",
  "properties": {
    "q":     { "type": "string", "description": "Free-text search over name and description." },
    "tag":   { "type": "string", "description": "Filter to one tag." },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 12 }
  },
  "additionalProperties": false
}
```

---

### `render_avatar`

Returns a complete `<model-viewer>` HTML document for the specified avatar. Claude renders this as an inline HTML artifact — an interactive 3D viewer that supports orbit controls, auto-rotate, and AR on mobile.

**Scope required:** `avatars:read`

```json
{
  "type": "object",
  "properties": {
    "id":            { "type": "string", "format": "uuid" },
    "slug":          { "type": "string" },
    "auto_rotate":   { "type": "boolean", "default": true },
    "background":    { "type": "string", "description": "CSS background color or gradient.", "default": "transparent" },
    "height":        { "type": "string", "default": "480px" },
    "width":         { "type": "string", "default": "100%" },
    "camera_orbit":  { "type": "string", "description": "model-viewer camera-orbit value, e.g. \"0deg 80deg 2m\"." },
    "poster":        { "type": "string", "description": "HTTPS URL of a poster image shown while loading." },
    "ar":            { "type": "boolean", "default": true, "description": "Include AR button for mobile." }
  },
  "additionalProperties": false
}
```

The response contains two content entries: a short text summary (for the transcript) and a `resource` entry with `mimeType: "text/html"` that MCP clients render inline.

**Note:** Agents whose embed policy sets `surfaces.mcp = false` cannot be rendered via this tool. The server returns error code `-32000` with message `embed_denied_surface` in that case.

---

### `delete_avatar`

Soft-delete an avatar you own. Irreversible from the API (contact support to recover).

**Scope required:** `avatars:delete`

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "format": "uuid" }
  },
  "required": ["id"],
  "additionalProperties": false
}
```

---

### `attach_avatar_to_agent`

Give an agent a persistent visual body: attach a generated/rigged avatar you own (from `forge_avatar`, `mesh_forge` + `rig_mesh`, or any avatar in `list_my_avatars`) to one of your registered agent identities. The same `agent_id` shows the same body afterwards — `get_avatar`, `render_avatar`, and `get_embed_code` all resolve it. This is the bridge from generation to identity: generate a rigged GLB, save it as an avatar, then call this tool to make it the agent's body. Chain `register_agent` next to mint the on-chain identity (ERC-8004 on Base, or a Metaplex Agent Registry PDA on Solana) and `anchor_provenance` to credential the GLB itself — together the agent has a body, an on-chain identity, and a verifiable authenticity record.

**Scope required:** `agents:write`. Both the agent and the avatar must belong to the caller — requires a signed-in three.ws account (OAuth); x402 pay-per-call principals cannot call this.

```json
{
  "type": "object",
  "properties": {
    "agent_id":  { "type": "string", "format": "uuid", "description": "Your agent identity id." },
    "avatar_id": { "type": "string", "format": "uuid", "description": "The avatar to attach — one of your own (see list_my_avatars)." }
  },
  "required": ["agent_id", "avatar_id"],
  "additionalProperties": false
}
```

Returns `status: "attached"`, the agent/avatar ids and names, `replaced_avatar_id` (the previous body, if any), `profile_url`, and a `next_steps` hint pointing at `register_agent` / `anchor_provenance` when they haven't run yet.

---

### `validate_model`

Run the [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator) against any public HTTPS GLB or glTF URL. Returns error, warning, info, and hint counts with detailed per-issue messages. SSRF-hardened: only public `https://` URLs are fetched.

**Rate limit:** 10 calls/minute per user.

```json
{
  "type": "object",
  "properties": {
    "url":        { "type": "string", "format": "uri", "description": "Public https URL of a .glb or .gltf file." },
    "max_issues": { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

Example response text:
```
glTF-Validator report for avatar.glb (1842.3 KB)
Errors: 0, Warnings: 2, Infos: 4, Hints: 1

  [WRN] ACCESSOR_ELEMENT_OUT_OF_RANGE: … @ /accessors/3
  [WRN] MESH_PRIMITIVE_UNUSED_TEXCOORD: … @ /meshes/0/primitives/0
```

---

### `inspect_model`

Parse a remote GLB/glTF and return structural statistics: scene/node/mesh counts, vertex and triangle totals, material and texture summaries, animation count, extensions used. Pure inspection — no pass/fail verdict, no spec compliance check.

**Rate limit:** 30 calls/minute per user.

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri", "description": "Public https URL of a .glb or .gltf file." }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

Example response text:
```
Model: avatar.glb (1.80 MB, glb)
Generator: Blender 4.1 · glTF 2.0
Scenes: 1, Nodes: 47, Meshes: 12, Materials: 8, Textures: 10
Animations: 3, Skins: 1
Vertices: 18,432, Triangles: 24,108
Indexed primitives: 12, Non-indexed: 0
Extensions used: KHR_materials_unlit
Textures:
  • Albedo — image/jpeg 1024×1024, 184.2 KB
  • Normal — image/png 512×512, 92.7 KB
```

`structuredContent` carries the full structured object for programmatic processing.

---

### `optimize_model`

Inspect the model and return actionable suggestions for reducing file size and draw-call overhead: triangle budget, Draco/Meshopt compression, oversized textures, KTX2 transcoding, non-indexed primitives, redundant materials, and more. Each suggestion includes a severity (`info`, `warn`, `critical`) and a size-reduction estimate.

**Rate limit:** 10 calls/minute per user.

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "format": "uri", "description": "Public https URL of a .glb or .gltf file." }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

Example response text:
```
[CRIT] large_textures: 3 textures exceed 512×512 — consider resizing. — estimated 60% size reduction
[WARN] no_draco: No geometry compression detected — apply Draco or Meshopt. — estimated 40% size reduction
[INFO] ktx2_transcoding: Convert PNG/JPEG textures to KTX2 for GPU-native compression.
```

---

### `mint_3d_asset`

Mint a generated or owned GLB as a **Metaplex Core NFT on Solana whose media is a live, interactive 3D viewer** — the rigged glTF model is stored under `animation_url`, not a static image. The tool promotes the GLB and a freshly-rendered thumbnail to durable storage (R2, plus IPFS when configured), builds Metaplex-compliant metadata with baked provenance (creator, prompt, generation model, parent lineage, timestamp), and mints a Core asset with an enforced Royalties plugin to the recipient. **Devnet by default**; pass `network: "mainnet"` for a real mainnet mint.

The call is **idempotent**: a row is claimed before any on-chain action, so a repeat call with the same arguments returns the same mint instead of minting twice. The royalty is capped at **10 %** (1000 bps) — a higher request is clamped.

**Signed provenance ledger.** Alongside the provenance baked into the NFT metadata, the mint appends an ERC-191-signed record to the platform's append-only `agent_actions` ledger — the same ledger [`@three-ws/provenance-mcp`](https://www.npmjs.com/package/@three-ws/provenance-mcp) reads and verifies (`list_agent_actions` / `query_action`). It requires the source avatar to have a provisioned agent; when it doesn't, the mint still succeeds and `provenance_ledger` in the response is `null` — never a blocking requirement. Every avatar generated through the platform (chat forge-to-avatar, direct upload, studio save) also gets this same signed ledger entry the moment its agent is provisioned, independent of ever being minted.

**Remix royalty settlement.** When `parent_mint` names another creator's tokenized asset (this mint is a derivative), the parent creator's royalty share — using the rate set on their own mint — is routed out of **this mint's fee** as a real on-chain USDC transfer, the moment the mint confirms. Mainnet only, and only when the mint fee was actually collected via x402 (an OAuth-bypassed call has nothing to split). Every outcome is reported honestly in `remix_royalty.reason` (`no_creator_wallet`, `below_dust_floor`, `payout_unconfigured`, `devnet_not_settled`, `no_fee_collected`, `parent_not_found`) rather than a fabricated payout.

**Pricing:** $0.25 USDC per mint via x402 (an OAuth bearer token bypasses payment). Supply either `avatar_id` (an avatar you own) or `glb_url`, and a recipient (`owner_wallet`, or your OAuth-linked Solana wallet).

```json
{
  "type": "object",
  "properties": {
    "avatar_id":               { "type": "string", "format": "uuid", "description": "An owned avatar to tokenize." },
    "glb_url":                 { "type": "string", "format": "uri", "description": "Or a GLB URL to tokenize." },
    "owner_wallet":            { "type": "string", "description": "Recipient Solana wallet (base58). Defaults to your OAuth wallet." },
    "name":                    { "type": "string", "maxLength": 200 },
    "description":             { "type": "string", "maxLength": 2000 },
    "network":                 { "type": "string", "enum": ["devnet", "mainnet"], "default": "devnet" },
    "seller_fee_basis_points": { "type": "integer", "minimum": 0, "maximum": 1000, "description": "Enforced royalty; clamped to the 10% cap." },
    "royalty_recipient":       { "type": "string", "description": "Wallet the royalty routes to. Defaults to the owner." },
    "parent_mint":             { "type": "string", "description": "Lineage: the asset this was remixed from." },
    "prompt":                  { "type": "string", "maxLength": 1000 },
    "generation_model":        { "type": "string", "maxLength": 96 },
    "generation_provider":     { "type": "string", "maxLength": 64 },
    "idempotency_key":         { "type": "string", "maxLength": 128 }
  },
  "additionalProperties": false
}
```

The `structuredContent` returns the `mint` address, `explorer_asset_url` + `explorer_tx_url` (Solscan), `viewer_url` (the live three.ws 3D viewer), `metadata_uri`, the `royalty` terms (`basis_points`, `percent`, `recipient`, `cap_basis_points`, `capped`), `provenance_ledger` (`action_id`, `signed`, `signer_address`, `digest` — or `null`), and `remix_royalty` (the settlement above — or `null` when there's no `parent_mint`).

---

### `get_3d_asset_onchain`

Resolve a Solana mint address to its **live 3D asset**: current holder, the interactive viewer link + GLB (confirmed live via a HEAD request), baked provenance, and the enforced on-chain royalty terms. Reads the Metaplex Core asset, fetches its off-chain metadata, and joins the three.ws launch record when the asset was minted through the platform. Works on any Metaplex Core mint. Read-only, public — no auth, no payment.

```json
{
  "type": "object",
  "properties": {
    "mint":    { "type": "string", "description": "The Metaplex Core asset (mint) pubkey, base58." },
    "network": { "type": "string", "enum": ["devnet", "mainnet"], "default": "devnet" }
  },
  "required": ["mint"],
  "additionalProperties": false
}
```

Returns `holder`, `media` (`glb_url`, `image_url`, `viewer_url`, `viewer_live`), `provenance`, `provenance_ledger` (the mint's signed `agent_actions` entry, or `null`), `royalty` (`basis_points`, `percent`, `recipient`, `enforced_onchain`, `cap_basis_points`), `remix_royalty` (the settlement routed to the parent creator, or `null`), and, for platform mints, `minted_through_threews` + `tx_signature`.

**Browsing every mint:** `GET /api/v1/tokenized/launches?limit=24&offset=0&network=mainnet&agent_id=<uuid>` is the free, public, paginated directory of every 3D asset minted through three.ws — the NFT counterpart to `GET /api/v1/pump/launches`. No auth, no payment; 60 requests/min per IP. The same directory renders as a live public gallery at [three.ws/minted](https://three.ws/minted) — a `<model-viewer>` card per mint with its royalty terms, network, and remix badge, the NFT counterpart of [/launches](https://three.ws/launches).

---

### `create_gated_embed`

Turn an avatar or on-chain agent **you own** into a holder-only interactive 3D embed. Visitors must prove — with a real, server-verified Solana SPL token balance, never a client-reported number — they hold at least `min_amount` of `mint` before the live scene renders; below the bar they see a designed locked teaser with a connect-wallet CTA. `mint` defaults to `$THREE` but accepts any SPL mint at runtime (a community can gate with its own token). Requires `avatars:write` scope.

```json
{
  "type": "object",
  "properties": {
    "asset_id":   { "type": "string", "description": "\"avatar:<uuid>\" or \"<chainId>:<agentId>\" — an asset you own." },
    "mint":       { "type": "string", "description": "SPL mint holders must have a balance of. Defaults to $THREE." },
    "min_amount": { "type": "number", "exclusiveMinimum": 0, "description": "Minimum balance a visitor must hold to unlock." }
  },
  "required": ["asset_id", "min_amount"],
  "additionalProperties": false
}
```

The `structuredContent` returns `gate_id`, `asset_id`, `gate` (`mint`, `min_amount`, `chain`), and `embed_snippet` — a ready-to-paste `<script>` + `<three-d>` tag. See [Token-gated 3D embeds](./token-gated-3d-embeds.md) for the full verification flow, the anti-abuse token/rate-limit design, and how visitors unlock the embed.

---

### `crypto_data`

Call any endpoint in the free [Crypto Data API](./api-reference.md) (the same aggregator behind `GET /api/v1/x/*`: DEX pairs, CoinGecko/DefiLlama market data, Jupiter Solana prices and swap quotes, direct Solana RPC reads) as an MCP tool call. The tool description is generated from the live provider registry at call time, so it always lists exactly the provider/endpoint pairs registered on this deployment — nothing hand-enumerated to drift out of date.

```json
{
  "type": "object",
  "properties": {
    "provider": { "type": "string", "description": "Registered provider id, e.g. \"coingecko\", \"dexscreener\", \"jupiter\", \"solana\", \"defillama\"." },
    "endpoint": { "type": "string", "description": "Endpoint id under that provider, e.g. \"price\", \"token\", \"quote\"." },
    "params":   { "type": "object", "description": "Endpoint-specific query params.", "additionalProperties": true }
  },
  "required": ["provider", "endpoint"],
  "additionalProperties": false
}
```

An unknown `provider`/`endpoint` pair returns an error result listing every valid pair. A registered endpoint marked free runs within the same per-IP quota the REST free lane enforces — no wallet needed. An endpoint with no free tier, or a free quota you've exhausted, returns a JSON-RPC `-32402` error naming the exact REST URL and USDC price to pay via [x402](./x402.md) — never a second, MCP-only payment flow.

```bash
# Equivalent to: GET /api/v1/x/dexscreener/token?addresses=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
curl -s https://three.ws/api/mcp -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "crypto_data", "arguments": {
    "provider": "dexscreener", "endpoint": "token",
    "params": { "addresses": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" }
  } }
}'
```

---

### `token_snapshot`

One-call snapshot for a Solana token mint. Fans out to whichever free crypto-data providers are registered on this deployment (DexScreener pairs, Jupiter price, Solana RPC supply) and merges what answers into one object — a provider that's unregistered, unconfigured, or errors is recorded in `skipped`/`failed` rather than failing the whole call. For pump.fun-specific bonding-curve/launch data, use `pump_snapshot` instead; this tool covers general market data.

```json
{
  "type": "object",
  "properties": {
    "mint": { "type": "string", "description": "Base58 Solana token mint address." }
  },
  "required": ["mint"],
  "additionalProperties": false
}
```

```bash
curl -s https://three.ws/api/mcp -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "token_snapshot", "arguments": { "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump" } }
}'
```

Returns `{ mint, sources: [...], dexscreener?, jupiter?, solana?, skipped: [...], failed: [...] }` — `sources` lists which providers actually answered.

---

### `text_to_animation`

Generate a brand-new motion from a natural-language prompt ("waving confidently", "a slow tai-chi sweep") with a text-to-motion diffusion model (MDM, MIT), then retarget it onto a caller-supplied rigged humanoid GLB — the same retarget engine `apply_animation` uses. Unlike the curated animation library, the motion does not pre-exist: it's synthesized for the prompt, on the self-host `model-text2motion` GPU worker (`workers/model-text2motion/`).

```json
{
  "type": "object",
  "properties": {
    "prompt":            { "type": "string", "minLength": 3, "maxLength": 1000 },
    "model_url":         { "type": "string", "format": "uri", "description": "Public https URL of a rigged humanoid .glb to animate." },
    "duration_seconds":  { "type": "number", "minimum": 1, "maximum": 10, "default": 4 }
  },
  "required": ["prompt", "model_url"],
  "additionalProperties": false
}
```

Returns the retargeted three.js `AnimationClip` JSON (or a baked animated GLB) plus a retarget report, the same shape `apply_animation` returns. Requires the text2motion worker configured on the deployment (`GCP_TEXT2MOTION_URL`) — errors with `-32001` if unset. Also reachable outside MCP via `POST /api/forge-motion` (`GET /api/forge-motion?job=<id>` to poll).

### `generate_garment`

Turn a text prompt ("a red varsity jacket") into a rigged, wearable garment published to the three.ws wardrobe catalog: reference image (Vertex image lane) → PBR mesh (self-host GPU fleet) → skinned to the canonical humanoid skeleton with full-body context (`model-rig`) → validated against every rule in `specs/GARMENT_MANIFEST.md`, including the 60% bind-coverage gate, before publish. Asynchronous (about 7 minutes); poll with `garment_status`.

```json
{
  "type": "object",
  "properties": {
    "prompt": { "type": "string", "minLength": 3, "maxLength": 500 },
    "slot":   { "type": "string", "enum": ["top", "bottom", "footwear", "outerwear", "hair", "headwear", "glasses", "accessory"] }
  },
  "required": ["prompt", "slot"],
  "additionalProperties": false
}
```

Returns `{ job_id, status, eta_seconds }`. The finished garment appears in the public catalog automatically and attaches to any humanoid avatar via the additive wardrobe (`docs/avatar-wardrobe.md`). Requires `GCP_GARMENT_FORGE_URL` on the deployment — errors with `-32001` if unset. Also reachable outside MCP via `POST /api/garment-forge`.

### `garment_status`

Poll a `generate_garment` job. While running, reports the pipeline stage (`image → mesh → compose → rig → extract → validate → publish`); when done, returns the published `glb_url`, `manifest_url`, thumbnail, measured bind `coverage`, and the occluded body regions.

```json
{
  "type": "object",
  "properties": { "job_id": { "type": "string" } },
  "required": ["job_id"],
  "additionalProperties": false
}
```

### `list_garment_catalog`

Fetch the public wardrobe catalog: every published garment manifest (id, slot, name, GLB url, thumbnail, occluded regions, license), optionally filtered by `slot`. Any entry attaches to any humanoid avatar.

```json
{
  "type": "object",
  "properties": {
    "slot": { "type": "string", "enum": ["top", "bottom", "footwear", "outerwear", "hair", "headwear", "glasses", "accessory"] }
  },
  "additionalProperties": false
}
```

### Your connected home

Five tools reach a Home Assistant house the account has connected at
[three.ws/smart-home](https://three.ws/smart-home). They are the same handlers the 3D agent and
the voice loop call, so the gate below cannot be different on this channel. `home_id` is optional
for an account with exactly one home.

Scopes: `home:read` for the three read tools, `home:act` for the two write tools. `home:act`
authorises **asking**; it never authorises answering, which is what keeps every bearer principal
out of the confirmation path.

**The gate.** Reads are free. Writes that make the house safer (`lock`, `close_cover`,
`close_valve`, `alarm_arm_*`) run immediately and never prompt. Writes that OPEN the house
(`unlock`, opening a door, gate or garage, `alarm_disarm`) never run from a tool call: they return
a **pending confirmation**, which is neither a success nor an error, and a signed-in person
redeems it in their own browser at `POST /api/home/:id/confirm` (session and CSRF only, no bearer,
ever). There is no `confirmed` property in any schema below and there never will be: a model
cannot set a field it was not handed.

Home Assistant's own `intent__HassTurnOff` is documented as performing an **unlock** on a lock, so
the gate resolves what a call would actually touch rather than trusting a service name. Entity,
area and scene names come from the user's devices and household and are returned in
`structuredContent` rather than interpolated into prose: treat them as untrusted data.

#### `home_status`

Read the current state of a connected home: its rooms, what is lit, the temperature, and whether
it is locked up. Returns a per-room rollup and a `stale` flag when the live connection has
dropped. Read-only.

```json
{
  "type": "object",
  "properties": {
    "home_id": { "type": "string", "format": "uuid" },
    "room":    { "type": "string", "maxLength": 80 }
  },
  "additionalProperties": false
}
```

#### `home_list_macros`

List the scenes and scripts this house already has. Prefer running one over composing your own
sequence of calls: the household's own "Bedtime" scene knows about the plant light and the fish
tank. Read-only.

```json
{
  "type": "object",
  "properties": { "home_id": { "type": "string", "format": "uuid" } },
  "additionalProperties": false
}
```

#### `home_grants`

List the entities this home has pre-approved, so a guarded action on one of them runs without
asking. Read this before proposing something that would otherwise prompt. Read-only.

```json
{
  "type": "object",
  "properties": { "home_id": { "type": "string", "format": "uuid" } },
  "additionalProperties": false
}
```

Returns the grants, and `confirmation_ttl_seconds` (90) so a caller knows how long a pending
confirmation stays redeemable.

#### `home_activate`

Match a phrase like "good night" or "I am home" to one of this house's own scenes or scripts, and
run it. Returns the match and its confidence. A house with no match runs nothing rather than
firing the closest scene. If the scene would unlock, open or disarm something, this returns a
pending confirmation instead of running.

```json
{
  "type": "object",
  "properties": {
    "home_id": { "type": "string", "format": "uuid" },
    "phrase":  { "type": "string", "minLength": 1, "maxLength": 200 },
    "dry_run": { "type": "boolean", "default": false }
  },
  "required": ["phrase"],
  "additionalProperties": false
}
```

#### `home_call`

Call a Home Assistant service when no scene fits. Target with `entity_id`, `device_id`, `area_id`
or `floor_id`; every target is resolved to concrete entities before the gate sees it.

```json
{
  "type": "object",
  "properties": {
    "home_id": { "type": "string", "format": "uuid" },
    "domain":  { "type": "string", "minLength": 1, "maxLength": 64 },
    "service": { "type": "string", "minLength": 1, "maxLength": 64 },
    "data":    { "type": "object", "default": {} }
  },
  "required": ["domain", "service"],
  "additionalProperties": false
}
```

Full walkthrough: [Connect your home](./tutorials/connect-your-home.md). To run a house from your
own machine with no three.ws account at all, use
[`@three-ws/home-mcp`](../packages/home-mcp/README.md) instead, where a guarded action is refused
outright because an MCP client has no person in it to confirm one.

---

## Rate limits

| Scope            | Limit                    |
|------------------|--------------------------|
| Per IP (all)     | 600 requests / minute    |
| Per user (all)   | 1 200 requests / minute  |
| `validate_model` | 10 calls / minute / user |
| `inspect_model`  | 30 calls / minute / user |
| `optimize_model` | 10 calls / minute / user |

Rate-limit errors return JSON-RPC error code `-32000` with message `rate_limited` and a `retry_after` field (seconds).

---

## Example Claude workflow

Here is a realistic conversation showing how Claude uses the MCP tools end-to-end.

**User:**
> I just uploaded a character called "storm-mage". Can you check if it's valid, show me its stats, and then render it?

**Claude internally calls:**

1. `get_avatar({ slug: "storm-mage" })` — resolves the UUID and model URL.

2. `validate_model({ url: "https://three.ws/cdn/u/…/storm-mage.glb" })` — runs the Khronos validator.

   Response:
   ```
   glTF-Validator report for storm-mage.glb (3241.0 KB)
   Errors: 0, Warnings: 1, Infos: 2, Hints: 0
     [WRN] NODE_EMPTY: node "Armature" has no mesh and no children
   ```

3. `inspect_model({ url: "https://three.ws/cdn/u/…/storm-mage.glb" })` — structural overview.

   Response:
   ```
   Model: storm-mage.glb (3.17 MB, glb)
   Generator: Blender 4.2 · glTF 2.0
   Scenes: 1, Nodes: 63, Meshes: 18, Materials: 11, Textures: 14
   Animations: 7, Skins: 1
   Vertices: 31,204, Triangles: 41,892
   ```

4. `render_avatar({ slug: "storm-mage", auto_rotate: true, height: "520px" })` — renders the HTML artifact.

**Claude replies:**

> Your storm-mage avatar looks good! The validator found zero errors and one minor warning: an empty "Armature" node that has no mesh or children — harmless but you can clean it up in Blender.
>
> Stats: 18 meshes, 11 materials, 7 animations, ~42K triangles — well within real-time budget. Here it is:
>
> *[inline 3D viewer appears as an interactive HTML artifact]*

---

## Error handling

MCP errors follow the JSON-RPC error object shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "unknown tool: load_model",
    "data": null
  }
}
```

| Code     | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `-32600` | Invalid JSON-RPC request (e.g. wrong `jsonrpc` version)        |
| `-32601` | Method not found                                               |
| `-32602` | Invalid params or unknown tool name                            |
| `-32603` | Internal server error                                          |
| `-32002` | Insufficient OAuth scope for the requested tool                |
| `-32000` | Server error: `rate_limited` (includes `retry_after`), `embed_denied_surface` |

Tool execution errors (avatar not found, fetch failure, validation library crash) do **not** use the JSON-RPC error channel. They return a normal result with `isError: true` and the message in `content[0].text`. This follows the MCP spec convention and allows tool-error recovery without aborting a batch.

**Authentication errors** return HTTP `401` with a `WWW-Authenticate` header. The header includes the protected-resource metadata URL so compliant clients (Claude Desktop, Claude Code) can start the OAuth flow automatically.

---

## Local development and testing

Clone the repo and start the dev server:

```bash
git clone https://github.com/nirholas/three.ws
npm install
npm run dev
# MCP endpoint: http://localhost:3000/api/mcp
```

Authentication is still enforced in dev mode. Use your API key in the `Authorization` header, or point a local OAuth client at the dev server.

Test the server with `mcp-inspector`:

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp
```

`mcp-inspector` gives you a browser UI to call tools manually, inspect responses, and validate JSON schemas before wiring up a full Claude workflow.

To point Claude Code at your local server, update `.mcp.json`:

```json
{
  "mcpServers": {
    "3d-agent": {
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer 3da_live_xxxxx"
      }
    }
  }
}
```

Restart Claude Code after editing `.mcp.json` so the new server config is picked up.

---

## Tool safety annotations

Every tool three.ws publishes carries the MCP `annotations` block, and those hints are a promise you can build on. Clients use them to decide whether a call needs a human in the loop, so the values are verified rather than asserted:

| Hint | What it means on three.ws |
| --- | --- |
| `readOnlyHint: true` | The call does not change state. Safe for a client to run unattended. |
| `readOnlyHint: false` | The call changes something: a stored avatar, an embed, an on-chain asset, a payment. |
| `destructiveHint: true` | The change cannot be undone (a transfer, a tip, a delete). |
| `destructiveHint: false` | The change is additive, so a retry or a follow-up call can correct it. |
| `idempotentHint` | Whether repeating the identical call produces the identical result. |
| `openWorldHint` | Whether the answer depends on a live external system (a chain, a market feed). |

Two things to know about the guarantee:

- **A read-only tool never writes anything you asked about.** A handful of read tools warm an internal cache while serving you (the Oracle verdict cache, the on-chain attestation cache). Those writes are the server's own bookkeeping, they are non-fatal, and they never change the result you get.
- **Anything that spends is annotated as spending.** Tools that mint, tip, or settle a payment declare `readOnlyHint: false`, and the irreversible ones declare `destructiveHint: true`. Price is advertised separately in `tools/list` under `pricing` (see [x402](/docs/x402)).

Contributors: `npm run audit:mcp-safety` enforces this. It parses each tool's handler, follows the functions it actually calls, and fails the build when a tool declares `readOnlyHint: true` while writing to the database or sending a transaction, when an irreversible action declares `destructiveHint: false`, or when a tool ships no annotations at all (the MCP spec defaults `destructiveHint` to `true` when omitted, so an unannotated tool tells clients to treat a harmless read as dangerous). The check is part of `npm run gate`; `npm run audit:mcp-safety -- --list` prints every tool with the evidence found in its handler.

---

## Related

- [MCP Tools Catalog](/docs/mcp-tools): every three.ws MCP tool, its server, and its price
- [MCP tool safety](/docs/mcp-safety): what the safety annotations promise, and how they are verified
- [MCP Tool Catalog](/mcp-tools): the searchable index of every tool, generated from source
- [3D Studio MCP (free)](/docs/mcp-studio): the no-auth, no-payment 3D generation server
- [Spatial MCP](/docs/spatial-mcp): returning live 3D scenes as native MCP responses
- [x402](/docs/x402): the USDC micropayment rail behind the paid tools

---

## Runnable example

[`examples/agent-native-3d/`](https://github.com/nirholas/three.ws/tree/main/examples/agent-native-3d) A Node script that drives the free MCP server end to end: generate a mesh, rig it, save it as a persona, speak through it, and emit every embed snippet.

It is part of the curated set `npm run export:satellites` publishes as the public
three.ws examples repo, so it is installed, run, and link-checked before every release.
