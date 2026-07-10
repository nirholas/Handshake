# ERC-8004 Validation Attestation

When an agent is registered (or re-validated) on-chain, three.ws automatically
runs its GLB through the platform's glTF validator and records a signed
validation attestation on the ERC-8004 **ValidationRegistry**. This is what makes
`supportedTrust: ["validation"]` in the 3D Agent Card real — the agent carries an
on-chain, independently-verifiable proof that its model passed validation.

## Flow

```
register/bind ──▶ POST /api/erc8004/validate ──▶ api/_lib/validation-attest.js
                                                   │
                  1. fetch GLB (SSRF-guarded)      │  reuses the ONE glTF validator
                  2. sha256 the bytes (byte-check) │  (src/gltf-inspect.js, the same
                  3. inspectModel() → report       │   code behind /api/x402/model-check)
                  4. pin report JSON → R2          │
                  5. recordValidation(...) signed  ▼
                     by VALIDATOR_PRIVATE_KEY ──▶ ValidationRegistry (on-chain)

profile badge ◀── GET /api/erc8004/validation ◀── resolveLatestValidation()
                  (walletless)                     getLatestByKind(agentId,"glb-schema")
```

- **Pass/fail** = zero parse/schema errors. Optimization suggestions are recorded
  as warnings/infos and never fail a model. See
  [`src/erc8004/validation-report.js`](../../src/erc8004/validation-report.js).
- **Byte-check vs schema-check are independent.** A passing schema validation
  never overrides the sha256 byte identity — both are surfaced in the report
  (`byteCheck.sha256` and `issues`).
- **Best-effort.** A validation failure, a missing validator key, an undeployed
  registry, or a non-allow-listed validator never blocks or reverts the
  registration. The agent is registered; it's just unvalidated, and the badge
  says so.
- **Re-runnable.** Re-validating after a GLB update records a fresh attestation;
  `getLatestByKind` (and the badge) reflect the latest.

## Badge states

`src/shared/validation-badge.js` renders four designed states from the on-chain
read: **validated** (green ✓, links to the proof report + validator), **validation
failed** (red, shows the failure reason from the pinned report), **not validated**
(registry deployed, no attestation yet — owners get a Validate action), and
**pending** (while fetching / attesting). When the ValidationRegistry isn't
deployed on the agent's chain the badge renders nothing.

## Operating the platform validator

The validator is a dedicated EVM key. It is **not** in the repo.

1. **Provision** (already done — address below):
   ```
   node scripts/erc8004/provision-validator-key.mjs
   ```
   Address: `0x93Bc7EfB0059B784465619FC73C2db8D01b1CD04` (provisioned 2026-06-15).
2. **Store the secret**: set `VALIDATOR_PRIVATE_KEY` on the Cloud Run service
   (`three-ws-api`) for production and `.env.local` for local runs. Never commit it.
3. **Fund** the address with gas on each ValidationRegistry chain.
4. **Allow-list** it on each chain as the registry owner (run as the
   ValidationRegistry deployer):
   ```
   cast send <ValidationRegistry> "addValidator(address)" \
     0x93Bc7EfB0059B784465619FC73C2db8D01b1CD04 --rpc-url <chain>
   ```

Until the key is configured **and** allow-listed on a chain whose
ValidationRegistry is deployed, `/api/erc8004/validate` returns a clear ops error
(`validator_key_not_configured`, `validation_registry_not_deployed`, or
`validator_not_allowlisted`) — never a silent skip. **Testnet** (Base Sepolia
84532) already has a deployed registry, so it's the first end-to-end target;
**mainnet** activates automatically once task 01 fills the mainnet address in
`api/_lib/erc8004-chains.js`, `src/erc8004/abi.js`, and `sdk/src/erc8004/abi.js`.

## Surfaces

| Piece | File |
| ----- | ---- |
| Pure report (hash, pass/fail, build) | `src/erc8004/validation-report.js` |
| Server attestor | `api/_lib/validation-attest.js` |
| Endpoints (`validate` POST, `validation` GET) | `api/erc8004/[action].js` |
| Walletless on-chain read | `api/_lib/onchain.js` → `resolveLatestValidation` |
| Registry address + ABI | `api/_lib/erc8004-chains.js` |
| Badge component | `src/shared/validation-badge.js` |
| Profile render | `src/agent-detail.js` |
| DB cache (list views / ops) | migration `20260615000000_erc8004_validation.sql` |
