# `api/_okx3d/` - OKX.AI service engines (three.ws Forge + Agent Identity Studio)

The engine layer behind the paid `/api/okx/3d/*` services three.ws sells to other agents on the OKX.AI marketplace (agent #2632). The route [`api/okx/3d/[service].js`](../okx/3d/%5Bservice%5D.js) owns transport, x402 payment, and the OKX 402 dialect; this directory owns the actual work. Prices, tool names, and input schemas all come from one catalog, [`../_lib/okx-catalog.js`](../_lib/okx-catalog.js), so the listing, the 402 challenges, and the engines can never disagree.

**The listed line-up (rebuilt 2026-08-22) is three.ws Forge**, in [`forge.js`](./forge.js): four paid A2MCP rows (`forge-draft` $0.01, `forge-standard` $0.05, `forge-hd` $0.25, `forge-image` $0.25) plus a free `forge-status` poll. Each row is a real MCP Streamable HTTP server exposing the same three tools (`forge_3d` paid, `forge_status` and `getting_started` free), so a buying agent writes one client and points it at whichever price it wants. It is a front, not a pipeline: generation runs through the same `/api/gpt-forge` lane the ChatGPT custom GPT uses, and responses are shaped by the same [`../_mcp-studio/studio-shape.js`](../_mcp-studio/studio-shape.js), so the marketplace and the GPT cannot drift into two contracts over one generator.

Everything else here is on the **back burner**: `listed: false` in the catalog keeps it off the marketplace listing and out of the submission payload while it stays deployed, tested and payable.

The back-burner flagship is the **Agent Identity Studio** ($1.50 per identity): a brand brief goes in, a complete 3D identity comes out.

```
brief → identity prompt (Granite director, fail-soft)
      → textured mesh          (/api/forge)
      → humanoid auto-rig      (/api/forge?action=rig, UniRig)
      → posed studio renders   (/api/render/avatar-clip + sharp compositing)
      → PFP crop (1024 + 128 preview) and full-body set, persisted to R2
```

Every GPU and render stage is driven over the deployed three.ws HTTP surfaces (the same pattern the npx MCP server uses in [`../_mcp-studio/forge-client.js`](../_mcp-studio/forge-client.js)), so the module behaves identically inside the production function and in a local run, and holds no provider keys of its own.

## Files

| File | Role |
| --- | --- |
| [`forge.js`](./forge.js) | The listed line-up: per-endpoint MCP tool catalogs, dispatchers, x402 price hooks, the bazaar discovery metadata in each 402, the age-13+ content gate that runs before any generation starts, and the strict HD lane (refuses before settlement rather than serving a lower tier). Done responses carry the public model page (`/m/<creation id>`) and every link is repeated in the text content. One surface is built per catalog row and memoized. |
| [`identity.js`](./identity.js) | The pipeline engine: prompt shaping, forge/rig/render orchestration, sharp compositing (PFP head crop, 4:5 full-body frames), and the R2-persisted job state machine. |
| [`tools.js`](./tools.js) | The A2MCP face of the pipeline for `/api/okx/3d/identity-studio`: MCP tool catalog (`create_identity` paid, `identity_status` and `getting_started` free), dispatcher, x402 pricing hook, and the 402 challenge metadata indexers see. |
| [`rest-services.js`](./rest-services.js) | Engine adapters for the decomposed paid REST services (`text-to-3d`, `text-to-3d-pro`, `image-to-3d`, `rig`, `avatar`, `retarget`, `pose-seed`, `fbx-export`). Thin wrappers over engines the platform already runs, no duplicated pipeline logic. |

## Job model

Job state lives as one JSON document in R2 (`okx-identity/jobs/<id>.json`, via [`../_lib/r2.js`](../_lib/r2.js)); renders land under `okx-identity/renders/<id>/`. Job ids travel as signed tokens ([`../_lib/forge-job-token.js`](../_lib/forge-job-token.js)) so a job handle cannot be guessed or forged.

The contract that keeps buyers safe and requests bounded:

- `createIdentityJob` validates the brief and the reference image's reachability (SSRF-guarded via [`../_lib/ssrf-guard.js`](../_lib/ssrf-guard.js)) **before** the transport settles the x402 payment. A thrown error means nothing was charged.
- Each free `identity_status` poll calls `advanceIdentityJob`, which moves the pipeline by exactly **one** bounded step (a single upstream poll, or one render). No request outlives its function budget; polling is what drives the job to completion (typically 3 to 6 minutes).
- Failed generate/rig/render stages retry free up to 3 attempts; a rate-limited upstream is treated as backoff, never as a consumed attempt. The buyer pays once, for deliverables, not for transient upstream weather.
- The render plan (one PFP pose plus three full-body poses from [`../../src/pose-presets.js`](../../src/pose-presets.js)) is seeded deterministically from the job id: reproducible per job, varied across jobs.
- Jobs persist about 30 days.

Prompt direction runs on the in-process LLM chain ([`../_lib/llm.js`](../_lib/llm.js), watsonx Granite leading the shared free-first chain) and is fail-soft: if every provider is down, a deterministic template (`fallbackIdentityPrompt`) produces the generation prompt instead. Nothing is fabricated and nothing blocks.

## Exports

From `forge.js`:

- `forgeSurface(id)` → `{ entry, challenge, dispatch, TOOLS, TOOL_CATALOG, isPublicTool, x402Amount }` for one listed forge row, or `null` for an id that is not one. The route feeds these straight into its shared A2MCP transport.
- `isForgeService(id)` and `FORGE_SERVICE_IDS`: which catalog ids this module serves.
- `FORGE_TOOL` (`forge_3d`) and `FORGE_STATUS_TOOL` (`forge_status`), re-exported from the catalog so tool names have one definition.

From `identity.js`:

- `createIdentityJob({ base?, agentName, brief, styleHints?, referenceImageUrl? })` → `{ jobId, state }`. Validates, shapes the prompt, submits generation, persists state. `jobId` is the signed token clients poll with.
- `advanceIdentityJob(id, { base? })` → the updated state after one bounded pipeline step, or `null` for an unknown id.
- `describeIdentityJob(state, { base? })` → the public status/result shape: `status`, `stage`, `progress`, and on `done` the `deliverables` (PFP URLs, full-body set, `rigged_glb_url`, `mesh_glb_url`, viewer and pose-studio links).
- `encodeIdentityJobToken(id)` / `decodeIdentityJobToken(token)`, `loadIdentityJob(id)` (raw R2 state read).
- `shapeIdentityPrompt`, `fallbackIdentityPrompt`, `buildRenderPlan`, `validateReferenceImage`, and the constants `MAX_BRIEF_CHARS` (2000), `MAX_GENERATION_PROMPT_CHARS` (300), `IDENTITY_DIRECTOR_INSTRUCTION`.

From `tools.js` (consumed by the route's MCP transport):

- `dispatch` (built on [`../_lib/mcp-dispatch.js`](../_lib/mcp-dispatch.js)) plus `TOOLS`, `TOOL_CATALOG`, `PROTOCOL_VERSION`.
- `isPublicIdentityTool(name)`: true for the free tools servable without OAuth or x402 (`identity_status`, `getting_started`).
- `identityX402Amount(toolName)`: atomic USDC price for one `tools/call`, `null` when free.
- `IDENTITY_CHALLENGE`: the 402 challenge metadata facilitators and indexers see.

From `rest-services.js`:

- `invokeRestService(id, args, { req, payer })`: validates `args` against the catalog schema (Ajv), then dispatches to the engine adapter. Runs after payment verification and before settlement; throws HTTP-shaped errors (`{ status, code, message }`) so the route skips settlement and the buyer keeps their money. Async lanes return `{ status: 'queued', job_id, poll_url }` (polling `GET /api/forge?job=<id>` is free); fast lanes return `{ status: 'done', ... }` inline.
- `isRestPaidService(id)`: whether a catalog id is a paid REST row with a live engine adapter.

Shared director prompts (single-subject mesh spec, avatar humanoid steer, brand-mark lexicon) are imported from [`../_lib/forge-director-prompts.js`](../_lib/forge-director-prompts.js), the same source of truth `/api/forge` and the studio MCP tools use.

## Usage

No install step: this deploys with the rest of `api/` (see [`api/README.md`](../README.md) for routing). Buyers reach the listed services at `https://three.ws/api/okx/3d/forge-{draft,standard,hd,image,status}` (A2MCP), and the back burner at `https://three.ws/api/okx/3d/identity-studio` (A2MCP) and `https://three.ws/api/okx/3d/<service>` (REST). The free machine-readable index is `https://three.ws/api/okx/3d/catalog`, where `services` is the listed line-up and `unlisted` is the back burner.

To run the real pipeline locally, use the demo driver, which imports `createIdentityJob` / `advanceIdentityJob` / `describeIdentityJob` straight from [`identity.js`](./identity.js) and executes real runs of the production pipeline for the identities in [`../../data/agent-identities.json`](../../data/agent-identities.json):

```sh
node --env-file=.env.local scripts/okx-identity-demo.mjs [slug] [--force]
```

It needs the `S3_*` (R2) vars from `.env.local`; generation, rigging, and rendering all run on the deployed three.ws surfaces. Results (render URLs, GLB URLs, programmatic rig verification) are written back into `data/agent-identities.json`, which powers the [/agent-identities](../../pages/agent-identities.html) showcase page. Rigging is verified for real: the rigged GLB must contain a skin with joints and skinned primitives carrying `JOINTS_0` + `WEIGHTS_0`, or the run is recorded as failed. See [`../../scripts/okx-identity-demo.mjs`](../../scripts/okx-identity-demo.mjs).

Tests: [`tests/api/okx-forge.test.js`](../../tests/api/okx-forge.test.js) (the listed line-up), [`tests/api/okx-identity-studio.test.js`](../../tests/api/okx-identity-studio.test.js) and [`tests/api/okx-3d-services.test.js`](../../tests/api/okx-3d-services.test.js).

## Related

- [`docs/okx-marketplace.md`](../../docs/okx-marketplace.md), the buyer-facing docs: endpoints, prices, payment walkthrough.
- [`api/okx/3d/[service].js`](../okx/3d/%5Bservice%5D.js), the route that fronts these engines (transport, x402, OKX 402 dialect, payment replay cache).
- [`../_lib/okx-catalog.js`](../_lib/okx-catalog.js), the single source of truth for services, prices, and schemas.
- [`prompts/finish/okx-ai-08-forge-relisting.md`](../../prompts/finish/okx-ai-08-forge-relisting.md), the executable work order that resubmits agent #2632 with this line-up.
- [`STRUCTURE.md`](../../STRUCTURE.md), the OKX.AI marketplace row maps this whole surface.
