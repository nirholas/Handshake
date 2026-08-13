# Changelog

All notable changes to `@three-ws/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-08-13

### Fixed

- Importing `@three-ws/sdk/permissions` or `@three-ws/sdk/permissions/advanced` no longer fails when the optional peer dependency `viem` is not installed. The ERC-7710 helpers now load `viem` at call time through the shared peer loader (`loadViem`), matching how `ethers` and `@solana/web3.js` are handled; a missing peer surfaces as an actionable install instruction instead of a module-resolution crash. `encodeCaveats()` is now async as a result (internal API; not exported from any package entry point).

### Changed

- README corrections: `register()` needs no manual registry configuration on the 22 chains with built-in canonical ERC-8004 deployments, and per-chain overrides are set via `THREE_WS_REGISTRY_<KIND>_<chainId>` env vars rather than by editing the source table. The license line now matches the actual proprietary LICENSE file.

### Added

- Core-path test suite for `AgentKit` (`test/agent-kit.test.js`): the README quickstart exercised against a real jsdom document, covering mount, open/close, the onMessage roundtrip, `addMessage`, `dispose`, and the three `.well-known` manifests.

## [0.2.0] — 2026-06-12

Packaging metadata release — no API or behavior changes. Public surface is identical to `0.1.0`.

### Changed

- Added `author`, `homepage`, and `repository` fields so the npm listing links back to three.ws and the canonical GitHub repo.
- Normalized `package.json` formatting (one keyword/optional-dependency per line) to match the repo's Prettier config.

## [0.1.0] — 2026-04-14

Initial public release.

### Added

- `AgentKit` — one-call class to ship an ERC-8004 agent (panel + registration + manifests).
- `AgentPanel` — standalone floating chat UI with voice I/O. Bring your own `onMessage` handler.
- ERC-8004 wallet + IPFS + on-chain registration flow via `registerAgent()`.
- `.well-known` manifest generators: `agentRegistration()`, `agentCard()`, `aiPlugin()`.
- Low-level exports: `IDENTITY_REGISTRY_ABI`, `REPUTATION_REGISTRY_ABI`, `VALIDATION_REGISTRY_ABI`, `REGISTRY_DEPLOYMENTS`, `agentRegistryId()`, `buildRegistrationJSON()`, `getIdentityRegistry()`, `connectWallet()`, `pinToIPFS()`.
- TypeScript declarations (`index.d.ts`).
- Standalone `styles.css` under the `.ak-*` namespace (no CSS-variable dependency).
- Runnable example at `example/index.html`.
