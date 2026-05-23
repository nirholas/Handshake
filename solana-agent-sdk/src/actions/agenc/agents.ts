// AgenC agent registry — thin three.ws-shaped wrappers around the
// @tetsuo-ai/sdk agent helpers. Adds ergonomic conversions: a 32-byte agentId
// can be supplied as a hex string ("0x…"), a base58 32-byte string, or a UTF-8
// label (hashed via SHA-256 to 32 bytes).

import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  deriveAgentPda,
  getAgent,
  registerAgent,
  type AgentState,
  type RegisterAgentParams,
} from "@tetsuo-ai/sdk";
import bs58 from "bs58";
import {
  requireAgenCSigner,
  type AgenCClient,
} from "./client.js";

export type AgenCAgentIdInput = Uint8Array | number[] | string;

/**
 * Normalize an agent identifier into the exact 32-byte form AgenC expects.
 * Accepts: a 32-byte Uint8Array/number[], a 0x-prefixed 64-hex string,
 * a 32-byte base58 string, or any UTF-8 label (hashed via SHA-256).
 */
export function toAgenCAgentId(input: AgenCAgentIdInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== 32) {
      throw new Error(`agentId must be 32 bytes, got ${input.length}`);
    }
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length !== 32) {
      throw new Error(`agentId must be 32 bytes, got ${input.length}`);
    }
    return Uint8Array.from(input);
  }
  const s = input.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) {
    const hex = s.slice(2);
    if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(`hex agentId must be exactly 32 bytes (64 hex chars)`);
    }
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  // Try base58 → must decode to exactly 32 bytes; otherwise treat as label.
  try {
    const decoded = bs58.decode(s);
    if (decoded.length === 32) return decoded;
  } catch {
    // fall through to label hashing
  }
  // UTF-8 label: hash to 32 bytes so any human-readable identifier maps to a
  // deterministic on-chain id.
  return Uint8Array.from(createHash("sha256").update(s, "utf8").digest());
}

export interface AgenCRegisterAgentArgs {
  /** 32-byte agent id (or any string — hashed via toAgenCAgentId). */
  agentId: AgenCAgentIdInput;
  /** u64 capability bitmask describing what this agent can do. */
  capabilities: number | bigint;
  /** Public endpoint where the agent can be reached (URL or DID). */
  endpoint: string;
  /** Optional pointer to extended metadata (IPFS/HTTPS). */
  metadataUri?: string | null;
  /**
   * Stake in lamports. Required to satisfy on-chain economic checks; the
   * AgenC protocol slashes this on dispute resolution.
   */
  stakeAmount: number | bigint;
}

export interface AgenCRegisterAgentResult {
  agentPda: PublicKey;
  agentId: Uint8Array;
  txSignature: string;
}

/** Register a new agent on the AgenC coordination protocol. */
export async function registerAgenCAgent(
  client: AgenCClient,
  args: AgenCRegisterAgentArgs,
): Promise<AgenCRegisterAgentResult> {
  const signer = requireAgenCSigner(client);
  const agentId = toAgenCAgentId(args.agentId);
  const params: RegisterAgentParams = {
    agentId,
    capabilities: args.capabilities,
    endpoint: args.endpoint,
    metadataUri: args.metadataUri ?? null,
    stakeAmount: args.stakeAmount,
  };
  const result = await registerAgent(
    client.connection,
    client.program,
    signer,
    params,
  );
  return {
    agentPda: result.agentPda,
    agentId,
    txSignature: result.txSignature,
  };
}

/**
 * Look up an AgenC agent by id (32-byte form, hex string, or label) or by PDA.
 * Returns null if the account does not exist.
 */
export async function getAgenCAgent(
  client: AgenCClient,
  idOrPda: AgenCAgentIdInput | PublicKey,
): Promise<AgentState | null> {
  const agentPda =
    idOrPda instanceof PublicKey
      ? idOrPda
      : deriveAgentPda(toAgenCAgentId(idOrPda), client.programId);
  return getAgent(client.program, agentPda);
}

/** Derive the on-chain PDA for an AgenC agent without fetching state. */
export function deriveAgenCAgentPda(
  client: AgenCClient,
  id: AgenCAgentIdInput,
): PublicKey {
  return deriveAgentPda(toAgenCAgentId(id), client.programId);
}
