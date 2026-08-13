# Run an inference node

The three.ws open inference network (Phase 4 of the roadmap) decouples agent
inference from any single provider: agents pay nodes for compute, and every
result arrives with a cryptographic receipt. The **node operator client** in
`node-operator/` is how you join the supply side: register your machine, claim
inference jobs, execute them with a real open model, and return signed results
that anyone can verify against your public address.

This guide takes a zero-context operator from checkout to a verified result.

## What you run

One Node.js process with three parts:

- **Identity.** A Solana Ed25519 keypair. The public key is your node address
  (and future payout address); the secret key signs every result. Generate one
  with `node src/cli.js generate-key` and keep the printed secret private.
- **Engine.** distilgpt2 (the 82M-parameter distilled GPT-2) running on ONNX
  Runtime. The quantized graph is about 80 MB, downloads from Hugging Face on
  first run into `MODEL_CACHE_DIR`, and is reused after that. CPU works out of
  the box; the GPU image runs the same graph on CUDA.
- **Loop.** Register with the coordinator, poll for jobs, run each prompt
  through the model, sign the result, submit it. The poll cadence is
  `POLL_MS` (default 3 s), matching the platform's existing worker pattern.

## The wire contract

The protocol was derived from the platform's existing worker job format
(bearer shared-secret auth and claim/execute/submit loops, as in
`workers/agent-screen-pool`). Three endpoints, all JSON over HTTPS, all
authenticated with `Authorization: Bearer $NODE_WORKER_SECRET`:

| Endpoint | Direction | Body |
|---|---|---|
| `POST /api/inference/nodes/register` | node -> coordinator | `{ node, capabilities, models, endpoint?, version, registeredAt }` |
| `POST /api/inference/jobs/claim` | node -> coordinator | `{ node }` -> `{ job }` or `{ job: null }` |
| `POST /api/inference/jobs/submit` | node -> coordinator | result record + `signature` |

A **job envelope** is:

```json
{
	"jobId": "job_01J...",
	"type": "llm.completion",
	"model": "Xenova/distilgpt2",
	"input": { "prompt": "The three.ws open inference network lets anyone" },
	"maxTokens": 16,
	"issuedAt": "2026-08-12T16:22:48.833Z"
}
```

A **result record** binds the output to the job and the node:

```json
{
	"jobId": "job_01J...",
	"node": "<base58 node address>",
	"model": "Xenova/distilgpt2",
	"result": { "text": "...", "tokens": 16, "latencyMs": 1147 },
	"inputHash": "<sha256-hex of the UTF-8 prompt>",
	"outputHash": "<sha256-hex of the UTF-8 output text>",
	"completedAt": "2026-08-12T16:22:57.568Z",
	"signature": "<base58 Ed25519 signature>"
}
```

The signature covers a canonical string, so verification never depends on
JSON field order:

```
threews-inference-v1\n
<jobId>\n
<nodeAddress>\n
<model>\n
<inputHash>\n
<outputHash>\n
<latencyMs rounded>\n
<completedAt>
```

Anyone can verify a result offline with only the node's public address:

```bash
node src/cli.js verify receipt.json
```

## The open protocol (OIN), and when to use it instead

The contract above is the coordinator's: the platform hands out `llm.completion`
jobs and this client claims them. It assumes a coordinator exists and that you
have its shared secret.

The [Open Inference Protocol](../specs/OPEN_INFERENCE_PROTOCOL.md) is the other
direction: your node stands on its own and any requester can reach it, with no
coordinator in the middle. You publish a signed capability advertisement at
`GET /.well-known/oin` saying what you can run and what it costs, you accept job
envelopes at `POST /oin/jobs`, and every result you return carries an Ed25519
signature over a digest of the exact job plus a hash of the exact bytes you
produced. Nothing about it is three.ws-specific, which is the point: a requester
that has never heard of this platform can verify your work.

Use the coordinator contract to sell compute into the platform's job queue; use
OIN to be reachable by anyone. They share a key type (Ed25519) and coexist on
one process, so a node can do both.

The platform's mesh stylization worker is the reference OIN node
([`workers/stylize/oin.py`](../workers/stylize/oin.py), enabled by
`OIN_ENABLED=true`), and the conformance runner proves any node speaks the
protocol before it takes a paying job:

```bash
node scripts/oin-conformance.mjs --node https://your-node.example \
  --api-key "$NODE_API_KEY" --input https://three.ws/avatars/fox.glb
```

It exits 0 only when the advertisement signature, the job digest, the response
signature, and the artifact hash all check out.

## Quickstart

Requires Node.js 20+ and access to huggingface.co (one-time model download).

```bash
cd node-operator
npm ci
node src/cli.js generate-key
# export the printed secret:
export NODE_SECRET_KEY=<base58 secret>
export NODE_WORKER_SECRET=<coordinator shared secret>
export BASE_URL=https://three.ws
node src/cli.js run
```

With Docker (CPU):

```bash
docker build -t three-ws/node-operator .
docker run --rm \
	-e NODE_SECRET_KEY=<secret> -e NODE_WORKER_SECRET=<shared> \
	-e BASE_URL=https://three.ws \
	-v node-model-cache:/app/.model-cache \
	three-ws/node-operator
```

For NVIDIA GPUs, install the driver plus nvidia-container-toolkit, then use
`Dockerfile.gpu` and `docker run --gpus all`. The engine lists the CUDA
provider first when `ONNXRUNTIME_CUDA=1` (set in the GPU image), so the same
code runs on the GPU with no other change.

## Prove it locally

`selftest` spins up a real in-process HTTP coordinator that speaks the same
wire contract (bearer auth, register, claim, submit), runs one job through
the real model, and has the coordinator verify the signature before accepting
the result. It prints a receipt you can re-verify offline:

```bash
node src/cli.js selftest
```

Expected output ends with `verified: signature = true , output hash = true`
and a JSON receipt. A forged signature (right shape, wrong key) is rejected
with HTTP 422, which the test suite covers.

## Configuration reference

Every setting is an environment variable; there is no config file to keep in
sync. The full table is in [node-operator/README.md](../node-operator/README.md).

| Variable | Default | Notes |
|---|---|---|
| `NODE_SECRET_KEY` | none | Required. base58, base64, or solana-keygen JSON. |
| `NODE_WORKER_SECRET` | none | Coordinator shared secret (16+ chars). |
| `BASE_URL` | `https://three.ws` | Any coordinator deployment. |
| `MODEL_ID` | `Xenova/distilgpt2` | Any HF repo with a merged-quantized ONNX export. |
| `MODEL_REVISION` | `main` | Pin a commit hash for reproducible weights. |
| `MODEL_CACHE_DIR` | `./.model-cache` | Model cache; mount a volume in Docker. |
| `POLL_MS` | `3000` | Claim poll cadence. |
| `MAX_JOBS` | unlimited | Stop after N jobs. |

## Security model

- The coordinator authenticates nodes with the shared worker secret; nodes
  authenticate results with their Ed25519 signatures. The two channels are
  independent, so a leaked worker secret lets an attacker *receive* jobs but
  never *prove* results for a node they do not hold the key for.
- Generation is greedy (deterministic) on purpose: two honest nodes given the
  same prompt produce the same output hash, so a coordinator can spot-check
  results by re-execution or by comparing hashes across replicas.
- The canonical string binds the job id, so a valid result for one job cannot
  be replayed as the answer to another.

## What this is not (yet)

- The built-in model is the proof workload, not the production model catalog.
  Serving larger models means pointing `MODEL_ID` at a bigger ONNX export and
  running the GPU image; the wire contract is unchanged.
- On-chain settlement (pay-per-token with receipts) is the adjacent roadmap
  slice; this client already exposes the node address and signed receipts
  that settlement consumes.
