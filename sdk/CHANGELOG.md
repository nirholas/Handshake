# Changelog

All notable changes to `@three-ws/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
