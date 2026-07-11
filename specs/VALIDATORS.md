# Validator Allow-list Policy

The [ValidationRegistry](../contracts/src/ValidationRegistry.sol) only accepts attestations from allow-listed validator addresses. This document describes who is on the list, how attestations are formed, and how the list is changed.

## Why an allow-list

A validation report says "I checked agent #N's model and it is sound." For that statement to carry weight, consumers need to know _who_ signed it. Open writes would let any address claim "verified" status, collapsing the trust signal to zero. Allow-listing keeps the set small, named, and accountable.

## What a validator attests to

A validator runs a deterministic suite over an agent's GLB and metadata, produces an [agent validation report](../public/validation/REPORT_FORMAT.md), pins it to IPFS, and calls `recordValidation(uint256 agentId, bool passed, bytes32 proofHash, string proofURI, string kind)` from an allow-listed address — `proofHash` is the sha256 of the report JSON, `proofURI` points at the pinned report (e.g. `ipfs://…`), and `kind` tags the suite (e.g. `"glb-schema"`).

The minimum suite for "verified" status:

| Suite                | What it checks                                                    |
| -------------------- | ----------------------------------------------------------------- |
| `glb-schema`         | File parses as valid glTF/GLB; all required chunks present.       |
| `gltf-validator`     | Khronos `gltf-validator` reports zero errors (warnings allowed).  |
| `manifest-integrity` | Card `model.sha256` matches the bytes at `model.uri`.             |
| `card-schema`        | Card validates against [three.ws Card v1](3D_AGENT_CARD.md).      |
| `services-reachable` | Each `services[].endpoint` returns 2xx within 5s (informational). |

A `pass` verdict requires zero `fail` suites. `warn` is allowed.

## Current allow-list

Maintained on-chain at the registry's `isValidator` mapping. The canonical mirror lives at:

- **Base mainnet (8453):** [public/.well-known/validators.json](../public/.well-known/validators.json)
- **Base Sepolia (84532):** same file, `testnet` array.

Each entry is `{ address, name, contact, addedAt, scope }`. `scope` is one of `gltf` (default suite only) or `gltf+services` (also runs `services-reachable`).

## Becoming a validator

1. Open a PR adding your entry to [validators.json](../public/.well-known/validators.json) with:
    - Operator name and a contactable email or HTTPS endpoint for disputes.
    - The Ethereum address you will sign from. **Use a dedicated key**, not a personal wallet.
    - A link to your runner's source (so suite determinism is auditable).
2. Run the canonical suite over three reference agents (provided in the PR template) and post the resulting report CIDs in the PR. Maintainers reproduce the runs.
3. On approval, the registry owner calls `addValidator(address)` and the PR is merged.

## Removal

A validator is removed for any of:

- Signing a `pass` for a card whose `model.sha256` does not match the bytes (one strike).
- Signing reports off-policy (e.g. attesting fields outside the suite).
- Unreachable contact for >30 days while a dispute is open.
- Voluntary withdrawal.

Removal is `removeValidator(address)`. Past attestations remain on-chain but consumers SHOULD treat reports from a removed validator as expired from the removal block onward.

## Governance

Until a multisig is in place, the registry owner is the project deployer wallet. Migration to a 3-of-5 Safe on Base is tracked in [SECURITY.md](SECURITY.md).
