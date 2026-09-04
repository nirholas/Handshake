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
use solana_clock::Clock;
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
    svm.add_program(program_id, &bytes)
        .unwrap_or_else(|e| panic!("loading {so_name} into the VM failed: {e:?}"));
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

/// A fixed, realistic wall-clock time for the VM: 2026-01-01T00:00:00Z.
///
/// LiteSVM boots with `unix_timestamp == 0`, which no real cluster ever reports.
/// The programs under test stamp `Clock::get()?.unix_timestamp` into account
/// state and treat `0` as "not set", so tests must run against a clock that
/// looks like a real one. Fixed rather than "now" so runs stay reproducible.
pub const TEST_UNIX_TIMESTAMP: i64 = 1_767_225_600;

/// Point the VM's clock at [`TEST_UNIX_TIMESTAMP`].
pub fn set_realistic_clock(svm: &mut LiteSVM) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = TEST_UNIX_TIMESTAMP;
    clock.epoch_start_timestamp = TEST_UNIX_TIMESTAMP;
    svm.set_sysvar(&clock);
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

// ── SPL token helpers ───────────────────────────────────────────────────────
//
// LiteSVM boots with the real SPL Token and Associated Token Account programs,
// so these build genuine instructions against them rather than writing account
// bytes by hand. A test that fabricated a token account would prove nothing
// about a program that CPIs into the token program.

use litesvm::types::FailedTransactionMetadata;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_system_interface::program as system_program;
use solana_transaction::Transaction;

/// Rent-exempt size of an SPL `Mint`.
const MINT_LEN: u64 = 82;

/// Send one instruction and return its logs, or the failure's logs.
pub fn send_ix(
    svm: &mut LiteSVM,
    ix: Instruction,
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<Vec<String>, Vec<String>> {
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        signers,
        svm.latest_blockhash(),
    );
    match svm.send_transaction(tx) {
        Ok(meta) => Ok(meta.logs),
        Err(FailedTransactionMetadata { meta, .. }) => Err(meta.logs),
    }
}

/// Create and initialize a real SPL mint whose authority is `authority`.
pub fn create_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Pubkey, decimals: u8) -> Pubkey {
    let mint = Keypair::new();
    let lamports = svm.minimum_balance_for_rent_exemption(MINT_LEN as usize);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        lamports,
        MINT_LEN,
        &pk(TOKEN_PROGRAM_ID),
    );
    // InitializeMint2 (tag 20): decimals, mint authority, then a COption
    // freeze authority which we leave as None.
    let mut data = vec![20u8, decimals];
    data.extend_from_slice(authority.as_ref());
    data.push(0);
    let init = Instruction {
        program_id: pk(TOKEN_PROGRAM_ID),
        accounts: vec![AccountMeta::new(mint.pubkey(), false)],
        data,
    };
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[create, init],
        Some(&payer.pubkey()),
        &[payer, &mint],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("mint creation must succeed");
    mint.pubkey()
}

/// Create the associated token account for `(owner, mint)` and return it.
pub fn create_ata(svm: &mut LiteSVM, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ata = associated_token_address(owner, mint);
    let ix = Instruction {
        program_id: pk(ASSOCIATED_TOKEN_PROGRAM_ID),
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
        ],
        data: vec![0], // Create
    };
    send_ix(svm, ix, payer, &[payer]).expect("ATA creation must succeed");
    ata
}

/// Mint `amount` to `dest`, signed by the mint authority.
pub fn mint_to(
    svm: &mut LiteSVM,
    payer: &Keypair,
    authority: &Keypair,
    mint: &Pubkey,
    dest: &Pubkey,
    amount: u64,
) {
    let mut data = vec![7u8]; // MintTo
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: pk(TOKEN_PROGRAM_ID),
        accounts: vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
        ],
        data,
    };
    send_ix(svm, ix, payer, &[payer, authority]).expect("mint_to must succeed");
}

/// Token balance of an account, or 0 when the account no longer exists (which
/// is what a closed vault looks like).
pub fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    match svm.get_account(account) {
        Some(a) if a.data.len() >= 165 => decode_token_account(&a.data).amount,
        _ => 0,
    }
}

/// Push the VM's clock forward by `seconds`, so a test can cross an expiry
/// boundary without sleeping.
pub fn advance_clock(svm: &mut LiteSVM, seconds: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp += seconds;
    svm.set_sysvar(&clock);
}
