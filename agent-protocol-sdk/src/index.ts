import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, type Idl } from '@coral-xyz/anchor';
import { IDL, AGENT_INVOCATION_PROGRAM_ID } from './idl.js';

export { IDL, AGENT_INVOCATION_PROGRAM_ID } from './idl.js';
export type { AgentInvocation } from './idl.js';

/** PDA seed prefix shared with the on-chain program (`b"agent"`). */
const AGENT_SEED = Buffer.from('agent');

/** On-chain limits enforced by the program; validated client-side too so callers
 *  get a clear error instead of a failed simulation. */
export const MAX_SKILL_NAME_LEN = 64;
export const MAX_PARAMETERS_LEN = 512;

/**
 * Derive an agent's program-derived identity from the authority that owns it.
 * Matches `seeds = [b"agent", authority]` in the on-chain program.
 */
export function deriveAgentPda(
  authority: PublicKey,
  programId: PublicKey = new PublicKey(AGENT_INVOCATION_PROGRAM_ID),
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([AGENT_SEED, authority.toBuffer()], programId);
}

export interface InvokeSkillParams {
  /** Live Solana connection used to build and send the transaction. */
  connection: Connection;
  /** Keypair that owns the invoking agent. Signs and pays for the transaction. */
  invokerAuthority: Keypair;
  /** Authority that owns the target agent (its agent PDA is re-derived from this). */
  targetAuthority: PublicKey;
  /** Skill identifier to invoke (1-64 bytes). */
  skillName: string;
  /** Opaque parameter blob passed to the skill (≤512 bytes), typically JSON. */
  parameters: string;
  /** Override the program id, e.g. when pointing at a devnet deployment. */
  programId?: PublicKey;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Record a verifiable skill invocation from one agent to another. Validates the
 * inputs against the program's on-chain limits, derives both agent PDAs, builds
 * the `invoke_skill` instruction, and submits it.
 *
 * @returns the confirmed transaction signature.
 */
export async function invokeSkill({
  connection,
  invokerAuthority,
  targetAuthority,
  skillName,
  parameters,
  programId = new PublicKey(AGENT_INVOCATION_PROGRAM_ID),
}: InvokeSkillParams): Promise<string> {
  if (skillName.length === 0) {
    throw new Error('skillName must not be empty');
  }
  if (byteLength(skillName) > MAX_SKILL_NAME_LEN) {
    throw new Error(`skillName exceeds ${MAX_SKILL_NAME_LEN} bytes`);
  }
  if (byteLength(parameters) > MAX_PARAMETERS_LEN) {
    throw new Error(`parameters exceed ${MAX_PARAMETERS_LEN} bytes`);
  }

  const provider = new AnchorProvider(connection, new Wallet(invokerAuthority), {
    commitment: 'confirmed',
  });
  // Anchor 0.30+ camelCases the IDL at runtime (methods.invokeSkill), while our
  // hand-maintained IDL literal keeps the on-chain snake_case names, so type
  // the program against the generic Idl rather than the raw literal type.
  const idl = { ...IDL, address: programId.toBase58() } as unknown as Idl;
  const program = new Program(idl, provider);

  const instruction = await program.methods
    .invokeSkill(skillName, parameters)
    .accounts({
      invokerAuthority: invokerAuthority.publicKey,
      targetAuthority: targetAuthority,
    })
    .instruction();

  const transaction = new Transaction().add(instruction);
  return sendAndConfirmTransaction(connection, transaction, [invokerAuthority], {
    commitment: 'confirmed',
  });
}
