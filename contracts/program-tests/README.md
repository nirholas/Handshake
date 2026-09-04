# `program-tests`

Invariant tests for the three three.ws Solana programs, run against their **real
compiled bytecode** in [LiteSVM](https://github.com/LiteSVM/litesvm).

Nothing in here re-implements program logic. The crate builds instructions,
derives addresses, and decodes account bytes; the behavior under test is the
`.so` produced by `cargo-build-sbf`, executing in a VM with the real SPL Token and
Associated Token Account programs loaded. A failing test therefore means the
program is wrong, not that a stub drifted.

| Program | Source | Tests | Invariants |
|---|---|---|---|
| `skill_license` | [`../skill-license/src/lib.rs`](../skill-license/src/lib.rs) | 21 | `SL-1` .. `SL-8` |
| `agent_invocation` | [`../agent-invocation/src/lib.rs`](../agent-invocation/src/lib.rs) | 11 | `AI-1` .. `AI-4` |
| `knock_escrow` | [`../knock-escrow/src/lib.rs`](../knock-escrow/src/lib.rs) | 10 | `KE-1` .. `KE-10` |

Invariants are defined in
[`specs/ECONOMY_CONTRACT_INVARIANTS.md`](../../specs/ECONOMY_CONTRACT_INVARIANTS.md).
Every id has a positive test (the property holds when it should) and a negative
test (a caller trying to break it is rejected), and every test names its id in a
doc comment, so `grep -rn "SL-3" .` finds the proof.

## Run

The bytecode has to exist first. `cargo test` does not build it, and will fail
with the exact command to run if a `.so` is missing.

```bash
cd contracts/skill-license    && cargo-build-sbf
cd contracts/agent-invocation && cargo-build-sbf
cd contracts/knock-escrow     && cargo-build-sbf
cd contracts/program-tests    && cargo test
```

`cargo-build-sbf` ships with the Solana (Agave) toolchain:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

A cold SBF build of `skill_license` takes about ten minutes; the tests themselves
run in seconds.

## Writing a test

`src/lib.rs` holds the shared harness. The pieces you need:

```rust
use litesvm::LiteSVM;
use program_tests::*;

let mut svm = LiteSVM::new();
set_realistic_clock(&mut svm);                                    // see below
load_program(&mut svm, pk(SKILL_LICENSE_ID), "skill-license", "skill_license.so");

// Anchor instruction data: 8-byte discriminator + borsh args.
let data = ix_data("mint_skill_license", &borsh_string("summarize"));

// Account state, decoded from the SPL wire layouts.
let mint = decode_mint(&svm.get_account(&nft_mint).unwrap().data);
let token = decode_token_account(&svm.get_account(&ata).unwrap().data);

// Assert on the program's own error name rather than a raw code.
assert!(logs_have_anchor_error(&logs, "UnauthorizedMinter"));
```

Account order in an instruction must match the field order of the program's
`#[derive(Accounts)]` struct, and the `is_signer` / `is_writable` flags must match
its `Signer` types and `mut` / `init` attributes. Each test file builds its
instructions through a `Harness` whose builders take every account as a parameter,
so a negative test can substitute exactly one wrong account and prove that the
constraint on *that* account is what rejects the transaction.

### The clock must be set

`set_realistic_clock` is not optional. LiteSVM boots with
`Clock::unix_timestamp == 0`, which no real cluster ever reports, and
`skill_license` writes that timestamp into `SkillLicense.revoked_at` where `0`
means "not revoked". Against the default clock a revocation records nothing and
the `AlreadyRevoked` guard never trips. The programs are correct on a real
cluster; the harness has to look like one. This is recorded as an accepted risk in
[`specs/ECONOMY_CONTRACT_THREAT_MODEL.md`](../../specs/ECONOMY_CONTRACT_THREAT_MODEL.md)
because it is exactly the kind of environmental assumption an audit should know
about.

## Dependency pins

`Cargo.toml` pins `litesvm` to `=0.15.2` and three `solana-*` runtime crates to
`=4.1.1`. LiteSVM 0.15.2 destructures `ExecutionRecord` exhaustively, so a later
patch release of those crates (which added fields) stops it from compiling. The
harness also depends on the granular `solana-instruction` / `solana-keypair` /
`solana-transaction` crates rather than the `solana-sdk` umbrella, because the
umbrella's version range conflicts with LiteSVM's. Loosen either at your own risk;
`cargo build --tests` tells you immediately.

## Context

- Audit entry point: [`../AUDIT-README.md`](../AUDIT-README.md)
- Solidity counterpart: [`../test/`](../test) (Foundry, 242 tests)
- Deploy runbooks: [`../skill-license/DEPLOYMENT.md`](../skill-license/DEPLOYMENT.md)
