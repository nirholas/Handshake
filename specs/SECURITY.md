# Security & Threat Model — three.ws Card v1

Scope: agents registered under [three.ws Card v1](3D_AGENT_CARD.md) on the ERC-8004 Identity, Reputation, and Validation registries. For general site security contact info, see [/.well-known/security.txt](../public/.well-known/security.txt).

This document enumerates abuse vectors specific to three.ws registration and lists the current mitigation (or marks it open).

## Vectors

### V1 — Stolen / unlicensed model registration

A user pins someone else's GLB to IPFS and registers it as their agent.

- **Mitigation:** card requires `model.license` (SPDX or URL). Validators MAY refuse `pass` for cards with `license: "unknown"`. DMCA takedown contact published in [security.txt](../public/.well-known/security.txt). Registry never serves the file directly — it points at IPFS.
- **Status:** partial. License is declarative, not verified. Open: perceptual-hash blocklist for known stolen assets.

### V2 — Mutable model swap

Card uses `https://` `model.uri` and operator swaps the GLB after registration.

- **Mitigation:** `model.sha256` is mandatory; `<three-d-agent-badge>` and the resolver verify hash on every load. A swap surfaces as `unverified`. Spec SHOULD prefers `ipfs://` for prevention.
- **Status:** mitigated for clients that verify; clients that ignore the badge are out of scope.

### V3 — Fake "verified" claim

A site renders its own green pill claiming verification without checking.

- **Mitigation:** the trust signal is the on-chain validation attestation from an allow-listed validator (see [VALIDATORS.md](VALIDATORS.md)) — not the badge UI. Consumers verify against ValidationRegistry directly or via the resolver.
- **Status:** mitigated by design.

### V4 — Validator key compromise

A validator's signing key leaks; attacker signs `pass` for malicious agents.

- **Mitigation:** validator keys are dedicated, not personal wallets (per [VALIDATORS.md](VALIDATORS.md)). Compromise → `removeValidator(address)`. Past attestations from that validator SHOULD be treated as expired from the removal block onward by any indexer / resolver.
- **Status:** policy in place; key custody is each validator's responsibility. Open: support EIP-712 attestations with explicit expiry timestamps so leaked keys self-expire.

### V5 — Reputation gaming (sybil reviews)

Attacker mints many agents and posts inflated `ReputationRegistry` scores for a target.

- **Mitigation:** ReputationRegistry already enforces one score per (reviewer, agent). Beyond that, the recommended reputation surface for v1 is _measured_ signals from validators (render success, load p95, A2A handshake), not user thumbs-up. See [3D_AGENT_CARD.md](3D_AGENT_CARD.md) §"Reputation".
- **Status:** partial. The on-chain primitive is sybil-resistant per-pair but not per-identity. Open: weight reviews by reviewer's own validation history.

### V6 — Sybil registrations

Attacker mints thousands of agents to spam discovery surfaces.

- **Mitigation:** registration costs gas — Base mainnet is the primary chain for this reason. The optional gasless path via paymaster is rate-limited per wallet/IP at the paymaster layer, not on-chain.
- **Status:** mitigated on mainnet; paymaster rate limits are operational, not specified here.

### V7 — IPFS unpinning

Pinned GLB is dropped by all gateways; card now points at dead content.

- **Mitigation:** the registration flow pins via the platform pinning service (`api/pinning/[action].js`) — Pinata when `PINATA_JWT` is set, with web3.storage and Filebase as alternative providers (`src/pinning/`). Validators MUST re-fetch on every attestation; a dropped file produces a `fail` on `manifest-integrity`, demoting the agent.
- **Status:** mitigated during validator runs. Long-term: optional Filecoin deal storage for "permanent" tier agents.

### V8 — NSFW / illegal model content

A registered agent's GLB contains illegal or platform-violating content.

- **Mitigation:** pre-pin moderation hook in the registration UI (open). Post-registration takedowns happen at the gateway / discovery layer — the chain entry persists but the agent is hidden from `/explore` and the resolver returns `403 BLOCKED`.
- **Status:** **OPEN**. No moderation hook is wired in [src/erc8004/register-ui.js](../src/erc8004/register-ui.js) yet. This is the highest-priority gap before opening public registration.

### V9 — Supply-chain on the badge / resolver

Attacker compromises `three.ws` and serves a malicious badge bundle that lies about verification.

- **Mitigation:** badge source is open in [src/erc8004/badge.js](../src/erc8004/badge.js); embedders SHOULD self-host or pin to a known SRI hash. Resolver responses are signed (open) so a tampered response can be detected client-side.
- **Status:** partial. SRI guidance documented; resolver signing is open.

### V10 — Card spoofing via tokenURI rewrite

Identity NFT owner updates `tokenURI` to point at a new card with different `model.sha256`.

- **Mitigation:** every card update is an on-chain event. Indexers SHOULD show the version chain via the optional `previousVersion` field. Consumers MAY pin to a specific card CID rather than following the live `tokenURI`.
- **Status:** mitigated by design; `previousVersion` adoption is encouraged.

## Reporting

Security issues: see [public/.well-known/security.txt](../public/.well-known/security.txt). For validator misconduct, open a public issue tagged `validator-dispute`.

## Governance roadmap

- Identity / Reputation / Validation registry **owner** is currently the deployer EOA. Migrate to a 3-of-5 Safe on Base before opening public registration.
- Validator allow-list changes go through a PR + on-chain `addValidator`/`removeValidator` call from the owner. Post-Safe migration, allow-list changes require multisig approval.
