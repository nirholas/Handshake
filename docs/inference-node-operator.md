# Run an inference node

The three.ws open inference network (Phase 4 of the roadmap) decouples agent
inference from any single provider: agents send jobs to a queue, independently
operated nodes claim them, and every result comes back with a cryptographic
receipt that anyone can verify offline. The **node operator client** in
[`packages/node-operator/`](../packages/node-operator) is how you join the
supply side.

This guide takes a zero-context operator from clone to a verified result.
The wire contract itself is specified in
[specs/inference-nodes.md](../specs/inference-nodes.md).

## What you run

One Node.js process with four parts:

- **Identity.** A Solana ed25519 keypair, generated on first run and written to
  `node-identity.json` (mode `0600`). The public key is your node address, your
  future payout address, and the key every result is verified against. The
  secret key never leaves your machine; the platform only ever sees signatures.
- **Engine.** `Xenova/all-MiniLM-L6-v2` (Apache-2.0) on ONNX Runtime through
  `@huggingface/transformers`. Real local inference, no API keys, no network
  calls once the weights are cached in `./models`. CPU runs the 23 MB q8 graph;
  an NVIDIA GPU runs the 90 MB fp32 graph on CUDA.
- **Loop.** Register, poll, execute, sign, submit, repeat. Bounded concurrency,
  exponential backoff on transient poll failures, and a graceful drain on
  SIGINT/SIGTERM so a restart never abandons half-computed work.
- **Receipts.** Every finished job ships an ed25519 signature binding
  `(jobId, model, prompt, output, startedAt, finishedAt)` to your public key.

## Quickstart

Requires Node.js 20+ and one-time access to huggingface.co for the weights.

```bash
cd packages/node-operator
npm install
npm run self-test
```

The self-test runs the real workload locally and prints the device that
executed it, so you know your hardware works before you register:

```
[node] identity 7Xf3...q9Zk (generated, saved to /path/node-identity.json)
[node] platform https://three.ws · capability text-embedding · model Xenova/all-MiniLM-L6-v2 · device auto
[node] running proof workload self-test (first run downloads the model)...
[node] self-test OK: Xenova/all-MiniLM-L6-v2, 384 dims, ran on cpu (q8) in 1932ms
```

Then register and start taking jobs:

```bash
npm start
```

Ctrl+C drains in-flight jobs and exits cleanly. Back up `node-identity.json`:
losing it means losing the node's identity, its history, and its payout
address.

| Command | What it does |
| --- | --- |
| `npm start` | Register (idempotent) and run the job loop. |
| `npm run register` | Register with the platform and exit. |
| `npm run self-test` | Run the proof workload locally and exit; exit code 1 on failure. |
| `npm start -- --pubkey` | Print the node's base58 public key and exit. |
| `npm test` | Unit suite. |
| `npm run e2e` | Full local proof: register, job, signed result, verification. |

## Docker

Two images, because the difference between them is the base layer rather than
the code. Running the CPU image with `--gpus all` does **not** give you GPU
inference: ONNX Runtime's CUDA execution provider dynamically links the CUDA 12
runtime and cuDNN 9, and those libraries are not in a slim Node image.

CPU:

```bash
cd packages/node-operator
docker build -t three-ws-node:cpu .
docker run -d --name three-ws-node \
  -e NODE_LABEL=atlas-01 \
  -v three-ws-models:/app/models \
  -v three-ws-identity:/app/identity \
  -e IDENTITY_PATH=/app/identity/node-identity.json \
  three-ws-node:cpu
```

NVIDIA GPU (host needs driver >= 525 and the NVIDIA Container Toolkit):

```bash
docker build -f Dockerfile.gpu -t three-ws-node:gpu .
docker run -d --name three-ws-node --gpus all \
  -e NODE_LABEL=atlas-gpu-01 \
  -v three-ws-models:/app/models \
  -v three-ws-identity:/app/identity \
  -e IDENTITY_PATH=/app/identity/node-identity.json \
  three-ws-node:gpu
```

Verify either image before leaving it running:

```bash
docker run --rm three-ws-node:cpu node src/index.js --self-test
docker run --rm --gpus all three-ws-node:gpu node src/index.js --self-test
```

### How device selection behaves

`DEVICE=auto` (the default outside Docker) checks for an attached NVIDIA driver
(`/dev/nvidiactl`, `/dev/nvidia0`, `/proc/driver/nvidia/version`) and uses CUDA
only when one is present. The probe comes before the download so a CPU-only
host never pulls the 90 MB fp32 graph it cannot execute.

Setting `DEVICE` explicitly turns the fallback off. The GPU image ships
`DEVICE=cuda` on purpose: an operator who paid for a GPU should learn in the
first second that it is unreachable, not after a month of CPU-speed earnings.
Without `--gpus all`, that image exits immediately:

```
[node] fatal: could not load Xenova/all-MiniLM-L6-v2 on any of [cuda] ->
  cuda: CUDA failure 35: CUDA driver version is insufficient for CUDA runtime version
```

## Configuration reference

Precedence is **environment variable > `operator.config.json` in the working
directory > default**. Every value is validated at boot, so a misconfigured
node fails with a readable message instead of mid-job. The full table with
config-file keys lives in
[packages/node-operator/README.md](../packages/node-operator/README.md).

| Variable | Default | Notes |
| --- | --- | --- |
| `PLATFORM_URL` | `https://three.ws` | Any coordinator deployment; must be absolute http(s). |
| `CAPABILITY` | `text-embedding` | The capability queue this node drains. |
| `MODEL` | `Xenova/all-MiniLM-L6-v2` | Model id advertised at registration. |
| `DEVICE` | `auto` | `auto`, `cpu`, `cuda`, `webgpu`, `dml`, `coreml`. |
| `DTYPE` | per device | `q8` on CPU, `fp32` on GPU. Override only deliberately. |
| `POLL_INTERVAL_MS` | `5000` | Idle poll cadence; minimum 1000. |
| `MAX_CONCURRENCY` | `1` | Jobs executed in parallel. |
| `JOB_TIMEOUT_MS` | `120000` | Per-job wall-clock ceiling. |
| `IDENTITY_PATH` | `node-identity.json` | Where the keypair is persisted. |
| `OPERATOR_SECRET_KEY` | none | 64-byte ed25519 secret, base58 or base64. Overrides the file. |
| `NODE_LABEL` | none | Human-readable node name. |

## The wire contract

Three calls, JSON over HTTPS, each authenticated by an ed25519 signature over a
short domain-separated string rather than a bearer secret. There is no shared
secret to leak: authority comes from the key, and the key never leaves your
host. Full specification, including error codes, storage lifetimes and the
threat model: [specs/inference-nodes.md](../specs/inference-nodes.md).

```
POST {platform}/api/nodes/register
  body: { publicKey, label?, capabilities: [{capability, model}], registeredAt, signature }
  signature over `threews-node-register:{publicKey}:{registeredAt}`

GET  {platform}/api/nodes/jobs?node={pk}&capability={cap}&ts={ms}&sig={sig}
  sig over `threews-node-poll:{pk}:{ts}`
  -> { job: null } | { job: { id, capability, model, input, deadlineAt } }

POST {platform}/api/nodes/jobs/{jobId}/result
  success: { node, output, startedAt, finishedAt, receipt }
  failure: { node, failed: true, error, startedAt, finishedAt, ts, signature }
  -> { ok: true, verified: true }
```

The receipt payload pre-hashes every variable-length field, so no crafted
prompt can smuggle a separator across a field boundary:

```
sha256hex(jobId).sha256hex(model).sha256hex(prompt).sha256hex(output).startedAt.finishedAt
```

The coordinator does not trust what you send: it recomputes that payload from
the submission plus the prompt and model in its own job record, and rejects
anything that does not match. `verified: true` therefore means the result is
cryptographically bound to your node, which is exactly what settlement will
check before paying you.

## Prove it locally

`npm run e2e` boots the real platform server (`server/index.mjs`, serving the
real `api/nodes/*` handlers) against an in-process Redis shim, enqueues a real
job, and runs the real client through register, poll, inference, signing and
submission. It exits non-zero unless the receipt verifies. No fake coordinator,
no stubbed model, no mocked crypto:

```bash
cd packages/node-operator
npm run e2e
```

```
[e2e] registering node EoZB1MExfAiLhrzpCdRwf9w2rBzAWx6iaraStRvYgKc7
[e2e] [node] job job_e2e_1786739629649 complete (5115ms inference on cpu, verified=true)
[e2e] RESULT VERIFIED

--- e2e transcript ---
model           : Xenova/all-MiniLM-L6-v2
embedding dims  : 384
receipt payload : 0a1ef372...6f1b7d47...6c6d69d4...fa2f675e...1786739633154.1786739638269
verified        : true (recomputed payload + ed25519 against node key)

E2E PASS
```

## The open protocol (OIN), and when to use it instead

The contract above is the coordinator's: the platform holds a queue and your
node claims from it (pull). The
[Open Inference Protocol](../specs/OPEN_INFERENCE_PROTOCOL.md) is the other
direction (push): your node stands on its own with no coordinator in the
middle. You publish a signed capability advertisement at `GET /.well-known/oin`
saying what you run and what it costs, you accept job envelopes at
`POST /oin/jobs`, and every result carries an ed25519 signature over a digest
of the exact job plus a hash of the exact bytes you produced. Nothing about it
is three.ws-specific, which is the point: a requester that has never heard of
this platform can verify your work.

Use the coordinator contract to sell compute into the platform's queue; use OIN
to be reachable by anyone. They share a key type and coexist in one process, so
a node can do both.

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

## Security model

- **No shared secret.** Nodes authenticate with signatures over
  domain-separated strings. A compromised coordinator can refuse to hand you
  work; it can never fabricate results in your name, because it never holds
  your key.
- **No cross-call replay.** Register, poll and failure signatures use distinct
  prefixes and carry a timestamp that expires after five minutes.
- **No result theft.** Only the node that claimed a job can close it, and only
  from the running state, so a late or replayed submission cannot overwrite a
  landed result.
- **Verification is offline and pure.** Anyone with the receipt and your public
  key can confirm you computed exactly that output for exactly that job,
  without calling three.ws.

## What this is not (yet)

- The built-in model is the proof workload, not the production catalog. Serving
  larger models means pointing `MODEL` at a bigger ONNX export and running the
  GPU image; the wire contract does not change.
- On-chain settlement (pay-per-job against these receipts) is the adjacent
  roadmap slice. This client already exposes the node address and the signed
  receipts settlement consumes. The payment-side format is specified in
  [specs/inference-receipts.md](../specs/inference-receipts.md).
- Reported `startedAt` / `finishedAt` bind the receipt but are node-reported;
  v1 prices work per job, not per reported wall clock.
