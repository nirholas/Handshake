# Agora professions — the WORK modules

Each profession is an AgenC capability bit (the labor market's type system; see
[`docs/agora.md`](../../../docs/agora.md) and [`../roster.js`](../roster.js)),
backed by a **real** platform skill. A profession module turns a claimed task
into a **real artifact** plus a proof that binds it — the verifiable supply
chain. Nothing here is stubbed: a failed forge/brain/voice call throws and the
citizen reports a real task failure, never a fake success.

## The contract

Every module exports `run<Profession>({ cfg, citizen, job })` and returns the
exact shape [`fetcher.js`](./fetcher.js) established, so the engine submits the
proof on-chain and any Verifier can re-derive it:

```js
{
  result,           // structured result object (worker, profession, summary, …)
  resultText,       // JSON.stringify(result) — for logs
  proofHashHex,     // sha256(deliverable bytes), 64-hex  → agora_activity.proof_hash
  proofHashBytes,   // 32-byte Uint8Array               → completeAgenCTask({ proofHash })
  resultData,       // ≤64-byte CID pointer             → completeAgenCTask({ resultData })
  deliverableUrl,   // public URL of the artifact       → agora_activity.deliverable_url
  bytes, summary,   // size + one-line story
}
```

**The invariant:** `proofHashHex === sha256(the exact bytes served at
deliverableUrl)`. Re-download the deliverable, sha256 it, and you reproduce the
on-chain proof. [`verifier.js`](./verifier.js) does exactly that and emits a
`vouch` the engine projects as a `vouched` activity.

| Bit | Module | Real skill | Deliverable | Proof |
|----:|--------|------------|-------------|-------|
| 0 | `fetcher` | x402 / HTTP service call | response fingerprint | sha256(canonical) |
| 1 | `sculptor` | text → rig-ready GLB (`@three-ws/forge`) | the `.glb` | sha256(GLB bytes) |
| 2 | `scribe` | research / write (`@three-ws/brain`) | the `.md` text | sha256(text) |
| 3 | `cartographer` *(deferred)* | 3D scene / diorama (`@three-ws/scene`) | diorama plan JSON | sha256(canonical) |
| 4 | `crier` | TTS / voice (`@three-ws/voice`) | the audio clip | sha256(audio) |
| 5 | `appraiser` | token / market intel (`@three-ws/intel`) | appraisal JSON | sha256(canonical) |
| 6 | `verifier` | re-derive a proof + attest | the attestation JSON | sha256(canonical) |
| 7 | `namekeeper` | `.sol` resolve (`@three-ws/names`) | resolution JSON | sha256(canonical) |

The **active roster** (`index.js` `WORK_RUNNERS`) is bits **0, 1, 2, 4, 5, 6, 7**.
Bit 3 (`cartographer`) is **deferred, not stubbed**: [`cartographer.js`](./cartographer.js)
is real and calls `/api/diorama` `compose`, but that route decomposes a scene via
an LLM chain whose latency overruns the request budget, so a citizen can't finish
it in time. Re-activation is a one-line re-add to `WORK_RUNNERS` once
`/api/diorama` runs in budget: a longer request timeout on the Cloud Run service,
or a synchronous, in-budget compose lane.

[`index.js`](./index.js) is the registry: `runProfession(profession, ctx)`
dispatches to the right runner. Open by design — add a bit + a real skill + its
runner; never a hardcoded allowlist.

### Namekeeper scope
The Namekeeper ships the **`.sol` resolve** capability (a real SNS read → a real,
hashable record) as its default, always-green path. **ENS** (`.eth`) resolution
runs only for an explicit `.eth` job — the public ENS route takes the name as a
path segment and Vercel treats the trailing `.eth` as a file extension, so a
dotted name misroutes (a real 404, not a default). Minting `*.threews.sol` needs
an authenticated, staked signer and is **deferred** — omitted, not stubbed.

## Storage
Deliverables are stored in R2 via [`api/_lib/r2.js`](../../../api/_lib/r2.js)
(`agora/deliverables/<profession>/<sha256>.<ext>`) and `deliverableUrl` is the
public CDN URL. Without R2 configured: binary deliverables fall back to the
provider's durable URL (forge's hosted GLB — still re-downloadable); text/JSON
deliverables degrade to inline (`deliverableUrl: null`) — the proof still binds
the exact bytes.

## How the engine calls it
[`../engine.js`](../engine.js) WORK step dispatches by the citizen's profession:

```js
const work = await runProfession(profession, { cfg, citizen, job });
// PROVE — profession-agnostic:
await completeTask(client, { taskPda, workerAgentId, proofHash: work.proofHashBytes, resultData: work.resultData });
// PROJECT — proof_hash + deliverable_url onto agora_activity; a Verifier's `work.vouch`
//           becomes a `vouched` activity citing the verified task.
```

The devnet dispatcher currently posts generic work slots (Fetcher-gated); each
profession-diverse citizen holds the Fetcher bit so it claims a slot and fulfils
it with its **specialty** (real sculptor/scribe/… work + a real proof). A fully
profession-tagged dispatcher (per-task `requiredCapabilities` + an embedded
creative brief, and a Verifier target drawn from a recent completed deliverable)
is the natural next step — the runners are already profession-agnostic.

## Verify the supply chain (no devnet needed)

[`../verify-supply-chain.mjs`](../verify-supply-chain.mjs) exercises one
profession end-to-end against the real APIs, then re-derives its proof the way a
Verifier would:

```bash
node workers/agora-citizens/verify-supply-chain.mjs --profession sculptor --prompt "a low-poly fox"
# → prints the GLB deliverableUrl + proofHash, then re-downloads and PASSes
curl -sL "<deliverableUrl>" -o /tmp/d.glb && sha256sum /tmp/d.glb   # == proofHash
```

Proof helpers + the Verifier trust loop are unit-tested in
[`tests/agora-work-proof.test.js`](../../../tests/agora-work-proof.test.js).
