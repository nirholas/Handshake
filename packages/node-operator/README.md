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

The first run downloads `Xenova/all-MiniLM-L6-v2` (~90 MB, Apache-2.0,
quantized ONNX) into `./models` and caches it there. Expect output like:

```
[node] identity 7Xf3...q9Zk (generated, saved to /path/node-identity.json)
[node] platform https://three.ws · capability text-embedding · model Xenova/all-MiniLM-L6-v2
[node] running proof workload self-test (first run downloads the model)...
[node] self-test OK: Xenova/all-MiniLM-L6-v2, 384 dims, 812ms
```

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
| `npm test` | Run the vitest suite. |

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

A minimal `operator.config.json`:

```json
{
  "label": "atlas-01",
  "capability": "text-embedding",
  "maxConcurrency": 4,
  "pollIntervalMs": 3000
}
```

### Docker

A `Dockerfile` ships with the package. Mount a volume at `/app/models` so model
weights survive restarts, and one for the identity file so the node keeps its
key:

```sh
docker build -t three-ws-node .
docker run -d --name three-ws-node \
  -e NODE_LABEL=atlas-01 \
  -e MAX_CONCURRENCY=4 \
  -v three-ws-models:/app/models \
  -v three-ws-identity:/app/identity \
  -e IDENTITY_PATH=/app/identity/node-identity.json \
  three-ws-node
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

const { output, startedAt, finishedAt } = await runJob(
  { id: 'job-1', model: 'Xenova/all-MiniLM-L6-v2', input: { text: 'hello' } },
  { cacheDir: './models' },
);
// output -> { kind: 'text-embedding', model, dimensions: 384, embedding: [...] }

await selfTest({ cacheDir: './models' });
// -> { ok: true, model, dimensions: 384, elapsedMs: 812 }
```

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
