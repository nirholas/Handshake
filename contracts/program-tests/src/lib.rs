//! Shared harness for the Solana program invariant tests in `tests/`.
//!
//! Every test in this crate runs the REAL compiled SBF bytecode of the program
//! under test inside [LiteSVM](https://github.com/LiteSVM/litesvm). Nothing here
//! re-implements program logic: the helpers below only build instructions, derive
//! addresses, and read account bytes back, so a test failure always means the
//! program (or the invariant) is wrong, never the harness.
//!
//! Build the bytecode before running the tests:
//!
//! ```text
//! cd contracts/skill-license     && cargo-build-sbf
//! cd contracts/agent-invocation  && cargo-build-sbf
//! cd contracts/program-tests     && cargo test
//! ```

use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;
use std::path::PathBuf;
use std::str::FromStr;

/// `skill_license`'s `declare_id!`.
pub const SKILL_LICENSE_ID: &str = "EdngSwxmDktyrr4phwGEZnCXEoQ27vgnBtowjhKa7Wr8";
/// `agent_invocation`'s `declare_id!`.
pub const AGENT_INVOCATION_ID: &str = "AgEntJDMi1A7UadCoYcx6Fm3gusNk8SHLCi7vSUa4Zfo";

/// SPL Associated Token Account program, the canonical mainnet address.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/// SPL Token program, the canonical mainnet address.
pub const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// Parse a base58 program address that is a compile-time constant of this crate.
pub fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).expect("constant program address must parse")
}

/// SHA-256, the same digest the programs use for `skill_seed` and the same one
/// Anchor uses to derive discriminators.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// Anchor's 8-byte discriminator: the first eight bytes of
/// `sha256("<namespace>:<name>")`. `namespace` is `global` for an instruction
/// and `account` for an account type.
pub fn discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let digest = sha256(format!("{namespace}:{name}").as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

/// Instruction data for an Anchor instruction: discriminator followed by the
/// borsh-encoded arguments.
pub fn ix_data(name: &str, args: &[u8]) -> Vec<u8> {
    let mut data = discriminator("global", name).to_vec();
    data.extend_from_slice(args);
    data
}

/// Load a program's compiled bytecode into the VM, failing with an actionable
/// message when the SBF build has not been run yet.
pub fn load_program(svm: &mut LiteSVM, program_id: Pubkey, crate_dir: &str, so_name: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(crate_dir)
        .join("target/deploy")
        .join(so_name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}. Build it first: cd contracts/{crate_dir} && cargo-build-sbf",
            path.display()
        )
    });
    svm.add_program(program_id, &bytes);
}

/// Derive the associated token account for `(owner, mint)`, the same derivation
/// the ATA program itself performs.
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            owner.as_ref(),
            pk(TOKEN_PROGRAM_ID).as_ref(),
            mint.as_ref(),
        ],
        &pk(ASSOCIATED_TOKEN_PROGRAM_ID),
    )
    .0
}

/// Fields of an SPL token `Mint` this suite asserts on. Offsets are the SPL
/// Token program's fixed 82-byte layout, which is part of its wire format.
pub struct MintState {
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub decimals: u8,
    pub freeze_authority: Option<Pubkey>,
}

/// Decode an SPL `Mint` account.
pub fn decode_mint(data: &[u8]) -> MintState {
    assert!(data.len() >= 82, "mint account is {} bytes", data.len());
    let coption = |offset: usize| -> Option<Pubkey> {
        let tag = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
        if tag == 0 {
            None
        } else {
            Some(Pubkey::new_from_array(
                data[offset + 4..offset + 36].try_into().unwrap(),
            ))
        }
    };
    MintState {
        mint_authority: coption(0),
        supply: u64::from_le_bytes(data[36..44].try_into().unwrap()),
        decimals: data[44],
        freeze_authority: coption(46),
    }
}

/// Fields of an SPL token account this suite asserts on. Offsets are the SPL
/// Token program's fixed 165-byte layout.
pub struct TokenAccountState {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// SPL `AccountState`: 0 uninitialized, 1 initialized, 2 frozen.
    pub state: u8,
}

impl TokenAccountState {
    pub fn is_frozen(&self) -> bool {
        self.state == 2
    }
}

/// Decode an SPL token account.
pub fn decode_token_account(data: &[u8]) -> TokenAccountState {
    assert!(data.len() >= 165, "token account is {} bytes", data.len());
    TokenAccountState {
        mint: Pubkey::new_from_array(data[0..32].try_into().unwrap()),
        owner: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
        state: data[108],
    }
}

/// Borsh-encode a string argument (4-byte little-endian length, then bytes).
pub fn borsh_string(s: &str) -> Vec<u8> {
    let mut out = (s.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(s.as_bytes());
    out
}

/// True when a failed transaction's logs mention the given Anchor error name.
/// Anchor logs `Error Code: <Name>. Error Number: <n>` on a constraint or
/// `require!` failure, so matching the name is exact, not a substring guess.
pub fn logs_have_anchor_error(logs: &[String], error_name: &str) -> bool {
    let needle = format!("Error Code: {error_name}.");
    logs.iter().any(|l| l.contains(&needle))
}
