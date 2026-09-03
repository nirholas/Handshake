# Claude Connectors Directory: Submission Answer Sheet

**Status:** copy-paste-ready. Fields the operator must supply privately are marked `[HUMAN: fill in]`.
**Generated for:** the three.ws remote MCP servers. **Regenerated:** 2026-09-03.
**Method:** every string below was re-derived from production on 2026-09-03, not from a prior
snapshot. Tool names, titles, and annotations come from a live unauthenticated `tools/list` against
`https://three.ws/api/mcp` and `https://three.ws/api/mcp-3d`; prices come from
`public/mcp-catalog.json` (regenerated the same day and gated by `npm run audit:mcp-catalog`), with
the nine tools the catalog does not carry priced by a live unpaid call. Every URL in this sheet was
fetched and returned 200.

---

## 0. Read this first: open items the operator must resolve

None of these are blank form fields. They are judgment calls only the operator can make.

1. **Org / role (gating).** The in-app portal requires a **Team or Enterprise** Claude org and an
   **Owner** role (or a custom role with Directory management permission).
   `[HUMAN: confirm]` you have that. If not, use the **public MCP directory submission form**
   instead; the field content below is identical either way.

2. **Media-generation policy (review risk).** The published review criteria list "AI-generated
   images, video, or audio" among rejected use cases. The **`/api/mcp-3d` 3D Studio** server is
   largely generative (`text_to_3d`, `image_to_3d`, `retexture_*`, `stylize_model`,
   `generate_material`); the main server has two generative tools (`render_avatar_image`,
   `text_to_animation`).
   **Recommendation unchanged:** submit **`/api/mcp` first**. Of its 53 tools, 45 are free and 39
   are annotated `readOnlyHint: true`, so it presents as a data and validation surface. Hold
   `/api/mcp-3d` as a separate, later listing and ask the directory team whether 3D model (GLB)
   generation counts as prohibited media generation. `[HUMAN: decide]`

3. **Financial-transfer surface (review risk, CHANGED since the last revision).** The review
   criteria reject "financial asset transfers." Two facts to state plainly:
   - The connector charges **USDC via x402** as a per-call service fee for compute. Disclose it
     under the Transactions acknowledgment.
   - The main server's trader, Oracle, and Solana tools (`trader_leaderboard`, `trader_profile`,
     `copy_subscribe`, `copy_status`, `oracle_*`, `solana_agent_*`, `pumpfun_*`) are **read-only
     market data and on-chain reputation reads. They do not move funds or execute trades.**
   - **New:** `/api/mcp-3d` now carries two tools that DO move funds, `persona_tip` and
     `persona_send`. Both are annotated `destructiveHint: true`, settle real USDC on Solana, are
     hard-capped at $1 per call and $5 cumulative per session, and require `confirm: true` above
     $0.25. They are user-initiated payments from the user's own persona wallet, not custody or
     brokerage. If the directory treats any fund movement as disqualifying, submit `/api/mcp`
     (which has no such tool) and scope these out of the later 3D Studio listing. `[HUMAN: decide]`

4. **Discovery is OPEN in production (RESOLVED, was a blocker).** A prior revision of this sheet
   recorded that unauthenticated `initialize` / `tools/list` were OAuth-challenged and x402-gated,
   and warned the portal could not sync tools before OAuth. **That is no longer true.** Verified
   2026-09-03: an unauthenticated `POST` with a plain `Accept: application/json` returns **HTTP 200
   and the full catalog** on both servers, in under a second. The portal (and any registry crawler)
   can enumerate tools with no credential. OAuth remains what a user connects with to reach their
   own account-scoped data.

5. **Prerequisite artifacts.** `_generated/tool-inventory.md` and `_generated/remote-tools-list.json`
   are the prompt-01 captures and are now older than the live surface; the tables in section 4 below
   supersede them and were pulled live. `_generated/claude-reviewer-guide.md` documents the
   **separate stdio npm connector** (`@three-ws/mcp-server`), a different submission path, so
   section 6 here is the self-contained **remote-server** reviewer guide.

6. **Privacy is live (no action).** Verified 2026-09-03: `https://three.ws/legal/privacy` returns
   200 and contains the "MCP Connectors, AI Processing & Payments" section. `https://three.ws/support`
   returns 200. No pending privacy deploy.

---

## 1. Primary server choice

**Submit `https://three.ws/api/mcp` (three.ws Avatars & Agents) as the flagship.**

Why:
- Broadest and most directory-friendly surface: account-scoped avatar management, glTF/GLB
  validation, inspection and optimization (read-only), agent identity and reputation, agent memory,
  and live market reads. 39 of its 53 tools are annotated read-only; only 2 are destructive.
- Lower review risk than the 3D Studio server on both the media-generation criterion (section 0.2)
  and the fund-transfer criterion (section 0.3).
- Discovery works with no credential, so the portal's Connection step can sync tools immediately.

Optionally submit `https://three.ws/api/mcp-3d` (three.ws 3D Studio, 35 tools) as a second listing
once sections 0.2 and 0.3 are settled.

**Production verification, run 2026-09-03:**
```
POST https://three.ws/api/mcp      tools/list, no auth  -> 200, 53 tools
POST https://three.ws/api/mcp-3d   tools/list, no auth  -> 200, 35 tools
GET  https://three.ws/.well-known/oauth-protected-resource -> 200
     resource: https://three.ws/api/mcp
     authorization_servers: ["https://three.ws"]
     resource_documentation: https://three.ws/docs/mcp
     scopes_supported: avatars:read, avatars:write, avatars:delete, profile, offline_access,
                       memory:read, memory:write, agents:read, agents:write, feedback:read,
                       wallet:read, wallet:write, services:write
GET  https://three.ws/legal/privacy          -> 200
GET  https://three.ws/legal/tos              -> 200
GET  https://three.ws/support                -> 200
GET  https://three.ws/docs/mcp               -> 200
GET  https://three.ws/three-ws-mcp-icon.svg  -> 200
```

Unpaid calls to the 27 paid tools across the hosted remotes were swept the same day: **27 of 27**
returned a clean, structured x402 `PaymentRequired` (`x402Version: 2`, four `accepts` entries),
with no hang and no credential material in any response body.

---

## 2. Listing fields (portal Listing, Connection, Company and Authentication steps)

| Field | Value |
|---|---|
| **Server name** (max 100) | three.ws: Avatars & Agents |
| **Server URL** | `https://three.ws/api/mcp` |
| **Transport** | Streamable HTTP (MCP 2025-06-18) |
| **Tagline** (max 55) | `3D avatars, glTF tools & on-chain agent data` (44) |
| **Categories (1 to 5)** | Developer Tools; Productivity; Data & Analytics |
| **Documentation URL** | `https://three.ws/docs/mcp` |
| **Privacy policy URL** | `https://three.ws/legal/privacy` |
| **Support contact** | `support@three.ws` and `https://three.ws/support` (both live) |
| **Icon** | `https://three.ws/three-ws-mcp-icon.svg` |
| **URL slug** | `three-ws` |
| **Company name** | `[HUMAN: fill in legal entity name]` |
| **Company website** | `https://three.ws` |
| **Primary contact** | `[HUMAN: fill in name + email]` |
| **Authentication** | OAuth 2.1 (authorization code + PKCE). x402 (USDC) is an alternative pay-per-call path for unauthenticated callers. Discovery needs neither. |
| **User connection model** | Each user connects their own three.ws account via OAuth |

**Description** (max 2,000 chars):
> three.ws turns Claude into a 3D-content and on-chain-agent workstation. Manage your three.ws
> avatars (list, fetch, search public avatars, render to an interactive viewer or a static image,
> delete); validate, inspect, and get optimization guidance for any glTF/GLB model; list and apply
> animation presets to rigged models; and embed a live 3D viewer anywhere with a generated snippet.
>
> It also reads the on-chain agent economy: ERC-8004 and Solana agent reputation, attestations, and
> identity passport checks for impersonation screening; an agent registry you can call and register
> into; and persistent agent memory (remember, recall, forget) scoped to your account.
>
> For market context it surfaces live pump.fun data (recent claims, token and creator intel,
> graduations), Oracle conviction signals, and a pump.fun trader leaderboard with full track records
> and copy-subscription management, all read-only market data.
>
> Connect your three.ws account with OAuth to use your account-scoped tools. Public data tools can
> alternatively be paid per call with x402 (USDC). The only token three.ws promotes is $THREE.

---

## 3. Read / write capabilities summary (portal Use cases step)

Counts below are live as of 2026-09-03.

**`/api/mcp`: 53 tools. 45 free, 8 paid. 39 read-only, 2 destructive.**

- **Reads:** avatars (own and public search), glTF/GLB validation and inspection, animation presets
  and similarity search, agent registry, reputation, attestations and passport, agent memory recall,
  pump.fun market data, Oracle signals, trader leaderboard and profiles, copy-subscription status,
  embed-code generation.
- **Writes:** render and save avatar assets, delete an avatar, register an agent on-chain, call
  another agent, remember and forget memory, arm an Oracle watch, subscribe to copy a trader. Writes
  that touch a chain or an external API carry `openWorldHint: true`.
- **Destructive:** exactly two tools carry `destructiveHint: true` on the wire, `delete_avatar` and
  `forget`. Every other tool sets it explicitly to false.
- **Payments:** paid tools return a structured x402 `PaymentRequired` (not an error) when
  unauthenticated and unpaid. OAuth-connected account tools are operator-funded for the user.

**`/api/mcp-3d`: 35 tools. 21 free, 14 paid. 15 read-only, 2 destructive**
(`persona_tip`, `persona_send`; see section 0.3).

### Use cases
1. **Avatar ops in chat.** "List my three.ws avatars, render `nova` to an image, and give me an
   embed snippet for my site."
2. **glTF QA.** "Validate this GLB URL, inspect its mesh and material counts, and suggest
   optimizations before I ship it."
3. **Agent due diligence.** "Check the on-chain reputation and impersonation passport for this
   agent address before I delegate to it."
4. **Agent memory.** "Remember that this user prefers low-poly avatars," recalled in later sessions.
5. **Market read.** "Show the top pump.fun traders this week and the recent graduations."

---

## 4. Full tool list

> Pulled live from `tools/list` on 2026-09-03. **R/O** is `readOnlyHint: true`; **Dx** is
> `destructiveHint: true`. **Price** is the pay-per-call USDC amount for unauthenticated callers;
> free tools never charge. OAuth-connected account tools are operator-funded for the user.
>
> Two titles below (`persona_say`, `persona_identity`) read with a colon here. Production currently
> serves them with a dash; the punctuation was corrected in the tree on 2026-09-03 and takes effect
> on the next deploy. Nothing else in these tables differs from what production serves today.

### `https://three.ws/api/mcp`: three.ws Avatars & Agents (53 tools)

| Tool name | Title | R/O | Dx | Price |
|---|---|:--:|:--:|---|
| `getting_started` | Getting Started (free) | yes | - | free |
| `list_my_avatars` | List my avatars | yes | - | free |
| `get_avatar` | Get avatar | yes | - | free |
| `search_public_avatars` | Search public avatars | yes | - | $0.001 |
| `render_avatar` | Render avatar | yes | - | $0.005 |
| `render_avatar_image` | Render an avatar to an image | - | - | free |
| `delete_avatar` | Delete avatar | - | yes | free |
| `get_embed_code` | Get embed code | yes | - | free |
| `create_gated_embed` | Create a token-gated embed | - | - | free |
| `validate_model` | Validate glTF/GLB model | yes | - | $0.01 |
| `inspect_model` | Inspect glTF/GLB model | yes | - | $0.01 |
| `optimize_model` | Suggest optimizations for a glTF/GLB model | yes | - | $0.05 |
| `diff_models` | Diff two glTF/GLB models | yes | - | free |
| `print_analyze` | Check whether a 3D model can be printed | yes | - | free |
| `print_quote` | Price a real 3D print and get a signed quote | yes | - | free |
| `list_animations` | List animation presets | yes | - | free |
| `animation_signature` | Measure what an animation clip actually does | yes | - | free |
| `find_similar_animations` | Find clips with similar measured motion | yes | - | free |
| `apply_animation` | Apply an animation preset to a rigged model | - | - | $0.01 |
| `text_to_animation` | Generate an animation from a text prompt and retarget it onto a model | - | - | free |
| `list_sign_vocabulary` | List the ASL vocabulary | yes | - | free |
| `sign_text` | Sign text in ASL | yes | - | free |
| `solana_agent_reputation` | Get Solana agent reputation | yes | - | $0.001 |
| `solana_agent_attestations` | List Solana agent attestations | yes | - | free |
| `solana_agent_passport` | Get Solana agent passport | yes | - | free |
| `pumpfun_recent_claims` | Recent pump.fun claims | yes | - | free |
| `pumpfun_token_intel` | Pump.fun token intel | yes | - | free |
| `pumpfun_creator_intel` | Pump.fun creator intel | yes | - | free |
| `pumpfun_recent_graduations` | Recent pump.fun graduations | yes | - | free |
| `call_agent` | Call agent | - | - | free |
| `register_agent` | Register an agent on-chain | - | - | free |
| `attach_avatar_to_agent` | Give an agent a body | - | - | free |
| `identity_check` | Screen an agent identity for impersonation | yes | - | free |
| `remember` | Remember | - | - | free |
| `recall` | Recall | yes | - | free |
| `forget` | Forget | - | yes | free |
| `oracle_top_plays` | Oracle top conviction plays | yes | - | free |
| `oracle_coin` | Oracle verdict for one coin | yes | - | free |
| `oracle_arm_watch` | Arm agent Oracle watch | - | - | free |
| `oracle_watch_status` | Oracle watch status + track record | yes | - | free |
| `trader_leaderboard` | Top pump.fun traders | yes | - | free |
| `trader_profile` | Full track record for one agent | yes | - | free |
| `copy_subscribe` | Subscribe to copy a trader | - | - | free |
| `copy_status` | My copy subscriptions | yes | - | free |
| `mint_3d_asset` | Mint a 3D asset as a Solana NFT | - | - | $0.25 |
| `get_3d_asset_onchain` | Resolve a 3D NFT to its live asset + provenance | yes | - | free |
| `crypto_data` | Crypto Data API | yes | - | free |
| `token_snapshot` | Crypto token snapshot | yes | - | free |
| `generate_garment` | Generate a wearable garment from a text prompt | - | - | free |
| `garment_status` | Check a garment generation job | yes | - | free |
| `list_garment_catalog` | List the wardrobe garment catalog | yes | - | free |
| `list_feedback` | List feedback | yes | - | free |
| `get_feedback_repro` | Compile a feedback report into a failing test | yes | - | free |

### `https://three.ws/api/mcp-3d`: three.ws 3D Studio, optional second listing (35 tools)

| Tool name | Title | R/O | Dx | Price |
|---|---|:--:|:--:|---|
| `getting_started` | Getting Started (free) | yes | - | free |
| `text_to_3d` | Generate a 3D model from a text prompt | - | - | $0.15 |
| `image_to_3d` | Reconstruct a 3D model from one or more images | - | - | $0.15 |
| `generation_status` | Check a 3D generation job | yes | - | free |
| `capture_scene` | Reconstruct a 3D scene from a video | - | - | $0.05 |
| `preview_3d` | Preview any GLB as an interactive 3D artifact | yes | - | free |
| `remove_background` | Remove the background from an image | - | - | $0.01 |
| `remesh_model` | Remesh, simplify, repair, or convert a 3D model | - | - | $0.02 |
| `stylize_model` | Apply a one-click geometric stylization filter to a 3D model | - | - | $0.02 |
| `segment_model` | Split a 3D model into named, separable parts | - | - | $0.02 |
| `retexture_model` | Paint a new texture onto a 3D model from a text prompt | - | - | $0.05 |
| `retexture_region` | Repaint one masked region of a model's texture (magic brush) | - | - | $0.05 |
| `auto_rig_model` | Auto-rig a static 3D model (skeleton + skin weights) | - | - | $0.05 |
| `pose_model` | Resolve a text prompt to a pose-studio seed + joint rotations | yes | - | $0.01 |
| `direct_prompt` | Optimize a rough idea into a 3D-generation prompt (IBM Granite) | - | - | $0.01 |
| `generate_material` | Generate a glTF PBR material from a description (IBM Granite) | - | - | $0.01 |
| `save_avatar` | Save a generated GLB as a durable, named avatar | - | - | free |
| `create_agent_persona` | Mint a persistent, living agent persona from a rigged GLB | - | - | free |
| `get_agent_persona` | Reload a persisted persona by id (continuity across sessions) | yes | - | free |
| `persona_say` | Speak a reply through a persona: lip-sync + emotion + gesture | - | - | free |
| `validate_spatial_response` | Validate a Spatial MCP 3D artifact | yes | - | free |
| `export_ar` | Export a model for AR ("View in your space") | yes | - | free |
| `verify_provenance` | Verify a 3D model authenticity (content credential) | yes | - | free |
| `anchor_provenance` | Anchor a signed content credential for a 3D model | - | - | $0.05 |
| `persona_identity` | Read a persona's on-chain identity: wallet, reputation, holdings | yes | - | free |
| `persona_tip` | Tip USDC from a persona's own wallet | - | yes | free |
| `persona_send` | Send USDC from a persona's own wallet | - | yes | free |
| `x402_preflight` | Check whether an x402 seller can actually settle before paying it | yes | - | free |
| `inspect_model` | Inspect glTF/GLB model | yes | - | free |
| `optimize_model` | Suggest optimizations for a glTF/GLB model | yes | - | free |
| `list_animations` | List animation presets | yes | - | free |
| `animation_signature` | Measure what an animation clip actually does | yes | - | free |
| `find_similar_animations` | Find clips with similar measured motion | yes | - | free |
| `apply_animation` | Apply an animation preset to a rigged model | - | - | free |
| `text_to_animation` | Generate an animation from a text prompt and retarget it onto a model | - | - | free |

## 5. Allowed link URIs (portal Allowed links step, optional, suppresses confirm prompts)

Declare these HTTPS origins. They are every external origin a tool response can emit, re-derived
from the handler source on 2026-09-03.

**Owned (declare):**
- `https://three.ws` : viewer links, AR launch links, generated GLB downloads under
  `https://three.ws/cdn/...`, embed targets, avatar pages, docs and legal. Generated assets are now
  served from this origin directly.

**Third-party hosts referenced in responses (reputable, read-only):**
- `https://solscan.io` : Solana account and transaction links. This is the explorer the agent
  registry and persona wallet tools actually emit, and it was missing from the previous revision of
  this list.
- `https://explorer.solana.com` : Solana transaction links from the provenance anchoring tools.
- `https://pump.fun` : token and coin links in market-data output.
- `https://basescan.org` : Base transaction links (x402 settlement and EVM agent data).
- ERC-8004 agent data on other EVM chains, only when that chain is referenced:
  `https://etherscan.io`, `https://arbiscan.io`, `https://polygonscan.com`.
- `https://storage.googleapis.com` : reference assets served from the project's own GCS bucket.

> Removed in this revision: `https://three-ws-public.r2.dev`. No handler references it any more and
> the host returns 500, so declaring it would be stale.
>
> Custom URI schemes: none. The connector opens only `https://` links.

---

## 6. Reviewer access and test instructions (portal Test & launch step)

> Paste this into the reviewer-instructions box. Replace the `[HUMAN: ...]` credentials privately.
> This is the remote-server (OAuth) reviewer guide. `_generated/claude-reviewer-guide.md` covers the
> separate stdio npm connector and applies only if that package is submitted as a local connector.

**Server:** `https://three.ws/api/mcp` (Streamable HTTP). 3D Studio: `https://three.ws/api/mcp-3d`.

**Discovery needs no credential.** Adding the connector by URL is enough to list all 53 tools. This
was verified unauthenticated on 2026-09-03 and answers in under a second.

**Connect (OAuth 2.1), for account-scoped tools:**
1. The client discovers `https://three.ws/.well-known/oauth-protected-resource` and runs the flow.
2. Sign in with the reviewer test account: `[HUMAN: fill in test account login]`. The account is
   pre-populated with sample avatars and agent memory so list, get, search and recall return real
   data.
3. After OAuth, account-scoped tools run operator-funded and free to the reviewer.

**Free smoke path (no payment, no account):**
- `getting_started` gives the server overview and per-tool pricing.
- `list_animations`, `search_public_avatars` (try `"robot"`), `pumpfun_recent_graduations`.
- On the 3D Studio server, `preview_3d` on any public GLB URL returns a viewer artifact.

**Generation can take minutes, and that is not a hang.** A free 3D generation is real GPU work.
Sampled live on 2026-09-03, the same prompt completed in 5s, 143s and 205s on different calls,
because the lane fails over across several model backends with different queue depths. The server
therefore never blocks past **180 seconds**: at that point it returns a structured `pending` result
carrying a `jobId`, and the caller collects the finished model with the **`check_job`** tool. This
was verified end to end the same day: a 205s call returned a pending handle, and `check_job` on that
handle returned the finished GLB. If your MCP client has a default request timeout near 60 seconds,
raise it, or expect the pending-plus-`check_job` path rather than a single blocking call.

**Funded path, exercising paid (x402) tools for real:**
- Paid tools called without payment return a clean `PaymentRequired` carrying the price, the asset
  and how to pay. This is not an error. Swept 2026-09-03: 27 of 27 paid tools behaved this way.
- To run them for real, use the prepared reviewer path: `[HUMAN: choose ONE and fill in:
  (a) a reviewer OAuth account flagged for operator-funded paid tools, or (b) a small pre-funded
  Solana USDC test wallet, giving the address and a funding note.]`
- Then exercise `validate_model` (pass any public GLB URL) and `render_avatar`.

**Expected output shapes:**
- Read tools return JSON records plus `https://three.ws/...` links.
- Render and preview return a viewer artifact or an image URL on `three.ws`.
- Paid and unpaid returns a structured x402 `PaymentRequired`.

**What `PaymentRequired` means (not a bug):** three.ws tools are pay-per-call in USDC. An
unauthenticated, unpaid call returns a structured `PaymentRequired` with `x402Version: 2`, the
price, the asset (USDC on Solana or Base) and `payTo`. This is documented v2 MCP/x402 behavior: the
tool is working and quoting its price. OAuth-connected account calls skip it.

---

## 7. Compliance acknowledgments (portal Compliance step)

Truthful draft answers. `[HUMAN: ...]` marks where operator confirmation is required.

1. **Directory guidelines.** *Acknowledged.* We will follow the Connectors Directory guidelines and
   the MCP open-source terms. The server source is public at `https://github.com/nirholas/three.ws`.
2. **API usage and ownership.** *Acknowledged.* All tools call first-party three.ws APIs under
   `three.ws`, or legitimately proxy upstream services for which three.ws holds accounts (model
   providers, Solana and EVM RPC, pump.fun data). No third-party API is impersonated.
3. **Transactions.** *Disclosed.* Paid tools charge a per-call service fee in USDC via x402 for
   compute. The market, trader, Oracle and Solana tools on `/api/mcp` are read-only data and do not
   transfer user funds or execute trades. The 3D Studio server's `persona_tip` and `persona_send`
   do move real USDC from the user's own persona wallet, under a $1 per-call and $5 per-session cap
   with explicit confirmation above $0.25; see section 0.3. `[HUMAN: confirm the legal entity for the
   Company step, and confirm that copy_subscribe records a subscription only with no automated
   on-chain order execution.]`
4. **Media generation.** *Disclosed.* `render_avatar_image` and `text_to_animation` on the main
   server, and the 3D Studio generative tools, produce 3D models and rendered images. `[HUMAN:
   confirm with the directory team whether 3D model generation is acceptable. If media generation is
   disallowed, submit /api/mcp only and scope out those two tools.]`
5. **Prompt injection.** *Acknowledged.* Tool descriptions are function-only: no hidden or encoded
   instructions, no directions for Claude to call other tools or follow external instruction
   sources, no system-prompt overrides.
6. **Data collection.** *Acknowledged.* We collect only the tool inputs needed to fulfill a call
   (prompts, asset URLs, addresses) plus usage metadata for quota and abuse control. We never query
   Claude's memory, chat history, or user files. This is disclosed in the privacy policy.
7. **Documentation.** *Acknowledged.* Public docs are live at `https://three.ws/docs/mcp` and the
   privacy policy at `https://three.ws/legal/privacy`. Both returned 200 on 2026-09-03.

---

## 8. Manifest sanity

Verified 2026-09-03 against the files in the repository root:

- Schema: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.
- `server.json`: name `io.github.nirholas/three.ws`, remote `https://three.ws/api/mcp`
  (`streamable-http`), website `https://three.ws`, description 88 chars (registry max is 100).
- `server-3d.json`: name `io.github.nirholas/threews-3d-studio`, remote
  `https://three.ws/api/mcp-3d`, description 96 chars.
- `npm run audit:mcp` passes across all 49 manifests in the repository.
- No coin other than `$THREE` is referenced in either manifest.

---

## 9. Privacy policy coverage

`https://three.ws/legal/privacy` returned 200 on 2026-09-03 and contains the "MCP Connectors, AI
Processing & Payments" section, confirmed by fetching the live page. It covers data collection,
usage and storage, third-party sharing (infrastructure plus AI model providers), retention, a
contact address, and specifically MCP tool inputs, x402 payment and wallet data, and OAuth scope
limits. No pending privacy deploy.
