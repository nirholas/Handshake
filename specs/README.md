# Specs

The specifications that define the three.ws embodied-agent platform: on-chain identity, the manifest bundle, skills, permissions, memory, the 3D scene, the editor, embedding, and security. These documents are the source of truth for how a three.ws agent is described, registered, rendered, and embedded. Most reference the `<agent-3d>` web component (a placeholder tag) and build on ERC-8004.

## Index

- [`AGENT_MANIFEST.md`](./AGENT_MANIFEST.md) — Agent Manifest Spec v0.1. The content-addressed JSON+files bundle (Claude-shaped: `instructions.md`, `SKILL.md`, `memory/MEMORY.md`) that fully describes an embodied agent; pinned to IPFS and stamped into the ERC-8004 Identity Registry.
- [`3D_AGENT_CARD.md`](./3D_AGENT_CARD.md) — three.ws Card v1. A strict superset of the ERC-8004 registration card for agents whose primary embodiment is a 3D model; the JSON the ERC-721 `tokenURI` resolves to.
- [`SKILL_SPEC.md`](./SKILL_SPEC.md) — Skill Spec v0.1. A portable, content-addressed capability bundle (`SKILL.md` instructions + `tools.json` schema) that any compatible agent can install at runtime — "the npm of embodied AI."
- [`PERMISSIONS_SPEC.md`](./PERMISSIONS_SPEC.md) — Permissions Spec v0.1. Scoped, time-bound, revocable on-chain delegations (ERC-7710 envelopes + the ERC-7715 `wallet_grantPermissions` method) that let an agent's smart account act for its owner within limits approved once.
- [`MEMORY_SPEC.md`](./MEMORY_SPEC.md) — Memory Spec v0.1. A file-based, human-readable agent memory modeled on Claude Code's memory; memory travels with the agent as files in the manifest bundle.
- [`STAGE_SPEC.md`](./STAGE_SPEC.md) — Stage Spec v0.1. The `<agent-stage>` element that hosts one Three.js scene (one WebGL context) for multiple `<agent-3d>` children, so several agents can share a room without N renderers.
- [`EDITOR_SPEC.md`](./EDITOR_SPEC.md) — Editor Spec v0.1. The authoring surface: the `editor` attribute switches `<agent-3d>` from playback into editing mode, whose "Copy Embed" output is a clean playback element.
- [`EMBED_SPEC.md`](./EMBED_SPEC.md) — Embed Spec v0.2. The `<agent-3d>` web component and loader script — the entire framework compiled to a single custom element for zero-friction embedding.
- [`EMBED_HOST_PROTOCOL.md`](./EMBED_HOST_PROTOCOL.md) — EMBED_HOST_PROTOCOL v1. The versioned postMessage bus between a host page (Claude.ai, LobeHub, a blog) and an embedded three.ws iframe.
- [`CLAUDE_ARTIFACT.md`](./CLAUDE_ARTIFACT.md) — The `/api/artifact` contract: a single fully-inlined HTML document (three.js, loader, viewer, and GLB all in the body) that renders as a Claude.ai artifact under Claude's restrictive CSP.
- [`ENS_AGENT_CLAIM.md`](./ENS_AGENT_CLAIM.md) — ENS / DNS Agent Claim v1. A convention of two cheap-to-set records that bidirectionally bind a human-readable name to an on-chain agent identity, with no new on-chain infrastructure.
- [`VALIDATORS.md`](./VALIDATORS.md) — Validator Allow-list Policy. Who may write to the on-chain `ValidationRegistry`, how attestations are formed, and how the allow-list is changed.
- [`SECURITY.md`](./SECURITY.md) — Security & Threat Model for three.ws Card v1. Enumerates abuse vectors specific to three.ws registration on the ERC-8004 registries and the current mitigation for each.

## Schema

[`schema/`](./schema) holds the SQL DDL for the Postgres tables that back these specs (see `schema/README.md` for column-level docs):

- `agent_delegations.sql` — ERC-7710 signed delegation envelopes (`permissions/0.1`).
- `agent_subscriptions.sql` — recurring skill subscriptions (`permissions/0.1`).
- `dca_strategies.sql` — dollar-cost-averaging strategies (`dca/0.1`).
- `embed-policy.sql` — per-agent embed referrer allow-list.
- `indexer_state.sql` — delegation-indexer cron checkpoint state.
- `voice-cloning.sql` — per-agent ElevenLabs `voice_id` storage.
