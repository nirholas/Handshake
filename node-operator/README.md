# Node operator client (three.ws open inference network)

Run a three.ws inference node: register with the platform, claim inference
jobs, execute them with a real open model, and return cryptographically
signed results. This is the Phase 4 roadmap slice "node operator client
(Docker + GPU drivers) with onchain registration" (`README.md` roadmap at the
repo root).

The client is self-contained: one Node.js process, a Solana Ed25519 keypair
as its identity, and a small open model (distilgpt2, ONNX) as the built-in
proof workload. It works on CPU out of the box and uses the GPU automatically
when run from the GPU image.

## How it works

1. **Identity.** The node's Solana Ed25519 keypair is both its payout address
   and its signing key. The public address is safe to share; the secret key
   stays on the machine.
2. **Registration.** On boot the client POSTs its address, capabilities, and
   model list to the coordinator (`POST /api/inference/nodes/register`),
   authenticated with the shared worker secret.
3. **Job loop.** The client polls for jobs (`POST /api/inference/jobs/claim`),
   runs each prompt through the local model, and submits the result
   (`POST /api/inference/jobs/submit`).
4. **Signed responses.** Every result is signed with the node key over a
   canonical string that binds the job id, node address, model, and the
   SHA-256 hashes of the input prompt and generated output. Anyone can verify
   a result with only the node's public address: recompute the canonical
   string and check the Ed25519 signature (`node src/cli.js verify <file>`).

The wire contract is documented in [docs/inference-node-operator.md](../docs/inference-node-operator.md)
and was derived from the platform's existing worker job format (bearer
shared-secret auth and claim/execute/submit loops, as in
`workers/agent-screen-pool`).

## Install

Requires Node.js 20+ (24 recommended) and network access to huggingface.co
for the one-time model download (~80 MB).

```bash
cd node-operator
npm ci
```

Or with Docker (no local Node needed):

```bash
docker build -t three-ws/node-operator .
```

### GPU

The CPU image runs everywhere. For NVIDIA GPUs:

1. Install the NVIDIA driver and
   [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
   on the host; verify with `nvidia-smi`.
2. Build and run the GPU image:

```bash
docker build -f Dockerfile.gpu -t three-ws/node-operator:gpu .
docker run --rm --gpus all \
  -e NODE_SECRET_KEY=... -e NODE_WORKER_SECRET=... \
  -e BASE_URL=https://three.ws \
  -v node-model-cache:/app/.model-cache \
  three-ws/node-operator:gpu
```

`src/engine.js` lists the CUDA execution provider before CPU, so the same
code runs the graph on the GPU as soon as the CUDA runtime is present.

## Config

All configuration is environment variables:

| Variable             | Default                | Meaning                                              |
| -------------------- | ---------------------- | ---------------------------------------------------- |
| `NODE_SECRET_KEY`    | none                   | **Required.** Node keypair: base58, base64, or a solana-keygen JSON byte array. |
| `NODE_WORKER_SECRET` | none                   | Shared worker secret for the coordinator (16+ chars), same pattern as `SCREEN_WORKER_SECRET`. |
| `BASE_URL`           | `https://three.ws`     | Coordinator base URL.                                |
| `MODEL_CACHE_DIR`    | `./.model-cache`       | Where model files are downloaded and reused.         |
| `MODEL_ID`           | `Xenova/distilgpt2`    | Hugging Face model id for the proof workload.        |
| `MODEL_REVISION`     | `main`                 | Model revision; pin a commit hash for reproducibility. |
| `POLL_MS`            | `3000`                 | Job poll cadence.                                    |
| `MAX_JOBS`           | unlimited              | Stop after N jobs (useful for smoke runs).           |
| `NODE_ENDPOINT_URL`  | none                   | Optional public callback URL advertised at registration. |

## Run

Generate a key (once, keep the secret safe):

```bash
node src/cli.js generate-key
```

Register only (useful to confirm coordinator connectivity):

```bash
NODE_SECRET_KEY=<secret> NODE_WORKER_SECRET=<shared-secret> node src/cli.js register
```

Run the daemon (registers, then loops):

```bash
NODE_SECRET_KEY=<secret> NODE_WORKER_SECRET=<shared-secret> node src/cli.js run
```

With Docker:

```bash
docker run --rm \
  -e NODE_SECRET_KEY=<secret> \
  -e NODE_WORKER_SECRET=<shared-secret> \
  -e BASE_URL=https://three.ws \
  -v node-model-cache:/app/.model-cache \
  three-ws/node-operator
```

## Verify

### Local end-to-end proof

`selftest` spins up a real HTTP coordinator in-process (same wire contract:
bearer auth, register, claim, submit), runs one job through the real model,
and has the coordinator cryptographically verify the signed result before
accepting it. The receipt (job, result, signature) is printed as JSON.

```bash
node src/cli.js generate-key   # once
NODE_SECRET_KEY=<secret> node src/cli.js selftest
```

Expected tail of the output:

```
[node ...] completed {"type":"completed","jobId":"selftest-...","tokens":16,...}
[node ...] verified: signature = true , output hash = true
--- selftest receipt ---
{ "job": { ... }, "result": { ... }, "signature": "..." }
```

### Verifying any signed result

Save a receipt JSON (`{ job, result, signature }`) and verify it offline,
anywhere, with no coordinator access:

```bash
node src/cli.js verify receipt.json
```

Prints `VALID` plus the node address, model, hashes, and signature prefix, or
exits non-zero with `INVALID`.

## Tests

The repo's root test runner covers this client:

```bash
npm test -- tests/node-operator.test.js   # from the repo root
```

Coverage: identity round-trips (base58/base64/JSON key encodings, sign and
verify), the wire codec (canonical string, hash binding, tamper rejection),
the coordinator client (auth header, register/claim/submit paths), the BPE
tokenizer and greedy generation against the real distilgpt2 weights, and a
full selftest loop against the in-process coordinator.

## Limits and honest notes

- The built-in model is a proof workload, not a production model: distilgpt2
  proves registration, execution, and signed settlement end to end. Serving
  larger models is a matter of pointing `MODEL_ID` at a bigger ONNX export
  and running the GPU image; the wire contract does not change.
- Generation is greedy (deterministic) by design: two honest nodes given the
  same prompt produce the same output hash, which is what makes results
  independently checkable.
- On-chain settlement of verified results (pay-per-token with receipts) is
  the adjacent roadmap slice; this client already exposes the address and the
  signed receipts settlement needs.
