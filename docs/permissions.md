# Permissions & Delegation

As agents become more capable — signing blockchain transactions, calling external APIs, spending tokens on behalf of users — the question of *what the agent is allowed to do* becomes critical. Without a permission system, any skill a user installs could make unlimited on-chain actions. There would be no way to limit scope, set an expiry, or revoke access after the fact.

three.ws solves this with **ERC-7710 delegation**: a standard for granting on-chain capabilities to agents with precise, enforceable constraints. Think of it as OAuth scopes, but for blockchain operations — the user signs once, the delegation encodes the full scope, and smart contracts enforce it on every redemption.

---

## How ERC-7710 delegation works

An ERC-7710 delegation is a signed authorization envelope with the following structure:

| Field | Type | Description |
|-------|------|-------------|
| `delegate` | `address` | The agent's smart account — the party authorized to act |
| `delegator` | `address` | The owner wallet — the party granting authority |
| `authority` | `bytes32` | `0xff...ff` for root delegations (non-chained) |
| `caveats` | `Caveat[]` | Array of `{ enforcer, terms }` structs encoding scope constraints |
| `salt` | `bytes32` | Random value for replay protection |
| `signature` | `bytes` | EIP-712 signature over the struct, produced by the delegator |

The user signs the delegation via EIP-712 in MetaMask (triggered by the `wallet_grantPermissions` JSON-RPC call defined in ERC-7715). The signature is **off-chain** — the envelope is stored in the database and pinned to IPFS. When an agent needs to take a scoped action, it submits the envelope to the `DelegationManager` contract, which verifies the signature and enforces every caveat before executing the call.

**The trust model:** the user signs once. Smart contracts enforce that scope on every redemption. The agent acts autonomously within the limits the owner approved — no further user interaction required until the scope needs to change or the delegation expires.

---

## Scope vocabulary

Scope is encoded as caveats on the delegation envelope. For off-chain indexing and manifest embedding, scope is also stored as a JSON object with these fields:

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `token` | `string` | ERC-20 address (EIP-55) or `"native"` | Token the agent may spend |
| `maxAmount` | `string` | Non-negative integer in base units | Per-period spending cap |
| `period` | `string` | `"daily"`, `"weekly"`, `"once"` | When the allowance resets |
| `targets` | `string[]` | EIP-55 checksummed addresses | Contracts the agent may call |
| `expiry` | `number` | Unix seconds, must be in the future | When the delegation expires |

Each scope field maps to a deployed caveat enforcer contract:

- **AllowedTargetsEnforcer** — rejects any call whose `to` address is not in `targets`
- **ERC20TransferAmountEnforcer** — enforces the `maxAmount` spending cap for an ERC-20 token
- **ERC20PeriodTransferEnforcer** — enforces `maxAmount` per `period` (resets the counter each cycle)
- **NativeTokenTransferAmountEnforcer** / **NativeTokenPeriodTransferEnforcer** — same, for native ETH
- **TimestampEnforcer** — enforces `expiry` (`block.timestamp <= expiry`, else reverts)
- **LimitedCallsEnforcer** — caps total number of redemptions

Enforcer addresses are deterministic (CREATE2, from `@metamask/delegation-deployments v1.2.0`) and available in [src/erc7710/abi.js](../src/erc7710/abi.js) as `CAVEAT_ENFORCERS`.

---

## Granting permissions

### Via the grant modal (UI)

When a skill or agent action requires a delegation that doesn't yet exist, the grant modal appears. It is a 3-step flow:

1. **Scope builder** — the user selects token, spend limit, period, target contracts, and expiry. Common contracts (e.g., Uniswap V3 Router) are offered by name.
2. **Plain-English review** — the modal translates the scope into a human-readable summary (e.g., "Up to 10 USDC per day, to Uniswap V3 Router, expiring 2026-07-01") before opening the MetaMask prompt. This step must never be skipped — it gives the user a trusted-context preview before the raw EIP-712 data appears in MetaMask.
3. **EIP-712 sign** — MetaMask opens the `wallet_grantPermissions` prompt; the user approves; the signed delegation is stored and pinned.

### Programmatically

Use `encodeScopedDelegation` and `signDelegation` from `@three-ws/sdk/permissions` (or directly from [src/permissions/toolkit.js](../src/permissions/toolkit.js)):

```js
import { encodeScopedDelegation, signDelegation } from '@three-ws/sdk/permissions';
import { CAVEAT_ENFORCERS } from '@three-ws/sdk/erc7710';
import { AbiCoder } from 'ethers';

const CHAIN_ID = 84532; // Base Sepolia

// Build the unsigned envelope with your caveats
const delegation = encodeScopedDelegation({
  delegator: '0xOwnerWallet...',
  delegate:  '0xAgentAccount...',
  chainId:   CHAIN_ID,
  expiry:    Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // 7 days
  caveats: [
    {
      // Only allow calls to a specific contract
      enforcer: CAVEAT_ENFORCERS.AllowedTargetsEnforcer[CHAIN_ID],
      terms: '0x' + targetAddress.slice(2).toLowerCase().padStart(64, '0'),
    },
    {
      // Cap at 10 USDC per period
      enforcer: CAVEAT_ENFORCERS.ERC20PeriodTransferEnforcer[CHAIN_ID],
      terms: AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256'],
        [usdcAddress, 10_000_000n], // 10 USDC (6 decimals)
      ),
    },
  ],
});

// Sign with the delegator's wallet (ethers v6 signer)
const signed = await signDelegation(delegation, signer);
// signed.signature — the EIP-712 bytes
// signed.hash      — keccak256 of the struct (safe to log; never log the signature)
```

Then store the signed delegation via `POST /api/permissions/grant`:

```js
const res = await fetch('/api/permissions/grant', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agentId:    '<uuid>',
    chainId:    CHAIN_ID,
    delegation: signed,
    scope: {
      token:     '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
      maxAmount: '10000000',
      period:    'daily',
      targets:   ['0xTargetContract...'],
      expiry:    signed.expiry,
    },
  }),
});
// → { ok: true, id: 'delegation-uuid', delegationHash: '0x...' }
```

---

## Redeeming a delegation (inside a skill)

Skills call `redeemFromSkill` from [src/runtime/delegation-redeem.js](../src/runtime/delegation-redeem.js). This is the main entrypoint for any on-chain action a skill needs to take:

```js
import { redeemFromSkill } from '@three-ws/sdk/runtime';

// Inside a skill handler:
export async function execute_swap({ tokenIn, tokenOut, amount }, ctx) {
  const result = await redeemFromSkill({
    agentId:  ctx.agentId,
    chainId:  84532,
    skillId:  'my-swap-skill',
    mode:     'auto', // 'client' | 'relayer' | 'auto'
    calls: [{
      to:    '0xSwapRouter...',
      value: 0n,
      data:  encodeSwapCall(tokenIn, tokenOut, amount),
    }],
  });

  if (!result.ok) {
    return { ok: false, error: result.code, message: result.message };
  }
  return { ok: true, txHash: result.txHash };
}
```

`redeemFromSkill` handles the full lifecycle:

1. **Rate check** — enforces a hard client-side limit of 5 redemptions per minute per tab. Exceeding it returns `{ ok: false, code: 'rate_limited' }` without any network call.
2. **Delegation lookup** — fetches the active delegation for `agentId + chainId` from `/api/permissions/metadata` with a 60-second in-memory cache. Returns `delegation_not_found` if none.
3. **Scope pre-flight** — validates that every call in `calls` targets an address in `scope.targets` and that no call value exceeds `scope.maxAmount`. This runs off-chain before touching the chain, preventing wasted gas on obvious scope violations.
4. **Mode resolution** — in `auto` mode, picks `client` if `window.ethereum` is available and the signed delegation is present, or `relayer` if a bearer token is configured in `window.__AGENT_RUNTIME_CONFIG__`.
5. **Submission** — `client` mode connects the wallet and calls `DelegationManager.redeemDelegations()` directly; `relayer` mode POSTs to `/api/permissions/redeem` with a bearer token.
6. **Protocol events** — emits `PERMISSIONS_REDEEM_START`, `PERMISSIONS_REDEEM_SUCCESS`, or `PERMISSIONS_REDEEM_ERROR` on the agent protocol bus for observability.

To monitor redemption events:

```js
import { subscribeRedeemEvents } from '@three-ws/sdk/runtime';

const unsubscribe = subscribeRedeemEvents((event) => {
  console.log(event.type, event.payload);
});
// Later: unsubscribe()
```

---

## Revoking permissions

### Via the manage panel (UI)

Mount the panel for an agent:

```js
import { mountManagePanel } from '@three-ws/sdk/permissions';

const { unmount } = mountManagePanel({
  container: document.getElementById('permissions-container'),
  agentId: '<uuid>',
});
```

The panel lists all active delegations with scope summaries, expiry dates, and revoke buttons. Revoking calls `DelegationManager.disableDelegation()` on-chain (via MetaMask) and then mirrors the status to the server.

### Programmatically

Revoking has two parts: the on-chain transaction and the server-side mirror.

```js
import { Contract, BrowserProvider } from 'ethers';
import { DELEGATION_MANAGER_DEPLOYMENTS, DELEGATION_MANAGER_ABI } from '@three-ws/sdk/erc7710';

// 1. Submit disableDelegation on-chain
const provider = new BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const dm = new Contract(
  DELEGATION_MANAGER_DEPLOYMENTS[84532],
  DELEGATION_MANAGER_ABI,
  signer,
);
const tx = await dm.disableDelegation(delegationTuple);
const receipt = await tx.wait();

// 2. Mirror to the server
await fetch('/api/permissions/revoke', {
  method: 'POST',
  body: JSON.stringify({ id: 'delegation-uuid', txHash: receipt.hash }),
});
```

**Revocation is authoritative on-chain.** The database mirrors state via an indexer that polls `DelegationDisabled` events, but there is a brief race window between the on-chain confirmation and the indexer catching up. During this window the database may still show the delegation as `active`. For a real-time view, use `GET /api/permissions/verify?hash=0x...&chainId=N` which reads `disabledDelegations()` directly from the chain.

---

## The permissions API

All routes are under `/api/permissions/`. Responses use `{ ok: true, ... }` on success and `{ ok: false, error: '<code>', message: '...' }` on failure.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/permissions/grant` | Session cookie | Store a signed delegation + scope |
| `GET` | `/api/permissions/list` | Session cookie | List delegations (`?agentId=X&status=active`) |
| `POST` | `/api/permissions/revoke` | Session cookie | Mirror on-chain revocation to DB |
| `POST` | `/api/permissions/redeem` | Agent bearer token | Server-side redemption via relayer |
| `GET` | `/api/permissions/metadata` | Public (cached) | Public scope view for a given `agentId` |
| `GET` | `/api/permissions/verify` | Public | Real-time on-chain validity check (`?hash=0x...&chainId=N`) |

The `metadata` endpoint returns `{ ok, spec: "erc-7715/0.1", delegations: [...] }` with `Cache-Control: public` and `Access-Control-Allow-Origin: *` — it is safe to call from embed iframes.

---

## The DelegationManager contract

All delegation enforcement runs through the `DelegationManager` contract, deployed at the same address on all supported chains via CREATE2:

```
0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
```

**Supported chains:** Ethereum mainnet (1), Base mainnet (8453), Base Sepolia (84532), Sepolia (11155111), Arbitrum Sepolia (421614), Optimism Sepolia (11155420).

Key contract functions:

```solidity
// Redeem one or more delegations to execute calls
function redeemDelegations(
  bytes[] _permissionContexts,
  bytes32[] _modes,
  bytes[] _executionCallDatas
) external;

// Revoke — caller must be the delegator
function disableDelegation(Delegation _delegation) external;

// Read-only: check if a delegation hash has been revoked
function disabledDelegations(bytes32 delegationHash) external view returns (bool);
```

ABIs and all caveat enforcer addresses are in [src/erc7710/abi.js](../src/erc7710/abi.js).

---

## Skill trust modes

The skill registry applies trust rules when installing skills:

| Mode | Who can install |
|------|----------------|
| `any` | Any skill from any URL |
| `owned-only` | Only skills whose `manifest.json` `author` field matches the agent owner's wallet address |
| `whitelist` | Only skills on an explicit allow-list |

Skills installed from unverified URLs in `any` mode must still explicitly declare the permissions they need in their manifest, and the delegation must be granted by the user before those permissions can be exercised. Installing a skill does not automatically grant it any delegation.

### Declaring permissions in skill manifests

If your skill redeems delegations or calls `redeemFromSkill`, declare this in `manifest.json`:

```json
{
  "spec": "skill/0.1",
  "name": "dca-trader",
  "version": "0.1.0",
  "permissions": {
    "requires_delegation": true,
    "scope_hint": {
      "token": "native",
      "period": "daily",
      "targets": ["0xExpectedContract..."]
    }
  },
  "tools": [...]
}
```

The skill registry uses this declaration to show users what a skill needs before they install it, and to pre-populate the grant modal with the suggested scope.

---

## Error codes

All error codes are OAuth-style strings returned as `error` in the `{ ok: false, error, message }` response shape:

| Code | When | Recovery |
|------|------|----------|
| `delegation_expired` | `expiry` has passed at redemption time | Prompt user to grant a new delegation |
| `delegation_revoked` | `disableDelegation` confirmed on-chain, or DB status is `revoked` | Prompt user to grant a new delegation |
| `scope_exceeded` | Call value exceeds `maxAmount` or period allowance | Reduce call value or prompt scope update |
| `target_not_allowed` | A call target is not in `scope.targets` | Restrict targets or prompt scope update |
| `delegation_not_found` | No active delegation for `agentId + chainId` | Prompt user to grant permissions |
| `signature_invalid` | EIP-712 signature verification fails | Reject the envelope; prompt user to re-sign |
| `chain_not_supported` | `chainId` has no `DelegationManager` deployment | Inform user; use a supported chain |
| `rate_limited` | Exceeded 5 redemptions per minute per tab | Back off and retry |
| `no_redemption_path` | No wallet connected and no relayer token | Connect wallet or configure relayer |

---

## Security model

**What the delegation enforces:**
- Spending limits per token per period (`maxAmount`, `period`)
- Allowed call targets (`targets`) — an agent cannot call contracts outside the approved list even if it tries
- Hard expiry (`expiry`) — enforced on-chain by `block.timestamp`; no server-side clock drift matters
- Replay protection — each delegation has a random 32-byte `salt` and a domain separator bound to `chainId` and the `DelegationManager` address; a delegation from Base cannot be replayed on Ethereum

**Blast radius of a compromised agent key:**
If an agent's signing key is exposed, an attacker is limited to: the contracts in `targets`, the `maxAmount` per period, and the time window before `expiry`. Revoke immediately via `DelegationManager.disableDelegation()` — this is enforceable on-chain regardless of what the server knows.

**Relayer trust:**
When `POST /api/permissions/redeem` is used instead of direct wallet submission, the relayer sees the raw calls before broadcasting. Scope is still enforced on-chain by the `DelegationManager` even if the relayer is compromised — an attacker cannot exceed the signed caveats. However, a compromised relayer can censor redemptions or front-run them. Treat the relayer with the same trust level as the agent's signing key.

**No mainnet defaults:**
The grant modal and toolkit require the user to explicitly choose a chain. Mainnet support requires explicit opt-in through the agent owner's settings. Base Sepolia (84532) and Sepolia (11155111) are the default test chains.

**No custodial delegator keys:**
The delegator (owner) wallet key is never held server-side. The agent's smart account key may be held server-side only as defined in the agent trust boundary documentation (task 09). Never store or redeem a delegation whose EIP-712 signature has not been verified — `signature_invalid` is the correct error for any unverified envelope.

---

## Smoke testing

The smoke test script at [scripts/smoke-permissions.js](../scripts/smoke-permissions.js) exercises the full delegation lifecycle against a deployed environment: encoding, EIP-712 signing, grant API, list API, verify API, on-chain revocation, and negative cases. Run it against a staging deployment before releasing permission-related changes:

```sh
SMOKE_BASE_URL=https://your-app.vercel.app \
SMOKE_AGENT_ID=<uuid> \
SMOKE_CHAIN_ID=84532 \
SMOKE_DELEGATOR_KEY=0x<testnet-private-key> \
SMOKE_SESSION_COOKIE=<session> \
node scripts/smoke-permissions.js
```

Set `SMOKE_SKIP_REVOKE=1` to skip the on-chain revocation step if the test wallet has no testnet ETH.

---

## See also

- [Architecture Overview](./architecture.md)
- [Agent System](./agent-system.md)
- [ERC-8004 Blockchain Identity](./erc8004.md)
- [Skill System](./skills.md)
- [EIP-7710](https://eips.ethereum.org/EIPS/eip-7710) — delegation envelope format
- [EIP-7715](https://eips.ethereum.org/EIPS/eip-7715) — `wallet_grantPermissions` JSON-RPC method
- [MetaMask Delegation Toolkit](https://docs.metamask.io/delegation-toolkit/)
