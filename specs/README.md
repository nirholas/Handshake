# Specs

The specifications that define the three.ws embodied-agent platform: on-chain identity, the manifest bundle, skills, permissions, memory, the 3D scene, the editor, embedding, and security. These documents are the source of truth for how a three.ws agent is described, registered, rendered, and embedded. Most reference the `<agent-3d>` web component (a placeholder tag) and build on ERC-8004.

## Index

- [`AGENT_MANIFEST.md`](./AGENT_MANIFEST.md) — Agent Manifest Spec v0.1. The content-addressed JSON+files bundle (Claude-shaped: `instructions.md`, `SKILL.md`, `memory/MEMORY.md`) that fully describes an embodied agent; pinned to IPFS and stamped into the ERC-8004 Identity Registry.
- [`3D_AGENT_CARD.md`](./3D_AGENT_CARD.md) — three.ws Card v1. A strict superset of the ERC-8004 registration card for agents whose primary embodiment is a 3D model; the JSON the ERC-721 `tokenURI` resolves to.
- [`SKILL_SPEC.md`](./SKILL_SPEC.md) — Skill Spec v0.1. A portable, content-addressed capability bundle (`SKILL.md` instructions + `tools.json` schema) that any compatible agent can install at runtime — "the npm of embodied AI."
- [`PERMISSIONS_SPEC.md`](./PERMISSIONS_SPEC.md) — Permissions Spec v0.1. Scoped, time-bound, revocable on-chain delegations (ERC-7710 envelopes + the ERC-7715 `wallet_grantPermissions` method) that let an agent's smart account act for its owner within limits approved once.
- [`MEMORY_SPEC.md`](./MEMORY_SPEC.md) — Memory Spec v0.1. A file-based, human-readable agent memory modeled on Claude Code's memory; memory travels with the agent as files in the manifest bundle.
- [`STAGE_SPEC.md`](./STAGE_SPEC.md) — Stage Spec v0.1. The `<agent-stage>` element that hosts one Three.js scene (one WebGL context) for multiple `<agent-3d>` children, so several agents can share a room without N renderers.
- [`AVATAR_PARAMETERS.md`](./AVATAR_PARAMETERS.md): Avatar Parameter Model v0.1. The serialized description of an avatar's body (morphs, skeleton-space proportions, colors, layers, garments) that the editor, the baker and every fork read; the GLB is a render of it, not the source of truth.
- [`EDITOR_SPEC.md`](./EDITOR_SPEC.md) — Editor Spec v0.1. The authoring surface: the `editor` attribute switches `<agent-3d>` from playback into editing mode, whose "Copy Embed" output is a clean playback element.
- [`EMBED_SPEC.md`](./EMBED_SPEC.md) — Embed Spec v0.2. The `<agent-3d>` web component and loader script — the entire framework compiled to a single custom element for zero-friction embedding.
- [`EMBED_HOST_PROTOCOL.md`](./EMBED_HOST_PROTOCOL.md) — EMBED_HOST_PROTOCOL v1. The versioned postMessage bus between a host page (Claude.ai, LobeHub, a blog) and an embedded three.ws iframe.
- [`CLAUDE_ARTIFACT.md`](./CLAUDE_ARTIFACT.md) — The `/api/artifact` contract: a single fully-inlined HTML document (three.js, loader, viewer, and GLB all in the body) that renders as a Claude.ai artifact under Claude's restrictive CSP.
- [`ENS_AGENT_CLAIM.md`](./ENS_AGENT_CLAIM.md) — ENS / DNS Agent Claim v1. A convention of two cheap-to-set records that bidirectionally bind a human-readable name to an on-chain agent identity, with no new on-chain infrastructure.
- [`VALIDATORS.md`](./VALIDATORS.md) — Validator Allow-list Policy. Who may write to the on-chain `ValidationRegistry`, how attestations are formed, and how the allow-list is changed.
- [`SECURITY.md`](./SECURITY.md) — Security & Threat Model for three.ws Card v1. Enumerates abuse vectors specific to three.ws registration on the ERC-8004 registries and the current mitigation for each.
- [`ECONOMY_CONTRACT_INVARIANTS.md`](./ECONOMY_CONTRACT_INVARIANTS.md): Economy Contract Invariants v1. The properties every value-bearing contract in [`contracts/`](../contracts) must hold for all reachable states and all callers, each with a stable id and a positive plus negative test that cites it.
- [`ECONOMY_CONTRACT_THREAT_MODEL.md`](./ECONOMY_CONTRACT_THREAT_MODEL.md): Economy Contract Threat Model v1. The attacker's-eye companion to the invariants: what is worth stealing, which actor could try, what stops each attempt, and which risks are accepted rather than mitigated. Entry point for a review engagement is [`contracts/AUDIT-README.md`](../contracts/AUDIT-README.md).
- [`PROVENANCE_3D.md`](./PROVENANCE_3D.md): Verifiable 3D Provenance v1. C2PA-style signed content credentials for AI-generated 3D: creator, prompt, model, lineage and the GLB's content hash, ed25519-signed and anchored on Solana. Verification is free and public.
- [`SIM_READINESS.md`](./SIM_READINESS.md): Simulation Readiness v1. The physics grade a 3D asset carries: watertightness, metric scale, mass and inertia, and a convex collision proxy, in four verdicts. Everything is derived from the mesh; anything unknowable from the geometry is reported as unknown rather than invented. Rides the provenance credential when signed.

- [`SKILL_ROYALTY_SPLIT.md`](./SKILL_ROYALTY_SPLIT.md): Skill Royalty Split v1. How a paid skill call divides between the author and the platform, and how that division is recorded: exact integer arithmetic that conserves value and rounds toward the creator, who the author of record is, which wallet a payout resolves to, and the ledger invariants both earning lanes must hold. The contract the x402 rail, the accrual writer, the settle cron and the earnings surface all read from.

- [`KNOCK_PROTOCOL.md`](./KNOCK_PROTOCOL.md): Knock Protocol v1. A priced door to a person: how a door advertises its terms, how a knock is paid for on the free and x402 lanes, the ordering rule that guarantees a refused knock is never a paid one, the derived receipt token the sender reads the answer with, and the custody and non-enumeration invariants.
- [`OPEN_INFERENCE_PROTOCOL.md`](./OPEN_INFERENCE_PROTOCOL.md): Open Inference Protocol (OIN) v0.1. The vendor-neutral wire protocol for agent inference: a job envelope, a signed capability advertisement, and an Ed25519-signed response anyone can verify against the node's published key, so inference decouples from any single provider. Reference verifier in `api/_lib/oin-verify.js`; reference node in `workers/stylize`.
- [`inference-receipts.md`](./inference-receipts.md): Inference Receipt v1. The settlement half of the same story: what a paid inference call hands back as proof (job, model, input/output hashes, node and issuer signatures, the settlement transaction) and how to verify it offline.

## Schema

[`schema/`](./schema) holds the SQL DDL for the Postgres tables that back these specs (see `schema/README.md` for column-level docs):

- `agent_delegations.sql` — ERC-7710 signed delegation envelopes (`permissions/0.1`).
- `agent_subscriptions.sql` — recurring skill subscriptions (`permissions/0.1`).
- `dca_strategies.sql` — dollar-cost-averaging strategies (`dca/0.1`).
- `embed-policy.sql` — per-agent embed referrer allow-list.
- `indexer_state.sql` — delegation-indexer cron checkpoint state.
- `voice-cloning.sql` — per-agent ElevenLabs `voice_id` storage.
