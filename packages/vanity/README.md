<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/vanity</h1>

<p align="center"><strong>Mine Solana vanity addresses (custom prefix and/or suffix) locally, zero dependencies, in Node or the browser.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/vanity"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/vanity?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/vanity"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/vanity?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/vanity?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/vanity?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#pricing">Pricing</a> ·
  <a href="https://three.ws/vanity">three.ws</a>
</p>

---

> `@three-ws/vanity` grinds Solana addresses whose Base58 form starts with a
> prefix and/or ends with a suffix of your choosing: `THREE…`, `…pump`, your
> ticker, your handle. The hot loop runs on the platform's native Ed25519
> primitive (Node's `crypto.generateKeyPairSync`, the browser's WebCrypto
> `crypto.subtle`) with zero dependencies, so the package imports everywhere
> a runtime with Ed25519 exists. Keys are generated entirely on your machine
> and **never leave it**. For agents that can't grind locally, the same
> capability is exposed as a paid x402 HTTP endpoint and the `vanity_grinder`
> MCP tool.

## Why

Vanity grinding is embarrassingly parallel keypair generation: make an Ed25519
keypair, Base58-encode the public key, check the prefix/suffix, repeat until a
hit. Keygen dominates the loop, and a single Node thread sustains a couple of
thousand keypairs per second (1,730/s measured on an idle cloud container). A
4-char prefix expects ~11M attempts, which is hours at that rate, so the
difficulty model matters as much as the hot loop: you need to know what a
pattern costs before you start, not after.

`@three-ws/vanity` is that, done once:

- **Native crypto, not JS math.** Keygen runs on the platform's built-in
  Ed25519 (OpenSSL under Node, the browser's WebCrypto), not a JS
  reimplementation, with zero dependencies to install or audit.
- **Difficulty up front.** `expectedAttempts()` and a live ETA tell you whether
  a pattern is seconds or years *before* you commit to a grind.
- **Keys stay local.** The grind happens client-side. No address, no secret key,
  no telemetry is sent anywhere. That is the entire security posture (see below).
- **A paid lane when you can't grind.** Short patterns (≤3 chars) are available
  over x402: pay per call in USDC, get a fresh keypair, no toolchain.

This is the SDK twin of the [3D Studio MCP server](https://three.ws/mcp)'s
`vanity_grinder` tool and the [`/vanity`](https://three.ws/vanity) browser
grinder: the same capability, exposed as plain functions.

## Install

```bash
npm install @three-ws/vanity
```

Zero runtime dependencies. Works in Node 18+ and any browser or runtime with
WebCrypto Ed25519 support. To turn the 64-byte secret key into a usable
wallet, add [`@solana/web3.js`](https://www.npmjs.com/package/@solana/web3.js)
(peer, optional): `Keypair.fromSecretKey(result.secretKey)`.

## Quick start

Grind an address that starts with `THR`:

```js
import { grind } from '@three-ws/vanity';

const { publicKey, secretKey, attempts, durationMs } = await grind({
  prefix: 'THR',
});

console.log(publicKey);  // → THR… (Base58)
console.log(secretKey);  // → Uint8Array(64), Solana's standard keypair layout
```

`secretKey` is the 64-byte Ed25519 layout (`[32-byte seed][32-byte pubkey]`),
ready for `Keypair.fromSecretKey()`:

```js
import { Keypair } from '@solana/web3.js';
const wallet = Keypair.fromSecretKey(secretKey);
```

A fuller run — suffix, case-insensitive, live progress + ETA, cancellable:

```js
import { grind, expectedAttempts } from '@three-ws/vanity';

const controller = new AbortController();
// Quote the SAME options you are about to grind: ignoreCase changes the answer
// (here it divides the case-sensitive 11,316,496 by 16).
console.log('expected attempts:', expectedAttempts({ prefix: 'ag', suffix: 'nt', ignoreCase: true }));

const result = await grind({
  prefix: 'ag',
  suffix: 'nt',
  ignoreCase: true,
  signal: controller.signal,
  onProgress: ({ attempts, rate, eta }) => {
    console.log(`${attempts.toLocaleString()} tried · ${Math.round(rate)}/s · ETA ${eta}`);
  },
});
// later, to bail out:  controller.abort();
```

Pick the **suffix** when you can: the leading characters of a Base58-encoded
32-byte key are not uniformly distributed, so a given prefix can be markedly
harder than `58^n` predicts. Suffix characters are uniform.

## API

### `grind(options) → Promise<GrindResult>`

Grind for a vanity address on the calling thread, yielding to the event loop
between fixed-size batches so aborts land promptly and progress fires on a
wall-clock cadence. Rejects with `AbortError` if `signal` aborts.

| Option | Type | Default | Notes |
|---|---|---|---|
| `prefix` | `string` | none | Base58 prefix the address must start with. |
| `suffix` | `string` | none | Base58 suffix the address must end with. |
| `ignoreCase` | `boolean` | `false` | Case-insensitive match (folds upper+lower Base58 chars). |
| `signal` | `AbortSignal` | none | Cancel the grind. |
| `onProgress` | `(p) => void` | none | Called ~every 250ms with `{ attempts, rate, eta }`. |

At least one of `prefix` / `suffix` is required. Both are validated against the
Base58 alphabet (`0 O I l` excluded) and a 6-char-per-pattern ceiling before any
work starts — an invalid pattern rejects immediately with a specific message.

**Returns** `GrindResult`

| Field | Type | Notes |
|---|---|---|
| `publicKey` | `string` | Base58 address (matches your pattern). |
| `secretKey` | `Uint8Array(64)` | Ed25519 secret key, `Keypair.fromSecretKey()`-compatible. |
| `attempts` | `number` | Total keypairs tried. |
| `durationMs` | `number` | Wall-clock duration. |
| `workers` | `number` | Always `1` on the local path. |

**`onProgress` payload**

| Field | Type | Notes |
|---|---|---|
| `attempts` | `number` | Running total. |
| `rate` | `number` | Keypairs/sec. |
| `eta` | `string` | Expected time to a hit at the current rate: `"~12 seconds"`, `"~3 hours"`, `"unknown"`. The distribution is memoryless, so this does not count down as attempts accumulate. |

### `expectedAttempts({ prefix?, suffix?, ignoreCase? }) → number`

The mean of the geometric distribution — `58^n` adjusted for case-insensitivity
per character. Use it to gate a pattern before grinding (e.g. warn past a
threshold).

### `validatePattern(pattern) → { valid, errors }`

Validate a single prefix or suffix against the Base58 alphabet and length ceiling.
Returns specific, user-facing error strings (e.g. `invalid character 'O'
(uppercase o) — use other uppercase letters`).

### `grindViaApi(options) → Promise<ApiResult>` — the paid lane

For environments that can't grind locally, grind a short pattern over the hosted
[x402](https://x402.org) endpoint instead of locally. Wraps
`GET /api/x402/vanity`. Combined pattern capped at 3 chars; pass an
x402-capable `fetch` to settle the 402 automatically.

| Option | Type | Notes |
|---|---|---|
| `prefix` / `suffix` | `string` | Combined ≤ 3 chars. |
| `ignoreCase` | `boolean` | Case-insensitive match. |
| `format` | `'keypair' \| 'mnemonic'` | `mnemonic` returns an importable BIP-39 phrase (≤ 2 chars, ~100× slower). |
| `strength` | `128 \| 256` | Mnemonic only: 12 or 24 words. |
| `sealTo` | `string` | Optional X25519 public key — the secret is ECIES-sealed to you and the plaintext is omitted from the response. |
| `fetch` | `typeof fetch` | An x402-wrapped fetch (see [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch)). Without one you get a `PaymentRequiredError` carrying the x402 challenge to settle yourself. |
| `baseUrl` | `string` | API origin. Defaults to `THREE_WS_BASE_URL` or `https://three.ws`. |
| `apiKey` | `string` | Sent as `Authorization: Bearer …`. Not required for the x402 lane. |
| `headers` | `Record<string,string>` | Extra request headers. |
| `signal` | `AbortSignal` | Cancel the request. |

Response fields: `address`, `secretKeyBase58`, `secretKey` (64-int array),
`attempts`, `durationMs`, `expectedAttempts`, `network`, `explorerUrl`, and —
for `format=mnemonic` — `mnemonic`, `wordCount`, `derivationPath`.

### `createVanity(options?) → VanityClient`

Bind `fetch` / `baseUrl` / `apiKey` / `headers` once and reuse them across calls,
instead of repeating them on every `grindViaApi()`. Returns `{ grindViaApi }`
with identical semantics.

```js
import { createVanity } from '@three-ws/vanity';
import { wrapFetchWithPayment } from '@three-ws/x402-fetch';

const vanity = createVanity({ fetch: wrapFetchWithPayment(fetch, payer) });
const { address } = await vanity.grindViaApi({ prefix: 'ag' });
```

### Also exported

| Export | What it is |
|---|---|
| `base58Encode(bytes)` | Base58 (Solana address) encoder for a `Uint8Array` / number array. Zero deps. |
| `BASE58_ALPHABET` | The 58-character alphabet (excludes the confusable `0 O I l`). |
| `MAX_PATTERN_LENGTH` | The per-pattern ceiling `validatePattern` and `grind` enforce (`6`). |
| `DEFAULT_BASE_URL` | `https://three.ws` — the origin the hosted lane uses unless overridden. |
| `ThreeWsError` / `PaymentRequiredError` | Typed errors (`code`, `status`, and `accepts` for the x402 challenge). |

## How it works

Two keygen backends, one `grind()` surface. Picked by environment, resolved
once, then the same batched hot loop runs on either.

```
                     grind({ prefix, suffix })
                               |
             +------- Node ----+---- browser/Deno ------+
             v                                          v
  crypto.generateKeyPairSync('ed25519')    crypto.subtle.generateKey('Ed25519')
             |                                          |
             +--------------------+---------------------+
                                  v
        batched loop: keygen -> Base58 encode -> prefix/suffix compare
        (2,000 keys per batch, then yield so aborts + progress land)
                                  |
                                  v
            { publicKey, secretKey, attempts, durationMs, workers: 1 }
```

- **Platform crypto core.** The hot loop (Ed25519 keygen, Base58 encode,
  prefix/suffix compare) uses the runtime's native crypto primitive. Under
  Node that is OpenSSL via `generateKeyPairSync`; in the browser it is
  WebCrypto. No JS big-integer math on the keygen path, no dependencies.
- **Batched and abortable.** The loop checks 2,000 candidates, then yields to
  the event loop, so an `AbortSignal` lands within one batch and `onProgress`
  fires on a ~250ms wall-clock cadence.
- **Single-threaded by design.** The local path runs on the calling thread;
  `GrindResult.workers` is always `1`, and one thread sustains roughly
  1,000-4,000 keypairs per second depending on how busy the host is (1,730/s
  measured idle). For long patterns, run several `grind()` calls in your own
  worker threads or processes if you need parallelism. The hosted x402 endpoint caps patterns at 3 chars because it
  grinds under a server-side wall-clock budget.

## Security

This is the part that matters for a secret-key tool.

- **Keys are generated locally and never transmitted.** In both the browser and
  Node SDK paths, the keypair is produced on your machine by the platform's
  own crypto primitive. No address, no secret key, no prefix is sent to
  three.ws or anywhere else. There is no network call on the local `grind()`
  path.
- **The secret exists once, in memory.** `grind()` resolves with the
  `secretKey`; nothing persists it. Capture it (write the wallet, store it
  encrypted) before the value goes out of scope.
- **The paid lane is fresh-per-request and never stored.** The x402 endpoint
  grinds a brand-new keypair per call and returns it once over TLS; it is never
  written to disk and is stripped from the idempotency cache. Because that
  secret transits the network, prefer `sealTo` (ECIES-seal it to your X25519
  key so the plaintext never appears in the response or any proxy log) — or just
  grind locally.
- **MCP responses can be logged.** The `vanity_grinder` MCP tool returns a real,
  spendable secret in plaintext over the MCP channel, which the host (Claude
  Desktop, Cursor, any proxy) may log. Import it immediately and never reuse a
  secret that may have been logged. For the strongest guarantee, grind locally
  with this SDK.

## Pricing

The local `grind()` path is free and unlimited — it's your CPU. Pricing only
applies to the paid `grindViaApi()` HTTP lane, which is difficulty-tiered
(each Base58 character multiplies expected work by ~58):

| Combined chars | `keypair` | `mnemonic` |
|---|---|---|
| 1 | **$0.01** | **$0.05** |
| 2 | **$0.05** | **$0.50** |
| 3 | **$0.25** | — (capped at 2) |

A [provably-fair lane](https://three.ws/vanity/verify) (`GET
/api/x402/vanity-verifiable`, $0.02–$0.40) grinds under a commit–reveal protocol
and returns a signed receipt you can verify entirely client-side. Settlement
runs only **after** a successful grind, so an exhausted budget costs nothing and
can be retried. Pay per call in USDC on Base or Solana mainnet — no API keys, no
accounts. Pair with [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch)
to automate the 402.

## Errors & edge cases

The local `grind()` path rejects on:

| Condition | Surfaces as |
|---|---|
| No `prefix` and no `suffix` | `Error: prefix or suffix is required` |
| Non-Base58 char (`0 O I l`, etc.) | `Error: invalid prefix: invalid character 'O' …` |
| Pattern longer than 6 chars | `Error: length 7 exceeds maximum of 6` |
| `signal` aborted | `AbortError` (`DOMException`) |
| Runtime without Ed25519 support | `ThreeWsError` (`code: 'no_ed25519'`) naming the required runtimes |

The paid `grindViaApi()` path surfaces the endpoint's HTTP errors:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `validation_error` | 400 | Bad pattern, format, or strength. | Fix the input. |
| `pattern_too_long` | 400 | Combined pattern over the mnemonic cap of 2. (A combined pattern over 3 never leaves the process: the SDK rejects it locally as `invalid_input`.) | Grind locally with `grind()`. |
| `grind_exhausted` | 504 | Time budget elapsed without a hit (rare, <1% at 3 chars). | Retry — you weren't charged. |
| `rate_limited` | 429 | Pre-payment probe rate limit. | Honour `retry-after`. |

Long patterns are designed, not crashed: the server tells you to grind them
locally with `grind()`, where the only cap is the 6-char-per-pattern ceiling.

## Examples

**Node — grind, then write a Solana CLI keypair file:**

```js
import { grind } from '@three-ws/vanity';
import { writeFileSync } from 'node:fs';

const { publicKey, secretKey } = await grind({ suffix: 'pump' });
writeFileSync(`${publicKey}.json`, JSON.stringify(Array.from(secretKey)));
// → solana config set --keypair ./<address>.json
```

**Browser — cancel a long grind from the UI:**

```js
import { grind } from '@three-ws/vanity';

const controller = new AbortController();
const job = grind({ prefix: 'THR', signal: controller.signal, onProgress: render });

document.querySelector('#stop').onclick = () => controller.abort();

const { publicKey, secretKey } = await job; // rejects with AbortError on stop
```

**Agent — the free MCP tool, no toolchain:**

```js
// The same capability ships as the `vanity_grinder` MCP tool on the
// three.ws MCP server. Or call the paid HTTP lane directly:
import { grindViaApi } from '@three-ws/vanity';
import { wrapFetchWithPayment } from '@three-ws/x402-fetch';

const { address, secretKeyBase58 } = await grindViaApi({
  prefix: 'ag',
  fetch: wrapFetchWithPayment(fetch, payer),
});
```

## Related

- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — auto-pay the 402 on the hosted grinder.
- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — text/image → rig-ready 3D GLB, the same SDK pattern.
- [`@three-ws/pumpfun-mcp`](https://www.npmjs.com/package/@three-ws/pumpfun-mcp) — launch a token to a vanity mint you ground here.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
