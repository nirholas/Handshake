# crates/

Rust crates compiled to WebAssembly for performance-critical hot loops that JavaScript cannot match. Built with `wasm-pack` via `npm run build:wasm`; the generated WASM artifacts are checked into the repo so the app builds without a Rust toolchain.

| Crate | Description |
| --- | --- |
| [vanity-grinder](vanity-grinder/README.md) | The Rust to WASM hot loop behind the browser-side Solana vanity address grinder: batched ed25519 keypair trials with a raw curve25519-dalek derivation, returning a match or null per batch. |
