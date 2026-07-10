# Task 04 — Professions (real, profession-specific work)

**Goal:** Expand the workforce from one profession (Fetcher) to the full roster,
each doing **real** work backed by a real platform skill. The headline is
**Sculptor** — a citizen that turns a task into a textured, rigged **GLB** via
`@three-ws/forge`, proves it with `sha256(GLB)`, and records the deliverable URL —
the verifiable 3D supply chain. Plus Scribe (LLM), Verifier (re-derives others'
proofs), and the remaining bits as feasible.

**Depends on:** Task 02 (the loop + WORK interface).

## Context to read first
- `docs/agora.md` (§ Professions table).
- `api/agora/[action].js` `PROFESSIONS` array (keep in sync).
- `@three-ws/forge` (`packages/forge/`), `api/forge*.js`, `api/mcp-3d.js` — text →
  GLB. `@three-ws/brain` (brain-mcp / multi-provider router) — LLM. `@three-ws/scene`
  (scene-mcp) — diorama. `@three-ws/voice` — TTS/a2f. `@three-ws/intel` — market.
  `@three-ws/names` — .sol/ENS.
- Task 02 `work/fetcher.js` — the pluggable WORK module shape to copy.
- `api/_lib/r2.js` (`publicUrl`) — where to store a produced GLB so it has a real
  `deliverable_url`.

## Background
The WORK step is pluggable: a profession module takes a claimed task + its
description and returns `{ result, proofHash, deliverableUrl?, resultData }`. The
loop handles claim/complete/projection generically. Each module must produce a
**real artifact** and a proof that binds it: `proofHash = sha256(canonical bytes
of the deliverable)`, so any Verifier (or the UI's Verify button in Task 07) can
re-derive it.

## Build (scope)
Implement one module per profession under `workers/agora-citizens/work/`:
1. **`sculptor.js` (bit 1)** — call forge with the task's prompt → GLB bytes →
   upload to R2 (`publicUrl`) → `deliverableUrl` = the GLB URL,
   `proofHash = sha256(GLB bytes)`, `resultData` = a 64-byte pointer (CID/short
   URL). Handle forge tiers/credits honestly; if the free lane is unavailable, the
   citizen reports the job failed (real failure, not a fake success).
2. **`scribe.js` (bit 2)** — call brain with the task prompt → text →
   `deliverableUrl` (store the text artifact in R2 or return inline), proof =
   `sha256(text)`.
3. **`verifier.js` (bit 6)** — given another citizen's completed task, fetch its
   `deliverable_url`, recompute `sha256`, compare to the on-chain `proofHash`,
   and leave a real attestation (vouch) — projecting a `vouched` activity. This is
   the trust loop: agents checking agents' work.
4. **Remaining bits where a real skill exists** — `cartographer.js` (scene),
   `crier.js` (voice), `appraiser.js` (intel), `namekeeper.js` (names). Implement
   the ones whose backing API is reachable; for any you defer, **do not stub** —
   leave the bit out of the active roster and note it, rather than shipping a fake.
5. **Roster update** — give Task 02's roster citizens these professions; keep
   `PROFESSIONS` in `api/agora/[action].js` and `docs/agora.md` in sync with any
   bit you add.

## Out of scope
The UI that renders the GLB/deliverable (Tasks 06/07). Mainnet. Inventing new
capability bits without a backing skill.

## Contracts
- Each module exports `async function work({ task, citizen, client }) →
  { result, proofHash /* 32-byte */, deliverableUrl?, resultData /* ≤64 bytes */ }`.
- Deliverables stored via R2 `publicUrl`; `agora_activity.deliverable_url` set.
- `proofHash` is always `sha256` of the canonical deliverable bytes — consistent
  across producer and Verifier.

## Definition of Done
- [ ] A **Sculptor** citizen completes a real task: paste the GLB `deliverableUrl`
  (loads in a browser / glTF viewer) + the on-chain `proofHash` + the complete tx.
- [ ] Re-downloading that GLB and hashing it reproduces the on-chain `proofHash`
  (show the command + match).
- [ ] A **Verifier** citizen independently re-derives another citizen's proof and
  leaves a real `vouched` attestation (show the row + any on-chain memo/tx).
- [ ] Scribe produces a real text deliverable with a matching proof.
- [ ] Any deferred profession is **omitted**, not stubbed; `PROFESSIONS` +
  `docs/agora.md` stay in sync with what actually ships.
- [ ] No mock outputs anywhere; a failed forge/brain call surfaces as a real task
  failure.

## Verification
```bash
node workers/agora-citizens/index.js     # with a Sculptor in the roster
curl -s "localhost:3000/api/agora/passport?agentId=<sculptor-hex>" | jq '.activity[0]'
# verify the deliverable:
curl -sL "<deliverableUrl>" -o /tmp/d.glb && sha256sum /tmp/d.glb   # == on-chain proofHash
```

## Guardrails
- Forge/brain/voice cost real credits — respect quotas; never loop-spam a paid API.
- Deliverables are world-readable — no secrets in them.
- Push to `threews`; changelog: yes (user-visible — "Agora agents now sculpt 3D
  models, write, and verify each other's work").
