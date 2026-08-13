//! Invariant tests for the `skill_license` program.
//!
//! Proves `SL-1` .. `SL-8` of `specs/ECONOMY_CONTRACT_INVARIANTS.md` against the
//! real compiled bytecode running in LiteSVM, including the real SPL Token and
//! Associated Token Account programs. Each invariant gets a positive case and a
//! negative case.

use litesvm::LiteSVM;
use program_tests::*;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::program as system_program;
use solana_transaction::Transaction;

const MARKETPLACE_SEED: &[u8] = b"marketplace";
const SKILL_LICENSE_SEED: &[u8] = b"skill_license";
const SKILL_MINT_SEED: &[u8] = b"skill_mint";
const RENT_SYSVAR_ID: &str = "SysvarRent111111111111111111111111111111111";

/// `Marketplace`: discriminator, authority, minter, licenses_minted, bump.
const MARKETPLACE_MINTED_OFFSET: usize = 8 + 32 + 32;

/// Decoded `SkillLicense` account (borsh layout after the 8-byte discriminator).
struct License {
    authority: Pubkey,
    agent_mint: Pubkey,
    nft_mint: Pubkey,
    skill_hash: [u8; 32],
    purchase_date: i64,
    revoked_at: i64,
    skill_name: String,
}

fn decode_license(data: &[u8]) -> License {
    let p = |o: usize| Pubkey::new_from_array(data[o..o + 32].try_into().unwrap());
    let name_len = u32::from_le_bytes(data[129..133].try_into().unwrap()) as usize;
    License {
        authority: p(8),
        agent_mint: p(40),
        nft_mint: p(72),
        skill_hash: data[104..136 - 32].try_into().unwrap(),
        purchase_date: i64::from_le_bytes(data[136..144].try_into().unwrap()),
        revoked_at: i64::from_le_bytes(data[144..152].try_into().unwrap()),
        skill_name: String::from_utf8(data[133..133 + name_len].to_vec()).unwrap(),
    }
}

struct Harness {
    svm: LiteSVM,
    program_id: Pubkey,
    authority: Keypair,
    minter: Keypair,
    owner: Keypair,
    agent_mint: Pubkey,
    marketplace: Pubkey,
}

impl Harness {
    /// Boot the VM, load the program, and initialize the singleton marketplace.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program_id = pk(SKILL_LICENSE_ID);
        load_program(&mut svm, program_id, "skill-license", "skill_license.so");

        let authority = Keypair::new();
        let minter = Keypair::new();
        let owner = Keypair::new();
        for kp in [&authority, &minter, &owner] {
            svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        }
        let marketplace = Pubkey::find_program_address(&[MARKETPLACE_SEED], &program_id).0;

        let mut h = Self {
            svm,
            program_id,
            authority,
            minter,
            owner,
            agent_mint: Keypair::new().pubkey(),
            marketplace,
        };

        let ix = Instruction {
            program_id: h.program_id,
            accounts: vec![
                AccountMeta::new(h.marketplace, false),
                AccountMeta::new(h.authority.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: ix_data(
                "initialize_marketplace",
                &h.minter.pubkey().to_bytes().to_vec(),
            ),
        };
        let authority = h.authority.insecure_clone();
        h.send(ix, &authority, &[&authority])
            .expect("marketplace initialization must succeed");
        h
    }

    fn send(
        &mut self,
        ix: Instruction,
        payer: &Keypair,
        signers: &[&Keypair],
    ) -> Result<Vec<String>, Vec<String>> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.logs),
            Err(failed) => Err(failed.meta.logs),
        }
    }

    fn license_pda(&self, owner: &Pubkey, agent_mint: &Pubkey, skill: &str) -> Pubkey {
        Pubkey::find_program_address(
            &[
                SKILL_LICENSE_SEED,
                owner.as_ref(),
                agent_mint.as_ref(),
                &sha256(skill.as_bytes()),
            ],
            &self.program_id,
        )
        .0
    }

    fn nft_mint_pda(&self, owner: &Pubkey, agent_mint: &Pubkey, skill: &str) -> Pubkey {
        Pubkey::find_program_address(
            &[
                SKILL_MINT_SEED,
                owner.as_ref(),
                agent_mint.as_ref(),
                &sha256(skill.as_bytes()),
            ],
            &self.program_id,
        )
        .0
    }

    /// `mint_skill_license`, with the signing minter overridable so a negative
    /// test can present an unauthorized signer.
    fn mint_ix(&self, minter: &Pubkey, owner: &Pubkey, skill: &str) -> Instruction {
        let license = self.license_pda(owner, &self.agent_mint, skill);
        let nft_mint = self.nft_mint_pda(owner, &self.agent_mint, skill);
        let ata = associated_token_address(owner, &nft_mint);
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.marketplace, false),
                AccountMeta::new(*minter, true),
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new_readonly(self.agent_mint, false),
                AccountMeta::new(license, false),
                AccountMeta::new(nft_mint, false),
                AccountMeta::new(ata, false),
                AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
                AccountMeta::new_readonly(pk(ASSOCIATED_TOKEN_PROGRAM_ID), false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(pk(RENT_SYSVAR_ID), false),
            ],
            data: ix_data("mint_skill_license", &borsh_string(skill)),
        }
    }

    fn revoke_ix(&self, minter: &Pubkey, owner: &Pubkey, skill: &str) -> Instruction {
        let license = self.license_pda(owner, &self.agent_mint, skill);
        let nft_mint = self.nft_mint_pda(owner, &self.agent_mint, skill);
        let ata = associated_token_address(owner, &nft_mint);
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(self.marketplace, false),
                AccountMeta::new_readonly(*minter, true),
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new(license, false),
                AccountMeta::new_readonly(nft_mint, false),
                AccountMeta::new(ata, false),
                AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
            ],
            data: ix_data("revoke_skill_license", &[]),
        }
    }

    /// `burn_skill_license`. `signer` is the account presented as the license
    /// owner, so a negative test can present a stranger.
    fn burn_ix(&self, signer: &Pubkey, license_owner: &Pubkey, skill: &str) -> Instruction {
        let license = self.license_pda(license_owner, &self.agent_mint, skill);
        let nft_mint = self.nft_mint_pda(license_owner, &self.agent_mint, skill);
        let ata = associated_token_address(license_owner, &nft_mint);
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(license, false),
                AccountMeta::new(*signer, true),
                AccountMeta::new(nft_mint, false),
                AccountMeta::new(ata, false),
                AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
            ],
            data: ix_data("burn_skill_license", &[]),
        }
    }

    fn set_minter_ix(&self, authority: &Pubkey, new_minter: &Pubkey) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.marketplace, false),
                AccountMeta::new_readonly(*authority, true),
            ],
            data: ix_data("set_minter", &new_minter.to_bytes().to_vec()),
        }
    }

    /// Mint a license to the harness owner with the configured minter.
    fn mint(&mut self, skill: &str) -> Result<Vec<String>, Vec<String>> {
        let ix = self.mint_ix(&self.minter.pubkey(), &self.owner.pubkey(), skill);
        let minter = self.minter.insecure_clone();
        self.send(ix, &minter, &[&minter])
    }

    fn license_of(&self, skill: &str) -> License {
        let pda = self.license_pda(&self.owner.pubkey(), &self.agent_mint, skill);
        decode_license(&self.svm.get_account(&pda).expect("license must exist").data)
    }

    fn licenses_minted(&self) -> u64 {
        let data = self.svm.get_account(&self.marketplace).unwrap().data;
        u64::from_le_bytes(
            data[MARKETPLACE_MINTED_OFFSET..MARKETPLACE_MINTED_OFFSET + 8]
                .try_into()
                .unwrap(),
        )
    }
}

// ── SL-1: only the configured minter mints or revokes; only the admin rotates ─

/// SL-1 (positive): the wallet recorded as `marketplace.minter` can mint.
#[test]
fn configured_minter_can_mint() {
    let mut h = Harness::new();
    h.mint("summarize").expect("the configured minter must be able to mint");
    assert_eq!(h.license_of("summarize").authority, h.owner.pubkey());
}

/// SL-1 (negative): a user cannot self-mint a free license, and neither can the
/// marketplace admin, because minting is gated on the minter key alone.
#[test]
fn unauthorized_signer_cannot_mint() {
    let mut h = Harness::new();
    for imposter in [h.owner.insecure_clone(), h.authority.insecure_clone()] {
        let ix = h.mint_ix(&imposter.pubkey(), &h.owner.pubkey(), "summarize");
        let logs = h
            .send(ix, &imposter, &[&imposter])
            .expect_err("a non-minter must not be able to mint");
        assert!(
            logs_have_anchor_error(&logs, "UnauthorizedMinter"),
            "expected UnauthorizedMinter, got {logs:?}"
        );
    }
}

/// SL-1 (negative): revocation is minter-only too, so a refund cannot be forged
/// by the license holder or by the admin key.
#[test]
fn unauthorized_signer_cannot_revoke() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let imposter = h.owner.insecure_clone();
    let ix = h.revoke_ix(&imposter.pubkey(), &h.owner.pubkey(), "summarize");
    let logs = h
        .send(ix, &imposter, &[&imposter])
        .expect_err("a non-minter must not be able to revoke");
    assert!(
        logs_have_anchor_error(&logs, "UnauthorizedMinter"),
        "expected UnauthorizedMinter, got {logs:?}"
    );
}

/// SL-1 (positive): the admin authority rotates the minter, and the rotation
/// takes effect immediately in both directions.
#[test]
fn admin_can_rotate_the_minter() {
    let mut h = Harness::new();
    let new_minter = Keypair::new();
    h.svm.airdrop(&new_minter.pubkey(), 100_000_000_000).unwrap();

    let ix = h.set_minter_ix(&h.authority.pubkey(), &new_minter.pubkey());
    let authority = h.authority.insecure_clone();
    h.send(ix, &authority, &[&authority])
        .expect("the admin must be able to rotate the minter");

    let old = h.minter.insecure_clone();
    let ix = h.mint_ix(&old.pubkey(), &h.owner.pubkey(), "summarize");
    let logs = h
        .send(ix, &old, &[&old])
        .expect_err("the rotated-out minter must lose minting rights");
    assert!(logs_have_anchor_error(&logs, "UnauthorizedMinter"));

    let ix = h.mint_ix(&new_minter.pubkey(), &h.owner.pubkey(), "summarize");
    h.send(ix, &new_minter, &[&new_minter])
        .expect("the rotated-in minter must be able to mint");
}

/// SL-1 (negative): only the admin authority may rotate the minter. The minter
/// cannot promote itself or hand the role on.
#[test]
fn non_admin_cannot_rotate_the_minter() {
    let mut h = Harness::new();
    let imposter = h.minter.insecure_clone();
    let ix = h.set_minter_ix(&imposter.pubkey(), &imposter.pubkey());
    let logs = h
        .send(ix, &imposter, &[&imposter])
        .expect_err("a non-admin must not be able to rotate the minter");
    assert!(
        logs_have_anchor_error(&logs, "UnauthorizedAdmin"),
        "expected UnauthorizedAdmin, got {logs:?}"
    );
}

// ── SL-2: one license per (owner, agent, skill) ──────────────────────────────

/// SL-2 (positive): the license and its NFT mint land at exactly the addresses
/// derived from `(owner, agent_mint, sha256(skill_name))`.
#[test]
fn license_addresses_are_deterministic() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let license = h.license_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    let nft_mint = h.nft_mint_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    assert!(h.svm.get_account(&license).is_some_and(|a| a.owner == h.program_id));
    assert_eq!(h.license_of("summarize").nft_mint, nft_mint);
    assert_eq!(
        h.svm.get_account(&nft_mint).map(|a| a.owner),
        Some(pk(TOKEN_PROGRAM_ID))
    );
}

/// SL-2 (negative): the same purchase can never mint a second license. The
/// second `init` fails on the already-existing account.
#[test]
fn the_same_purchase_cannot_mint_twice() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();
    let logs = h
        .mint("summarize")
        .expect_err("a duplicate purchase must not mint a second license");
    assert!(
        logs.iter().any(|l| l.contains("already in use")),
        "expected an already-in-use failure, got {logs:?}"
    );
}

// ── SL-3: supply locked at 1, freeze authority retained ──────────────────────

/// SL-3 (positive): exactly one token exists, it sits in the owner's ATA, the
/// mint authority is gone, and the marketplace kept the freeze authority.
#[test]
fn supply_is_locked_at_one_with_freeze_authority_retained() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let nft_mint = h.nft_mint_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    let mint = decode_mint(&h.svm.get_account(&nft_mint).unwrap().data);
    assert_eq!(mint.supply, 1);
    assert_eq!(mint.decimals, 0);
    assert_eq!(mint.mint_authority, None, "mint authority must be removed");
    assert_eq!(
        mint.freeze_authority,
        Some(h.marketplace),
        "freeze authority must stay with the marketplace so a refund can revoke"
    );

    let ata = associated_token_address(&h.owner.pubkey(), &nft_mint);
    let token = decode_token_account(&h.svm.get_account(&ata).unwrap().data);
    assert_eq!(token.amount, 1);
    assert_eq!(token.owner, h.owner.pubkey());
    assert!(!token.is_frozen());
}

/// SL-3 (negative): with the mint authority removed, an SPL `MintTo` cannot
/// inflate the 1-of-1, whoever signs it.
#[test]
fn no_one_can_mint_a_second_token() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let nft_mint = h.nft_mint_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    let ata = associated_token_address(&h.owner.pubkey(), &nft_mint);

    // SPL Token `MintTo` (instruction 7) for one more token.
    let mut data = vec![7u8];
    data.extend_from_slice(&1u64.to_le_bytes());
    let minter = h.minter.insecure_clone();
    let ix = Instruction {
        program_id: pk(TOKEN_PROGRAM_ID),
        accounts: vec![
            AccountMeta::new(nft_mint, false),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(minter.pubkey(), true),
        ],
        data,
    };
    h.send(ix, &minter, &[&minter])
        .expect_err("a locked mint must reject any further MintTo");

    let mint = decode_mint(&h.svm.get_account(&nft_mint).unwrap().data);
    assert_eq!(mint.supply, 1, "supply must still be exactly one");
}

// ── SL-4: skill-name bounds ──────────────────────────────────────────────────

/// SL-4 (positive): a 64-byte name, the documented maximum, is accepted and
/// stored intact.
#[test]
fn max_length_skill_name_is_accepted() {
    let mut h = Harness::new();
    let name = "s".repeat(64);
    h.mint(&name).expect("a 64-byte skill name must be accepted");
    assert_eq!(h.license_of(&name).skill_name, name);
}

/// SL-4 (negative): an empty name is rejected before any account is created.
#[test]
fn empty_skill_name_is_rejected() {
    let mut h = Harness::new();
    let logs = h.mint("").expect_err("an empty skill name must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "EmptySkillName"),
        "expected EmptySkillName, got {logs:?}"
    );
    assert_eq!(h.licenses_minted(), 0, "a rejected mint must not count");
}

/// SL-4 (negative): one byte over the bound is rejected, so the account size and
/// the PDA seed derivation stay bounded.
#[test]
fn oversized_skill_name_is_rejected() {
    let mut h = Harness::new();
    let logs = h
        .mint(&"s".repeat(65))
        .expect_err("a 65-byte skill name must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "SkillNameTooLong"),
        "expected SkillNameTooLong, got {logs:?}"
    );
}

// ── SL-5: revocation freezes rather than deletes, and is single-shot ─────────

/// SL-5 (positive): revocation stamps `revoked_at`, freezes the holder's token
/// account, and keeps the license readable so a verifier can see the state.
#[test]
fn revocation_freezes_and_records() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let ix = h.revoke_ix(&h.minter.pubkey(), &h.owner.pubkey(), "summarize");
    let minter = h.minter.insecure_clone();
    h.send(ix, &minter, &[&minter]).expect("the minter must be able to revoke");

    let license = h.license_of("summarize");
    assert!(license.revoked_at > 0, "revoked_at must be stamped");
    assert!(
        license.purchase_date > 0 && license.revoked_at >= license.purchase_date,
        "revocation must not precede the purchase"
    );

    let nft_mint = h.nft_mint_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    let ata = associated_token_address(&h.owner.pubkey(), &nft_mint);
    let token = decode_token_account(&h.svm.get_account(&ata).unwrap().data);
    assert!(token.is_frozen(), "the holder's token account must be frozen");
    assert_eq!(token.amount, 1, "revocation must not burn the token");
}

/// SL-5 (negative): a license already carrying a non-zero `revoked_at` cannot be
/// revoked again, so the original revocation timestamp can never be overwritten.
#[test]
fn a_revoked_license_cannot_be_revoked_again() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let minter = h.minter.insecure_clone();
    let ix = h.revoke_ix(&minter.pubkey(), &h.owner.pubkey(), "summarize");
    h.send(ix, &minter, &[&minter]).unwrap();
    let first_stamp = h.license_of("summarize").revoked_at;

    let ix = h.revoke_ix(&minter.pubkey(), &h.owner.pubkey(), "summarize");
    let logs = h
        .send(ix, &minter, &[&minter])
        .expect_err("a second revocation must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "AlreadyRevoked"),
        "expected AlreadyRevoked, got {logs:?}"
    );
    assert_eq!(h.license_of("summarize").revoked_at, first_stamp);
}

// ── SL-6: only the holder burns, and the rent comes back to them ─────────────

/// SL-6 (positive): the owner burns their license; the token account and the
/// license PDA are closed and their rent lands with the owner.
#[test]
fn owner_can_burn_and_reclaims_rent() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let license = h.license_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    let nft_mint = h.nft_mint_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    let ata = associated_token_address(&h.owner.pubkey(), &nft_mint);
    let before = h.svm.get_balance(&h.owner.pubkey()).unwrap();

    let owner = h.owner.insecure_clone();
    let ix = h.burn_ix(&owner.pubkey(), &owner.pubkey(), "summarize");
    h.send(ix, &owner, &[&owner]).expect("the owner must be able to burn");

    let after = h.svm.get_balance(&h.owner.pubkey()).unwrap();
    assert!(after > before, "closing both accounts must credit the owner rent");
    assert!(
        h.svm.get_account(&license).map(|a| a.data.is_empty()).unwrap_or(true),
        "the license PDA must be closed"
    );
    assert!(
        h.svm.get_account(&ata).map(|a| a.data.is_empty()).unwrap_or(true),
        "the token account must be closed"
    );
    assert_eq!(decode_mint(&h.svm.get_account(&nft_mint).unwrap().data).supply, 0);
}

/// SL-6 (negative): a stranger cannot burn someone else's license, so nobody can
/// destroy a holder's access key or steal its rent.
#[test]
fn a_stranger_cannot_burn_someone_elses_license() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let ix = h.burn_ix(&stranger.pubkey(), &h.owner.pubkey(), "summarize");
    h.send(ix, &stranger, &[&stranger])
        .expect_err("a stranger must not be able to burn another holder's license");

    let license = h.license_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    assert!(
        h.svm.get_account(&license).is_some_and(|a| !a.data.is_empty()),
        "the license must survive the attempt"
    );
}

// ── SL-7: the lifetime counter uses checked arithmetic ───────────────────────

/// SL-7 (positive): the counter advances by exactly one per accepted mint.
#[test]
fn licenses_minted_counts_each_mint_once() {
    let mut h = Harness::new();
    assert_eq!(h.licenses_minted(), 0);
    h.mint("summarize").unwrap();
    assert_eq!(h.licenses_minted(), 1);
    h.mint("render").unwrap();
    assert_eq!(h.licenses_minted(), 2);
}

/// SL-7 (negative): at `u64::MAX` the counter refuses to wrap. The state is
/// written straight into the marketplace account, which is the only way to reach
/// the boundary, and the next mint must fail closed rather than roll over to 0.
#[test]
fn licenses_minted_cannot_wrap() {
    let mut h = Harness::new();
    let mut account = h.svm.get_account(&h.marketplace).unwrap();
    account.data[MARKETPLACE_MINTED_OFFSET..MARKETPLACE_MINTED_OFFSET + 8]
        .copy_from_slice(&u64::MAX.to_le_bytes());
    h.svm.set_account(h.marketplace, account).unwrap();
    assert_eq!(h.licenses_minted(), u64::MAX);

    let logs = h.mint("summarize").expect_err("the counter must not wrap");
    assert!(
        logs_have_anchor_error(&logs, "Overflow"),
        "expected Overflow, got {logs:?}"
    );
    assert_eq!(h.licenses_minted(), u64::MAX, "the counter must not roll over");
}

// ── SL-8: the skill seed is sha256(skill_name) ───────────────────────────────

/// SL-8 (positive): the stored `skill_hash` is exactly `sha256(skill_name)`, the
/// same digest a client computes, and the license lives at the PDA that hash
/// derives.
#[test]
fn skill_hash_matches_the_client_derivation() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();

    let license = h.license_of("summarize");
    assert_eq!(license.skill_hash, sha256(b"summarize"));
    assert_eq!(license.agent_mint, h.agent_mint);

    let derived = Pubkey::find_program_address(
        &[
            SKILL_LICENSE_SEED,
            h.owner.pubkey().as_ref(),
            h.agent_mint.as_ref(),
            &sha256(b"summarize"),
        ],
        &h.program_id,
    )
    .0;
    assert_eq!(derived, h.license_pda(&h.owner.pubkey(), &h.agent_mint, "summarize"));
}

/// SL-8 (negative): two different skill names never share a license account, so
/// buying one skill can never be read as owning another.
#[test]
fn different_skill_names_never_share_a_license() {
    let mut h = Harness::new();
    h.mint("summarize").unwrap();
    h.mint("render").unwrap();

    let a = h.license_pda(&h.owner.pubkey(), &h.agent_mint, "summarize");
    let b = h.license_pda(&h.owner.pubkey(), &h.agent_mint, "render");
    assert_ne!(a, b);
    assert_ne!(h.license_of("summarize").skill_hash, h.license_of("render").skill_hash);
    assert_ne!(h.license_of("summarize").nft_mint, h.license_of("render").nft_mint);
}
