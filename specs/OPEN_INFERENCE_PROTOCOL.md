# Open Inference Protocol (OIN) v0.1

An open, vendor-neutral wire protocol for agent inference: a requester hands a
job to any compatible node (GPU or CPU), and the node returns a result it has
cryptographically signed with an Ed25519 key. Anyone who holds the job envelope
and the response can verify the result against the node's published public key,
without trusting any intermediary. Inference decouples from any single
provider: the platform's own workers, a third-party operator, and a hobby
node all speak the same envelopes.

The design starts from how three.ws's own GPU workers already receive jobs and
return results (submit -> `202 { task_id }`, poll -> result URL, bearer auth on
every route) and extends it with the two things a multi-operator network needs
that a single-provider deployment did not: **capability advertisement** (so a
requester can discover what a node can run and price it) and **signed
responses** (so a result is attributable to a specific node key and cannot be
forged or tampered with in transit).

- Spec id: `oin/0.1`
- Status: reference. One in-repo worker (`workers/stylize`) speaks it behind a
  flag; the reference verifier is [`api/_lib/oin-verify.js`](../api/_lib/oin-verify.js).
- Signature scheme: Ed25519 (RFC 8032), the same curve Solana accounts sign
  with, so a node operator's existing Solana keypair doubles as its node key.

## Terminology

- **Requester** - the party that constructs and submits a job (the platform
  API today; any marketplace contract tomorrow).
- **Node** - any process that advertises capabilities, accepts job envelopes,
  executes them, and returns signed responses.
- **Verifier** - any third party (often the requester, but not necessarily)
  that checks a signed response against the job envelope and the node's
  advertised public key.

## Transport

OIN runs over plain HTTPS with JSON bodies. A node exposes:

| Route | Auth | Purpose |
|---|---|---|
| `GET /.well-known/oin` | none | Capability advertisement (signed). |
| `POST /oin/jobs` | bearer (optional) | Submit a job envelope. Returns `202`. |
| `GET /oin/jobs/:id` | bearer (optional) | Poll a job. Returns the signed response when done. |

Whether a node requires bearer auth on the job routes is a deployment choice;
the advertisement declares it (`auth` field) so a requester knows before
submitting. A node MAY also serve its own native routes alongside OIN (the
reference worker keeps its pre-existing `/process` + `/tasks/:id` contract;
OIN is additive, never a breaking change).

## Canonical encoding

Every hash and signature in OIN is computed over the **JCS canonical JSON**
(RFC 8785) of the object being hashed, UTF-8 encoded. JCS is deterministic
(key order sorted, no whitespace, minimal number encoding), so two
implementations that parse the same JSON document always derive the same bytes
to hash or sign. All digests are SHA-256 over the canonical bytes, hex-encoded
lowercase with no prefix. The reference implementation provides the
canonicalizer; requesters and verifiers SHOULD use a conforming RFC 8785
implementation of their own.

## Job envelope

The envelope is everything the node needs to run the job and everything the
verifier needs to bind the response to the job. Unknown top-level fields are
allowed and ride along into the digest, so the format extends without a
version bump.

```jsonc
{
	"spec": "oin/0.1",              // required, exact string
	"job_id": "j_7f2c1d...",        // required, requester-chosen unique id
	"capability": "mesh.stylize",   // required, one of the advertised keys
	"created_at": "2026-08-12T00:00:00.000Z", // required, ISO 8601 UTC
	"deadline": 1800,               // optional, seconds after created_at
	"input": { "model": "...", "data": "..." }, // required, capability-defined
	"params": { /* ... */ },        // optional, capability-defined
	"payment": {                    // optional, opaque to the node protocol
		"scheme": "x402", "network": "solana", "receipt": "..."
	},
	"callback_url": "https://...",  // optional push delivery; polling is the default
	"requester": "did:...",         // optional, for metering/attribution
	"request_id": "req_..."         // optional, opaque correlation id
}
```

`input.model` names the model, filter, or engine within the capability
(for `mesh.stylize`: `voxel`, `brick`, `voronoi`, or `lowpoly`). `input.data`
carries the primary payload reference (an https URL in v0.1); everything else
the capability needs lives in `params`.

A node MUST reject an envelope whose `spec` it does not recognize with
`400 { "error": "unsupported_spec" }`, and a `capability` it does not
advertise with `400 { "error": "unsupported_capability" }`.

## Capability advertisement

`GET /.well-known/oin` returns the node's self-description. It is the only
unauthenticated route and it is itself signed, so a requester that already
trusts a node key out of band can pin it, and a directory service can crawl
advertisements without credentialing.

```jsonc
{
	"spec": "oin/0.1",
	"node_id": "node_3f8a...",          // stable operator-chosen id
	"node_pubkey": "ed25519:AbC1...",   // base64, 32-byte raw public key
	"generated_at": "2026-08-12T00:00:00.000Z",
	"capabilities": [
		{
			"key": "mesh.stylize",
			"version": "0.1",
			"models": ["voxel", "brick", "voronoi", "lowpoly"],
			"max_input_bytes": 134217728,
			"pricing": { "currency": "USDC", "unit": "job", "amount": "0.01" },
			"sla": { "typical_seconds": 10 }
		}
	],
	"endpoints": {
		"submit": "/oin/jobs",
		"poll": "/oin/jobs/:id",
		"health": "/health"
	},
	"auth": "bearer",                   // "bearer" or "none"
	"signature": "base64..."            // Ed25519 over canonical advertisement minus this field
}
```

The `signature` is produced by deleting the `signature` field, canonicalizing
the remaining object, and signing those bytes with the node key. A requester
verifies it exactly like a response signature (rules below), with the
advertisement itself as the payload.

## Signed response format

When a job reaches a terminal state (`done` or `failed`) the node produces a
signed response envelope:

```jsonc
{
	"spec": "oin/0.1",
	"job_digest": "hex...",          // SHA-256 over the canonical job envelope
	"node_pubkey": "ed25519:AbC1...",
	"completed_at": "2026-08-12T00:00:10.000Z",
	"status": "done",                // "done" | "failed"
	"output": {                      // present on done
		"url": "https://storage.googleapis.com/bucket/path.glb",
		"sha256": "hex...",          // digest of the bytes at `url`
		"bytes": 123456
	},
	"usage": { "elapsed_ms": 9421, "units": 1 },  // optional metering
	"error": { "code": "bad_input", "message": "..." }, // present on failed
	"signature": "base64..."         // Ed25519 over canonical response minus this field
}
```

The response commits to the job only through `job_digest`; the job envelope
itself travels out of band (the requester already has it). Signing a digest of
the job instead of the job itself keeps the signature input small and lets a
verifier that receives a job from a third party confirm it is the job the node
actually answered.

Failed jobs are signed too. A signed failure is evidence the node received the
job and declined or could not complete it, which matters for settlement and
reputation just as much as a signed success.

## Verification rules

A verifier accepts a signed response only when **all** of the following hold,
checked in order; the first failure names the verdict:

1. **Shape** - `spec` is `oin/0.1`; `job_digest`, `node_pubkey`,
   `completed_at`, `status`, and `signature` are present; `status` is `done`
   or `failed`; `done` responses carry `output` and `failed` responses carry
   `error`. (`bad_shape`)
2. **Job binding** - the verifier recomputes SHA-256 over the JCS-canonical
   job envelope it holds and requires equality with `job_digest`.
   (`job_digest_mismatch`)
3. **Key** - `node_pubkey` parses as `ed25519:` followed by 32 bytes of
   base64. If the verifier pins or looked up the node's advertisement, the key
   MUST equal the advertised `node_pubkey`. (`bad_pubkey` / `untrusted_node`)
4. **Signature** - removing `signature`, canonicalizing the remaining
   response, and verifying the Ed25519 signature against the decoded public
   key succeeds. (`bad_signature`)
5. **Freshness** - `completed_at` parses as ISO 8601 and is not later than the
   job's `deadline` (when the job declared one) and not more than 24 hours in
   the future of the verifier's clock. (`stale_response` / `future_response`)
6. **Output integrity** - for `done` responses, the bytes fetched from
   `output.url` hash (SHA-256, lowercase hex) to `output.sha256` and their
   length equals `output.bytes`. (`output_digest_mismatch`) A verifier that
   only checks the envelope (never fetches the artifact) MAY defer this rule
   and report `verified_unfetched_output`.

A response that passes rules 1-5 is `verified`; rule 6 upgrades it to
`verified_with_output`. No verdict short of `verified` entitles the node to
payment.

### Reference verifier

[`api/_lib/oin-verify.js`](../api/_lib/oin-verify.js) implements rules 1-5 in
dependency-free Node (Ed25519 via `node:crypto`), plus an opt-in
`verifyOutput()` for rule 6 and a `verifyAdvertisement()` that applies the same
signature rule to `/.well-known/oin` (rules 1, 3, and 4; there is no job to bind
and no deadline to miss). It is the conformance target for third-party
verifiers.

### Conformance runner

[`scripts/oin-conformance.mjs`](../scripts/oin-conformance.mjs) drives a live
node through the entire protocol and verifies every signature with the
reference verifier: fetch and verify the advertisement, submit a job for an
advertised capability, confirm the node's `job_digest` matches the requester's
own canonicalization, poll to a terminal state, verify the signed response, then
fetch the artifact and check rule 6. It exits 0 only when every step passes, so
it is the check an operator runs before claiming a node speaks OIN.

```bash
node scripts/oin-conformance.mjs \
  --node https://your-node.example \
  --api-key "$NODE_API_KEY" \
  --input https://three.ws/avatars/fox.glb \
  --model voxel --params '{"resolution":24,"output_format":"glb"}'
```

## Reference worker

`workers/stylize` (the platform's CPU mesh-stylization worker) speaks OIN
behind a flag:

- `OIN_ENABLED=true` mounts `GET /.well-known/oin`, `POST /oin/jobs`, and
  `GET /oin/jobs/:id` next to the native routes.
- `OIN_SIGNING_KEY` holds the node's Ed25519 secret key (base64, 32-byte seed
  or 64-byte expanded key). Unset with the flag on: the worker refuses to
  start, so a node can never advertise a key it cannot sign with.
- With the flag off the worker is byte-for-byte its pre-OIN self.

A node with no GCS bucket (any self-hosted operator) sets `OIN_RESULT_DIR` and
`OIN_RESULT_BASE_URL` instead, and artifacts land on the filesystem under the
URL the signature commits to. That is the whole local proof:

```bash
cd workers/stylize
API_KEY=local GCS_BUCKET=unused OIN_ENABLED=true \
OIN_SIGNING_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
OIN_RESULT_DIR=/tmp/oin OIN_RESULT_BASE_URL=http://127.0.0.1:8402 \
python -m uvicorn main:app --port 8401
```

with `/tmp/oin` served on port 8402, then point the conformance runner above at
`http://127.0.0.1:8401`.

The worker-side protocol layer is [`workers/stylize/oin.py`](../workers/stylize/oin.py),
vendored byte-identical into any worker that adopts OIN (same pattern as
`worker_security.py`). Job execution is the same pipeline the native `/process`
route runs; OIN only changes the envelope in and the signature out. That is the
point: the protocol wraps existing capability instead of replacing it.

## Security considerations

- **Replay.** `job_digest` binds the response to one envelope; a requester
  that reuses a `job_id` with different inputs gets a different digest and a
  failed rule 2. Nodes SHOULD reject a second submission of a `job_id` they
  have already answered with `409 { "error": "duplicate_job" }`.
- **Key custody.** The signing key lives only in the node's environment. An
  advertisement leak is harmless (it is public data); a key leak is fatal to
  that node's reputation, and rotation is a new advertisement plus a registry
  update wherever the old key was pinned.
- **Output fetch.** Rule 6 fetches a node-supplied URL; verifiers MUST fetch
  it with SSRF guards (https-only, private-IP rejection, size cap) of the kind
  the workers themselves use.
- **No transport trust assumed.** TLS protects the pipe; the signature protects
  the payload. A response proxied through an untrusted relay still verifies.

## Out of scope for v0.1

- On-chain settlement and receipts. `payment` is the reserved hook, and the
  adjacent [inference-receipts.md](inference-receipts.md) already settles paid
  LLM inference the same way (a signed job, a signed response, and a confirmed
  transaction anyone can re-check offline). Binding an OIN response to a
  settlement receipt is a v0.2 concern.
- Streaming responses and chunked artifact proofs.
- Multi-node redundancy (the same job run by N nodes with cross-checks).
- Anything EVM-specific: the signature curve is Ed25519; an EVM-flavored
  `node_pubkey` namespace is a future spec revision, never a blocker here.
