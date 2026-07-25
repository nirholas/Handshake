# vanity-grinder (Rust → WASM)

The Rust source for the WASM module behind the browser-side Solana vanity
address grinder. Compiled with `wasm-pack`, it exposes one `grind` function
that tries a batch of ed25519 keypairs per call and returns `{ secretKey,
publicKey }` on a prefix/suffix match, or `null` when the batch misses.

This is the hot loop only. Everything around it lives in JS:

| Piece | Location |
| --- | --- |
| Compiled WASM + JS glue consumed by the site | [src/solana/vanity/wasm/](../../src/solana/vanity/wasm/) |
| Main-thread grinder API + web-worker pool | [src/solana/vanity/grinder.js](../../src/solana/vanity/grinder.js), [grinder-worker.js](../../src/solana/vanity/grinder-worker.js) |
| Server-side grinding (Cloud Run worker) | [workers/vanity-grinder/](../../workers/vanity-grinder/) |
| Product UI (agent vanity card, /vanity) | [src/agent-vanity-grinder.js](../../src/agent-vanity-grinder.js) |

## Why raw curve25519-dalek

Each candidate needs only `SHA-512(seed) → clamp → scalar·G → compress`: the
ed25519 public-key derivation without constructing ed25519-dalek's full
`SigningKey`. The output is bit-for-bit identical to
`SigningKey::from_bytes(seed).verifying_key().to_bytes()`, and skipping the
struct roughly doubles throughput in WASM.

## Key layout and safety

- The JS caller supplies a fresh cryptographically-random 32-byte `start_seed`
  per batch; the crate only increments the low 4 bytes as a counter, so keys
  are unpredictable as long as the seed source is.
- The returned 64-byte `secretKey` is Solana's standard `[seed][pubkey]`
  layout, directly compatible with `Keypair.fromSecretKey()` in
  `@solana/web3.js`.
- Grinding happens entirely client-side (or on our own worker); a ground
  secret key never leaves the machine that generated it.

## Build

```bash
cargo install wasm-pack   # once
wasm-pack build --release --target web
```

Copy the artifacts from `pkg/` into `src/solana/vanity/wasm/` to update the
module the site ships. The release profile pins `lto = "fat"`, a single
codegen unit, and `wasm-opt -O3 --enable-simd`: keep those; the grinder's
value is throughput.

`publish = false` is intentional: this crate is an internal build input, not a
published library.
