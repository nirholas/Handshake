# Audit pack: three.ws economy contracts

Start here if you are reviewing these contracts. This document is the single
entry point: what is in scope, what each contract is for, what it claims about
itself, what is already proven, what is already known, and the exact commands to
reproduce every number quoted below.

Nothing in this pack asks you to take a claim on trust. Every number has a command
next to it, and every "this is safe because" resolves to an invariant id whose
test you can run.

- **Invariants** (what the code claims must always be true): [`specs/ECONOMY_CONTRACT_INVARIANTS.md`](../specs/ECONOMY_CONTRACT_INVARIANTS.md)
- **Threat model** (assets, actors, failure modes): [`specs/ECONOMY_CONTRACT_THREAT_MODEL.md`](../specs/ECONOMY_CONTRACT_THREAT_MODEL.md)
- **Static analysis + dispositions**: [`audit/static-analysis.md`](./audit/static-analysis.md)
- **Deploy status and address provenance**: [`DEPLOYMENTS.md`](./DEPLOYMENTS.md)
- **Registration-layer threat model** (upstream of these contracts): [`specs/SECURITY.md`](../specs/SECURITY.md)

## Scope

The economy set is the code that moves value or records the economic state value
is priced against. The roadmap names three of them specifically: **reputation**
(`ReputationRegistry`), **royalty** (`AgentPayments` on EVM, `skill_license` on
Solana), and **delegation** (`IdentityRegistry`). The rest of the set is included
because it shares the same review surface and two of them are already live.

Solana leads on this platform, so the two Anchor programs are first-class scope,
not an appendix.

| Contract | Source | Lines | Role | Deploy status | Invariants | Tests |
|---|---|---|---|---|---|---|
| IdentityRegistry | [`src/IdentityRegistry.sol`](src/IdentityRegistry.sol) | 295 | Delegation: ERC-721 agent identity, EIP-712 wallet binding, per-agent balances, spend allowances | Canonical ERC-8004 address live on 12 mainnets + 7 testnets; bytecode read verified 2026-06-19. Deployed by the ERC-8004 reference project, not from this tree | `ID-1` .. `ID-11` | 37 |
| ReputationRegistry | [`src/ReputationRegistry.sol`](src/ReputationRegistry.sol) | 210 | Reputation: one review per reviewer per agent, optional refundable ETH stake | Same as above | `REP-1` .. `REP-10` | 31 |
| AgentPayments | [`src/AgentPayments.sol`](src/AgentPayments.sol) | 411 | Royalty (EVM): payments in, split into authority and buyback shares, buyback swaps and burns | Not deployed. Address table in `DEPLOYMENTS.md` is unfilled | `AP-1` .. `AP-13` | 57 |
| skill_license | [`skill-license/src/lib.rs`](skill-license/src/lib.rs) | 464 | Royalty (Solana): 1-of-1 NFT access key per purchased skill, revocable on refund | Not deployed. Program id reserved via `declare_id!`; runbook in [`skill-license/DEPLOYMENT.md`](skill-license/DEPLOYMENT.md) | `SL-1` .. `SL-8` | 21 |
| GreenfieldVault | [`src/GreenfieldVault.sol`](src/GreenfieldVault.sol) | 338 | Pay-to-unlock marketplace over a real BNB Greenfield cross-chain permission grant | Not deployed to a public chain; proven on an anvil fork | `GV-1` .. `GV-9` | 41 |
| ValidationRegistry | [`src/ValidationRegistry.sol`](src/ValidationRegistry.sol) | 166 | Allow-listed validators attest to off-chain proofs | Not deployed from this tree; the platform uses the ERC-8004 reference registry | `VR-1` .. `VR-6` | 22 |
| WorldMoves | [`src/WorldMoves.sol`](src/WorldMoves.sol) | 146 | Event-only move stream, no value, no admin | Not deployed to a public chain | `WM-1` .. `WM-4` | 19 |
| agent_invocation | [`agent-invocation/src/lib.rs`](agent-invocation/src/lib.rs) | 129 | Verifiable agent-to-agent invocation events, no value | Not deployed. Program id reserved via `declare_id!` | `AI-1` .. `AI-4` | 11 |
| **ThreeWSPayments** | [`ThreeWSPayments.sol`](ThreeWSPayments.sol) | 97 | x402 pay-per-call USDC receiver | **LIVE on BNB Smart Chain, Base, Arbitrum One.** Custodies real USDC | `TWP-1` .. `TWP-6` | 22 |
| **ThreeWSFactory** | [`ThreeWSFactory.sol`](ThreeWSFactory.sol) | 20 | CREATE2 deployer behind the platform's vanity addresses | **LIVE on the same three chains** | `TWF-1` .. `TWF-4` | 13 |

Cross-contract invariants (`X-1` .. `X-5`) apply to the whole set.

**Out of scope:** `lib/` (vendored OpenZeppelin and forge-std), `test/`, `script/`,
`src/greenfield/*.sol` (reproduced ABIs of already-deployed BNB Greenfield
contracts, included so this tree compiles against the real bridge), and
`contracts/idl/pump/*` (third-party IDLs consumed read-only).

## Where to spend your time

Ranked by what a mistake would cost, not by line count:

1. **`AgentPayments.buybackTrigger`** ([`src/AgentPayments.sol`](src/AgentPayments.sol)).
   The only place in the set that makes an arbitrary external call with
   caller-supplied calldata, while the contract holds every agent's revenue and
   long-lived payer allowances. Controls are an owner gate, a router allow-list, a
   token-address exclusion, a reentrancy guard, effects-before-interaction, a
   measured balance delta, and a same-call allowance reset. Threat rows `F-AP-2`,
   `F-AP-3`, `F-AP-9`.
2. **`AgentPayments` conservation** (`AP-7`). One identity governs custody:
   `paymentVault + buybackVault + withdrawVault + totalWithdrawn + totalBuybacks
   == totalPayments`, per `(agentToken, currencyToken)`. Any path that breaks it is
   a loss of funds.
3. **`ThreeWSPayments`** is live and holds real USDC. Small, but the only contract
   in the set where a finding is an incident rather than a bug.
4. **`IdentityRegistry` delegation** (`ID-3`, `ID-7`, `ID-8`). Signature replay and
   cross-agent balance isolation. Capturing a delegation is as valuable as
   capturing funds, and quieter.
5. **`skill_license` authority model** (`SL-1`, `SL-3`, `SL-5`). The marketplace
   deliberately keeps freeze authority over every license so refunds can revoke.
   Confirm that power cannot be reached by anyone but the minter.
6. **`GreenfieldVault` async settlement** (`GV-2`, `GV-6`, `GV-9`). Money moves at
   `buy()`, but the permission is minted later by a cross-chain ack. Every state
   machine gap lives in that window.

## Reproduce everything

### Solidity

Foundry, `solc 0.8.24`, optimizer on at 200 runs (see [`foundry.toml`](foundry.toml)).

```bash
cd contracts
forge build
forge test                                            # 242 tests, all passing
forge coverage --no-match-coverage "(script|test)"    # 100% lines/statements/branches/functions
```

Coverage as of 2026-08-14, and the standard this set holds:

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| ThreeWSFactory.sol | 100% (6/6) | 100% (4/4) | 100% (2/2) | 100% (2/2) |
| ThreeWSPayments.sol | 100% (27/27) | 100% (26/26) | 100% (5/5) | 100% (9/9) |
| src/AgentPayments.sol | 100% (108/108) | 100% (149/149) | 100% (35/35) | 100% (14/14) |
| src/GreenfieldVault.sol | 100% (84/84) | 100% (118/118) | 100% (31/31) | 100% (8/8) |
| src/IdentityRegistry.sol | 100% (81/81) | 100% (94/94) | 100% (18/18) | 100% (20/20) |
| src/ReputationRegistry.sol | 100% (57/57) | 100% (67/67) | 100% (16/16) | 100% (10/10) |
| src/ValidationRegistry.sol | 100% (40/40) | 100% (43/43) | 100% (9/9) | 100% (10/10) |
| src/WorldMoves.sol | 100% (18/18) | 100% (21/21) | 100% (3/3) | 100% (6/6) |
| **Total** | **100% (421/421)** | **100% (522/522)** | **100% (119/119)** | **100% (79/79)** |

### Solana

The Anchor programs are tested against their **real compiled SBF bytecode** in
[LiteSVM](https://github.com/LiteSVM/litesvm), with the real SPL Token and
Associated Token Account programs loaded. Nothing is stubbed: a test failure means
the program is wrong.

```bash
cd contracts/skill-license    && cargo-build-sbf
cd contracts/agent-invocation && cargo-build-sbf
cd contracts/program-tests    && cargo test        # 32 tests, all passing
```

Line coverage is deliberately not quoted for these two. The unit under test is
bytecode executing inside a VM, so a host-side line-coverage tool would measure
the harness rather than the program. The coverage standard here is instruction and
invariant coverage instead, which is stronger and directly checkable:

| Program | Instructions | Instructions covered | Invariants | Positive + negative |
|---|---|---|---|---|
| `skill_license` | 5 (`initialize_marketplace`, `set_minter`, `mint_skill_license`, `burn_skill_license`, `revoke_skill_license`) | 5/5 | `SL-1` .. `SL-8` | every id |
| `agent_invocation` | 1 (`invoke_skill`) | 1/1 | `AI-1` .. `AI-4` | every id |

Seven of `skill_license`'s eight error variants are asserted by an
individually-named test. The eighth, `NotLicenseOwner`, is defense in depth behind
the PDA seed derivation: a stranger's derivation does not resolve to the victim's
license account, so the seeds constraint rejects the transaction first. The
stranger-burn test (`a_stranger_cannot_burn_someone_elses_license`) proves the
outcome that matters.

Harness details, including why the VM's clock must be set to a realistic value
before either program behaves correctly, are in
[`program-tests/README.md`](program-tests/README.md).

### Static analysis

```bash
cd contracts && slither . --filter-paths "lib/|test/|script/"      # 17 results, all dispositioned
cd contracts/skill-license && cargo clippy --all-targets
cd contracts/agent-invocation && cargo clippy --all-targets
```

Every result is dispositioned in writing in
[`audit/static-analysis.md`](./audit/static-analysis.md), with raw output
committed under [`audit/static-analysis/`](./audit/static-analysis).

## How invariants are proven

Every invariant has a stable id. The test that proves it names that id in a
comment, so the proof is greppable:

```bash
grep -rn "AP-7" contracts/test          # Solidity
grep -rn "SL-3" contracts/program-tests # Solana
```

Every id is covered by at least one positive test (the property holds when it
should) and at least one negative test (a caller trying to break it is rejected).
That rule is the reason the negative half is called out explicitly in each test's
doc comment.

## Known issues and accepted risks

These are already understood. If you find one of them, we agree; the value is in
what you find beyond them.

1. **`buybackTrigger` takes attacker-shaped input by construction.** Arbitrary
   calldata to an external address is what makes the contract DEX-agnostic. The
   residual risk after the allow-list and the token-address exclusion is execution
   quality (slippage, MEV), bounded by the buyback vault balance at call time.
2. **The skill-license marketplace keeps freeze authority** over every license mint,
   permanently, so refunds can revoke without the holder's signature. Intended, and
   asserted by `SL-3` rather than treated as a defect.
3. **`revoked_at == 0` is the "not revoked" sentinel** in `skill_license`. Safe on a
   real cluster (`Clock::unix_timestamp` is never 0) but it is a sentinel rather
   than a discriminated option. Changing it is an account-layout migration.
4. **Both Solana programs are upgradeable** by their deploy authority. Key custody
   is documented in [`skill-license/DEPLOYMENT.md`](skill-license/DEPLOYMENT.md).
5. **Nothing on EVM is upgradeable** (`X-1`). This removes proxy risk and adds
   migration risk: a fix is a redeploy plus a migration.
6. **Reputation sybil resistance is economic, not cryptographic.** The 0.001 ETH
   stake floor sets a price, it does not prevent a funded fleet. The market layer
   is expected to weight by stake size and staker history.
7. **`IdentityRegistry` has no admin recovery.** An owner who loses their key loses
   the agent, deliberately.
8. **`agent_invocation` events are a claim by the invoker**, not a receipt: the
   target does not sign. Settlement lives on the payments rail, not this log.
9. **The three registries this repo ships as reference implementations are not the
   bytecode live at `0x8004...` on most chains.** Consumers bind by address to
   whichever registry is canonical per chain. Read `DEPLOYMENTS.md` before assuming
   a source file corresponds to a live contract.

## Reporting

Send findings with a severity, a concrete failure scenario (inputs, ordering, and
the resulting wrong state), and the invariant id the finding breaks if one applies.
A finding that breaks a stated invariant is unambiguous by construction, which is
most of why the invariants are written down. Security contact and disclosure
process: [`.github/SECURITY.md`](../.github/SECURITY.md), or email security@three.ws.

## Repository map

```
contracts/
  AUDIT-README.md            this file
  DEPLOYMENTS.md             addresses, chains, provenance
  AGENT_PAYMENTS.md          AgentPayments deploy + wiring guide
  foundry.toml               solc 0.8.24, optimizer 200 runs
  src/*.sol                  the EVM economy set
  src/greenfield/*.sol       reproduced ABIs of live BNB Greenfield contracts
  test/*.t.sol               Solidity invariant tests
  skill-license/             Anchor program: skill licenses (Solana royalty half)
  agent-invocation/          Anchor program: invocation events
  program-tests/             LiteSVM invariant tests for both Anchor programs
  audit/                     static-analysis output and dispositions
  idl/                       generated IDLs consumed by the backend and SDKs
  script/                    Foundry deploy scripts
  vanity/                    CREATE2 salt records for the vanity addresses
```
