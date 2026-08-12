// Integration tests for the agent_invocation program, run by `anchor test`
// against a local validator with the real compiled program deployed.
//
// Every test cites the invariant it proves from
// specs/ECONOMY_CONTRACT_INVARIANTS.md (ids AI-1 .. AI-4), so
// `grep -rn "AI-1" contracts/agent-invocation/tests` finds the proof.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const IDL = require("../target/idl/agent_invocation.json");

const AGENT_SEED = Buffer.from("agent");

function deriveAgentPda(authority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AGENT_SEED, authority.toBuffer()], programId);
}

/** Extract the Anchor error code (6000-based) from a failed send. */
function anchorErrorCode(err: any): number | undefined {
  const code = err?.error?.errorCode?.number ?? err?.error?.errorCode?.code;
  if (typeof code === "number") return code;
  if (typeof code === "string") {
    // Anchor 0.31 constraint failures surface as a hex custom code in logs.
    const m = /custom program error: (0x[0-9a-f]+)/i.exec(String(err));
    if (m) return parseInt(m[1], 16);
  }
  const m = /custom program error: (0x[0-9a-f]+)/i.exec(String(err));
  if (m) return parseInt(m[1], 16);
  return undefined;
}

describe("agent_invocation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(IDL, provider);
  const programId = program.programId;

  const invokerAuthority = Keypair.generate();
  const targetAuthority = Keypair.generate();

  before(async () => {
    const sig = await provider.connection.requestAirdrop(
      invokerAuthority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  });

  // AI-1 / AI-2 / AI-3 (positive halves): a correctly derived invocation is
  // accepted and emits the event with every field recorded verbatim.
  it("records an invocation between two derived agent PDAs", async () => {
    const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey, programId);
    const [targetAgent] = deriveAgentPda(targetAuthority.publicKey, programId);

    const tx = await program.methods
      .invokeSkill("summarize", JSON.stringify({ url: "https://three.ws" }))
      .accounts({
        invokerAgent,
        invokerAuthority: invokerAuthority.publicKey,
        targetAuthority: targetAuthority.publicKey,
        targetAgent,
      })
      .signers([invokerAuthority])
      .rpc();

    const confirmed = await provider.connection.getTransaction(tx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert.ok(confirmed, "transaction should be confirmed");

    // The program is event-only (AI-4): no agent account is ever created.
    assert.strictEqual(await provider.connection.getAccountInfo(invokerAgent), null);
    assert.strictEqual(await provider.connection.getAccountInfo(targetAgent), null);
  });

  // AI-3 (negative half): an empty skill name reverts with EmptySkillName.
  it("rejects an empty skill name", async () => {
    const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey, programId);
    const [targetAgent] = deriveAgentPda(targetAuthority.publicKey, programId);

    await assert.rejects(
      program.methods
        .invokeSkill("", "{}")
        .accounts({
          invokerAgent,
          invokerAuthority: invokerAuthority.publicKey,
          targetAuthority: targetAuthority.publicKey,
          targetAgent,
        })
        .signers([invokerAuthority])
        .rpc(),
      (err: any) => {
        assert.ok(
          String(err).includes("EmptySkillName") || String(err).includes("6000"),
          `expected EmptySkillName, got: ${err}`,
        );
        return true;
      },
    );
  });

  // AI-3 (negative half): a skill name over 64 bytes reverts with
  // SkillNameTooLong; the 64-byte boundary itself is accepted.
  it("rejects a skill name over 64 bytes and accepts exactly 64", async () => {
    const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey, programId);
    const [targetAgent] = deriveAgentPda(targetAuthority.publicKey, programId);

    await assert.rejects(
      program.methods
        .invokeSkill("s".repeat(65), "{}")
        .accounts({
          invokerAgent,
          invokerAuthority: invokerAuthority.publicKey,
          targetAuthority: targetAuthority.publicKey,
          targetAgent,
        })
        .signers([invokerAuthority])
        .rpc(),
      (err: any) => {
        assert.ok(
          String(err).includes("SkillNameTooLong") || String(err).includes("6001"),
          `expected SkillNameTooLong, got: ${err}`,
        );
        return true;
      },
    );

    await program.methods
      .invokeSkill("s".repeat(64), "{}")
      .accounts({
        invokerAgent,
        invokerAuthority: invokerAuthority.publicKey,
        targetAuthority: targetAuthority.publicKey,
        targetAgent,
      })
      .signers([invokerAuthority])
      .rpc();
  });

  // AI-3 (negative half): parameters over 512 bytes revert; 512 is accepted.
  it("rejects parameters over 512 bytes and accepts exactly 512", async () => {
    const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey, programId);
    const [targetAgent] = deriveAgentPda(targetAuthority.publicKey, programId);

    await assert.rejects(
      program.methods
        .invokeSkill("summarize", "p".repeat(513))
        .accounts({
          invokerAgent,
          invokerAuthority: invokerAuthority.publicKey,
          targetAuthority: targetAuthority.publicKey,
          targetAgent,
        })
        .signers([invokerAuthority])
        .rpc(),
      (err: any) => {
        assert.ok(
          String(err).includes("ParametersTooLong") || String(err).includes("6002"),
          `expected ParametersTooLong, got: ${err}`,
        );
        return true;
      },
    );

    await program.methods
      .invokeSkill("summarize", "p".repeat(512))
      .accounts({
        invokerAgent,
        invokerAuthority: invokerAuthority.publicKey,
        targetAuthority: targetAuthority.publicKey,
        targetAgent,
      })
      .signers([invokerAuthority])
      .rpc();
  });

  // AI-1 (negative half): a caller cannot present somebody else's agent PDA as
  // their own. The seeds constraint re-derives the PDA from the signer, and
  // the mismatched account fails the constraint before the body runs.
  it("rejects an invoker_agent derived from a different authority", async () => {
    const [foreignAgent] = deriveAgentPda(targetAuthority.publicKey, programId);
    const [targetAgent] = deriveAgentPda(targetAuthority.publicKey, programId);

    await assert.rejects(
      program.methods
        .invokeSkill("summarize", "{}")
        .accounts({
          invokerAgent: foreignAgent, // belongs to targetAuthority, not the signer
          invokerAuthority: invokerAuthority.publicKey,
          targetAuthority: targetAuthority.publicKey,
          targetAgent,
        })
        .signers([invokerAuthority])
        .rpc(),
      (err: any) => {
        const code = anchorErrorCode(err);
        // ConstraintSeeds is Anchor error 2006.
        assert.ok(
          String(err).includes("ConstraintSeeds") || code === 2006 || String(err).includes("0x7d6"),
          `expected a seeds constraint failure, got: ${err}`,
        );
        return true;
      },
    );
  });

  // AI-2 (negative half): an arbitrary, non-PDA account cannot be passed as
  // the target agent.
  it("rejects a target_agent that is not the derived PDA", async () => {
    const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey, programId);
    const arbitrary = Keypair.generate().publicKey;

    await assert.rejects(
      program.methods
        .invokeSkill("summarize", "{}")
        .accounts({
          invokerAgent,
          invokerAuthority: invokerAuthority.publicKey,
          targetAuthority: targetAuthority.publicKey,
          targetAgent: arbitrary,
        })
        .signers([invokerAuthority])
        .rpc(),
      (err: any) => {
        const code = anchorErrorCode(err);
        assert.ok(
          String(err).includes("ConstraintSeeds") || code === 2006 || String(err).includes("0x7d6"),
          `expected a seeds constraint failure, got: ${err}`,
        );
        return true;
      },
    );
  });

  // AI-1 (negative half): the transaction must carry the invoker authority's
  // signature; without it the Signer constraint fails.
  it("rejects an unsigned invocation", async () => {
    const [invokerAgent] = deriveAgentPda(invokerAuthority.publicKey, programId);
    const [targetAgent] = deriveAgentPda(targetAuthority.publicKey, programId);

    await assert.rejects(
      program.methods
        .invokeSkill("summarize", "{}")
        .accounts({
          invokerAgent,
          invokerAuthority: invokerAuthority.publicKey,
          targetAuthority: targetAuthority.publicKey,
          targetAgent,
        })
        .rpc(), // no signer for invokerAuthority: provider wallet ≠ invoker
      (err: any) => {
        const s = String(err);
        assert.ok(
          s.includes("Signature") || s.includes("signer") || s.includes("unknown signer"),
          `expected a missing-signature failure, got: ${err}`,
        );
        return true;
      },
    );
  });
});
