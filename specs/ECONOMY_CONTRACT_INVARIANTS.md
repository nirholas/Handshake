# Economy Contract Invariants v1

Scope: every on-chain contract in [`contracts/`](../contracts) that carries value,
records economic state, or gates access. This document is the contract-side
counterpart to [`SECURITY.md`](./SECURITY.md): where that file enumerates abuse
vectors against agent *registration*, this one states the properties the
*contracts* must hold at all times, in a form an auditor or a fuzzer can check.

Read this together with:

- [`contracts/README.md`](../contracts/README.md) - what each registry is, plus the build and test commands a reviewer runs first.
- [`contracts/DEPLOYMENTS.md`](../contracts/DEPLOYMENTS.md) - the deploy-status table: which bytecode is live, at which address, on which chains, and how each address is verified.
- [`SECURITY.md`](./SECURITY.md) - the abuse vectors against agent registration that sit upstream of these contracts.

- [`ECONOMY_CONTRACT_THREAT_MODEL.md`](./ECONOMY_CONTRACT_THREAT_MODEL.md) - the attacker's-eye companion: assets, actors, and the failure mode each invariant exists to stop.
- [`contracts/AUDIT-README.md`](../contracts/AUDIT-README.md) - the entry point for a review engagement, with the commands that reproduce every coverage and static-analysis number quoted anywhere in this pack.

## How to read an invariant

Every invariant has a stable id (`REP-3`, `AP-7`, ...). The id is permanent: if
an invariant is retired, its id is retired with it and never reused, so an audit
report that cites `AP-7` still resolves years later.

Each invariant is stated as a property that must hold for **all** reachable
states and **all** callers, not as a description of the happy path. Each one is
covered by at least one positive test (the property holds when it should) and at
least one negative test (the property is enforced against a caller who tries to
break it). The test that proves an invariant names its id in a comment, so
`grep -rn "AP-7" contracts/test` finds the proof for a Solidity contract and
`grep -rn "SL-3" contracts/program-tests` finds it for a Solana program. The
Solana proofs run the real compiled bytecode in LiteSVM, not a stub; see
[`contracts/program-tests/README.md`](../contracts/program-tests/README.md).

Invariants marked **[deployed]** govern bytecode that is already live on a public
chain (see the deploy-status table in [`contracts/DEPLOYMENTS.md`](../contracts/DEPLOYMENTS.md)). Those are the
ones where a violation is an incident rather than a bug.

---

## IdentityRegistry (`ID-*`)

[`contracts/src/IdentityRegistry.sol`](../contracts/src/IdentityRegistry.sol).
ERC-721 agent identity, EIP-712 wallet delegation, per-agent ETH balances, and
spend delegation. This is the delegation contract of the economy set: it decides
who may act, and spend, on behalf of an agent.

| Id | Invariant |
|---|---|
| ID-1 | Agent ids are assigned strictly increasing from 1 and are never reused. `isAgent(id)` is true exactly for ids that have been minted and not burned. |
| ID-2 | Only the current NFT owner may call `setAgentURI`, `setMetadata`, `unsetAgentWallet`, `setSpendAllowance`, or `withdraw` for that agent. Ownership transfer of the NFT transfers all of those rights atomically. |
| ID-3 | `setAgentWallet` accepts a signature only if it is an unexpired EIP-712 signature by the *current* NFT owner over `(agentId, newWallet, nonce, deadline)` with `nonce == nonces[owner]`. Every accepted signature increments that nonce, so a signature is single-use and cannot be replayed. |
| ID-4 | `getAgentWallet` returns the bound delegate if one is set and the NFT owner otherwise. It never returns the zero address for a live agent. |
| ID-5 | ETH can enter the contract only through `deposit(agentId)`. Bare transfers revert (`receive` and `fallback` both revert), so no ETH is ever held without an owning agent. |
| ID-6 | Conservation: the contract's ETH balance is greater than or equal to the sum of `agentBalance` over all agents, at every point outside a call frame. |
| ID-7 | `spend` debits the caller's allowance and the agent's balance by exactly the same amount, and reverts if either would go negative. An allowance is therefore a ceiling, not a mint. |
| ID-8 | Agent balances are isolated: a spender authorized on agent A can never move ETH accounted to agent B, whatever the allowance on A. |
| ID-9 | If the ETH transfer inside `withdraw` or `spend` fails, the whole call reverts and no accounting change survives. Balances and allowances never drift from the real ETH held. |
| ID-10 | `withdraw` and `spend` are non-reentrant: a recipient that calls back into the contract during its payout cannot obtain a second payout from the same balance. |
| ID-11 | `withdraw` and `spend` reject the zero address as recipient, so ETH accounted to an agent is never burned by a mistyped call. |

## ReputationRegistry (`REP-*`)

[`contracts/src/ReputationRegistry.sol`](../contracts/src/ReputationRegistry.sol).
One review per reviewer per agent, optionally backed by an ETH stake. This is
the reputation contract of the economy set.

| Id | Invariant |
|---|---|
| REP-1 | One review per `(agentId, reviewer)` across *both* entry points. Having called `submitFeedback` blocks a later `stakeReputation` by the same address on the same agent, and the reverse. |
| REP-2 | Score range is enforced per entry point: `submitFeedback` accepts `[-100, 100]`, `stakeReputation` accepts `[1, 5]`. Anything outside reverts. |
| REP-3 | An agent's own NFT owner can never review it, through either entry point. |
| REP-4 | Feedback can only be recorded against an agent that exists in the Identity Registry. |
| REP-5 | The aggregate is updated exactly once per accepted review: `count` equals the number of stored feedback entries, and `sum` equals the sum of their scores. `getReputation` returns `(0, 0)` for an agent with no reviews and `sum * 100 / count` otherwise. |
| REP-6 | Stake conservation: for every agent, `getTotalStake(agentId)` equals the sum of `stakeOf[agentId][staker]` over all stakers, and the contract's ETH balance is greater than or equal to the sum of `getTotalStake` over all agents. |
| REP-7 | A staker can reclaim only their own stake, and only once: `withdrawStake` pays exactly `stakeOf[agentId][msg.sender]`, zeroes it, and reverts on a second call. One staker's withdrawal never reduces another staker's balance. |
| REP-8 | Withdrawing a stake does not retract the review: the feedback entry, the aggregate, and the `hasReviewed` flag all survive, so stake is refundable but reputation is not rentable. |
| REP-9 | `stakeReputation` requires at least 0.001 ETH. A payment below the floor reverts and records nothing. |
| REP-10 | `withdrawStake` is non-reentrant, and a refund that fails reverts the whole call, so a staker's recorded balance always matches the ETH they can actually take out. |

## AgentPayments (`AP-*`)

[`contracts/src/AgentPayments.sol`](../contracts/src/AgentPayments.sol).
Per-agent-token payment engine: payments in, split into an authority share and a
buyback share, buyback swaps to the agent token and burns it. This is the royalty
contract of the economy set (the EVM port of the Solana `pump_agent_payments`
program).

| Id | Invariant |
|---|---|
| AP-1 | An agent token can be registered once. Registration is restricted to the protocol owner or to the agent authority registering itself, so a third party cannot front-run a registration with a foreign authority. |
| AP-2 | `buybackBps` is at most `BPS_DENOMINATOR` (10000) at creation and after every update. |
| AP-3 | Invoice ids are deterministic and single-use: `computeInvoiceId` is a pure function of `(agentToken, currencyToken, amount, memo, startTime, endTime)` matching the SDK's off-chain derivation byte for byte, and a settled id can never settle again. |
| AP-4 | The invoice window is enforced on both bounds, with `0` meaning "unbounded" on that side. A payment outside the window reverts and credits nothing. |
| AP-5 | An ERC-20 payment credits the amount that actually arrived (balance difference), never the requested amount, so a fee-on-transfer currency cannot credit more than it paid. |
| AP-6 | The native sentinel and the zero address are rejected as an ERC-20 currency, so native accounting can only be reached through `acceptPaymentNative`. |
| AP-7 | Conservation, per `(agentToken, currencyToken)`: `paymentVault + buybackVault + withdrawVault + totalWithdrawn + totalBuybacks == totalPayments`. Value is only ever moved between the three vaults and out through withdraw or buyback; it is never created. |
| AP-8 | `distributePayments` is lossless: it drains `paymentVault` to zero and adds `amount * bps / 10000` to the buyback vault and the exact remainder to the withdraw vault. No dust is stranded or double-counted, and it is permissionless to crank. |
| AP-9 | `buybackTrigger` is restricted to the protocol owner, accepts only an allow-listed router, and rejects a router equal to the currency or agent token, so the payer allowances this contract holds can never be redirected. It spends the entire buyback vault, burns everything the swap returned, and reverts if the swap returned nothing. |
| AP-10 | The ERC-20 approval granted to a router is set for the swap and reset to zero in the same call, so no standing allowance survives a buyback. |
| AP-11 | `withdraw` is restricted to the agent's authority, rejects a zero receiver, and pays exactly the withdraw vault, zeroing it. |
| AP-12 | Authority transfer is restricted to the current authority and rejects the zero address, so an agent can never become unmanageable. |
| AP-13 | `acceptPayment`, `acceptPaymentNative`, `buybackTrigger`, and `withdraw` are non-reentrant. |

## ValidationRegistry (`VR-*`)

[`contracts/src/ValidationRegistry.sol`](../contracts/src/ValidationRegistry.sol).
Allow-listed validators attest to off-chain proofs. It holds no value, but it
gates the attestations other surfaces trust. Policy for who is allow-listed lives
in [`VALIDATORS.md`](./VALIDATORS.md).

| Id | Invariant |
|---|---|
| VR-1 | Only an address currently on the allow-list may record a validation. Removal takes effect immediately. |
| VR-2 | Only the owner may add or remove validators or transfer ownership, and ownership can never be transferred to the zero address (which would freeze the allow-list forever). |
| VR-3 | Validations are append-only. Nothing in the contract can mutate or delete a recorded validation, so an attestation history cannot be rewritten. |
| VR-4 | `getLatestByKind` returns the most recent record for that exact kind string and reverts when no record of that kind exists. Different kinds never shadow each other. |
| VR-5 | Validations can only be recorded against an agent that exists in the Identity Registry. |
| VR-6 | `getValidationRange` clamps to the stored length and returns an empty array for an out-of-range offset, so a paginating reader can never revert on a large limit. |

## GreenfieldVault (`GV-*`)

[`contracts/src/GreenfieldVault.sol`](../contracts/src/GreenfieldVault.sol).
Pay-to-unlock marketplace that grants a BNB Greenfield read permission
cross-chain on payment. The wire format for the objects it sells is
[`vault-manifest.md`](./vault-manifest.md).

| Id | Invariant |
|---|---|
| GV-1 | Only the seller may list, re-price, or delist their own object, and listing requires a live `ROLE_CREATE` grant to the vault on the mirrored object, checked against the real ObjectHub rather than asserted by the caller. |
| GV-2 | A `(objectId, buyer)` pair can have at most one open purchase. The guard clears on a failed settlement or a seller revoke, so the pair can transact again, and only then. |
| GV-3 | `buy` requires `msg.value >= price + live relay fee`, quoted from the real CrossChain oracle at call time and never hardcoded. Any excess is refunded in the same transaction. |
| GV-4 | Sale proceeds are credited pull-style. A seller that cannot receive ETH can never block a buyer's purchase, and `withdraw` pays exactly the credited balance once. |
| GV-5 | Conservation: the vault's ETH balance is greater than or equal to the sum of `pendingWithdrawals`, at every point outside a call frame. |
| GV-6 | `greenfieldCall` is accepted only from the real PermissionHub and only on the permission channel. Success records the real policy id and marks the sale Granted; failure marks it Failed and clears the purchase guard. |
| GV-7 | `revoke` is restricted to the sale's seller and to a sale in the Granted state, and it moves the sale to Revoked exactly once. |
| GV-8 | `buy`, `revoke`, and `withdraw` are non-reentrant, including against cross-function reentrancy from a refund callback. |
| GV-9 | A PermissionHub request that is declined rather than reverted (a `false` return) fails the whole call. `buy` never credits a seller for a permission that will not be minted, and `revoke` never marks a sale Revoked while the buyer keeps a live grant. |

## WorldMoves (`WM-*`)

[`contracts/src/WorldMoves.sol`](../contracts/src/WorldMoves.sol).
Event-only move stream. It holds no value and has no privileged role; it is in
scope because it is called at high frequency and an indexer trusts its log.

| Id | Invariant |
|---|---|
| WM-1 | `move` writes no storage. Its gas cost does not grow with call count, and a `move` never populates a checkpoint. |
| WM-2 | Coordinates are validated inclusively against `[COORD_MIN, COORD_MAX]` on all three axes, in both `move` and `checkpoint`. Out-of-range input reverts rather than being clamped. |
| WM-3 | A checkpoint is keyed by `(worldId, msg.sender)`. No caller can write another player's checkpoint, and worlds never share checkpoint state. |
| WM-4 | The contract has no owner, no admin, no pause, and no upgrade path. Nothing in it can be disabled or redirected after deployment. |

## ThreeWSPayments (`TWP-*`) **[deployed]**

[`contracts/ThreeWSPayments.sol`](../contracts/ThreeWSPayments.sol).
x402 pay-per-call receiver. Live on BNB Smart Chain, Base, and Arbitrum One
(addresses in [`contracts/DEPLOYMENTS.md`](../contracts/DEPLOYMENTS.md)). It
custodies real USDC, so its invariants are the highest-consequence ones here.

| Id | Invariant |
|---|---|
| TWP-1 | `pay` emits `Payment` only if the USDC transfer actually moved funds. A token that returns false without reverting, or reverts, must produce no receipt event, because the server keys settlement on that event. |
| TWP-2 | `pay` moves exactly the current `pricePerCall`, never an amount chosen by the caller. |
| TWP-3 | Only the owner may `setPrice`, `withdraw`, or `transferOwnership`, and ownership can never be transferred to the zero address. |
| TWP-4 | `withdraw` sends the contract's entire USDC balance to the current owner and reverts (moving nothing) if the token call fails. |
| TWP-5 | The constructor rejects a zero owner or zero token, so the deployed instance always has a reachable owner and a real token. |
| TWP-6 | The contract has no payable function and no fallback, so it cannot accrue native currency that nobody can withdraw. |

## ThreeWSFactory (`TWF-*`) **[deployed]**

[`contracts/ThreeWSFactory.sol`](../contracts/ThreeWSFactory.sol).
CREATE2 deployer used for the platform's vanity addresses. Live at the same
address on BNB Smart Chain, Base, and Arbitrum One.

| Id | Invariant |
|---|---|
| TWF-1 | `deploy` reverts if CREATE2 returned the zero address, so a failed deployment can never be reported as a success. |
| TWF-2 | `predict(salt, initCodeHash)` equals the address `deploy(salt, initCode)` produces for the same salt and `keccak256(initCode)`. The prediction is the deployment. |
| TWF-3 | Deploying the same `(salt, initCode)` pair twice reverts on the second attempt, because CREATE2 returns zero for an occupied address. An existing deployment cannot be silently replaced. |
| TWF-4 | The factory holds no state and no privileged role. It forwards no value (`create2` is called with `0`), so it can never hold or lose funds. |

## skill_license (`SL-*`)

[`contracts/skill-license/src/lib.rs`](../contracts/skill-license/src/lib.rs).
Solana/Anchor program issuing 1-of-1 NFT access keys for purchased skills. This
is the Solana half of the royalty set: the license is what a paid skill purchase
buys, and revocation is what a refund takes back.

| Id | Invariant |
|---|---|
| SL-1 | Only `marketplace.minter` may mint or revoke a license. Only `marketplace.authority` may rotate the minter. A user cannot self-mint a free license. |
| SL-2 | License and mint addresses are deterministic in `(owner, agent_mint, sha256(skill_name))`, so the same purchase can never mint two licenses: the second `init` fails on an existing account. |
| SL-3 | Supply is locked at exactly 1: the mint authority is removed in the same instruction that mints the single token. Freeze authority is deliberately retained by the marketplace so a refund can revoke without the holder's signature. |
| SL-4 | `skill_name` is non-empty and at most 64 bytes, which bounds both the PDA seed derivation and the account size. |
| SL-5 | Revocation is idempotent-safe: a license already carrying a non-zero `revoked_at` cannot be revoked again, and revocation freezes the holder's token account rather than deleting the record, so verifiers can still read the revoked state. |
| SL-6 | Only the license owner may burn their license (`has_one = authority`), and the burn closes the token account and the license PDA to that owner, reclaiming rent to them and nobody else. |
| SL-7 | `licenses_minted` uses checked arithmetic and can never wrap. |
| SL-8 | `skill_seed` is exactly `sha256(skill_name)` and matches the client derivation, so on-chain and off-chain agree on which account a license lives at. |

## agent_invocation (`AI-*`)

[`contracts/agent-invocation/src/lib.rs`](../contracts/agent-invocation/src/lib.rs).
Solana/Anchor program recording agent-to-agent skill invocations as verifiable
events.

| Id | Invariant |
|---|---|
| AI-1 | The invoker must sign, and `invoker_agent` must be the PDA derived from that signer, so a caller can only ever act as their own agent identity. |
| AI-2 | `target_agent` must be the PDA derived from `target_authority`, so an arbitrary account cannot be presented as a target. |
| AI-3 | `skill_name` is non-empty and at most 64 bytes; `parameters` is at most 512 bytes. Both bounds are enforced before the event is emitted. |
| AI-4 | The program moves no funds and grants no capability. Its only effect is the emitted event, so a bug here can mislead an indexer but cannot cause a loss. |

## knock_escrow (`KE-*`)

[`contracts/knock-escrow/src/lib.rs`](../contracts/knock-escrow/src/lib.rs).
Solana/Anchor program holding a knock's payment in escrow until the door's owner
answers or refuses it, or the reply window lapses. It is the only Solana program
in this set that custodies a stranger's money, so its invariants are written from
the sender's side: what a person who has never met the owner is guaranteed after
they pay. Each id below is proved by a positive and a negative test in
[`contracts/program-tests/tests/knock_escrow.rs`](../contracts/program-tests/tests/knock_escrow.rs)
against the real compiled bytecode. Three further properties the program enforces
but that are structural rather than behavioral (no admin path can move a parked
vault, message bodies never touch the chain, and price and window bounds) are
documented in [`contracts/knock-escrow/README.md`](../contracts/knock-escrow/README.md).

| Id | Invariant |
|---|---|
| KE-1 | An answer pays the owner exactly `amount - fee` and the treasury exactly `fee`, then closes the vault. No dust is ever stranded in a settled knock's vault. |
| KE-2 | Only the door's owner may answer. No other signer, including the `Config` authority, can settle a knock in the owner's favor. |
| KE-3 | An answer after `expires_at` is rejected, so money the sender is already owed back cannot be taken late. |
| KE-4 | Once the window has closed, ANYONE may crank the refund, and every unit goes to the sender. The refund does not depend on the sender still being online or on the owner cooperating. |
| KE-5 | Nobody may crank the refund while the window is open, so a sender cannot retract a knock the owner is still entitled to answer. |
| KE-6 | A refusal refunds in full and charges no fee. Declining to read something is not a service and is never billed. |
| KE-7 | A knock leaves `Pending` exactly once. `Answered`, `Refused`, and `Refunded` are terminal, so a settled knock can never be settled again. |
| KE-8 | `fee_bps` can never exceed `MAX_FEE_BPS` (1000, ten percent), enforced in both `initialize` and `set_config`, so an authority cannot set a fee that takes every future answer. |
| KE-9 | Shutting a door stops new knocks but does not touch knocks already in flight: those are still owed an answer or a refund. Closing up shop is not an escape from either. |
| KE-10 | A `KnockRecord` snapshots the fee in force when it was made, so raising the fee cannot reprice money that is already parked. The new fee applies only to knocks created after it lands. |

---

## Cross-contract invariants (`X-*`)

| Id | Invariant |
|---|---|
| X-1 | No contract in this set is upgradeable and none has a proxy or a pause switch. Deployed bytecode is final; a fix means a new deployment and a migration, never a silent swap. |
| X-2 | Every contract that holds value uses checks-effects-interactions plus an explicit reentrancy guard on every external-call path, rather than relying on either alone. |
| X-3 | No contract trusts a caller-supplied address as an authority. Authority is always read from contract storage or from the Identity Registry. |
| X-4 | No contract reads a price, a fee, or a rate from a caller. Fees are quoted live from the counterparty contract (`GV-3`) and prices are stored state set by an authorized role (`TWP-2`). |
| X-5 | Solidity 0.8 checked arithmetic is relied on for overflow safety. `unchecked` blocks appear only where the bound is proven by an adjacent check (id counters, review counts). |

## Change control

Adding a function to a contract in this set means adding its invariants here in
the same change, with tests that cite the new ids. A change that weakens an
existing invariant is a spec change and needs the same review as the code.
