//! Invariant tests for the `agent_invocation` program.
//!
//! Proves `AI-1` .. `AI-4` of `specs/ECONOMY_CONTRACT_INVARIANTS.md` against the
//! real compiled bytecode. Each invariant gets a positive case (the property
//! holds when it should) and a negative case (a caller trying to break it is
//! rejected).

use litesvm::LiteSVM;
use program_tests::*;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::program as system_program;
use solana_transaction::Transaction;

const AGENT_SEED: &[u8] = b"agent";

struct Harness {
    svm: LiteSVM,
    program_id: Pubkey,
    invoker: Keypair,
    target_authority: Pubkey,
}

impl Harness {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program_id = pk(AGENT_INVOCATION_ID);
        load_program(
            &mut svm,
            program_id,
            "agent-invocation",
            "agent_invocation.so",
        );

        let invoker = Keypair::new();
        svm.airdrop(&invoker.pubkey(), 10_000_000_000).unwrap();

        Self {
            svm,
            program_id,
            invoker,
            target_authority: Keypair::new().pubkey(),
        }
    }

    fn agent_pda(&self, authority: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[AGENT_SEED, authority.as_ref()], &self.program_id).0
    }

    /// Build an `invoke_skill` instruction with every account overridable, so a
    /// negative test can substitute exactly one wrong account.
    fn invoke_ix(
        &self,
        invoker_agent: Pubkey,
        invoker_authority: Pubkey,
        invoker_signs: bool,
        target_authority: Pubkey,
        target_agent: Pubkey,
        skill_name: &str,
        parameters: &str,
    ) -> Instruction {
        let mut args = borsh_string(skill_name);
        args.extend_from_slice(&borsh_string(parameters));
        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new_readonly(invoker_agent, false),
                AccountMeta::new_readonly(invoker_authority, invoker_signs),
                AccountMeta::new_readonly(target_authority, false),
                AccountMeta::new_readonly(target_agent, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: ix_data("invoke_skill", &args),
        }
    }

    /// The happy-path instruction: both PDAs correct, invoker signing.
    fn valid_ix(&self, skill_name: &str, parameters: &str) -> Instruction {
        self.invoke_ix(
            self.agent_pda(&self.invoker.pubkey()),
            self.invoker.pubkey(),
            true,
            self.target_authority,
            self.agent_pda(&self.target_authority),
            skill_name,
            parameters,
        )
    }

    fn send(&mut self, ix: Instruction) -> Result<Vec<String>, Vec<String>> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.invoker.pubkey()),
            &[&self.invoker],
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.logs),
            Err(failed) => Err(failed.meta.logs),
        }
    }

    /// Send a transaction the invoker does NOT sign, using a separate fee payer.
    fn send_unsigned_by_invoker(&mut self, ix: Instruction) -> Result<Vec<String>, String> {
        let payer = Keypair::new();
        self.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.logs),
            Err(failed) => Err(format!("{:?}", failed.err)),
        }
    }
}

// ── AI-1: the invoker must sign, and acts only as its own agent ──────────────

/// AI-1 (positive): the authority signs and passes its own derived agent PDA,
/// so the invocation is recorded and the event names that PDA.
#[test]
fn invoker_acting_as_own_agent_succeeds() {
    let mut h = Harness::new();
    let ix = h.valid_ix("summarize", "{\"url\":\"https://three.ws\"}");
    let logs = h.send(ix).expect("valid invocation must succeed");

    let expected = h.agent_pda(&h.invoker.pubkey()).to_string();
    assert!(
        logs.iter().any(|l| l.contains(&expected)),
        "expected the invoker agent PDA in the program logs, got {logs:?}"
    );
    assert!(
        logs.iter().any(|l| l.contains("invoked skill 'summarize'")),
        "expected the skill name in the program logs, got {logs:?}"
    );
}

/// AI-1 (negative): passing another authority's agent PDA while signing as
/// yourself is rejected by the seeds constraint, so nobody can act as an agent
/// they do not control.
#[test]
fn invoking_as_another_agent_is_rejected() {
    let mut h = Harness::new();
    let stranger = Keypair::new().pubkey();
    let ix = h.invoke_ix(
        h.agent_pda(&stranger),
        h.invoker.pubkey(),
        true,
        h.target_authority,
        h.agent_pda(&h.target_authority),
        "summarize",
        "{}",
    );
    let logs = h.send(ix).expect_err("a foreign invoker PDA must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "ConstraintSeeds"),
        "expected a seeds-constraint failure, got {logs:?}"
    );
}

/// AI-1 (negative): the authority must actually sign. Without its signature the
/// transaction never reaches the program body.
#[test]
fn unsigned_invoker_is_rejected() {
    let mut h = Harness::new();
    let ix = h.invoke_ix(
        h.agent_pda(&h.invoker.pubkey()),
        h.invoker.pubkey(),
        false,
        h.target_authority,
        h.agent_pda(&h.target_authority),
        "summarize",
        "{}",
    );
    let err = h
        .send_unsigned_by_invoker(ix)
        .expect_err("an unsigned invoker must be rejected");
    assert!(
        err.contains("Signature") || err.contains("signer"),
        "expected a missing-signature failure, got {err}"
    );
}

// ── AI-2: the target must be the PDA of the presented target authority ───────

/// AI-2 (positive): a target agent derived from its authority is accepted, and
/// its PDA is what the event records.
#[test]
fn target_agent_derived_from_its_authority_is_accepted() {
    let mut h = Harness::new();
    let ix = h.valid_ix("render", "{}");
    let logs = h.send(ix).expect("a correctly derived target must be accepted");
    let expected = h.agent_pda(&h.target_authority).to_string();
    assert!(
        logs.iter().any(|l| l.contains(&expected)),
        "expected the target agent PDA in the program logs, got {logs:?}"
    );
}

/// AI-2 (negative): an arbitrary account cannot be presented as the target
/// agent, so an indexer can never be told an invocation hit an agent that does
/// not exist under this program.
#[test]
fn arbitrary_target_account_is_rejected() {
    let mut h = Harness::new();
    let arbitrary = Keypair::new().pubkey();
    let ix = h.invoke_ix(
        h.agent_pda(&h.invoker.pubkey()),
        h.invoker.pubkey(),
        true,
        h.target_authority,
        arbitrary,
        "render",
        "{}",
    );
    let logs = h.send(ix).expect_err("an arbitrary target account must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "ConstraintSeeds"),
        "expected a seeds-constraint failure, got {logs:?}"
    );
}

// ── AI-3: input bounds ───────────────────────────────────────────────────────

/// AI-3 (positive): both fields are accepted exactly at their documented
/// maximum, so the bound is inclusive and the limits are usable.
#[test]
fn max_length_inputs_are_accepted() {
    let mut h = Harness::new();
    let name = "s".repeat(64);
    let params = "p".repeat(512);
    let ix = h.valid_ix(&name, &params);
    h.send(ix).expect("64-byte name and 512-byte parameters must be accepted");
}

/// AI-3 (negative): an empty skill name is rejected.
#[test]
fn empty_skill_name_is_rejected() {
    let mut h = Harness::new();
    let ix = h.valid_ix("", "{}");
    let logs = h.send(ix).expect_err("an empty skill name must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "EmptySkillName"),
        "expected EmptySkillName, got {logs:?}"
    );
}

/// AI-3 (negative): one byte over the skill-name bound is rejected.
#[test]
fn oversized_skill_name_is_rejected() {
    let mut h = Harness::new();
    let name = "s".repeat(65);
    let ix = h.valid_ix(&name, "{}");
    let logs = h.send(ix).expect_err("a 65-byte skill name must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "SkillNameTooLong"),
        "expected SkillNameTooLong, got {logs:?}"
    );
}

/// AI-3 (negative): one byte over the parameters bound is rejected.
#[test]
fn oversized_parameters_are_rejected() {
    let mut h = Harness::new();
    let params = "p".repeat(513);
    let ix = h.valid_ix("summarize", &params);
    let logs = h.send(ix).expect_err("a 513-byte parameter blob must be rejected");
    assert!(
        logs_have_anchor_error(&logs, "ParametersTooLong"),
        "expected ParametersTooLong, got {logs:?}"
    );
}

// ── AI-4: no funds move and no account is created ────────────────────────────

/// AI-4 (positive): a successful invocation moves no lamports beyond the network
/// fee the payer owes, and creates no account. The two agent PDAs stay
/// nonexistent, so the program grants no capability and holds no state.
#[test]
fn invocation_moves_no_funds_and_creates_no_account() {
    let mut h = Harness::new();
    let invoker_agent = h.agent_pda(&h.invoker.pubkey());
    let target_agent = h.agent_pda(&h.target_authority);

    assert!(h.svm.get_account(&invoker_agent).is_none());
    let before = h.svm.get_balance(&h.invoker.pubkey()).unwrap();

    let ix = h.valid_ix("summarize", "{}");
    h.send(ix).expect("valid invocation must succeed");

    let after = h.svm.get_balance(&h.invoker.pubkey()).unwrap();
    let fee = 5_000; // one signature at the default lamports-per-signature
    assert_eq!(
        before - after,
        fee,
        "the only lamports that may leave the invoker are the transaction fee"
    );

    for pda in [invoker_agent, target_agent] {
        let acct = h.svm.get_account(&pda);
        assert!(
            acct.map(|a| a.lamports == 0 && a.data.is_empty()).unwrap_or(true),
            "the program must not create or fund {pda}"
        );
    }
    assert_eq!(
        h.svm.get_balance(&h.target_authority).unwrap_or(0),
        0,
        "the target authority must never be credited by an invocation"
    );
}

/// AI-4 (negative): a rejected invocation is equally inert. The failed call
/// leaves no account and no balance change other than the fee.
#[test]
fn rejected_invocation_leaves_no_trace() {
    let mut h = Harness::new();
    let before = h.svm.get_balance(&h.invoker.pubkey()).unwrap();

    let ix = h.valid_ix("", "{}");
    h.send(ix).expect_err("an empty skill name must be rejected");

    let after = h.svm.get_balance(&h.invoker.pubkey()).unwrap();
    assert!(
        before - after <= 5_000,
        "a rejected invocation must cost at most the transaction fee"
    );
    assert!(h
        .svm
        .get_account(&h.agent_pda(&h.invoker.pubkey()))
        .map(|a| a.data.is_empty())
        .unwrap_or(true));
}
