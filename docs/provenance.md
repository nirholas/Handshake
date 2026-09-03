# Verifiable 3D provenance — content credentials for AI-generated models

Every model three.ws generates can carry a **signed content credential** — creator, prompt, model/provider, lineage, timestamp, and the GLB's content hash — with that hash **anchored on Solana**. Anyone can verify a model's authenticity and detect tampering **for free**, no account and no crypto. Anchoring (the on-chain write) is the paid, Claude-track action.

- **Spec:** [`specs/PROVENANCE_3D.md`](https://github.com/nirholas/three.ws/blob/main/specs/PROVENANCE_3D.md) (CC0)
- **Pure core:** [`api/_lib/provenance-3d.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/provenance-3d.js)
- **Free verify:** `GET /api/provenance?src=<glbUrl>` and the `verify_provenance` MCP tool
- **Paid anchor:** the `anchor_provenance` MCP tool

> **v2 credentials also carry a signed physics grade.** Alongside authorship, a credential can assert what a rigid-body solver would make of the mesh: watertight or not, real meters or a generator's unit box, its exact volume and inertia tensor. An unsigned grade is a claim anyone can forge; this one is not. See [Simulation readiness](./sim-readiness.md). Credentials signed under v1, before the field existed, keep verifying byte for byte, permanently.

## Verify a model (free, public)

```bash
curl "https://three.ws/api/provenance?src=https://three.ws/avatars/default.glb"
```

The endpoint always hashes the bytes it fetched, so it answers for any model, anchored or not. The stock avatar has never been anchored, so it comes back `unknown` with a real hash:

```jsonc
{
  "status": "unknown",
  "reason": "no provenance credential is on record for this asset",
  "badge": "Unverified",
  "glbSha256": "1ec0913a5093301a69a6c1f29e8ff9bed10d9e39708126e2ca2c9a4d3d7df35c",
  "credential": null,
  "issuer": null,
  "anchor": null
}
```

Point it at a model that *has* been anchored and the credential and its on-chain anchor come back with it:

```jsonc
{
  "status": "verified",              // verified | tampered | unknown
  "reason": "the model matches its signed credential",
  "badge": "Verified · three.ws",
  "glbSha256": "…",
  "credential": { "creator": "…", "prompt": "…", "model": "TRELLIS", "createdAt": "…" },
  "issuer": "<issuer pubkey>",
  "anchor": { "tx": "…", "cluster": "devnet", "explorerUrl": "https://explorer.solana.com/tx/…", "confirmed": true }
}
```

Agents get the same verdict from the `verify_provenance` tool on the [3D Studio MCP server](/docs/mcp). Pass `glb_url` or a known `hash`.

**Verdicts:**
- `verified` — the signature checks out **and** the model bytes match the signed hash.
- `tampered` — a credential exists but the bytes changed (even one byte) or the credential was altered.
- `unknown` — no credential is on record for this model.

The 3D viewer (`/viewer?src=…`) shows the result as a badge: **✓ Verified · three.ws** (links to the anchor), **⚠ Tampered**, or **Unverified**.

## Anchor a credential (paid, Claude track)

The `anchor_provenance` tool signs a credential with the three.ws issuer key, writes its hash into a Solana Memo transaction, and stores the full credential for public verification:

```jsonc
// tools/call → anchor_provenance
{ "glb_url": "https://three.ws/avatars/default.glb",
  "creator": "alice", "prompt": "a friendly robot", "model": "TRELLIS", "provider": "nvidia",
  "network": "devnet" }
// → { status: "anchored", glbSha256, credentialHash, issuer, anchor: { tx, cluster, explorerUrl } }
```

Real hashing, real ed25519 signature, real on-chain write. Requires the issuer key (`ATTEST_AGENT_SECRET_KEY`) and a funded issuer wallet on the target cluster; absent either, it returns a clear error rather than a fake transaction.

## Why it's trustworthy

- **Tamper-evident:** the credential is signed over a canonical (key-sorted) form, and it commits to the sha256 of the GLB bytes. One changed byte or one altered field flips the verdict to `tampered`.
- **Independently checkable:** the credential hash is on Solana; the explorer link is in every verified response.
- **Coin-clean verify:** the free verify path and its response carry no payment, wallet, or token fields — safe to ship in any store.

## Related

- [Spatial MCP](/docs/spatial-mcp) — the `lineage` field ties to conversational-refinement lineage
- [AR exports](/docs/ar) — provenance travels with the model into AR
