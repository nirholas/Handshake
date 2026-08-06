# Recognized Validator Policy

The deployed ERC-8004 ValidationRegistry has **no on-chain allow-list**. Any address can answer a validation request, but only the request the agent's own owner opened, and only if that request names it. Authority comes from the request, not from a list.

That leaves one question open that the chain does not answer: which validators' verdicts should a consumer believe? This document is that answer for three.ws. It defines the recognized set, how attestations are formed, and how the set changes.

## Why a recognized set

A validation report says "I checked agent #N's model and it is sound." For that statement to carry weight, consumers need to know _who_ signed it. Because the registry accepts any requested validator, the trust signal lives entirely in the reader: three.ws surfaces a verdict as "Validated" when the responder is in the recognized set below, and shows an unrecognized responder's verdict as an unverified third-party attestation.

## What a validator attests to

A validator runs a deterministic suite over an agent's GLB and metadata, produces an [agent validation report](../public/validation/REPORT_FORMAT.md), pins it to IPFS, and answers the agent's open request with `validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)`.

- `requestHash` is the id the owner opened with `validationRequest(validator, agentId, requestURI, requestHash)`. three.ws derives it as `keccak256(abi.encode(chainId, agentId, kind, subjectHash))` so the same subject always maps to the same request.
- `response` is a 0..100 score. A binary suite writes 100 for a pass and 0 for a fail; readers treat 50 and above as a pass.
- `responseHash` is the keccak of the report JSON, `responseURI` points at the pinned report (e.g. `ipfs://...`), and `tag` names the suite (e.g. `"glb-schema"`).

Note that `responseURI` is emitted in the `ValidationResponse` event but not stored, so a consumer recovers the report URL from the event (or a publisher's index) and verifies it against `responseHash`.

The minimum suite for "verified" status:

| Suite                | What it checks                                                    |
| -------------------- | ----------------------------------------------------------------- |
| `glb-schema`         | File parses as valid glTF/GLB; all required chunks present.       |
| `gltf-validator`     | Khronos `gltf-validator` reports zero errors (warnings allowed).  |
| `manifest-integrity` | Card `model.sha256` matches the bytes at `model.uri`.             |
| `card-schema`        | Card validates against [three.ws Card v1](3D_AGENT_CARD.md).      |
| `services-reachable` | Each `services[].endpoint` returns 2xx within 5s (informational). |

A `pass` verdict requires zero `fail` suites. `warn` is allowed.

## Current recognized set

Maintained off-chain, because the registry keeps no list. The canonical file is:

- **Base mainnet (8453):** [public/.well-known/validators.json](../public/.well-known/validators.json)
- **Base Sepolia (84532):** same file, `testnet` array.

Each entry is `{ address, name, contact, addedAt, scope }`. `scope` is one of `gltf` (default suite only) or `gltf+services` (also runs `services-reachable`).

## Becoming a validator

1. Open a PR adding your entry to [validators.json](../public/.well-known/validators.json) with:
    - Operator name and a contactable email or HTTPS endpoint for disputes.
    - The Ethereum address you will sign from. **Use a dedicated key**, not a personal wallet.
    - A link to your runner's source (so suite determinism is auditable).
2. Run the canonical suite over three reference agents (provided in the PR template) and post the resulting report CIDs in the PR. Maintainers reproduce the runs.
3. On approval the PR is merged, which is what makes three.ws recognize your verdicts. No on-chain step is involved: agent owners can already request you, and consumers reading the registry directly decide for themselves.

## Removal

A validator is removed for any of:

- Signing a `pass` for a card whose `model.sha256` does not match the bytes (one strike).
- Signing reports off-policy (e.g. attesting fields outside the suite).
- Unreachable contact for >30 days while a dispute is open.
- Voluntary withdrawal.

Removal is deleting the entry from validators.json (recorded in the commit that removes it). Past attestations remain on-chain, because nothing on-chain can revoke them, but consumers SHOULD treat reports from a removed validator as expired from the removal date onward.

## Governance

The recognized set is changed by commit to this repo, so the governance boundary is repo write access. Migration of platform-owned keys to a 3-of-5 Safe on Base is tracked in [SECURITY.md](SECURITY.md). The platform's own validator key and how it is operated are documented in [docs/erc8004/validation-attestation.md](../docs/erc8004/validation-attestation.md).
