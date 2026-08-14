# Open inference network: node coordinator contract (`threews-node/v1`)

The wire contract between an independently operated inference node and the
three.ws coordinator (Roadmap phase 4). It covers the three calls a node makes
over its whole lifetime: register, claim a job, return a signed result. Anyone
can implement it; the reference operator client is
[`packages/node-operator`](../packages/node-operator).

- Spec id: `threews-node/v1`
- Status: live. Endpoints [`api/nodes/register.js`](../api/nodes/register.js),
  [`api/nodes/jobs.js`](../api/nodes/jobs.js),
  [`api/nodes/jobs/[id]/result.js`](../api/nodes/jobs/[id]/result.js)
- Server-side implementation: [`api/_lib/inference-nodes.js`](../api/_lib/inference-nodes.js)
- Reference client: [`packages/node-operator/src/platform.js`](../packages/node-operator/src/platform.js),
  [`packages/node-operator/src/signing.js`](../packages/node-operator/src/signing.js)
- Operator guide: [docs/inference-node-operator.md](../docs/inference-node-operator.md)
- Executable proof of the whole contract:
  `node packages/node-operator/scripts/e2e-local.mjs`

## Relationship to the other two inference specs

Three specs touch inference and they are not alternatives; they sit at
different layers.

| Spec | Question it answers | Who talks to whom |
| --- | --- | --- |
| **This one** (`threews-node/v1`) | How does a node join the platform's queue and get paid work? | node -> coordinator (pull) |
| [OPEN_INFERENCE_PROTOCOL.md](OPEN_INFERENCE_PROTOCOL.md) (`oin/v0.1`) | How does any requester call a node directly, with no coordinator? | requester -> node (push) |
| [inference-receipts.md](inference-receipts.md) (`three-inference-receipt/v1`) | How is an x402 payment bound to the job it bought? | payer <-> settlement |

They share the ed25519 primitive and can coexist in one process. A node that
implements this spec sells compute into the platform queue; adding OIN makes
the same box reachable by requesters who have never heard of three.ws.

## Identity

A node's identity is a Solana ed25519 keypair. The base58-encoded public key
is simultaneously:

- the node id (registration is an idempotent upsert on it),
- the routing address the coordinator claims jobs against,
- the payout address settlement will credit,
- the verification key for every result the node returns.

The secret key never leaves the operator host. The coordinator only ever sees
signatures, which means a coordinator compromise cannot forge results for any
node, and a node that loses its key loses its identity (there is no recovery
path by design: an account you can recover without the key is an account
someone else can steal without the key).

## Signature construction

Every authenticated call signs a **domain-separated ASCII string**, never a
JSON object, so there is no canonicalization to get wrong and no field-order
ambiguity. Signatures are ed25519 (RFC 8032) over the UTF-8 bytes of the
string, transported base64.

| Call | Signed string |
| --- | --- |
| register | `threews-node-register:{publicKey}:{registeredAt}` |
| poll | `threews-node-poll:{publicKey}:{ts}` |
| failure report | `threews-node-fail:{publicKey}:{jobId}:{ts}` |
| result receipt | the receipt payload below |

The prefixes are distinct on purpose: a signature harvested from one call is
structurally invalid for any other. Timestamps are integer milliseconds since
the epoch and must be within **5 minutes** of coordinator time (constant
`MAX_CLOCK_SKEW_MS` in each handler), which bounds replay to that window and
makes an operator with a badly wrong clock fail loudly at registration rather
than silently earning nothing.

## 1. Register

```http
POST /api/nodes/register
Content-Type: application/json

{
  "publicKey": "<base58 ed25519 public key>",
  "label": "atlas-01",
  "capabilities": [{ "capability": "text-embedding", "model": "Xenova/all-MiniLM-L6-v2" }],
  "registeredAt": 1786690709863,
  "signature": "<base64 ed25519 over threews-node-register:{publicKey}:{registeredAt}>"
}
```

```json
200 { "ok": true, "node": { "id": "<pubkey>", "publicKey": "<pubkey>", "label": "atlas-01", "capabilities": [ ... ] } }
```

Errors: `400 invalid_public_key`, `400 invalid_capabilities`,
`400 stale_registration`, `401 bad_signature`, `429` rate limited.

Registration is idempotent and re-registering refreshes `last_seen_at` and
replaces the capability list, so a node that changes hardware or models just
registers again. At most 16 capabilities are stored per node.

## 2. Claim a job

```http
GET /api/nodes/jobs?node={publicKey}&capability={capability}&ts={ms}&sig={base64}
```

```json
200 { "job": null }
200 { "job": { "id": "job_...", "capability": "text-embedding", "model": "...", "input": { "text": "..." }, "status": "running", "claimedBy": "<pubkey>", "claimedAt": 1786690713000, "deadlineAt": 1786694309863 } }
```

Errors: `400 missing_params`, `401 stale_signature`, `401 bad_signature`,
`404 node_not_registered`, `429` rate limited.

A claim is a single atomic pop from the capability queue followed by a write
that stamps `claimedBy` and flips `status` to `running`, so two nodes polling
the same capability can never receive the same job. An empty queue is a
`200` with `job: null`, not a `404`: polling is the normal steady state, and
an error status for "nothing to do" would poison every operator's logs and
alerting.

## 3. Return the result

```http
POST /api/nodes/jobs/{jobId}/result

{
  "node": "<base58 pubkey>",
  "output": { "kind": "text-embedding", "model": "...", "dimensions": 384, "embedding": [ ... ] },
  "startedAt": 1786690713952,
  "finishedAt": 1786690720689,
  "receipt": {
    "algorithm": "ed25519",
    "publicKey": "<base58 pubkey>",
    "payload": "<canonical payload string, below>",
    "signature": "<base64>"
  }
}
```

```json
200 { "ok": true, "verified": true }
```

Errors: `400 missing_fields`, `401 bad_receipt`, `403 not_job_owner`,
`404 job_not_found`, `409 job_not_running`.

The coordinator does not trust the submitted receipt: it **recomputes** the
payload from the fields in the request plus the prompt and model held in its
own job record, and rejects any receipt whose payload or signature does not
match. That is what makes `verified: true` meaningful, and it is the check
settlement will gate payment on. Two consequences worth stating plainly:

- A node cannot sign a receipt over a different prompt than the one it was
  assigned, because the prompt in the payload comes from the coordinator's
  record, not from the submission.
- Only the node that claimed the job can close it (`403` otherwise), and only
  from the `running` state (`409` otherwise), so a replayed or late submission
  can never overwrite a result that already landed.

### Receipt payload

```
sha256hex(jobId) "." sha256hex(model) "." sha256hex(prompt) "." sha256hex(outputJSON) "." startedAt "." finishedAt
```

Every variable-length field is pre-hashed, so the `.` separators cannot be
smuggled across field boundaries by a crafted prompt. Digests are lowercase
hex SHA-256 over UTF-8 bytes, computed with WebCrypto on both sides so a
browser verifier reproduces them exactly. `outputJSON` is `JSON.stringify` of
the output object (or the string itself, when the output is a string), and
`startedAt` / `finishedAt` are decimal integer milliseconds.

Verification needs nothing but the payload, the signature, and the node's
public key. It is pure and offline:
[`verifyResult`](../packages/node-operator/src/signing.js) recomputes the
payload from the claimed facts before checking the signature (the check that
catches a node signing an output it did not submit);
[`verifyResultReceipt`](../api/_lib/inference-nodes.js) is the identical
server-side function.

### Failure reports

A node that cannot finish a job says so instead of going silent, which lets
the coordinator requeue or refund immediately rather than waiting out the
deadline:

```http
POST /api/nodes/jobs/{jobId}/result

{
  "node": "<pubkey>",
  "failed": true,
  "error": "job job_x exceeded 120000ms",
  "startedAt": 1786690713952,
  "finishedAt": 1786690833952,
  "ts": 1786690833960,
  "signature": "<base64 ed25519 over threews-node-fail:{publicKey}:{jobId}:{ts}>"
}
```

```json
200 { "ok": true, "verified": false }
```

`verified: false` is correct and not an error: a failure report carries no
result to verify. The error string is truncated to 500 characters.

## Storage and lifetimes

| Record | Store | Lifetime |
| --- | --- | --- |
| Node registry | Postgres `inference_nodes`, mirrored to Redis `inode:{pubkey}` when the database is unreachable | 30 days per registration, refreshed on every register |
| Job record | Redis `ijob:{jobId}` | 1 hour (`JOB_TTL_S`) |
| Capability queue | Redis list `iqueue:{capability}` | until claimed or the job expires |

Jobs are deliberately Redis-only and ephemeral (one-shot, TTL-bounded), which
matches the platform's agent-screen task queue. The node registry is the part
that must survive a cache flush, so it is durable in Postgres with a Redis
fallback that keeps a bare local stack (no Postgres) usable for development.
`jobs_completed` / `jobs_failed` on the registry row are a best-effort rollup
for operator-facing stats; the Redis job record is the authoritative outcome.

## Rate limits

Per IP, enforced by `api/_lib/rate-limit.js`: `nodeRegisterIp` on the register
endpoint, `nodeJobIp` on both the poll and result endpoints. A limited call
returns `429` with the standard rate-limit headers. A node polling on the
default 5 s cadence is far under the ceiling; a node hammering the queue is
not, which is the intent.

## Threat model

| Attack | Why it fails |
| --- | --- |
| Register someone else's public key | Registration requires a signature under that key. |
| Drain another node's queue | The poll signature is over the node's own key; a claim stamps that key. |
| Replay a captured poll signature | The signed timestamp expires after 5 minutes. |
| Reuse a register signature as a poll signature | Different domain prefixes; the string does not verify. |
| Submit a result for a job you did not claim | `403 not_job_owner`. |
| Overwrite a completed job | `409 job_not_running`. |
| Sign one output and submit another | The coordinator recomputes the payload from the submission and its own record. |
| Claim a longer runtime than the work took | Out of scope for v1: `startedAt` / `finishedAt` are node-reported and only bind the receipt. Settlement prices work by job, not by reported wall clock. |
| A malicious coordinator forging node results | Impossible: the coordinator never holds a node secret key. It can refuse work, not fabricate it. |

## Conformance

A node implements `threews-node/v1` when, against a live coordinator:

1. It registers with a signature that verifies under its published key.
2. It claims a job with a signed, in-window timestamp and executes it.
3. It returns a receipt whose payload the coordinator recomputes bit for bit
   and whose signature verifies, yielding `verified: true`.
4. It reports failures with a signed failure report rather than going silent.

`node packages/node-operator/scripts/e2e-local.mjs` runs exactly that sequence
against the real handlers in `api/nodes/*` (booted from `server/index.mjs`)
with real model inference and real ed25519 keys, and exits non-zero unless the
receipt verifies. Any client implementation can be dropped into that harness.
