# OKX.AI Marketplace Services

three.ws sells 3D generation to other AI agents on [OKX.AI](https://web3.okx.com), OKX's
on-chain agent marketplace. Buyers are agents: they discover a service, receive an HTTP 402
payment challenge, pay in stablecoins on X Layer (or USDC on our other x402 rails), and get
the artifact. Our marketplace entry is agent **#2632 "three.ws 3D Studio"**.

> **Listing state.** Resubmitted for review on 2026-08-27 with the line-up below (on-chain
> update tx `0xb4b2f51d…415ba`, X Layer). The earlier listing was rejected on 2026-07-04
> ("your A2MCP service has not been integrated with the OKX Agent Payments Protocol
> standard"); every row now answers that directly. Until approval lands, the services are
> reachable at the endpoints documented here. Current state is tracked in
> [`prompts/finish/okx-ai-PROGRESS.md`](../prompts/finish/okx-ai-PROGRESS.md).

**What we list, as of 2026-08-22: three.ws Forge.** The listing was rebuilt around one
thing done extremely well, turning a description into a real 3D model, because that is the
capability agents actually ask for and it is the smallest surface a reviewer has to trust.
An OKX.AI agent gets exactly what the "three.ws 3D Studio" custom GPT gives a ChatGPT user
(a GLB, a concept image, a browser viewer link, and an AR link that puts the model in a
real room), over the marketplace's own payment rail. Everything else we built for OKX.AI
(the Agent Identity Studio and the specialist rigging/retargeting/export endpoints) is on
the **back burner**: still deployed, still payable, deliberately off the listing. Those are
documented at the bottom of this page.

> Related: [REST API Reference](./api-reference.md) · [MCP servers](./mcp.md) ·
> [x402 payments](./x402.md) · seller-side protocol spec:
> [`specs/okx-agent-payments.md`](../specs/okx-agent-payments.md)

The **single source of truth** for every service (names, OKX listing copy, prices,
endpoints, input schemas, and which rows are listed) is
[`api/_lib/okx-catalog.js`](../api/_lib/okx-catalog.js). The free catalog endpoint below
serves it verbatim and the listing submission is generated from it, so the docs, the
endpoints, and the OKX listing cannot drift apart.

### The A2MCP listing description format

OKX listing QA requires **four** newline-separated parts on an A2MCP service and rejects a
listing missing any of them (the contract is stated in `onchainos agent update --help`).
Submitting two parts is what earned the standing review remark on agent #2632: "The service
you submitted is missing a complete description, parameter details, and usage examples."

| Part | Content | Where it comes from |
| --- | --- | --- |
| 1 | What the service does | `describes.capability` |
| 2 | Every parameter on ONE line, `;`-separated, each `<name> (<type>, required/optional): <meaning>` | generated from `inputSchema` + `describes.params` |
| 3 | Request method (`POST`/`GET`, plus the MCP tool name where there is one) | generated from `kind` + `tool` |
| 4 | A working `curl` against the real endpoint | generated from `endpoint` + `describes.example` |

Parts 2 and 4 are **derived, never hand-written**: `parameterSpec()` reads the row's own
JSON Schema, so a renamed argument renames itself in the listing, and `requestExample()`
builds the call from example arguments that the test suite validates against that same
schema. A published example the endpoint would reject cannot ship. `validateCatalog()`
fails any listed row whose schema and documented parameters disagree, whose description is
not four non-empty parts, or which exceeds OKX's 2000 half-width cap.

Back-burner rows (`listed: false`) are held to the catalog rules only; they pick up the
four-part rules when they return to the listing.

---

## Free discovery lane

No payment, no account, no key.

```bash
# Machine-readable index: `services` is the listed line-up, `unlisted` is the back burner
curl https://three.ws/api/okx/3d/catalog

# Live health of the lanes behind the paid services (real probes, not a static ok),
# including the median and p90 of the last hour's real forge_3d submits
curl https://three.ws/api/okx/3d/health
```

---

## three.ws Forge

Four paid services and one free one. Every row is a real **A2MCP** endpoint: MCP Streamable
HTTP, JSON-RPC 2.0 over `POST`, session terminate on `DELETE` (204). The paid tool answers an
unpaid call with an OKX-dialect 402 whose `accepts[]` **leads with `eip155:196`**, which is
the OKX Agent Payments Protocol integration the review asked for.

`POST` is the whole transport here: these servers hold no server-to-client stream, so a `GET`
is not an SSE session. On a paid row it answers the same 402 challenge (verified 2026-09-02:
`GET /api/okx/3d/forge-draft` is 402 with or without `Accept: text/event-stream`), and on a
free row it answers **405** with `Allow: POST, DELETE`, which is what the approved sellers on
this marketplace answer too. Discover a row by reading the free catalog, or by calling
`getting_started` over `POST`.

| Service | Price (USDT) | Endpoint | You send |
|---|---|---|---|
| Forge 3D Draft | $0.01 | `/api/okx/3d/forge-draft` | `prompt` |
| Forge 3D Standard | $0.05 | `/api/okx/3d/forge-standard` | `prompt` |
| Forge 3D HD | $0.25 | `/api/okx/3d/forge-hd` | `prompt` |
| Forge 3D from Image | $0.25 | `/api/okx/3d/forge-image` | `image_urls[]` |
| Forge Job Status | free | `/api/okx/3d/forge-status` | `job_id` |

The four paid rows differ **only** in generation lane and price. OKX prices a service, not
a parameter, so a quality tier has to be its own row to carry its own fee. Your client code
is identical across all of them: every endpoint exposes the same three tools.

| Tool | Cost | What it does |
|---|---|---|
| `forge_3d` | the row's price | Starts a generation, returns a `job` handle |
| `forge_status` | free | Polls any three.ws forge job, returns the finished links |
| `getting_started` | free | Overview of the server, its tools, prices, and links |

`forge_status` lives on every endpoint, so you poll a job where you paid for it and never
have to discover a second host mid-flight. It is also listed as its own free service, so an
agent can hold one status endpoint for jobs started anywhere.

### 1 · Start a generation (paid)

An unpaid call returns the 402 challenge; pay it (`onchainos payment pay --payload '<402
body>'` on OKX rails, or any x402 client) and replay with the payment header.

```bash
curl -sS -X POST https://three.ws/api/okx/3d/forge-standard \
  -H 'content-type: application/json' \
  -H 'PAYMENT-SIGNATURE: <the header your x402 client returned>' \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": {
      "name": "forge_3d",
      "arguments": { "prompt": "a low-poly orange fox sitting down" }
    }
  }'
```

Arguments for the three text rows:

| Field | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | 3 to 1000 characters, one subject, its style and key colours |
| `aspect_ratio` | no | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` |

`forge-image` takes `image_urls` (1 to 4 `https://` links to views of the same subject)
plus an optional `prompt` that sharpens the reconstruction.

A queued job returns:

```json
{
  "ok": true, "service": "forge-standard", "status": "pending",
  "job": "f1.…", "poll_tool": "forge_status",
  "poll_endpoint": "https://three.ws/api/okx/3d/forge-status",
  "poll_arguments": { "job_id": "f1.…", "title": "a low-poly orange fox sitting down" },
  "watchUrl": "https://three.ws/watch?job=…", "format": "glb", "etaSeconds": 45
}
```

Copy `poll_arguments` verbatim into the next `forge_status` call. The `title` is optional; if
you drop it, the status service recovers it from the job itself.

A fast lane can finish inline instead, in which case you get the `done` body below with no
polling at all.

### 2 · Poll the job (free)

```bash
curl -sS -X POST https://three.ws/api/okx/3d/forge-status \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": { "name": "forge_status", "arguments": { "job_id": "f1.…" } }
  }'
```

Poll every few seconds. When `status` is `"done"`:

```json
{
  "ok": true, "status": "done", "job": "f1.…",
  "glbUrl": "https://…/model.glb",
  "viewerUrl": "https://three.ws/viewer?src=…",
  "arUrl": "https://three.ws/api/ar?src=…",
  "pageUrl": "https://three.ws/m/0b6d2a9e-…",
  "previewImageUrl": "https://…/concept.png",
  "format": "glb", "tier": "standard"
}
```

The text content of the same response lists every one of those links on its own line, so an
agent that relays tool text to a human without reading `structuredContent` still hands over
the viewer, the AR launch and the page.

- `glbUrl` is the model itself, a real glTF binary you can download, open in any glTF
  runtime, or embed.
- `viewerUrl` opens it in a browser, spinning, on any device.
- `arUrl` is the device-aware AR launch: Scene Viewer on Android, Quick Look on iOS
  (GLB to USDZ converted in-page), the WebGL viewer on desktop. This is the link that puts
  the model in a human's actual room, which is usually what an agent's user wanted.
- `pageUrl` is the model's public page: the model spinning in a viewer with AR and
  fullscreen, download, embed code, share, comments and likes. It is the one link to hand a
  human when they should get everything.
- `previewImageUrl` is the painted concept view the forge produces before the mesh, so you
  can show something the moment it exists.

A failed job answers `status: "error"` with an actionable message and, when the generator can
name them, `retryBackends`: the alternate engines that can still serve this request. The lane
exhausts its own backend failover chain before it ever reports a failure, so an `error` frame
is terminal for that job. **A retry is a new paid call**: these rows settle when the lane
accepts a job (see Payment semantics below), so a job that fails during generation has been
charged. Over the 30 days to 2026-09-02, 255 of 10,278 forge jobs (2.5%) ended `failed` after
acceptance.

### Payment semantics

Each guarantee below is enforced in code (`verify → dispatch → settle-on-success`, in
[`api/okx/3d/[service].js`](../api/okx/3d/%5Bservice%5D.js)) and covered by the endpoint's
unit tests in [`tests/api/okx-forge.test.js`](../tests/api/okx-forge.test.js).

- **You pay only when the job is accepted.** Input validation and the age-13+ content gate
  run before settlement; a rejected prompt or a malformed argument fails the call and
  **no payment settles**. Acceptance is the line: once the lane takes the job the payment
  settles, so a failure that happens later, during generation, has been charged and a retry
  is a new paid call. Nothing here refunds after settlement.
- **HD means HD.** If the high-detail lane will not take a job, `forge-hd` answers
  `tier_unavailable` (with `charged: false` and a `retry_after`) instead of quietly serving
  a standard mesh at the HD price. That refusal is also before settlement.
- **A real MCP client gets a 402.** The shared three.ws MCP servers answer OAuth-capable
  clients (`Accept: text/event-stream`, `mcp-protocol-version`) with a 401 so they can
  discover OAuth. The OKX.AI endpoints never do: every unpaid paid-tool call is a 402 with
  the `PAYMENT-REQUIRED` header, whatever the client sends, because the OKX buyer flow keys
  strictly on 402.
- **Polling is free and unlimited**, on every endpoint and on the standalone status
  service.
- **One payment, one job.** The payment proof is single-use across dispatch and settlement
  (replay-guarded), and the settled amount always equals the advertised price.
- **Retried payments are safe.** The same payment plus the same body replays the same
  response through the idempotency cache instead of running a second job.
- **Each rail is advertised once**, and every rail in a service's 402 quotes the same
  amount, derived from the catalog module.

> **Not yet demonstrated end to end.** The X Layer rail reports `settleable: true` in
> production, but no *funded* call has settled on-chain against these endpoints yet: the
> payer wallet is unfunded, so every real attempt returns `insufficient_balance`. Treat the
> bullets above as the implemented and unit-tested contract, not as a claim of an observed
> on-chain settlement. The first settled transaction hash gets recorded in
> [`prompts/finish/okx-ai-PROGRESS.md`](../prompts/finish/okx-ai-PROGRESS.md).

---

## Back burner

These are **not** on the OKX.AI listing and are not part of the current submission. They
remain deployed, priced, tested and payable at the endpoints below, and the free catalog
publishes them under `unlisted` rather than hiding them, because they answer real 402s to
anyone holding the URL. They return to the listing once the forge rows have sales behind
them.

**Agent Identity Studio**, `$1.50`, `/api/okx/3d/identity-studio` (A2MCP). Turns an agent's
brand brief into a complete 3D identity: a square PFP sized for the OKX.AI avatar slot, a
three-pose full-body render set, and the rigged animation-ready GLB. Paid tool
`create_identity`, free `identity_status` polling. Demo identities generated end to end by
this pipeline: [three.ws/agent-identities](https://three.ws/agent-identities).

**Single-capability REST endpoints.** Plain JSON `POST`, one price each, all backed by the
same engines the [MCP 3D studio](./mcp.md) runs. `GET` on any of them returns its free
descriptor (price, description, input schema).

| Service | Price (USDT) | Endpoint | You send |
|---|---|---|---|
| Text → 3D Model (GLB) | $0.01 | `/api/okx/3d/text-to-3d` | `prompt` |
| Text → 3D Model (Pro) | $0.30 | `/api/okx/3d/text-to-3d-pro` | `prompt`, `tier?` |
| Image → 3D Model | $0.30 | `/api/okx/3d/image-to-3d` | `image_urls[]` |
| GLB Auto-Rigging | $0.25 | `/api/okx/3d/rig` | `glb_url` |
| Text → Rigged Avatar | $0.50 | `/api/okx/3d/avatar` | `prompt` or `image_url` |
| Animation Retargeting | $0.10 | `/api/okx/3d/retarget` | `model_url`, `animation` |
| Pose Seed | $0.02 | `/api/okx/3d/pose-seed` | `prompt` |
| FBX Export (rig-preserving) | $0.10 | `/api/okx/3d/fbx-export` | `model_url`, `format?` |

The buyer flow is the same for all of them: unpaid `POST` → 402 → sign
(`onchainos payment pay --payload '<402 body>'`) → replay with `PAYMENT-SIGNATURE`.
Generation-grade services reply `{status:"queued", job_id, poll_url}` and polling
`GET https://three.ws/api/forge?job=<job_id>` is free; fast services (`retarget`,
`pose-seed`) reply `{status:"done", …}` inline. Settlement happens **after** the engine
accepts the job, so invalid input, the avatar humanoid gate, or an engine failure answers
before settlement and never charges.

---

## Rails

Challenges advertise every rail the deployment can settle: **X Layer (`eip155:196`,
USD₮0)** first for OKX.AI buyers, plus the existing Solana / Base / BSC USDC rails so
non-OKX agents can pay the same endpoint. The wire format OKX buyers use (headers
`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, scheme `exact` EIP-3009) is
pinned down in [`specs/okx-agent-payments.md`](../specs/okx-agent-payments.md).
