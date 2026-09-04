//! Invariant tests for the `knock_escrow` program.
//!
//! Every test runs the REAL compiled SBF bytecode in LiteSVM against the real
//! SPL Token and Associated Token Account programs. Nothing here re-implements
//! the program, so a failure always means the program or the invariant is wrong.
//!
//! The invariants under test are the promises the product makes to a stranger
//! who is about to pay somebody they have never met:
//!
//!   KE-1  An answer pays the owner exactly `amount - fee` and the treasury the
//!         fee, and leaves no dust behind in the vault.
//!   KE-2  Only the door's owner can answer.
//!   KE-3  An answer after the window closes is refused, so the money the sender
//!         was promised back cannot be taken late.
//!   KE-4  After the window closes ANYONE can crank the refund, and every unit
//!         goes back to the sender.
//!   KE-5  Nobody can crank the refund early.
//!   KE-6  A refusal refunds in full and charges no fee.
//!   KE-7  A knock settles exactly once.
//!   KE-8  The fee ceiling is enforced at the boundary.
//!   KE-9  A closed door takes no money.
//!   KE-10 Raising the fee cannot reprice a knock that is already in escrow.
//!
//! Build the bytecode before running:
//!
//! ```text
//! cd contracts/knock-escrow && cargo build-sbf
//! cd contracts/program-tests && cargo test --test knock_escrow
//! ```

use litesvm::LiteSVM;
use program_tests::*;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_system_interface::program as system_program;

const KNOCK_ESCROW_ID: &str = "uVX46U6sGUs6PD3339ZXbTpMyhZwkQhBLPxnvRX9ps7";
const RENT_SYSVAR_ID: &str = "SysvarRent111111111111111111111111111111111";

const CONFIG_SEED: &[u8] = b"config";
const DOOR_SEED: &[u8] = b"door";
const KNOCK_SEED: &[u8] = b"knock";
const VAULT_SEED: &[u8] = b"vault";

/// One USDC at 6 decimals, the mint the live product prices doors in.
const DECIMALS: u8 = 6;
/// 0.05 USDC, the live schema's default door price.
const PRICE: u64 = 50_000;
/// 24 hours, inside the program's 1-hour..30-day band.
const WINDOW: i64 = 60 * 60 * 24;
/// 2.5%.
const FEE_BPS: u16 = 250;

/// Decoded `Door` (borsh, after the 8-byte discriminator).
struct Door {
    price: u64,
    open: bool,
    knocks: u64,
    answered: u64,
    refunded: u64,
    earned: u64,
}

fn decode_door(data: &[u8]) -> Door {
    Door {
        price: u64::from_le_bytes(data[104..112].try_into().unwrap()),
        open: data[120] == 1,
        knocks: u64::from_le_bytes(data[121..129].try_into().unwrap()),
        answered: u64::from_le_bytes(data[129..137].try_into().unwrap()),
        refunded: u64::from_le_bytes(data[137..145].try_into().unwrap()),
        earned: u64::from_le_bytes(data[145..153].try_into().unwrap()),
    }
}

/// Decoded `KnockRecord`.
struct KnockRec {
    amount: u64,
    fee_bps: u16,
    reply_hash: [u8; 32],
    expires_at: i64,
    state: u8,
}

fn decode_knock(data: &[u8]) -> KnockRec {
    KnockRec {
        amount: u64::from_le_bytes(data[104..112].try_into().unwrap()),
        fee_bps: u16::from_le_bytes(data[112..114].try_into().unwrap()),
        reply_hash: data[154..186].try_into().unwrap(),
        expires_at: i64::from_le_bytes(data[194..202].try_into().unwrap()),
        state: data[202],
    }
}

const STATE_ANSWERED: u8 = 1;
const STATE_REFUNDED: u8 = 2;
const STATE_REFUSED: u8 = 3;

struct Harness {
    svm: LiteSVM,
    program_id: Pubkey,
    authority: Keypair,
    owner: Keypair,
    sender: Keypair,
    treasury: Keypair,
    stranger: Keypair,
    mint: Pubkey,
    config: Pubkey,
    door: Pubkey,
    door_id: [u8; 32],
    sender_tokens: Pubkey,
    owner_tokens: Pubkey,
    treasury_tokens: Pubkey,
}

impl Harness {
    /// Boot the VM, load the program, mint real tokens, and open a priced door.
    fn new(fee_bps: u16) -> Self {
        let mut svm = LiteSVM::new();
        set_realistic_clock(&mut svm);
        let program_id = pk(KNOCK_ESCROW_ID);
        load_program(&mut svm, program_id, "knock-escrow", "knock_escrow.so");

        let authority = Keypair::new();
        let owner = Keypair::new();
        let sender = Keypair::new();
        let treasury = Keypair::new();
        let stranger = Keypair::new();
        for kp in [&authority, &owner, &sender, &treasury, &stranger] {
            svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        }

        let mint = create_mint(&mut svm, &authority, &authority.pubkey(), DECIMALS);
        let sender_tokens = create_ata(&mut svm, &sender, &sender.pubkey(), &mint);
        let owner_tokens = create_ata(&mut svm, &owner, &owner.pubkey(), &mint);
        let treasury_tokens = create_ata(&mut svm, &treasury, &treasury.pubkey(), &mint);
        mint_to(
            &mut svm,
            &authority,
            &authority,
            &mint,
            &sender_tokens,
            10_000_000,
        );

        let config = Pubkey::find_program_address(&[CONFIG_SEED], &program_id).0;
        let door_id = sha256(b"nirholas");
        let door = Pubkey::find_program_address(
            &[DOOR_SEED, owner.pubkey().as_ref(), door_id.as_ref()],
            &program_id,
        )
        .0;

        let mut h = Self {
            svm,
            program_id,
            authority,
            owner,
            sender,
            treasury,
            stranger,
            mint,
            config,
            door,
            door_id,
            sender_tokens,
            owner_tokens,
            treasury_tokens,
        };
        h.initialize(fee_bps).expect("initialize must succeed");
        h.open_door(PRICE, WINDOW).expect("open_door must succeed");
        h
    }

    fn initialize(&mut self, fee_bps: u16) -> Result<Vec<String>, Vec<String>> {
        let mut args = self.treasury.pubkey().to_bytes().to_vec();
        args.extend_from_slice(&fee_bps.to_le_bytes());
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.authority.pubkey(), true),
                AccountMeta::new(self.config, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: ix_data("initialize", &args),
        };
        let authority = self.authority.insecure_clone();
        send_ix(&mut self.svm, ix, &authority, &[&authority])
    }

    fn open_door(&mut self, price: u64, window: i64) -> Result<Vec<String>, Vec<String>> {
        let mut args = self.door_id.to_vec();
        args.extend_from_slice(&price.to_le_bytes());
        args.extend_from_slice(&window.to_le_bytes());
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.owner.pubkey(), true),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.door, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: ix_data("open_door", &args),
        };
        let owner = self.owner.insecure_clone();
        send_ix(&mut self.svm, ix, &owner, &[&owner])
    }

    /// Shut the door. `Option<T>` is borsh-encoded as a 1-byte tag then the value.
    fn close_door(&mut self) -> Result<Vec<String>, Vec<String>> {
        let args = vec![0u8, 0u8, 1u8, 0u8]; // price None, window None, open Some(false)
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(self.owner.pubkey(), true),
                AccountMeta::new(self.door, false),
            ],
            data: ix_data("set_door", &args),
        };
        let owner = self.owner.insecure_clone();
        send_ix(&mut self.svm, ix, &owner, &[&owner])
    }

    fn set_fee(&mut self, fee_bps: u16) -> Result<Vec<String>, Vec<String>> {
        let mut args = vec![0u8]; // treasury None
        args.push(1); // fee_bps Some
        args.extend_from_slice(&fee_bps.to_le_bytes());
        args.push(0); // authority None
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(self.authority.pubkey(), true),
                AccountMeta::new(self.config, false),
            ],
            data: ix_data("set_config", &args),
        };
        let authority = self.authority.insecure_clone();
        send_ix(&mut self.svm, ix, &authority, &[&authority])
    }

    fn knock_pda(&self, nonce: u64) -> (Pubkey, Pubkey) {
        let knock = Pubkey::find_program_address(
            &[
                KNOCK_SEED,
                self.door.as_ref(),
                self.sender.pubkey().as_ref(),
                &nonce.to_le_bytes(),
            ],
            &self.program_id,
        )
        .0;
        let vault =
            Pubkey::find_program_address(&[VAULT_SEED, knock.as_ref()], &self.program_id).0;
        (knock, vault)
    }

    fn knock(&mut self, nonce: u64) -> Result<Vec<String>, Vec<String>> {
        let (knock, vault) = self.knock_pda(nonce);
        let mut args = nonce.to_le_bytes().to_vec();
        args.extend_from_slice(&sha256(b"please read this"));
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.sender.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.door, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.sender_tokens, false),
                AccountMeta::new(knock, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(pk(RENT_SYSVAR_ID), false),
            ],
            data: ix_data("knock", &args),
        };
        let sender = self.sender.insecure_clone();
        send_ix(&mut self.svm, ix, &sender, &[&sender])
    }

    fn answer_as(&mut self, nonce: u64, signer: &Keypair) -> Result<Vec<String>, Vec<String>> {
        let (knock, vault) = self.knock_pda(nonce);
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(signer.pubkey(), true),
                AccountMeta::new_readonly(self.config, false),
                AccountMeta::new(self.door, false),
                AccountMeta::new(knock, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(self.owner_tokens, false),
                AccountMeta::new(self.treasury_tokens, false),
                AccountMeta::new(self.sender.pubkey(), false),
                AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
            ],
            data: ix_data("answer", &sha256(b"here is my reply")),
        };
        let signer = signer.insecure_clone();
        send_ix(&mut self.svm, ix, &signer, &[&signer])
    }

    fn answer(&mut self, nonce: u64) -> Result<Vec<String>, Vec<String>> {
        let owner = self.owner.insecure_clone();
        self.answer_as(nonce, &owner)
    }

    fn refuse(&mut self, nonce: u64) -> Result<Vec<String>, Vec<String>> {
        let (knock, vault) = self.knock_pda(nonce);
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(self.owner.pubkey(), true),
                AccountMeta::new(self.door, false),
                AccountMeta::new(knock, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(self.sender_tokens, false),
                AccountMeta::new(self.sender.pubkey(), false),
                AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
            ],
            data: ix_data("refuse", &[]),
        };
        let owner = self.owner.insecure_clone();
        send_ix(&mut self.svm, ix, &owner, &[&owner])
    }

    /// Crank the refund as `cranker`, who may be anybody at all.
    fn reclaim_as(&mut self, nonce: u64, cranker: &Keypair) -> Result<Vec<String>, Vec<String>> {
        let (knock, vault) = self.knock_pda(nonce);
        let ix = Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(cranker.pubkey(), true),
                AccountMeta::new(self.door, false),
                AccountMeta::new(knock, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(self.sender_tokens, false),
                AccountMeta::new(self.sender.pubkey(), false),
                AccountMeta::new_readonly(pk(TOKEN_PROGRAM_ID), false),
            ],
            data: ix_data("reclaim", &[]),
        };
        let cranker = cranker.insecure_clone();
        send_ix(&mut self.svm, ix, &cranker, &[&cranker])
    }

    fn door_state(&self) -> Door {
        decode_door(&self.svm.get_account(&self.door).unwrap().data)
    }

    fn knock_state(&self, nonce: u64) -> KnockRec {
        let (knock, _) = self.knock_pda(nonce);
        decode_knock(&self.svm.get_account(&knock).unwrap().data)
    }
}

// ── KE-1: an answer pays out exactly, and leaves nothing behind ─────────────

#[test]
fn ke1_answer_splits_the_payment_and_empties_the_vault() {
    let mut h = Harness::new(FEE_BPS);
    let (_, vault) = h.knock_pda(1);

    let sender_before = token_balance(&h.svm, &h.sender_tokens);
    h.knock(1).expect("a knock on an open door must succeed");
    assert_eq!(
        token_balance(&h.svm, &h.sender_tokens),
        sender_before - PRICE,
        "the sender is debited exactly the door price"
    );
    assert_eq!(
        token_balance(&h.svm, &vault),
        PRICE,
        "the whole price sits in escrow, not with the owner"
    );
    assert_eq!(
        token_balance(&h.svm, &h.owner_tokens),
        0,
        "the owner is paid nothing until they answer"
    );

    h.answer(1).expect("the owner must be able to answer");

    let fee = PRICE * FEE_BPS as u64 / 10_000;
    assert_eq!(token_balance(&h.svm, &h.owner_tokens), PRICE - fee);
    assert_eq!(token_balance(&h.svm, &h.treasury_tokens), fee);
    assert_eq!(
        token_balance(&h.svm, &vault),
        0,
        "no dust may be left stranded in a settled vault"
    );
    assert!(
        h.svm.get_account(&vault).is_none_or(|a| a.data.is_empty()),
        "the vault account is closed and its rent returned"
    );

    let k = h.knock_state(1);
    assert_eq!(k.state, STATE_ANSWERED);
    assert_eq!(
        k.reply_hash,
        sha256(b"here is my reply"),
        "the reply is committed on-chain so either side can prove it"
    );

    let d = h.door_state();
    assert_eq!((d.knocks, d.answered, d.refunded), (1, 1, 0));
    assert_eq!(d.earned, PRICE - fee, "earned counts the payout, not the fee");
}

// ── KE-2: only the owner can answer ─────────────────────────────────────────

#[test]
fn ke2_a_stranger_cannot_answer_and_take_the_money() {
    let mut h = Harness::new(FEE_BPS);
    h.knock(1).unwrap();

    let stranger = h.stranger.insecure_clone();
    let logs = h
        .answer_as(1, &stranger)
        .expect_err("a stranger must not be able to answer a knock");
    assert!(
        logs_have_anchor_error(&logs, "Unauthorized")
            || logs_have_anchor_error(&logs, "ConstraintHasOne"),
        "expected an authorization failure, got: {logs:?}"
    );

    let (_, vault) = h.knock_pda(1);
    assert_eq!(
        token_balance(&h.svm, &vault),
        PRICE,
        "the escrow is untouched by a failed answer"
    );
}

// ── KE-3: a late answer is refused ──────────────────────────────────────────

#[test]
fn ke3_the_owner_cannot_answer_after_the_window_closes() {
    let mut h = Harness::new(FEE_BPS);
    h.knock(1).unwrap();
    advance_clock(&mut h.svm, WINDOW + 1);

    let logs = h
        .answer(1)
        .expect_err("an answer after the window must be refused");
    assert!(
        logs_have_anchor_error(&logs, "ReplyWindowClosed"),
        "expected ReplyWindowClosed, got: {logs:?}"
    );
    assert_eq!(
        token_balance(&h.svm, &h.owner_tokens),
        0,
        "a late answer pays the owner nothing"
    );
}

// ── KE-4: the refund is permissionless and total ────────────────────────────

#[test]
fn ke4_anyone_can_crank_an_expired_refund_and_the_sender_gets_everything() {
    let mut h = Harness::new(FEE_BPS);
    let before = token_balance(&h.svm, &h.sender_tokens);
    h.knock(1).unwrap();
    advance_clock(&mut h.svm, WINDOW + 1);

    // Cranked by somebody with no stake in the knock at all: not the sender,
    // not the owner. The guarantee cannot depend on the sender being around.
    let stranger = h.stranger.insecure_clone();
    h.reclaim_as(1, &stranger)
        .expect("a stranger must be able to crank an expired refund");

    assert_eq!(
        token_balance(&h.svm, &h.sender_tokens),
        before,
        "the sender is made whole to the last unit"
    );
    assert_eq!(token_balance(&h.svm, &h.owner_tokens), 0);
    assert_eq!(
        token_balance(&h.svm, &h.treasury_tokens),
        0,
        "the protocol takes no fee on a refund"
    );
    assert_eq!(h.knock_state(1).state, STATE_REFUNDED);
    let d = h.door_state();
    assert_eq!((d.answered, d.refunded), (0, 1));
}

// ── KE-5: no early refund ───────────────────────────────────────────────────

#[test]
fn ke5_nobody_can_crank_the_refund_while_the_window_is_open() {
    let mut h = Harness::new(FEE_BPS);
    h.knock(1).unwrap();
    advance_clock(&mut h.svm, WINDOW - 60);

    let sender = h.sender.insecure_clone();
    let logs = h
        .reclaim_as(1, &sender)
        .expect_err("an early refund must be refused");
    assert!(
        logs_have_anchor_error(&logs, "ReplyWindowOpen"),
        "expected ReplyWindowOpen, got: {logs:?}"
    );
    let (_, vault) = h.knock_pda(1);
    assert_eq!(token_balance(&h.svm, &vault), PRICE);
}

// ── KE-6: refusing is free for the sender ───────────────────────────────────

#[test]
fn ke6_a_refusal_refunds_in_full_and_charges_no_fee() {
    let mut h = Harness::new(FEE_BPS);
    let before = token_balance(&h.svm, &h.sender_tokens);
    h.knock(1).unwrap();
    h.refuse(1).expect("the owner must be able to refuse");

    assert_eq!(
        token_balance(&h.svm, &h.sender_tokens),
        before,
        "refusing to read something is not a service, so it is not charged for"
    );
    assert_eq!(token_balance(&h.svm, &h.treasury_tokens), 0);
    assert_eq!(token_balance(&h.svm, &h.owner_tokens), 0);
    assert_eq!(h.knock_state(1).state, STATE_REFUSED);
}

// ── KE-7: a knock settles exactly once ──────────────────────────────────────

#[test]
fn ke7_a_settled_knock_cannot_be_settled_again() {
    let mut h = Harness::new(FEE_BPS);

    // Answered, then answered again.
    h.knock(1).unwrap();
    h.answer(1).unwrap();
    let paid_once = token_balance(&h.svm, &h.owner_tokens);
    assert!(h.answer(1).is_err(), "a knock must not pay out twice");
    assert_eq!(token_balance(&h.svm, &h.owner_tokens), paid_once);

    // Refunded, then answered.
    h.knock(2).unwrap();
    advance_clock(&mut h.svm, WINDOW + 1);
    let stranger = h.stranger.insecure_clone();
    h.reclaim_as(2, &stranger).unwrap();
    assert!(
        h.answer(2).is_err(),
        "a refunded knock must not be answerable"
    );

    // Refunded, then refunded again.
    assert!(
        h.reclaim_as(2, &stranger).is_err(),
        "a refund must not be replayable"
    );
}

// ── KE-8: the fee ceiling is real ───────────────────────────────────────────

#[test]
fn ke8_the_fee_cannot_be_set_above_the_ceiling() {
    let mut h = Harness::new(FEE_BPS);

    h.set_fee(1_000).expect("10% is exactly the ceiling");
    let logs = h
        .set_fee(1_001)
        .expect_err("one basis point over the ceiling must be refused");
    assert!(
        logs_have_anchor_error(&logs, "FeeTooHigh"),
        "expected FeeTooHigh, got: {logs:?}"
    );

    // And it is enforced at creation, not only on update.
    let mut fresh = LiteSVM::new();
    set_realistic_clock(&mut fresh);
    load_program(
        &mut fresh,
        pk(KNOCK_ESCROW_ID),
        "knock-escrow",
        "knock_escrow.so",
    );
    let authority = Keypair::new();
    fresh.airdrop(&authority.pubkey(), 100_000_000_000).unwrap();
    let config = Pubkey::find_program_address(&[CONFIG_SEED], &pk(KNOCK_ESCROW_ID)).0;
    let mut args = Keypair::new().pubkey().to_bytes().to_vec();
    args.extend_from_slice(&5_000u16.to_le_bytes());
    let ix = Instruction {
        program_id: pk(KNOCK_ESCROW_ID),
        accounts: vec![
            AccountMeta::new(authority.pubkey(), true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: ix_data("initialize", &args),
    };
    let logs = send_ix(&mut fresh, ix, &authority, &[&authority])
        .expect_err("initializing at 50% must be refused");
    assert!(logs_have_anchor_error(&logs, "FeeTooHigh"));
}

// ── KE-9: a closed door takes no money ──────────────────────────────────────

#[test]
fn ke9_a_closed_door_refuses_knocks_but_still_owes_the_ones_in_flight() {
    let mut h = Harness::new(FEE_BPS);
    h.knock(1).expect("the door is open for the first knock");
    h.close_door().expect("the owner may shut their door");
    assert!(!h.door_state().open);

    let logs = h.knock(2).expect_err("a shut door must refuse a knock");
    assert!(
        logs_have_anchor_error(&logs, "DoorClosed"),
        "expected DoorClosed, got: {logs:?}"
    );

    // Closing shop is not a way out of a knock already taken: the in-flight one
    // still refunds on schedule.
    let before = token_balance(&h.svm, &h.sender_tokens);
    advance_clock(&mut h.svm, WINDOW + 1);
    let stranger = h.stranger.insecure_clone();
    h.reclaim_as(1, &stranger)
        .expect("an in-flight knock still refunds after the door closes");
    assert_eq!(token_balance(&h.svm, &h.sender_tokens), before + PRICE);
}

// ── KE-10: an in-flight knock cannot be repriced ────────────────────────────

#[test]
fn ke10_raising_the_fee_cannot_reprice_a_knock_already_in_escrow() {
    let mut h = Harness::new(FEE_BPS);
    h.knock(1).unwrap();
    assert_eq!(
        h.knock_state(1).fee_bps,
        FEE_BPS,
        "the knock snapshots the fee it was made under"
    );

    // The authority raises the fee to the ceiling AFTER the money is parked.
    h.set_fee(1_000).unwrap();
    h.answer(1).unwrap();

    let fee_at_knock_time = PRICE * FEE_BPS as u64 / 10_000;
    assert_eq!(
        token_balance(&h.svm, &h.treasury_tokens),
        fee_at_knock_time,
        "the treasury takes the fee agreed at knock time, not the raised one"
    );
    assert_eq!(
        token_balance(&h.svm, &h.owner_tokens),
        PRICE - fee_at_knock_time
    );

    // The new fee does apply to the next knock.
    h.knock(2).unwrap();
    assert_eq!(h.knock_state(2).fee_bps, 1_000);
    assert_eq!(h.knock_state(2).amount, PRICE);
}
