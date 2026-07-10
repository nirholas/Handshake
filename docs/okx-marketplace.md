# OKX.AI Marketplace Services

three.ws sells 3D services to other AI agents on [OKX.AI](https://web3.okx.com), OKX's
on-chain agent marketplace. Buyers are agents: they discover a service, receive an HTTP 402
payment challenge, pay in stablecoins on X Layer (or USDC on our other x402 rails), and get
the artifact. Our marketplace listing is agent **#2632 "three.ws 3D Studio"**.

> Related: [REST API Reference](./api-reference.md) · [MCP servers](./mcp.md) ·
> [x402 payments](./x402.md) · seller-side protocol spec: [`specs/okx-agent-payments.md`](../specs/okx-agent-payments.md)

The **single source of truth** for every service (names, 2-part OKX descriptions, prices,
endpoints, input schemas) is [`api/_lib/okx-catalog.js`](../api/_lib/okx-catalog.js) — the
free catalog endpoint below serves it verbatim, so the docs, the endpoints, and the OKX
listing can never drift apart.

---

## Free discovery lane

No payment, no account, no key.

```bash
# Machine-readable index of every service
curl https://three.ws/api/okx/3d/catalog

# Live health of the lanes behind the paid services (real probes, not a static ok)
curl https://three.ws/api/okx/3d/health
```

---

## Agent Identity Studio — `$1.50` per identity

**The flagship.** Turns an AI agent's brand brief into a complete 3D identity:

- a **square PFP** (1024 px PNG + 128 px preview) framed head-and-shoulders, sized for the
  OKX.AI avatar slot and legible at marketplace thumbnail size;
- a **full-body render set** — three distinct poses from the three.ws pose library, studio
  lighting, consistent backdrop;
- the **rigged, animation-ready GLB** itself (humanoid skeleton + skin weights), usable in
  three.ws scenes, games, and any glTF runtime;
- a live [three.ws viewer](https://three.ws/viewer) link and pose-studio link.

Endpoint: `https://three.ws/api/okx/3d/identity-studio` — an A2MCP service (MCP Streamable
HTTP, JSON-RPC `tools/call`). Demo identities generated end-to-end by this pipeline:
[three.ws/agent-identities](https://three.ws/agent-identities).

### 1 · Create (paid)

An unpaid call returns the 402 challenge; pay it (e.g. `onchainos payment pay --payload …`
on OKX rails, or any x402 client) and replay with the payment header.

```bash
curl -sS -X POST https://three.ws/api/okx/3d/identity-studio \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": {
      "name": "create_identity",
      "arguments": {
        "agent_name": "LedgerLynx",
        "brief": "A meticulous on-chain accounting agent that reconciles wallets and flags anomalies in real time. Calm, precise, incorruptible.",
        "style_hints": "deep navy and silver palette, brushed-metal accents"
      }
    }
  }'
```

Arguments:

| Field | Required | Notes |
| --- | --- | --- |
| `agent_name` | yes | ≤80 chars, rendered into the identity brief |
| `brief` | yes | any language; >2000 chars is truncated and the response flags `brief_truncated` |
| `style_hints` | no | palette / materials / era / mood |
| `reference_image_url` | no | public image guiding the look — validated **before** any charge |

Success returns `{ job_id, status: "queued", poll_tool: "identity_status", eta_seconds }`.

### 2 · Poll (free)

```bash
curl -sS -X POST https://three.ws/api/okx/3d/identity-studio \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": { "name": "identity_status", "arguments": { "job_id": "<job_id>" } }
  }'
```

Each poll advances the pipeline one bounded step (generation → humanoid auto-rig → one
studio render per poll) and reports `stage` + render progress. Poll every ~5 s; typical time
to `done` is 3–6 minutes. When `status` is `"done"`, `deliverables` carries the PFP URLs,
the full-body set, `rigged_glb_url`, `mesh_glb_url`, `viewer_url`, and `pose_studio_url`.

### Payment semantics

Each guarantee below is enforced in code — the request path is
`verify → dispatch → settle-on-success` ([`api/okx/3d/[service].js`](../api/okx/3d/%5Bservice%5D.js)),
so an engine error is answered *before* settlement — and is covered by the endpoint's unit
tests.

- **You pay only when the job is accepted.** Input validation — including fetching your
  `reference_image_url` — runs before settlement; an invalid brief or unreachable image
  fails the call and **no payment settles**.
- **Failed stages retry free.** Generation and rigging each retry up to 3 total attempts on
  transient upstream failures; renders re-run on the next poll. Only exhausted retries mark
  the job `failed`, with the last actionable error in `last_error`.
- **Status polling is free and unauthenticated** — job tokens are HMAC-signed, so they are
  the only capability needed to read a job.
- One payment ↔ one job: the payment proof is single-use across dispatch + settlement
  (replay-guarded), and the settled amount always equals the advertised price.

> **Not yet demonstrated end to end.** The X Layer rail reports `settleable: true` in
> production, but no *funded* call has settled on-chain against this endpoint yet — the payer
> wallet is unfunded, so every real attempt returns `insufficient_balance`. Treat the bullets
> above as the implemented and unit-tested contract, not as a claim of an observed on-chain
> settlement. The first settled transaction hash will be recorded in
> [`prompts/okx-ai/PROGRESS.md`](../prompts/okx-ai/PROGRESS.md).

### Also on this endpoint (free)

- `getting_started` — overview of the server, tools, prices, and links.
- `GET https://three.ws/api/okx/3d/identity-studio` — SSE / discovery challenge.

---

## Decomposed 3D studio services

Micro-priced, single-capability REST endpoints — plain JSON `POST`, one price each, all
backed by the same engines the [MCP 3D studio](./mcp.md) runs (no separate pipeline).
`GET` on any of them returns its free descriptor (price, description, input schema).

| Service | Price (USDT) | Endpoint | You send |
|---|---|---|---|
| Text → 3D Model (GLB) | $0.01 | `/api/okx/3d/text-to-3d` | `prompt` |
| Text → 3D Model (Pro) | $0.30 | `/api/okx/3d/text-to-3d-pro` | `prompt`, `tier?` |
| Image → 3D Model | $0.30 | `/api/okx/3d/image-to-3d` | `image_urls[]` |
| Auto-Rig a GLB | $0.25 | `/api/okx/3d/rig` | `glb_url` |
| Text → Rigged Avatar | $0.50 | `/api/okx/3d/avatar` | `prompt` or `image_url` |
| Animation Retarget | $0.10 | `/api/okx/3d/retarget` | `model_url`, `animation` |
| Pose Seed | $0.02 | `/api/okx/3d/pose-seed` | `prompt` |
| FBX Export (rig-preserving) | $0.10 | `/api/okx/3d/fbx-export` | `model_url`, `format?` |

The buyer flow is the same for all of them: unpaid `POST` → 402 → sign
(`onchainos payment pay --payload '<402 body>'`) → replay with
`PAYMENT-SIGNATURE`. Generation-grade services reply `{status:"queued", job_id, poll_url}`
— polling `GET https://three.ws/api/forge?job=<job_id>` is free and unlimited; fast
services (`retarget`, `pose-seed`) reply `{status:"done", …}` inline. Settlement happens
**after** the engine accepts the job; invalid input, the avatar humanoid gate, or an
engine failure answers before settlement and never charges.

### Text → 3D Model (GLB) — $0.01

Textured GLB from a text prompt on the fast draft lane (NVIDIA NIM TRELLIS).

```bash
curl -i -X POST https://three.ws/api/okx/3d/text-to-3d \
  -H 'content-type: application/json' \
  -d '{"prompt":"a brass steampunk owl, full body"}'
```

### Text → 3D Model (Pro) — $0.30

An LLM art director refines the prompt, then a higher-quality lane generates the GLB.
`tier:"standard"` (default) or `tier:"high"` (max geometric detail + PBR textures).

```bash
curl -i -X POST https://three.ws/api/okx/3d/text-to-3d-pro \
  -H 'content-type: application/json' \
  -d '{"prompt":"ornate elven longsword","tier":"high"}'
```

### Image → 3D Model — $0.30

Reconstructs a textured GLB from 1–4 public photos of one object.

```bash
curl -i -X POST https://three.ws/api/okx/3d/image-to-3d \
  -H 'content-type: application/json' \
  -d '{"image_urls":["https://example.com/owl-front.jpg","https://example.com/owl-side.jpg"]}'
```

### Auto-Rig a GLB — $0.25

Adds an animation-ready humanoid skeleton and skin weights to a static GLB (UniRig lane).

```bash
curl -i -X POST https://three.ws/api/okx/3d/rig \
  -H 'content-type: application/json' \
  -d '{"glb_url":"https://cdn.three.ws/models/knight.glb"}'
```

### Text → Rigged Avatar — $0.50

Mesh generation + auto-rig in one call. Obvious non-humanoid prompts are refused **before**
payment settles (`allow_non_humanoid: true` overrides). The paid response returns the mesh
GLB immediately (`mesh_glb_url` + viewer link) plus the rig job to poll — a rig hiccup
never loses the paid generation.

```bash
curl -i -X POST https://three.ws/api/okx/3d/avatar \
  -H 'content-type: application/json' \
  -d '{"prompt":"a heroic knight in silver armor, full body"}'
```

### Animation Retarget — $0.10

Retargets a curated clip (idle, walk, dance, …) onto any rigged humanoid GLB — returns the
retargeted AnimationClip JSON keyed to the rig's actual bones plus a bone-coverage report.
Completes inside the request. Clip names are free at
[`/animations/manifest.json`](https://three.ws/animations/manifest.json).

```bash
curl -i -X POST https://three.ws/api/okx/3d/retarget \
  -H 'content-type: application/json' \
  -d '{"model_url":"https://cdn.three.ws/models/knight-rigged.glb","animation":"idle"}'
```

### Pose Seed — $0.02

Deterministic pose resolution: natural-language description → stable seed + full
joint-rotation map for humanoid rigs. Same prompt, same pose, every time. Completes inside
the request.

```bash
curl -i -X POST https://three.ws/api/okx/3d/pose-seed \
  -H 'content-type: application/json' \
  -d '{"prompt":"confident standing pose, arms crossed"}'
```

### FBX Export (rig-preserving) — $0.10

GLB → FBX for Unity/Unreal; a rigged GLB keeps its skeleton, skin weights, and blendshapes.
Other formats: `obj`, `stl`, `ply`, `usdz`, `3mf`.

```bash
curl -i -X POST https://three.ws/api/okx/3d/fbx-export \
  -H 'content-type: application/json' \
  -d '{"model_url":"https://cdn.three.ws/models/knight-rigged.glb","format":"fbx"}'
```

### Guarantees (all decomposed services)

- **Pay only after the job is accepted** — verify runs before the engine, settle after it;
  failure replies state explicitly that the payment was not taken.
- **Retried payments are safe** — the same payment + body replays the same response
  (idempotency cache); a payment proof is single-use across dispatch + settlement.
- **One service, one price** — every rail advertised in a service's 402 quotes the same
  amount, derived from the catalog module.

---

## Rails

Challenges advertise every rail the deployment can settle: **X Layer (`eip155:196`,
USD₮0)** via the OKX facilitator for OKX.AI buyers, plus the existing Solana / Base / BSC
USDC rails. The wire format OKX buyers use (headers `PAYMENT-REQUIRED` /
`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, scheme `exact` EIP-3009) is pinned down in
[`specs/okx-agent-payments.md`](../specs/okx-agent-payments.md).
