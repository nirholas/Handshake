# ERC-8004 Validation Attestation

three.ws runs an agent's GLB through the platform's glTF validator and records the
verdict on the ERC-8004 **ValidationRegistry**. This is what makes
`supportedTrust: ["validation"]` in the 3D Agent Card real: the agent carries an
on-chain, independently verifiable proof that its model passed validation.

## The registry is request/response, and that shapes everything

The deployed registry is the ERC-8004 reference `ValidationRegistryUpgradeable`
(the same 0x8004-vanity address family as the Identity Registry). It has no
validator allow-list and no single-call "record". It has two legs:

| Call | Who may send it | What it does |
| ---- | --------------- | ------------ |
| `validationRequest(validator, agentId, requestURI, requestHash)` | the agent's ERC-721 owner, a per-token approved operator, or an operator approved for all | opens a request under an id the caller chooses, addressed to one validator |
| `validationResponse(requestHash, response, responseURI, responseHash, tag)` | only the validator named in that request | answers it with a 0..100 score, a proof hash, and a tag |

Consequences worth knowing before reading the code:

- **A validator cannot attest unilaterally.** The platform validator can only
  answer a request that exists and names it. When it holds no operator authority
  over the agent, the owner has to open the request first.
- **`responseURI` is emitted, never stored.** The pinned report URL cannot be read
  back from registry storage, so the badge takes it from the platform index and
  only trusts it when its hash matches the on-chain `responseHash`.
- **Score, not a boolean.** A glTF check is binary, so we write 100 for a pass and
  0 for a fail and read back through a midpoint threshold
  (`src/erc8004/validation-report.js`).
- **An unanswered request is visible on-chain.** Its `tag` is empty until the
  validator answers, which is how "pending" is distinguished from "no verdict".

## Flow

```
register/bind ──▶ POST /api/erc8004/validate ──▶ api/_lib/validation-attest.js
                                                   │
                  1. fetch GLB (SSRF-guarded)      │  reuses the ONE glTF validator
                  2. sha256 the bytes (byte-check) │  (src/gltf-inspect.js, the same
                  3. inspectModel() -> report      │   code behind /api/x402/model-check)
                  4. find or open the request      │
                  5. pin report JSON -> R2         │
                  6. validationResponse(...) signed▼
                     by VALIDATOR_PRIVATE_KEY ──▶ ValidationRegistry (on-chain)

profile badge ◀── GET /api/erc8004/validation ◀── resolveLatestValidation()
                  (walletless)                     getAgentValidations(agentId)
                                                   + getValidationStatus(hash)
```

Step 4 resolves one of three ways:

1. **A request for the platform validator already exists** (same GLB re-validated,
   or the owner just opened one): answer it. Answering again updates that record
   in place, so re-validation never piles up duplicates.
2. **No request, but the platform validator is the owner or an approved operator**:
   open the request, then answer it. Two transactions, one call.
3. **No request and no authority**: return `409 validation_request_required` with
   the exact call the owner must sign (`registry`, `validatorAddress`, `agentId`,
   `requestURI`, `requestHash`). The badge prompts for it via
   [`src/erc8004/validation-request.js`](../../src/erc8004/validation-request.js),
   then retries `POST /api/erc8004/validate` with that `requestHash` so the
   platform answers it. Registration is never blocked either way.

The `requestHash` is derived, not random:
`keccak256(abi.encode(chainId, agentId, kind, glbSha256))`. The same model always
maps to the same request, and a new model always gets its own.

- **Pass/fail** = zero parse/schema errors. Optimization suggestions are recorded
  as warnings/infos and never fail a model. See
  [`src/erc8004/validation-report.js`](../../src/erc8004/validation-report.js).
- **Byte-check vs schema-check are independent.** A passing schema validation
  never overrides the sha256 byte identity; both are surfaced in the report
  (`byteCheck.sha256` and `issues`).
- **Best-effort.** A validation failure, a missing validator key, an undeployed
  registry, or a missing request never blocks or reverts the registration. The
  agent is registered; it is just unvalidated, and the badge says so.
- **Verifying a proof.** `hashReport()` keccaks the report's compact JSON. Fetch
  the pinned file, `JSON.stringify(JSON.parse(bytes))`, keccak it, and compare
  against the chain's `responseHash`.
- **One dead RPC never blocks an attestation.** The attestor signs against
  `evmFallbackProvider(chainId)` from `api/_lib/evm/rpc.js`, a quorum-1
  fallback over the chain's endpoint list in priority order, so both the reads
  in step 4 and the broadcast in step 6 go through whichever endpoint answers.
  On BSC Testnet that list leads with PublicNode, because the bnbchain data-seed
  nodes refuse every `eth_getLogs` call outright.
- **The `/validation` dashboard resolves `ipfs://` report links through the
  shared gateway list** in `src/ipfs.js` (`resolveURI`), the same rotation the
  rest of the platform uses, rather than one hardcoded gateway.

## Badge states

`src/shared/validation-badge.js` renders five designed states from the on-chain
read: **validated** (green, links to the proof report + validator), **validation
failed** (red, shows the failure reason from the pinned report), **validation
pending** (a request is open, no verdict yet), **not validated** (registry
deployed, nothing requested, and owners get a Validate action), and **pending**
(while fetching / attesting). When the ValidationRegistry is not deployed on the
agent's chain the badge renders nothing.

## Operating the platform validator

The validator is a dedicated EVM key. It is **not** in the repo.

1. **Provision** (already done, address below):
   ```
   node scripts/erc8004/provision-validator-key.mjs
   ```
   Address: `0x93Bc7EfB0059B784465619FC73C2db8D01b1CD04` (provisioned 2026-06-15).
2. **Store the secret**: set `VALIDATOR_PRIVATE_KEY` on the Cloud Run service
   (`three-ws-api`) for production and `.env.local` for local runs. Never commit it.
3. **Fund** the address with gas on each ValidationRegistry chain. It pays for the
   response transaction (and the request too, on agents where it is an operator).
4. **Nothing to allow-list.** The registry has no validator list; authority comes
   from the request. To let the platform attest without prompting the owner, the
   owner approves the validator as an operator on the Identity Registry
   (`approve(validator, agentId)` or `setApprovalForAll(validator, true)`).

Until the key is configured on a chain whose ValidationRegistry is deployed,
`/api/erc8004/validate` returns a clear ops error (`validator_key_not_configured`,
`validation_registry_not_deployed`, or `validation_request_required`), never a
silent skip. **Testnet** (Base Sepolia 84532 and six sibling testnets) has the
registry deployed and is the first end-to-end target; **mainnet** has no reference
deployment yet, so `VALIDATION_REGISTRY_MAINNET` stays empty and the badge renders
nothing there.

Before trusting any address in that table, run:

```
npm run verify:erc8004-validation
```

It follows each configured registry to its implementation, asserts every selector
in `VALIDATION_REGISTRY_ABI` is present in the bytecode, and exercises the reads
the badge depends on. This check exists because "there is bytecode at the address"
was once mistaken for "the address implements our interface": the platform pointed
at the reference registry while calling functions from
`contracts/src/ValidationRegistry.sol`, every call reverted, and the read path
reported the reverts as "no attestation yet".

## Surfaces

| Piece | File |
| ----- | ---- |
| Pure report + score/request-id helpers | `src/erc8004/validation-report.js` |
| Server attestor | `api/_lib/validation-attest.js` |
| Endpoints (`validate` POST, `validation` GET) | `api/erc8004/[action].js` |
| Walletless on-chain read | `api/_lib/onchain.js` -> `resolveLatestValidation` |
| Owner request leg (browser) | `src/erc8004/validation-request.js` |
| Registry address + ABI | `api/_lib/erc8004-chains.js` |
| Interface verifier | `scripts/erc8004/verify-validation-registry.mjs` |
| Badge component | `src/shared/validation-badge.js` |
| Profile render | `src/agent-detail.js` |
| Public dashboard | `src/validation-ui.js`, `/validation` |
| DB cache (list views / ops) | migrations `20260615000000_erc8004_validation.sql`, `20260806120000_erc8004_validation_request_hash.sql` |
