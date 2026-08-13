# Generated WASM grinder

This directory contains the wasm-bindgen output of [`/crates/vanity-grinder`](../../../../crates/vanity-grinder).

**Do not edit by hand.** Edit the Rust source at `crates/vanity-grinder/src/lib.rs`,
then regenerate with:

```bash
npm run build:wasm
```

The artifacts are checked into the repo so the app builds without a Rust
toolchain at install time. CI only needs `npm install` + `npm run build`.
This README and the `.gitignore` are rewritten by
[scripts/build-wasm.mjs](../../../../scripts/build-wasm.mjs) after every
build, because wasm-pack would otherwise clobber them.

## Files

- `vanity_grinder.js`: wasm-bindgen glue (default export `init`, named exports `grind`, `initSync`)
- `vanity_grinder_bg.wasm`: the compiled WebAssembly module
- `vanity_grinder.d.ts`: TypeScript declarations
- `vanity_grinder_bg.wasm.d.ts`: low-level wasm imports declarations
- `package.json`: generated package metadata (not published)

## API

```ts
import init, { grind } from './vanity_grinder.js';
import wasmUrl from './vanity_grinder_bg.wasm?url';

await init({ module_or_path: wasmUrl });

const seed = new Uint8Array(32);
crypto.getRandomValues(seed);
const hit = grind(prefix, suffix, ignoreCase, batchSize, seed);
// hit is either null or { secretKey: Uint8Array(64), publicKey: string }
```

The 64-byte `secretKey` is Solana's standard layout
(`[32-byte seed][32-byte public key]`), compatible with
`Keypair.fromSecretKey()` in `@solana/web3.js`.
