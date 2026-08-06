# Agent Validation Report Format

## Overview

An **agent validation report** is a JSON document that captures the results of testing an agent's GLB model and metadata against a suite of validation rules. Validators (auditors, testing services) generate these reports, answer the agent owner's on-chain request via `validationResponse()`, and end-users browse them to verify trust.

## Schema

```json
{
	"type": "agent-validation-report/0.1",
	"agentId": 1,
	"chainId": 84532,
	"validator": "0x1234567890123456789012345678901234567890",
	"ranAt": "2026-04-17T14:30:00Z",
	"suites": [
		{
			"name": "glb-schema",
			"status": "pass",
			"details": "GLB structure valid, all required chunks present"
		},
		{
			"name": "manifest-integrity",
			"status": "pass",
			"details": null
		},
		{
			"name": "skill-handlers-load",
			"status": "warn",
			"details": "Skill 'sing' references missing dependency @soundfont/npm"
		}
	],
	"verdict": "pass",
	"notes": "Agent passes baseline validation. Minor warnings on external deps."
}
```

## Field Definitions

| Field       | Type              | Required | Notes                                                                        |
| ----------- | ----------------- | -------- | ---------------------------------------------------------------------------- |
| `type`      | string            | ✓        | Always `"agent-validation-report/0.1"`. Versioned for forward compatibility. |
| `agentId`   | number            | ✓        | The agent token ID (from Identity Registry).                                 |
| `chainId`   | number            | ✓        | The blockchain chain ID (e.g., 84532 for Base Sepolia).                      |
| `validator` | string            | ✓        | The Ethereum address of the validator (0x-prefixed hex).                     |
| `ranAt`     | string (ISO 8601) | ✓        | UTC timestamp when tests ran. Format: `YYYY-MM-DDTHH:mm:ssZ`.                |
| `suites`    | array             | ✓        | Array of test suite results (see below).                                     |
| `verdict`   | enum              | ✓        | One of `"pass"`, `"warn"`, `"fail"`. Typically `"fail"` if any suite fails.  |
| `notes`     | string            | ✗        | Human-readable summary or recommendations (up to 500 chars).                 |

## Suite Object

Each suite in the `suites` array represents a category of validation tests:

| Field     | Type           | Required | Notes                                                                                |
| --------- | -------------- | -------- | ------------------------------------------------------------------------------------ |
| `name`    | string         | ✓        | Unique identifier (e.g., `glb-schema`, `manifest-integrity`, `skill-handlers-load`). |
| `status`  | enum           | ✓        | One of `"pass"`, `"warn"`, `"fail"`.                                                 |
| `details` | string \| null | ✗        | Optional failure/warning message (up to 200 chars). Null if passing.                 |

## Validation Rules

- **GLB Schema** (`glb-schema`): Confirms the GLB file structure is valid per glTF 2.0 spec.

    - Fails if: corrupted file, missing required chunks (glTF JSON, bin).
    - Warns if: unsupported extensions, non-standard materials.

- **Manifest Integrity** (`manifest-integrity`): Checks the agent's on-chain metadata JSON.

    - Fails if: `agentId`, `chainId`, or registry address mismatch.
    - Warns if: fields are missing or malformed.

- **Skill Handlers Load** (`skill-handlers-load`): Verifies that all declared skills can initialize.
    - Fails if: skill `handlers.js` has syntax errors or required imports are unavailable.
    - Warns if: optional dependencies are missing but fallbacks exist.

## Example

See [`example-report.json`](./example-report.json) for a complete, valid example.

## Hashing & On-Chain Storage

1. **Client-side hash**: The dashboard computes `keccak256(JSON.stringify(report))` to create the proof hash.
2. **IPFS pinning**: The full report JSON is uploaded to IPFS (via Pinata or `/api/erc8004/pin`).
3. **On-chain record**: The contract stores `(agentId, verdict, proofHash, proofURI, kind)`, where:
    - `proofHash` is the keccak256 hash.
    - `proofURI` is the IPFS URI (e.g., `ipfs://QmXyz...`).

Validators can verify the hash by fetching the report from IPFS and recomputing the hash locally.

## Trust Model

- Only Ethereum-validated wallets can submit validations.
- The `validator` address is recorded on-chain.
- End-users can view all validations for an agent and choose which validators to trust.
- No endorsement or filtering by the three.ws team — raw records from all validators are visible.
