# Static analysis: findings and dispositions

Every finding the analyzers report against this repo's contract sources, with a
written disposition. Raw tool output is committed next to this file in
[`static-analysis/`](./static-analysis) so a reviewer can diff their own run
against ours rather than take this table on trust.

Nothing here is suppressed with an inline pragma or a filter file. The counts
below are the analyzers' full output for the source tree, minus vendored
dependencies and the test/script trees (which are not deployed).

## Tools and versions

| Target | Tool | Version | Command |
|---|---|---|---|
| Solidity | [Slither](https://github.com/crytic/slither) | 0.11.6 | `cd contracts && slither . --filter-paths "lib/\|test/\|script/"` |
| Rust (Solana) | Clippy | shipped with the pinned Rust toolchain | `cd contracts/<program> && cargo clippy --all-targets` |

Add `--json audit/static-analysis/slither.json` to the Slither command for the
machine-readable form. The JSON is regenerated on demand rather than committed,
because it is half a megabyte of mostly source positions.

## Slither

Run of 2026-08-14 against `contracts/src/**` plus the two root `.sol` files:
44 contracts, 102 detectors, **17 results across 7 detectors**. Full output:
[`static-analysis/slither-report.txt`](./static-analysis/slither-report.txt).

Three results were **fixed** in the same change that produced this document,
taking the count from 20 to 17. The remaining 17 are dispositioned below.

### Fixed

| Detector | Where | Fix |
|---|---|---|
| `unused-return` (2 results) | `GreenfieldVault.buy`, `GreenfieldVault.revoke` | The real PermissionHub can decline a request by returning `false` instead of reverting. Both call sites ignored the return value, so a declined `createPolicy` would have credited the seller and burned the buyer's relay fee for a permission that was never going to be minted, and a declined `deletePolicy` would have marked a sale Revoked while the buyer kept a live grant. Both now revert with `PolicyRequestRejected`. This is a new invariant, `GV-9`, with tests on both sides. |
| `solc-version` (1 result) | `src/greenfield/*.sol` | The four vendored Greenfield interfaces carried `pragma solidity ^0.8.0`, which admits compiler versions with known severe bugs. Pinned to `^0.8.24`, matching every other file in the tree and the `solc_version` in `foundry.toml`. |

### Dispositioned

| Detector | Results | Impact/Confidence | Disposition |
|---|---|---|---|
| `reentrancy-eth` | 1 | High/Medium | `AgentPayments.buybackTrigger`. The flagged write is `acct.tokensBurned += bought` after the swap. It is unavoidable: the amount bought is not knowable until the router returns. It is also not part of the conservation identity (`AP-7`) that governs custody, only a cumulative statistic. Every write that *is* knowable up front (`buybackVault = 0`, `totalBuybacks += spend`) already happens before the external call, the function is `onlyOwner` and `nonReentrant`, and the router must be allow-listed and must not be the currency or agent token. The cross-function reentrancy Slither pairs it with is `distributePayments`, which only moves value between vaults and therefore preserves `AP-7` whenever it runs. Accepted. |
| `reentrancy-balance` | 2 | High/Medium | Same function. Slither flags `agentBefore` as a balance read that spans the external call. That is the point: the contract deliberately measures the delta across the swap rather than trusting a router-reported amount, exactly as `AP-5` does for fee-on-transfer payments. A stale read is impossible because both reads are of `address(this)` in the same call frame. Accepted. |
| `incorrect-equality` | 2 | Medium/High | `received == 0` in `_settle` and `bought == 0` in `buybackTrigger`. Neither is an equality test against a balance; both are "did this transfer or swap deliver anything at all" guards that revert on zero. There is no strict-equality dependence on an attacker-controllable amount. Accepted. |
| `timestamp` | 2 | Low/Medium | Invoice windows in `AgentPayments._settle` and the EIP-712 deadline in `IdentityRegistry.setAgentWallet`. Both are coarse deadlines measured in minutes or longer, where validator timestamp drift of a few seconds is immaterial. No value is priced off `block.timestamp`. Accepted. |
| `low-level-calls` | 8 | Informational/High | Seven are `recipient.call{value: ...}("")` for native transfers, which is the correct pattern (`transfer`'s 2300-gas stipend breaks smart-account recipients). Every one checks the returned success flag and reverts on failure. The eighth is the router call in `buybackTrigger`, which must be a raw call because the calldata is DEX-specific. Accepted. |
| `missing-inheritance` | 1 | Informational/High | Slither suggests `IdentityRegistry` should inherit `IIdentityRegistry`. It deliberately does not. On most chains the canonical registry is the ERC-8004 reference deployment at `0x8004A1...`, not this repo's bytecode (see `DEPLOYMENTS.md`), so the consumers bind to an *address* and must keep working against a registry this repo did not compile. Inheriting would also force an `ownerOf` override disambiguating `ERC721`, `IERC721` and the new interface, adding bytecode for no safety. The duplication Slither was really seeing (two identical interface declarations, one per consumer) was removed in this change: both now import the single [`src/IIdentityRegistry.sol`](../src/IIdentityRegistry.sol). Accepted. |
| `naming-convention` | 1 | Informational/High | `IdentityRegistry.DOMAIN_SEPARATOR()`. The name is fixed by EIP-2612 and EIP-712 tooling convention; renaming it to mixedCase would break every wallet and library that looks it up. Accepted. |

## Clippy

Both Solana programs, `--all-targets`. Output:
[`static-analysis/clippy-skill-license.txt`](./static-analysis/clippy-skill-license.txt),
[`static-analysis/clippy-agent-invocation.txt`](./static-analysis/clippy-agent-invocation.txt).

| Program | Warnings | Disposition |
|---|---|---|
| `skill-license` | 17 (5 duplicates) | Every warning resolves to a line inside an Anchor macro expansion, not to program source: `unexpected cfg condition value` for `custom-heap`, `custom-panic`, `solana` and `anchor-debug` (feature flags Anchor's own codegen tests for), and one `use of deprecated method AccountInfo::realloc` emitted by the `#[program]` attribute macro. All are attributable to `anchor-lang 0.31.1` and are fixed upstream by an Anchor bump, not by a change here. Zero warnings originate in `src/lib.rs` outside macro expansion. |
| `agent-invocation` | 13 (7 duplicates) | Identical set, same origin, same disposition. |

A reviewer can confirm the attribution by re-running with
`cargo clippy --all-targets -- -Z macro-backtrace` on a nightly toolchain: every
warning's backtrace terminates in `anchor_lang`'s `#[program]` or
`#[derive(Accounts)]`.

## What static analysis does not cover

Slither and Clippy find shapes, not intent. The properties that actually protect
funds here are stated as invariants in
[`specs/ECONOMY_CONTRACT_INVARIANTS.md`](../../specs/ECONOMY_CONTRACT_INVARIANTS.md)
and proven by the test suites described in
[`AUDIT-README.md`](../AUDIT-README.md). Neither tool checks any of them.
