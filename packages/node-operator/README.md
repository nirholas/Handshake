<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/node-operator</h1>

<p align="center"><strong>Run a three.ws inference node: register a Solana keypair, poll the job queue, execute real local inference, return a signed receipt.</strong></p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#wire-protocol">Wire protocol</a> ·
  <a href="#receipts">Receipts</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/node-operator` is the operator-side client for the three.ws open
> inference network. It turns any machine with Node 20+ into a node that the
> platform can route inference jobs to. The node holds a Solana ed25519 keypair,
> and that public key **is** its identity on the network: jobs are routed to it,
> results are verified against it, and settlement pays it. The secret key never
> leaves the operator host. The platform only ever sees signatures.

## Why

An inference network that trusts its nodes is not a network, it is a hosting
bill with extra steps. The hard problem is not running a model, it is proving
that a specific node ran a specific job and produced a specific output, so a
requester can pay for the result without trusting the operator or any
intermediary.

This client solves that end to end. Every job the node finishes ships with an
ed25519 **receipt** that binds `(jobId, model, prompt, output, startedAt,
finishedAt)` to the node's public key. Verification is pure and offline: anyone
holding the receipt and the pubkey can confirm the node computed exactly that
output for exactly that job, with no call back to three.ws.

## Install

The package is in-repo and not published to npm. Clone the repo and install
inside the package directory:

```sh
cd packages/node-operator
npm install
```

Node 20 or newer is required (the client uses `AbortSignal.timeout` and
`crypto.subtle`).

## Quick start

Prove your host can run the workload before you register:

```sh
npm start -- --self-test
```

The first run downloads `Xenova/all-MiniLM-L6-v2` (Apache-2.0; 23 MB as the q8
graph the CPU uses, 90 MB as the fp32 graph a GPU uses) into `./models` and
caches it there. Expect output like:

```
[node] identity 7Xf3...q9Zk (generated, saved to /path/node-identity.json)
[node] platform https://three.ws · capability text-embedding · model Xenova/all-MiniLM-L6-v2 · device auto
[node] running proof workload self-test (first run downloads the model)...
[node] self-test OK: Xenova/all-MiniLM-L6-v2, 384 dims, ran on cpu (q8) in 1932ms
```

`ran on cpu` / `ran on cuda` is the point of the self-test: it reports the
device that actually executed the forward pass, so "is my GPU being used?" is
answered before you register, not guessed at later.

Then register and start earning:

```sh
npm start
```

That registers the node with the platform and enters the poll loop. Ctrl+C
drains in-flight jobs and exits cleanly.

### CLI

| Command | What it does |
| --- | --- |
| `npm start` | Register (idempotent) and run the job loop until SIGINT/SIGTERM. |
| `npm start -- --register-only` | Register with the platform and exit. |
| `npm start -- --self-test` | Run the proof workload locally and exit; exit code 1 on failure. |
| `npm start -- --pubkey` | Print this node's base58 public key and exit. |
| `npm run register` | Alias for `--register-only`. |
| `npm run self-test` | Alias for `--self-test`. |
| `npm test` | Run the vitest suite. |
| `npm run e2e` | End-to-end proof against the real platform handlers (see [Testing](#testing)). |

## Identity

On first run the client generates an ed25519 keypair and writes it to
`node-identity.json` (mode `0600`) in the working directory, so restarts keep
the same identity and the same earnings history. To supply your own key
instead, set `OPERATOR_SECRET_KEY` to the 64-byte ed25519 secret key encoded as
either base58 or base64. The env var always wins over the file.

Back up `node-identity.json`. Losing it means losing the node's identity on the
network.

```js
import { resolveIdentity, defaultIdentityPath } from './src/identity.js';

const { identity, source } = resolveIdentity({
  envSecret: process.env.OPERATOR_SECRET_KEY,
  identityPath: defaultIdentityPath(),
});
console.log(identity.publicKey, source); // '7Xf3...q9Zk' 'file'
```

## Configuration

Precedence is **environment variable > `operator.config.json` in the working
directory > default**. Config is validated eagerly, so a misconfigured node
fails at boot with a readable message rather than mid-job.

| Env var | Config key | Default | Meaning |
| --- | --- | --- | --- |
| `PLATFORM_URL` | `platformUrl` | `https://three.ws` | Platform base URL. Must be absolute http(s); trailing slashes are stripped. |
| `CAPABILITY` | `capability` | `text-embedding` | Capability this node advertises and polls for. |
| `MODEL` | `model` | `Xenova/all-MiniLM-L6-v2` | Model id advertised at registration. |
| `POLL_INTERVAL_MS` | `pollIntervalMs` | `5000` | Idle poll interval. Minimum 1000. |
| `MAX_CONCURRENCY` | `maxConcurrency` | `1` | Jobs executed in parallel. Minimum 1. |
| `JOB_TIMEOUT_MS` | `jobTimeoutMs` | `120000` | Per-job wall clock ceiling. Minimum 10000. |
| `IDENTITY_PATH` | `identityPath` | `node-identity.json` | Where the keypair is persisted. Relative paths resolve against the working directory. |
| `OPERATOR_SECRET_KEY` | `secretKey` | none | 64-byte ed25519 secret key, base58 or base64. Overrides the identity file. |
| `NODE_LABEL` | `label` | none | Human-readable name shown alongside the node. |
| `DEVICE` | `device` | `auto` | Execution device: `auto`, `cpu`, `cuda`, `webgpu`, `dml`, `coreml`. See [Hardware](#hardware). |
| `DTYPE` | `dtype` | per device | Weight precision override: `q8`, `fp16`, `fp32`, `q4`. Defaults to `q8` on CPU and `fp32` on GPU. |

A minimal `operator.config.json`:

```json
{
  "label": "atlas-01",
  "capability": "text-embedding",
  "maxConcurrency": 4,
  "pollIntervalMs": 3000
}
```

## Hardware

`DEVICE=auto` (the default) checks for an attached NVIDIA driver
(`/dev/nvidiactl`, `/dev/nvidia0`, or `/proc/driver/nvidia/version`) and uses
CUDA when one is present, CPU otherwise. The check comes first for a practical
reason: the GPU path wants the 90 MB fp32 graph and the CPU path wants the
23 MB q8 graph, so probing before downloading saves every CPU-only operator a
download they can never execute.

Setting `DEVICE` explicitly disables the fallback. `DEVICE=cuda` on a host
without a working CUDA 12 runtime **exits non-zero at startup** with the
loader's own error rather than quietly running on the CPU:

```
[node] fatal: could not load Xenova/all-MiniLM-L6-v2 on any of [cuda] ->
  cuda: OrtSessionOptionsAppendExecutionProvider_Cuda: Failed to load shared library
```

That is deliberate. An operator who paid for a GPU should find out in the
first second, not from a month of CPU-speed earnings.

GPU support is real and comes from `onnxruntime-node` (bundled with
`@huggingface/transformers` v4), which ships
`libonnxruntime_providers_cuda.so` for linux/x64. It needs the CUDA 12 runtime
and cuDNN 9 present in the container or on the host, plus an NVIDIA driver
>= 525 and the NVIDIA Container Toolkit. That is exactly what `Dockerfile.gpu`
provides.

### Docker

Two images ship with the package because the difference is the base layer, not
the code: CUDA's runtime libraries are not in the slim Node image, so running
the CPU image with `--gpus all` does not get you GPU inference.

CPU:

```sh
docker build -t three-ws-node:cpu .
docker run -d --name three-ws-node \
  -e NODE_LABEL=atlas-01 \
  -e MAX_CONCURRENCY=4 \
  -v three-ws-models:/app/models \
  -v three-ws-identity:/app/identity \
  -e IDENTITY_PATH=/app/identity/node-identity.json \
  three-ws-node:cpu
```

NVIDIA GPU:

```sh
docker build -f Dockerfile.gpu -t three-ws-node:gpu .
docker run -d --name three-ws-node --gpus all \
  -e NODE_LABEL=atlas-gpu-01 \
  -v three-ws-models:/app/models \
  -v three-ws-identity:/app/identity \
  -e IDENTITY_PATH=/app/identity/node-identity.json \
  three-ws-node:gpu
```

Both mount `/app/models` so weights survive restarts and a separate volume for
the identity file so the node keeps its key (and its earnings history) across
container replacement. Verify either image before you leave it running:

```sh
docker run --rm three-ws-node:cpu node src/index.js --self-test
docker run --rm --gpus all three-ws-node:gpu node src/index.js --self-test
```

## The proof workload

The built-in capability is real local text embedding, not a stub. Embeddings
were chosen as the proof workload because they are the smallest thing that
still exercises the full tensor path a production inference job uses (tokenize,
transformer forward, mean pool, normalize), run in seconds on a laptop CPU, and
produce a deterministic, numerically verifiable output. There are no API keys
and no network calls at inference time; the model downloads once and runs
locally forever after.

Richer models plug into the same `runJob()` interface:

```js
import { runJob, selfTest } from './src/inference.js';

const { output, startedAt, finishedAt, device } = await runJob(
  { id: 'job-1', model: 'Xenova/all-MiniLM-L6-v2', input: { text: 'hello' } },
  { cacheDir: './models', device: 'auto' },
);
// output -> { kind: 'text-embedding', model, dimensions: 384, embedding: [...] }
// device -> 'cpu' | 'cuda': what actually ran it

await selfTest({ cacheDir: './models' });
// -> { ok: true, model, dimensions: 384, device: 'cpu', dtype: 'q8', elapsedMs: 1932 }
```

`output` carries no device or dtype field on purpose. The receipt hashes that
object, so two honest nodes running the same job must produce the same output
regardless of the hardware underneath. Runtime details belong in the
operator's logs, not in a signed result other nodes have to match.

## Wire protocol

Every authenticated call signs a short, domain-separated string, so a signature
harvested from one call can never be replayed against another. Server side these
are [api/nodes/register.js](../../api/nodes/register.js) and
[api/nodes/jobs.js](../../api/nodes/jobs.js).

**Register** (idempotent on `publicKey`):

```
POST {platformUrl}/api/nodes/register
body: { publicKey, label?, capabilities: [{ capability, model }], registeredAt, signature }
  signature = ed25519 over `threews-node-register:{publicKey}:{registeredAt}`
200: { ok: true, node: { id, publicKey, capabilities } }
```

**Claim the next job**:

```
GET {platformUrl}/api/nodes/jobs?node={publicKey}&capability={cap}&ts={ms}&sig={sig}
  sig = ed25519 over `threews-node-poll:{publicKey}:{ts}`
200: { job: null }                                          queue empty
200: { job: { id, capability, model, input, deadlineAt } }
```

**Submit a result**:

```
POST {platformUrl}/api/nodes/jobs/{jobId}/result
body: { node, output, startedAt, finishedAt, receipt }
200: { ok: true, verified: true }
```

**Report a failure** so the platform can requeue or refund:

```
POST {platformUrl}/api/nodes/jobs/{jobId}/result
body: { node, failed: true, error, startedAt, finishedAt, ts, signature }
  signature = ed25519 over `threews-node-fail:{publicKey}:{jobId}:{ts}`
```

The client for all four lives in [src/platform.js](src/platform.js):

```js
import { createPlatformClient } from './src/platform.js';

const client = createPlatformClient({ platformUrl: 'https://three.ws', identity });
await client.register({ label: 'atlas-01', capabilities: [{ capability: 'text-embedding', model: 'Xenova/all-MiniLM-L6-v2' }] });
const job = await client.pollJob({ capability: 'text-embedding' }); // job | null
```

## Receipts

The canonical signed message pre-hashes every variable-length field, so there
is no delimiter or encoding ambiguity:

```
sha256hex(jobId).sha256hex(model).sha256hex(prompt).sha256hex(output).startedAt.finishedAt
```

Sign a result, then verify it offline with nothing but the public key:

```js
import { signResult, verifyResult, verifyReceipt } from './src/signing.js';

const facts = { jobId: 'job-1', model: 'Xenova/all-MiniLM-L6-v2', prompt: 'hello', output, startedAt, finishedAt };
const receipt = await signResult(identity, facts);
// receipt -> { algorithm: 'ed25519', publicKey, payload, signature }

await verifyResult(facts, receipt);          // true: recomputes the payload, then checks the signature
verifyReceipt(receipt, identity.publicKey);  // true: signature only, no recomputation
```

`verifyResult` is the check the platform runs before crediting a job:
recompute the payload from the claimed inputs and reject any receipt whose
payload does not match, which catches a node that signed a different output
than the one it submitted.

## The job loop

[src/loop.js](src/loop.js) is poll, execute, sign, submit, with bounded
concurrency and graceful shutdown. Its failure policy matches the platform's
own workers: a job that throws is reported failed with its error string and the
loop keeps going; transient poll failures back off exponentially and retry,
because a node that gives up on the first network blip earns nothing. Only
SIGINT, SIGTERM, or a fatal registration error stops it.

```js
import { createJobLoop } from './src/loop.js';

const loop = createJobLoop({ client, identity, capability: 'text-embedding', maxConcurrency: 4 });
process.on('SIGTERM', () => loop.stop());
await loop.run();
console.log(loop.stats); // { completed, failed }
```

## Testing

```sh
npm test                      # unit suite
node scripts/e2e-local.mjs    # end-to-end against a local fake platform
```

`createIdentityFromSeed(seed)` in [src/identity.js](src/identity.js) derives a
reproducible keypair from a 32-byte seed, for tests and fixture nodes. Never
use it for a real operator identity: it puts key material in config.

## Related

- [specs/OPEN_INFERENCE_PROTOCOL.md](../../specs/OPEN_INFERENCE_PROTOCOL.md) - the vendor-neutral OIN wire protocol this network is converging on.
- [specs/inference-receipts.md](../../specs/inference-receipts.md) - the receipt format and verification rules.
- [STRUCTURE.md](../../STRUCTURE.md) - where every three.ws surface lives.
