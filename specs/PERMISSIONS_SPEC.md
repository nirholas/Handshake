# Permissions Spec v0.1 — ERC-7715 / ERC-7710 Advanced Permissions

## 1. Overview

An **advanced permission** is a scoped, time-bound, revocable on-chain delegation that authorizes an agent's smart account to execute transactions on behalf of its owner — without requiring the owner to sign each transaction individually. Agents registered under ERC-8004 identities (see `AGENT_MANIFEST.md`) need this primitive so skills running inside Claude artifacts, LobeHub plugins, or embed iframes can take on-chain actions autonomously within the limits the owner approved once.

The trust model is: the user signs once (EIP-712, via MetaMask), producing a delegation envelope that encodes the full scope. Smart contracts enforce that scope on every redemption. The agent redeems at will within scope — no further user interaction required. Revocation is an on-chain write; scope plus expiry cap the blast radius of a compromised agent key.

This spec covers ERC-7710 (delegation envelope format and `DelegationManager` interface) as adopted in this project, and ERC-7715 (the `wallet_grantPermissions` JSON-RPC method used to trigger MetaMask's grant UI). EIP references are inline throughout.

---

## 2. Delegation Envelope

A delegation is an ERC-7710 struct. Fields as used in this project:

| Field       | Type       | Description                                                                 |
| ----------- | ---------- | --------------------------------------------------------------------------- |
| `delegate`  | `address`  | Agent's smart account — the party authorized to redeem                      |
| `delegator` | `address`  | Owner wallet — the party granting authority                                 |
| `authority` | `bytes32`  | `0xff...ff` for a root delegation; hash of parent for chained (unused here) |
| `caveats`   | `Caveat[]` | Array of `{ enforcer, terms }` structs encoding scope restrictions          |
| `salt`      | `bytes32`  | Random value for replay protection (combined with `chainId`)                |
| `signature` | `bytes`    | EIP-712 signature over the struct hash, produced by the delegator           |

The signed envelope is pinned to IPFS and stored in the database as `delegation_json` (JSONB). The keccak256 of the EIP-712 struct hash is the `delegation_hash` used as the primary identifier across DB, manifest, and API.

**EIP-712 hashing.** The following fields are included in the struct hash: `delegate`, `delegator`, `authority`, `caveats` (array hash), and `salt`. The domain separator includes `chainId` and the `DelegationManager` contract address, providing chain-binding and contract-binding replay protection.

Reference: [EIP-7710](https://eips.ethereum.org/EIPS/eip-7710). Implementation utilities: [MetaMask Delegation Toolkit](https://docs.metamask.io/delegation-toolkit/) (`@metamask/delegation-toolkit` — verify exact package name and contract addresses in those docs before use).

---

## 3. Scope Vocabulary

Scope is encoded as caveats on the delegation envelope. For off-chain indexing and manifest embedding, scope is also stored as a `scope` JSON object (`{ token, maxAmount, targets[], expiry, period }`). The table below covers all valid scope keys:

| Key         | Type              | Range / Constraints                                     | Caveat mapping                        | Example                         |
| ----------- | ----------------- | ------------------------------------------------------- | ------------------------------------- | ------------------------------- |
| `token`     | `string`          | ERC-20 address (EIP-55 checksummed) or `"native"`       | ERC-20 allowance caveat               | `"0xA0b8...eB48"` or `"native"` |
| `maxAmount` | `string`          | Non-negative integer in base units; `"0"` is disallowed | ERC-20 allowance caveat (spend limit) | `"10000000"` (10 USDC, 6 dec)   |
| `period`    | `string`          | `"daily"` \| `"weekly"` \| `"once"`                     | Period caveat (resets allowance)      | `"daily"`                       |
| `targets`   | `string[]`        | Non-empty; each entry EIP-55 checksummed address        | Target allow-list caveat              | `["0xDef1...1234"]`             |
| `expiry`    | `number`          | Unix seconds (UTC); must be in the future at grant time | Expiry caveat                         | `1775250000`                    |
| `selectors` | `string[]` (opt.) | 4-byte hex selectors; if omitted, all selectors allowed | Selector allow-list caveat (optional) | `["0xa9059cbb"]`                |

**Caveat mapping detail:**

- **ERC-20 allowance caveat** — enforcer checks that the total spend in `calls` does not exceed `maxAmount` for the given `token`. Paired with the period caveat to reset per cycle.
- **Target allow-list caveat** — enforcer rejects any call whose `to` address is not in `targets`.
- **Period caveat** — enforcer tracks cumulative spend within the current period window; resets the counter at the start of each new window.
- **Expiry caveat** — enforcer calls `block.timestamp <= expiry`; reverts if past.
- **Selector caveat** (optional) — enforcer rejects any call whose `data[:4]` is not in `selectors`.

`selectors` is not in the current canonical `scope` JSON shape (see §4). It is noted here for completeness; treat as forward-reserved until the shape is updated.

---

## 4. Manifest Integration

The `permissions` field on `manifest.json` (ERC-7715 / `spec: "erc-7715/0.1"`):

```jsonc
"permissions": {
  "spec": "erc-7715/0.1",
  "delegationManager": "0x...", // DelegationManager address on the target chain
  "delegations": [
    {
      "chainId": 84532,
      "delegator": "0x...", // EIP-55 checksummed
      "delegate": "0x...", // EIP-55 checksummed agent account
      "hash": "0x...", // delegation envelope keccak256
      "uri": "ipfs://bafy...", // pinned envelope (or inline under "envelope")
      "scope": {
        "token": "0x...", // ERC-20 address, or "native"
        "maxAmount": "10000000", // base units, string
        "period": "daily", // daily|weekly|once
        "targets": ["0x..."], // allow-listed contracts
        "expiry": 1775250000 // unix seconds
      }
    }
  ]
}
```

`uri` resolves to the full signed ERC-7710 delegation envelope, pinned on IPFS. The runtime fetches this to obtain the raw envelope before calling `DelegationManager.redeemDelegations(...)`.

For embed contexts where IPFS is not reachable (restricted CSP, offline, iframe sandboxed without external network), `uri` may be omitted and the envelope included inline under `"envelope"` (same shape as the IPFS-pinned JSON). The inline form is validated at grant time; runtimes treat it as equivalent to the fetched form.

---

## 5. API Surface

All endpoints are under `/api/permissions/` (dispatched by [`api/permissions/[action].js`](../api/permissions/[action].js)). Auth, CORS, error shape, and rate-limit conventions follow [api/README.md](../api/README.md).

| Method | Path                        | Body / Query                                                  | Response                             |
| ------ | --------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| POST   | `/api/permissions/grant`    | `{ agentId, chainId, delegation, scope }`                     | `{ ok, id, delegationHash }`         |
| GET    | `/api/permissions/list`     | `?agentId=X` or `?delegator=0x...`                            | `{ ok, delegations: [...] }`         |
| POST   | `/api/permissions/revoke`   | `{ id, txHash }`                                              | `{ ok, status: 'revoked' }`          |
| POST   | `/api/permissions/redeem`   | `{ id, calls: [{to,value,data}] }` (auth: agent bearer token) | `{ ok, txHash, receipt }`            |
| GET    | `/api/permissions/metadata` | `?agentId=X` (public, cached)                                 | `{ ok, delegations: [public view] }` |
| GET    | `/api/permissions/verify`   | `?hash=0x...&chainId=N`                                       | `{ ok, valid, reason? }`             |

All responses follow `{ ok: true, ... }` on success and `{ ok: false, error: '<code>', message: '...' }` on failure, where `error` is one of the canonical codes in §8.

---

## 6. Redemption Flow

Redemption is the path from a skill requesting an on-chain action to a confirmed transaction.

1. **Skill calls `redeemFromSkill`** (`src/runtime/delegation-redeem.js`) with `{ agentId, chainId, calls, skillId }`. The caller is the agent's runtime; no user interaction at this step.
2. **Runtime loads the active delegation** via `getActiveDelegation({ agentId, chainId })` — queries the DB for `status = 'active'` and `expires_at > NOW()`. Returns `null` if none found, surfacing `delegation_not_found`.
3. **Runtime verifies scope** — checks that each call in `calls` targets an address in `scope.targets`, that the aggregate value does not exceed `maxAmount` for the period, and that `expiry` has not passed. Returns `scope_exceeded` or `target_not_allowed` without touching the chain.
4. **Runtime builds the `redeemDelegations(...)` calldata** using the ABI from `src/erc7710/abi.js`. Input: the full signed delegation envelope (fetched from `delegation_json`) plus the `calls` array.
5. **Runtime submits via relayer or the agent's smart account**. If the agent has a server-side signing key (task 09 trust boundary), the runtime signs and broadcasts directly. Otherwise, the call is sent to a relayer endpoint. This step requires: the delegation envelope, the agent's signing key (or relayer credentials), and the target chain RPC.
6. **Transaction lands on-chain.** The `DelegationManager` contract enforces all caveats; if any caveat reverts, the transaction reverts and the error propagates back as `scope_exceeded`.
7. **Runtime returns `{ ok, txHash, receipt }`** to the skill. The DB record is updated: `last_redeemed_at = NOW()`, `redemption_count++`.

---

## 7. Revocation

**On-chain.** The owner calls `DelegationManager.disableDelegation(delegationHash)` (ERC-7710 interface). This is the authoritative revocation; once the transaction is confirmed, no further redemptions succeed.

**Off-chain mirror.** The indexer cron (task 19) polls `DelegationManager` for `DelegationDisabled` events and updates `agent_delegations.status = 'revoked'`, `revoked_at = NOW()`, `tx_hash_revoke = <txHash>` in the DB. Until the indexer processes the event, the DB may still show `active` — this is the race window.

**Race condition.** A redemption submitted before the revoke transaction confirms, but processed concurrently, may succeed on-chain. The on-chain caveats remain the authority: if the revoke confirms first, the redemption reverts. If the redemption confirms first, it is valid. There is no off-chain mechanism to prevent this window — operators should treat `scope + expiry` as the primary blast-radius control, not the race-free revocation guarantee.

**Verify endpoint.** `GET /api/permissions/verify?hash=0x...&chainId=N` performs a real-time on-chain read (`DelegationManager.isDelegationDisabled(hash)`) before returning `{ valid }`, giving callers a fresh view independent of the indexer lag.

---

## 8. Error Codes

All codes are strings, OAuth-style. Returned as `error` in `{ ok: false, error: '<code>', message: '...' }`.

| Code                   | When returned                                                     | Client recovery                                           |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `delegation_expired`   | `expiry` timestamp has passed at time of redemption or verify     | Prompt user to grant a new delegation                     |
| `delegation_revoked`   | DB status is `revoked`, or on-chain `disableDelegation` confirmed | Prompt user to grant a new delegation                     |
| `scope_exceeded`       | Requested calls exceed `maxAmount` or period allowance            | Reduce call value, or prompt user to update scope         |
| `target_not_allowed`   | A `calls[].to` address is not in `scope.targets`                  | Restrict calls to allowed targets, or prompt scope update |
| `delegation_not_found` | No active delegation found for `agentId` + `chainId`              | Prompt user to grant permissions                          |
| `signature_invalid`    | EIP-712 signature verification fails on grant or verify           | Reject the envelope; prompt user to re-sign               |
| `chain_not_supported`  | `chainId` is not in `DELEGATION_MANAGER_DEPLOYMENTS`              | Inform user; only Base Sepolia and Sepolia are supported  |
| `rate_limited`         | Request rate exceeds per-agent or per-IP limit                    | Back off and retry with exponential delay                 |

---

## 9. Versioning

This spec is `permissions/0.1`. Version is advertised in two places:

- **Manifest**: `"permissions": { "spec": "erc-7715/0.1", ... }` — the `spec` string is the delegation format version, not the permissions spec version. These are currently aligned but may diverge if the delegation format changes independently of this spec.
- **Agent manifest**: agents that support advanced permissions must include the `permissions` field in their `manifest.json`. Agents without this field are treated as having no delegations.

Any breaking change to the canonical shapes in §4 or the API surface in §5 bumps the minor version (e.g., `permissions/0.2`). Non-breaking additions (new optional scope keys, new optional response fields) do not require a bump. The `spec` field in the manifest entry is the version agents and runtimes negotiate on.

SDK consumers and embed hosts that read the `permissions` field must check `spec` and reject or warn on unknown versions rather than silently misinterpreting fields.

---

## 10. Security Considerations

**Replay protection.** Each delegation envelope includes a `salt` (random `bytes32`) and the domain separator encodes `chainId` and the `DelegationManager` address. A signed envelope from chain A cannot be replayed on chain B, and a reused salt with the same parameters cannot produce a second valid delegation (the `DelegationManager` tracks disabled delegation hashes).

**Phishing — scope shown in English before approval.** The grant modal (task 10) translates the `scope` object into a human-readable summary (e.g., "Up to 10 USDC per day, to 0xDef1...1234, expiring 2026-07-01") before `wallet_grantPermissions` (EIP-7715) opens the MetaMask prompt. This ensures the user sees the scope in a trusted application context before MetaMask shows the raw EIP-712 data. Never skip this pre-display step.

**Compromised agent key.** If an agent's signing key is exposed, the attacker is limited to: the `targets` in the allow-list, the `maxAmount` per period, and the time window before `expiry`. Set `expiry` to the minimum useful duration. The `revoke` path lets the owner cut off access immediately.

**Relayer trust.** When `POST /api/permissions/redeem` is used instead of direct on-chain submission, the relayer sees the raw calls before broadcasting. The relayer is trusted infrastructure — treat it with the same threat model as the agent's signing key. Scope is still enforced on-chain by the `DelegationManager` even if the relayer is compromised; the attacker cannot exceed the signed caveats. However, a compromised relayer can censor redemptions or front-run them.

**No mainnet defaults.** Contract addresses in `DELEGATION_MANAGER_DEPLOYMENTS` must not include mainnet as a default. Base Sepolia (`84532`) and Sepolia are the supported chains. Mainnet support requires explicit opt-in through the agent owner's settings UI.

**No mock signatures.** All delegations must be real EIP-712 signatures verifiable on-chain. The `signature_invalid` error code is returned for any envelope that fails verification; never store or redeem an unverified envelope.

**No custodial delegator keys.** The delegator (owner) wallet key is never held server-side. The agent's smart account key may be held server-side only as defined in task 09's trust boundary documentation.

---

## See Also

- [AGENT_MANIFEST.md](./AGENT_MANIFEST.md) — manifest format; `permissions` field context
- [EMBED_SPEC.md](./EMBED_SPEC.md) — embed host context; inline envelope for IPFS-restricted environments
- [SKILL_SPEC.md](./SKILL_SPEC.md) — skill handler context; `redeemFromSkill` caller
- [api/README.md](../api/README.md) — shared API conventions (auth, CORS, rate limits, error shape)
- [EIP-7710](https://eips.ethereum.org/EIPS/eip-7710) — delegation envelope format and `DelegationManager` interface
- [EIP-7715](https://eips.ethereum.org/EIPS/eip-7715) — `wallet_grantPermissions` JSON-RPC method
- [MetaMask Delegation Toolkit](https://docs.metamask.io/delegation-toolkit/) — `@metamask/delegation-toolkit` package
