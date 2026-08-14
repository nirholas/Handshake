# Economy Contract Threat Model v1

The attacker's-eye companion to [`ECONOMY_CONTRACT_INVARIANTS.md`](./ECONOMY_CONTRACT_INVARIANTS.md).
That document states what must always be true; this one states what is worth
stealing, who could try, and how each attempt is stopped. An auditor reads this
first to decide where to spend their time, then reads the invariants to see what
the code claims, then reads the tests to see what is proven.

Entry point for a review engagement: [`contracts/AUDIT-README.md`](../contracts/AUDIT-README.md).

Related: [`SECURITY.md`](./SECURITY.md) covers abuse of agent *registration*, which
sits upstream of these contracts. [`VALIDATORS.md`](./VALIDATORS.md) covers who may
write attestations. This file covers the contracts themselves.

## How to read a failure mode

Every failure mode has a stable id (`F-REP-2`, `F-AP-5`, ...) that is permanent
and never reused. Each row names the attacker's goal, the control that stops it,
and the invariant id whose test proves the control holds. A row with no invariant
id is a risk that is accepted or handled operationally rather than in code, and it
says so explicitly.

Severity is the impact if the control failed, not the likelihood that it will:

| Severity | Meaning |
|---|---|
| Critical | Direct theft, or permanent loss, of user or protocol funds. |
| High | Loss of an economic right (a paid license, an agent's earnings authority) or forged economic state that money keys on. |
| Medium | Denial of service against a paying user, or corruption of state an indexer or a verifier trusts. |
| Low | Griefing, noise, or gas waste with no economic effect. |

---

## Global model

### Trust boundaries

1. **Anonymous internet → contract.** Anyone can call any external function with
   any arguments, in any order, from a contract or an EOA, and can reenter during
   any payout. Nothing about a caller is assumed.
2. **Platform-operated key → contract.** Four privileged roles exist across the
   set (below). Each is a real key held by three.ws, and each is modeled as
   *compromisable*: the question for every role is not "will it behave" but "what
   is the blast radius if it does not".
3. **Contract → third-party contract.** `AgentPayments` calls a DEX router,
   `GreenfieldVault` calls BNB Greenfield's PermissionHub and CrossChain, the
   reputation and validation registries call the Identity Registry, and
   `skill_license` CPIs into SPL Token. Each counterparty is untrusted code that
   can revert, lie in a return value, or reenter.
4. **Chain → off-chain reader.** The platform's servers, indexers, and SDKs key
   real behavior (settlement, access grants, reputation display) on events and
   account state. A contract that emits a false event is therefore an attack on
   the off-chain system even when no on-chain value moves.

### Privileged roles

| Role | Where | Powers | Blast radius if the key is stolen |
|---|---|---|---|
| Protocol owner | `AgentPayments.owner` | Register agent tokens, allow-list swap routers, trigger buybacks. | Can spend a buyback vault through an allow-listed router at a bad price. Cannot touch `withdrawVault` (agent-owned) or `paymentVault` before distribution, cannot change an agent's authority, cannot mint. Held by the platform multisig. |
| Agent authority | `AgentPayments._agents[token].authority` | Withdraw that agent's earnings, change its buyback split, hand the role on. | Loses one agent's accrued earnings. Isolated per agent token: no cross-agent reach. |
| Registry owner | `ValidationRegistry.owner`, `ThreeWSPayments.owner` | Add/remove validators; set the pay-per-call price and withdraw USDC. | Forged attestations (no funds), or price manipulation plus theft of undrawn USDC receipts on the x402 receiver. |
| Marketplace minter | `skill_license.marketplace.minter` | Mint and revoke skill licenses. | Can issue unpaid licenses and revoke paid ones. Rotatable by the admin authority without redeploying, which is exactly why `set_minter` exists. |
| Marketplace admin | `skill_license.marketplace.authority` | Rotate the minter. | Can install a hostile minter. This is the root key of the Solana royalty half; it is the one key whose loss cannot be recovered from in-contract. |

None of these roles can upgrade a contract: nothing in the EVM set is upgradeable
or proxied (`X-1`). The Solana programs are upgradeable by their deploy authority,
which is the standard Solana posture and is called out as an accepted risk below.

### Assets

| Asset | Where it lives | Worst case |
|---|---|---|
| Agent earnings (ERC-20 and native) | `AgentPayments` vaults | Theft or permanent lock of an agent's revenue. |
| Buyback capital | `AgentPayments.buybackVault` | Drained through a hostile "router". |
| x402 receipts (USDC) | `ThreeWSPayments` | Theft of settled pay-per-call revenue. |
| Agent deposits (native) | `IdentityRegistry.agentBalance` | Theft of an agent's operating balance by a delegated spender. |
| Reputation stakes (native) | `ReputationRegistry.stakeOf` | Theft of another staker's refundable stake. |
| Sale proceeds (native) | `GreenfieldVault.pendingWithdrawals` | Theft of a seller's unclaimed proceeds. |
| The delegation itself | `IdentityRegistry` agent wallet + spend allowance | Silent capture of the right to act as an agent. |
| A paid skill license | `skill_license` PDA + 1/1 NFT | Free access, or destruction of purchased access. |
| Reputation and attestation records | `ReputationRegistry`, `ValidationRegistry` | Forged trust signals that the marketplace prices against. |

---

## IdentityRegistry: the delegation contract

[`contracts/src/IdentityRegistry.sol`](../contracts/src/IdentityRegistry.sol).
Decides who may act, and spend, as an agent. Everything downstream that asks
"is this caller the agent" resolves here.

**Actors:** the agent NFT owner, a delegated agent wallet, an authorized spender,
an NFT marketplace holding the token in escrow, and the anonymous internet.

| Id | Failure mode | Severity | Control | Proven by |
|---|---|---|---|---|
| F-ID-1 | An attacker replays a captured `setAgentWallet` signature to re-bind the agent's wallet to themselves after the owner rotated it back. | High | Per-owner nonce consumed on every accepted signature, plus a deadline. | `ID-3` |
| F-ID-2 | An attacker gets a signature signed by a *previous* owner accepted after the NFT changed hands. | High | The signature is checked against the current `ownerOf`, not against the signer of record. | `ID-3` |
| F-ID-3 | A buyer of the agent NFT finds the seller still holds spend rights. | High | Every owner-gated right reads `ownerOf` live, so the transfer moves them atomically. | `ID-2` |
| F-ID-4 | A spender authorized on a cheap agent drains a valuable agent's balance. | Critical | Balances and allowances are keyed per agent id; `spend` debits both. | `ID-7`, `ID-8` |
| F-ID-5 | A malicious recipient reenters during a payout and withdraws the same balance twice. | Critical | Checks-effects-interactions plus a reentrancy guard on both payout paths. | `ID-9`, `ID-10` |
| F-ID-6 | ETH arrives with no owning agent and is stranded forever. | Medium | `receive` and `fallback` both revert; deposits only through `deposit(agentId)`. | `ID-5`, `ID-6` |
| F-ID-7 | A mistyped withdrawal burns an agent's balance to the zero address. | Medium | Zero recipient rejected. | `ID-11` |
| F-ID-8 | A contract owner (smart-account agent) cannot sign, so its wallet can never be bound. | Low | Signature verification goes through `SignatureChecker`, so ERC-1271 owners work. | `ID-3` |

**Accepted:** the agent NFT is the root of authority, so an owner who loses their
key loses the agent. There is deliberately no admin recovery path, because an
admin able to reassign agents would be a larger risk than the one it removes.

## ReputationRegistry: the reputation contract

[`contracts/src/ReputationRegistry.sol`](../contracts/src/ReputationRegistry.sol).
Holds refundable stakes and the aggregate score the marketplace prices against.

**Actors:** reviewers (staking and non-staking), the agent's own owner, sybil
fleets, and the anonymous internet.

| Id | Failure mode | Severity | Control | Proven by |
|---|---|---|---|---|
| F-REP-1 | One address inflates an agent by reviewing it repeatedly, or by using the non-staking entry point after the staking one. | Medium | A single `hasReviewed` flag gates both entry points. | `REP-1` |
| F-REP-2 | An agent owner reviews their own agent. | Medium | The owner is rejected on both entry points, read live from the Identity Registry. | `REP-3` |
| F-REP-3 | A reviewer withdraws their stake and keeps the score, renting reputation for free. | Medium | Withdrawal refunds the stake but never retracts the review, so the review's cost is the capital lockup the reviewer chose to end. | `REP-8` |
| F-REP-4 | A staker withdraws more than they staked, or twice, taking another staker's capital. | Critical | The refund pays exactly `stakeOf[agent][sender]` and zeroes it first. | `REP-6`, `REP-7` |
| F-REP-5 | A contract staker reenters `withdrawStake` during its refund. | Critical | Reentrancy guard plus effects-before-interaction. | `REP-10` |
| F-REP-6 | Scores are written against an agent id that does not exist, poisoning an indexer. | Low | Existence is checked against the Identity Registry. | `REP-4` |
| F-REP-7 | An out-of-range score skews the aggregate. | Medium | Range enforced per entry point (`[-100,100]` and `[1,5]`). | `REP-2` |
| F-REP-8 | Dust stakes make a sybil fleet cheap. | Medium | A 0.001 ETH floor per stake. | `REP-9` |

**Accepted:** sybil resistance here is economic, not cryptographic. A funded
attacker with many addresses can buy score, and the stake floor only sets the
price. The market layer that reads this registry is expected to weight by stake
size and staker history rather than by raw count. See
[`REPUTATION_STAKING_MARKET.md`](./REPUTATION_STAKING_MARKET.md).

## AgentPayments: the royalty contract (EVM)

[`contracts/src/AgentPayments.sol`](../contracts/src/AgentPayments.sol).
The highest-value contract in the set: it holds every agent's revenue and the
buyback capital, and it makes an arbitrary external call by design.

**Actors:** payers, the agent authority, the protocol owner, DEX routers,
fee-on-transfer and rebasing tokens, and MEV searchers watching the buyback.

| Id | Failure mode | Severity | Control | Proven by |
|---|---|---|---|---|
| F-AP-1 | A third party front-runs registration of an agent token and installs their own authority. | High | Registration is restricted to the protocol owner or to the authority registering itself, and is one-shot. | `AP-1` |
| F-AP-2 | The protocol owner points the "router" at the currency token itself and drains the maxUint256 allowances payers grant. | Critical | The router must be allow-listed, and is explicitly rejected when equal to the currency or agent token. | `AP-9` |
| F-AP-3 | A standing router allowance survives a buyback and is spent later. | Critical | The approval is set and reset to zero inside the same call. | `AP-10` |
| F-AP-4 | A fee-on-transfer currency credits more than it delivered, so the vaults promise money the contract does not hold. | Critical | Credit is the measured balance delta, never the requested amount. | `AP-5` |
| F-AP-5 | A payer replays a settled invoice, or the SDK and the contract disagree on an invoice id. | High | Ids are a pure function of the invoice fields and are single-use on-chain. | `AP-3` |
| F-AP-6 | A payment lands outside its window and is still credited. | Medium | Both bounds enforced, with `0` meaning unbounded. | `AP-4` |
| F-AP-7 | Rounding in the split strands dust, or credits it twice. | Medium | The split drains the payment vault to zero and gives the exact remainder to the withdraw vault. | `AP-7`, `AP-8` |
| F-AP-8 | Native accounting is reached through the ERC-20 path (or the reverse), double-counting a balance. | High | The native sentinel and the zero address are rejected as ERC-20 currencies. | `AP-6` |
| F-AP-9 | A malicious router or receiver reenters to spend a vault twice. | Critical | Reentrancy guards on every value-moving path, effects written before the external call. | `AP-13` |
| F-AP-10 | An agent becomes unmanageable because its authority is set to the zero address. | High | Authority transfer rejects zero and is restricted to the current authority. | `AP-12` |
| F-AP-11 | A searcher sandwiches the buyback swap and the protocol burns fewer tokens than the market price implies. | Medium | Not a contract control: the swap calldata is built off-chain with slippage limits, and the call reverts if it returns nothing. Operational, see accepted risks. | `AP-9` |

**Accepted:** `buybackTrigger` takes attacker-shaped input (arbitrary calldata to
an external address) by construction, because the contract must work with any DEX.
The mitigations are the allow-list, the token-address exclusion, the owner gate,
and the burn-everything-bought rule. The residual risk is execution quality
(slippage, MEV) rather than custody, and it is bounded by the buyback vault
balance at call time. A firm should spend a disproportionate share of its time
here.

## skill_license: the royalty contract (Solana)

[`contracts/skill-license/src/lib.rs`](../contracts/skill-license/src/lib.rs).
What a paid skill purchase actually buys, and what a refund takes back.

**Actors:** the license holder, the backend minter, the marketplace admin, and
anyone who can craft a transaction.

| Id | Failure mode | Severity | Control | Proven by |
|---|---|---|---|---|
| F-SL-1 | A user self-mints a license without paying. | High | Minting requires the minter's signature; the marketplace admin cannot mint either. | `SL-1` |
| F-SL-2 | The same purchase mints two licenses, or two purchases collide onto one. | High | Every address is a PDA of `(owner, agent_mint, sha256(skill_name))`; a duplicate `init` fails. | `SL-2`, `SL-8` |
| F-SL-3 | The 1/1 access key is inflated after issue. | High | The mint authority is removed in the same instruction that mints the single token. | `SL-3` |
| F-SL-4 | A refunded holder keeps working access, or a revoked license is silently deleted so verifiers cannot see the revocation. | High | Revocation freezes the holder's token account and stamps `revoked_at` while keeping the record readable. | `SL-5` |
| F-SL-5 | A revocation is replayed to overwrite the original timestamp. | Medium | A license with a non-zero `revoked_at` cannot be revoked again. | `SL-5` |
| F-SL-6 | A stranger burns someone else's license, destroying paid access and taking its rent. | High | The license PDA is derived from the signer, so a stranger's derivation does not resolve to the victim's account. | `SL-6` |
| F-SL-7 | A burn is pointed at a different license's NFT mint. | Medium | The mint must equal the one recorded on the license. | `SL-6` |
| F-SL-8 | The lifetime counter wraps and corrupts marketplace accounting. | Low | Checked addition; the instruction fails closed at the boundary. | `SL-7` |
| F-SL-9 | A hostile minter mints unpaid licenses at scale. | High | Not prevented in-contract by design: it is contained by rotating the minter (`set_minter`) and by the fact that the minter cannot rotate itself. | `SL-1` |

**Accepted, and worth an auditor's attention:**

- **The marketplace deliberately keeps freeze authority** on every license mint so
  a refund can revoke without the holder's cooperation. This is a real power over
  a user's asset and it is the intended design, not an oversight. It is why
  `SL-3` asserts the freeze authority is retained rather than removed.
- **`revoked_at == 0` is the "live" sentinel.** The value comes from
  `Clock::unix_timestamp`, which is never 0 on a real cluster, so the guard holds
  in production. It is nonetheless a sentinel rather than a discriminated
  `Option`, and the invariant test suite has to set a realistic clock for the
  program to behave correctly, which is exactly the shape of assumption an audit
  should record. Hardening it to an `Option<i64>` is an account-layout change and
  therefore a migration, not a patch.
- **Program upgradeability.** Both Solana programs are upgradeable by their deploy
  authority. Key custody is documented in
  [`contracts/skill-license/DEPLOYMENT.md`](../contracts/skill-license/DEPLOYMENT.md).

## agent_invocation

[`contracts/agent-invocation/src/lib.rs`](../contracts/agent-invocation/src/lib.rs).
Records agent-to-agent invocations as events. It moves no funds, so its threat
surface is entirely about what an indexer will believe.

| Id | Failure mode | Severity | Control | Proven by |
|---|---|---|---|---|
| F-AI-1 | An attacker emits invocations attributed to an agent they do not control, inflating that agent's apparent usage. | Medium | The invoker must sign, and the invoker agent must be the PDA derived from that signer. | `AI-1` |
| F-AI-2 | An arbitrary account is presented as the target, so an indexer records traffic to an agent that does not exist. | Medium | The target must be the PDA derived from the presented target authority. | `AI-2` |
| F-AI-3 | Unbounded strings make the event expensive to emit or to index. | Low | Both fields are length-bounded before the event is emitted. | `AI-3` |
| F-AI-4 | A bug here causes a loss of funds. | Low | The program has no value-moving instruction and creates no account. | `AI-4` |

**Accepted:** the target agent does not sign, so an invocation event does not
prove the target consented or performed work. Consumers must treat it as a claim
by the invoker, not as a receipt. This is intentional: the program is a public
log, and the settlement layer for real work is the payments rail, not this event.

## GreenfieldVault

[`contracts/src/GreenfieldVault.sol`](../contracts/src/GreenfieldVault.sol).
Pay-to-unlock over a genuinely asynchronous cross-chain grant, which is where its
interesting failure modes live.

| Id | Failure mode | Severity | Control | Proven by |
|---|---|---|---|---|
| F-GV-1 | A seller lists an object they do not control and takes payment for access they cannot grant. | High | Listing requires a live `ROLE_CREATE` grant checked against the real ObjectHub. | `GV-1` |
| F-GV-2 | A buyer pays and the hub silently declines the request, so the seller is credited for a grant that never happens. | High | A declined hub call (a `false` return, not a revert) reverts the whole purchase. | `GV-9` |
| F-GV-3 | A seller whose address rejects ETH blocks every purchase of their object. | Medium | Proceeds are credited pull-style; nothing is pushed during `buy`. | `GV-4` |
| F-GV-4 | The relay fee is stale or caller-supplied, so the cross-chain call underpays and the buyer loses the payment. | High | The fee is quoted live from the real CrossChain oracle at call time. | `GV-3` |
| F-GV-5 | A failed settlement leaves the pair permanently unable to transact. | Medium | The purchase guard clears on failure and on revoke. | `GV-2` |
| F-GV-6 | A forged ack marks a sale Granted with an attacker-chosen policy id. | High | Acks are accepted only from the real PermissionHub, and only on the permission channel. | `GV-6` |
| F-GV-7 | A refund callback reenters `buy` or `withdraw`. | Critical | Reentrancy guards, including against cross-function reentrancy. | `GV-8` |

**Accepted:** a buyer's practical access depends on BNB Greenfield honoring the
policy, which is outside this contract. The vault proves the payment-to-permission
link on-chain and surfaces the pending state honestly rather than pretending the
async grant is synchronous.

## ThreeWSPayments and ThreeWSFactory (live bytecode)

Both are deployed on BNB Smart Chain, Base, and Arbitrum One, so a violation here
is an incident rather than a bug. Addresses in
[`contracts/DEPLOYMENTS.md`](../contracts/DEPLOYMENTS.md).

| Id | Failure mode | Severity | Control | Proven by |
|---|---|---|---|---|
| F-TWP-1 | A token that returns false without reverting produces a receipt event, so the server settles a call that was never paid for. | Critical | The transfer's success is checked before the event is emitted. | `TWP-1` |
| F-TWP-2 | A caller chooses their own price. | High | The amount is always the stored `pricePerCall`. | `TWP-2` |
| F-TWP-3 | Ownership is renounced to the zero address, stranding the USDC balance. | High | Zero rejected on transfer and in the constructor. | `TWP-3`, `TWP-5` |
| F-TWP-4 | Native currency accumulates with no way to withdraw it. | Low | No payable function, no fallback. | `TWP-6` |
| F-TWF-1 | A failed CREATE2 deployment is reported as a success and the platform trusts an empty address. | High | A zero return reverts. | `TWF-1` |
| F-TWF-2 | An existing deployment is silently replaced at a predicted address. | High | CREATE2 returns zero for an occupied address, which reverts. | `TWF-3` |

## WorldMoves and ValidationRegistry

Neither holds value. `WorldMoves` is an event-only move stream whose risk is
indexer-facing (`WM-1` .. `WM-4`), and it has no owner, admin, pause, or upgrade
path at all. `ValidationRegistry` gates who may write attestations (`VR-1` ..
`VR-6`); its worst case is a forged attestation, and its allow-list policy is
[`VALIDATORS.md`](./VALIDATORS.md). The one structural risk in either is that
`ValidationRegistry` ownership could be transferred to an address that cannot act,
freezing the allow-list, which is why the zero address is rejected (`VR-2`).

---

## Cross-cutting assumptions an audit should challenge

1. **Solidity 0.8 checked arithmetic** is relied on for overflow safety; `unchecked`
   appears only where an adjacent check proves the bound (`X-5`).
2. **No upgradeability on EVM** (`X-1`). A fix means a new deployment and a
   migration. This removes proxy risk and adds migration risk.
3. **Authority is never taken from a caller** (`X-3`), and prices and fees are never
   taken from a caller (`X-4`).
4. **Every value-moving path has both** checks-effects-interactions and an explicit
   guard (`X-2`), rather than relying on either alone.
5. **Key custody is out of scope for the code review but in scope for the system.**
   The protocol owner, the marketplace admin, and the Solana upgrade authority are
   the three keys whose compromise is not recoverable in-contract.

## Change control

A new external function, a new privileged role, or a new external counterparty
means a new row here and a new invariant in
[`ECONOMY_CONTRACT_INVARIANTS.md`](./ECONOMY_CONTRACT_INVARIANTS.md), in the same
change as the code.
