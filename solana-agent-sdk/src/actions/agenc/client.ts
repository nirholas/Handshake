// AgenC client — wraps Connection + Anchor Program for the AgenC coordination
// protocol (agenc.tech, published by Tetsuo Corp). Lets three.ws agents
// register, list tasks, claim, and complete work on the public protocol
// without taking a direct dependency on Anchor in user-land code.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AnchorProvider,
  Program,
  type Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import { AGENC_COORDINATION_IDL } from "@tetsuo-ai/protocol";
import { DEVNET_RPC, MAINNET_RPC, PROGRAM_ID } from "@tetsuo-ai/sdk";
import bs58 from "bs58";

export type AgenCCluster = "mainnet" | "devnet";

/**
 * Devnet AgenC program ID as published by the protocol team on 2026-03-22
 * (source: https://docs.agenc.tech/docs/runtime/api/).
 *
 * HISTORICAL, and no longer the client default. The bundled
 * `AGENC_COORDINATION_IDL` now declares a different address, and the IDL is what
 * Anchor executes every instruction against, so `createAgenCClient` derives its
 * `programId` from the program itself. Kept as a named export for callers that
 * pin this specific deployment via `opts.programId`; do not reintroduce it as a
 * default, or reads and writes drift onto two different programs.
 */
export const AGENC_DEVNET_PROGRAM_ID = new PublicKey(
  "6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab",
);

/**
 * Mainnet AgenC program ID re-exported from `@tetsuo-ai/sdk`. Same caveat as
 * AGENC_DEVNET_PROGRAM_ID: historical, not the client default. The IDL address
 * wins.
 */
export const AGENC_MAINNET_PROGRAM_ID = PROGRAM_ID;

export interface AgenCClientOptions {
  /** "mainnet" or "devnet"; ignored if `rpcUrl` is set. Defaults to "mainnet". */
  cluster?: AgenCCluster;
  /** Override the RPC endpoint (e.g. a Helius/Triton URL). */
  rpcUrl?: string;
  /**
   * Signer for mutating instructions. Read-only operations work without one.
   * Pass either a raw `Keypair` (preferred — AgenC's SDK takes `Keypair`),
   * a base58 string, or a 64-byte secret-key array.
   */
  signer?: Keypair | string | Uint8Array | number[];
  /** Override the AgenC coordination program ID (advanced; rarely needed). */
  programId?: PublicKey;
}

export interface AgenCClient {
  connection: Connection;
  program: Program<Idl>;
  programId: PublicKey;
  cluster: AgenCCluster;
  signer: Keypair | null;
}

function resolveSigner(
  signer: AgenCClientOptions["signer"],
): Keypair | null {
  if (!signer) return null;
  // Duck-type Keypair so calling code that resolved a different copy of
  // @solana/web3.js (npm dedup misses are common in monorepos / file:
  // installs) still works.
  if (
    typeof signer === "object" &&
    !Array.isArray(signer) &&
    !(signer instanceof Uint8Array) &&
    "secretKey" in (signer as object) &&
    "publicKey" in (signer as object)
  ) {
    const candidate = signer as { secretKey: Uint8Array };
    return Keypair.fromSecretKey(Uint8Array.from(candidate.secretKey));
  }
  if (typeof signer === "string") {
    return Keypair.fromSecretKey(bs58.decode(signer));
  }
  return Keypair.fromSecretKey(Uint8Array.from(signer as Uint8Array | number[]));
}

function buildWallet(signer: Keypair | null): Wallet {
  if (signer) {
    return {
      payer: signer,
      publicKey: signer.publicKey,
      async signTransaction<T extends Transaction | VersionedTransaction>(
        tx: T,
      ): Promise<T> {
        if (tx instanceof VersionedTransaction) tx.sign([signer]);
        else (tx as Transaction).partialSign(signer);
        return tx;
      },
      async signAllTransactions<T extends Transaction | VersionedTransaction>(
        txs: T[],
      ): Promise<T[]> {
        for (const tx of txs) {
          if (tx instanceof VersionedTransaction) tx.sign([signer]);
          else (tx as Transaction).partialSign(signer);
        }
        return txs;
      },
    };
  }
  // Read-only wallet: signing throws. Anchor still needs a valid publicKey +
  // payer slot for provider construction, so we hold an ephemeral keypair —
  // it is never used to authorize a transaction.
  const ephemeral = Keypair.generate();
  return {
    payer: ephemeral,
    publicKey: ephemeral.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      _tx: T,
    ): Promise<T> {
      throw new Error(
        "AgenC client is read-only — pass `signer` in createAgenCClient() to mutate.",
      );
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      _txs: T[],
    ): Promise<T[]> {
      throw new Error(
        "AgenC client is read-only — pass `signer` in createAgenCClient() to mutate.",
      );
    },
  };
}

/**
 * Build an AgenCClient bound to a Solana cluster and (optionally) a signer.
 * Read-only methods (list tasks, get agent, get task status) work without a
 * signer; any state-mutating call requires `signer` to be set.
 */
export function createAgenCClient(opts: AgenCClientOptions = {}): AgenCClient {
  const cluster: AgenCCluster = opts.cluster ?? "mainnet";
  const rpcUrl =
    opts.rpcUrl ?? (cluster === "devnet" ? DEVNET_RPC : MAINNET_RPC);
  const connection = new Connection(rpcUrl, "confirmed");
  const signer = resolveSigner(opts.signer);
  const provider = new AnchorProvider(connection, buildWallet(signer), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  const idl = AGENC_COORDINATION_IDL as unknown as Idl;
  const program = new Program(idl, provider);

  // PDA derivation MUST use the same program the instructions execute against.
  // Anchor builds `program` from the IDL's declared address, so that address is
  // authoritative for both reads and writes; the AGENC_*_PROGRAM_ID constants
  // below have drifted from it. Defaulting `programId` to the constants split
  // the client in two: writes landed under the IDL's program while
  // deriveAgenCAgentPda/deriveTaskPda derived addresses under the stale one, so
  // every read resolved to an account that does not exist. The visible symptom
  // was a registration that could never be idempotent: getAgenCAgent returned
  // null for an agent that was plainly on-chain, the caller re-registered, and
  // the program failed with "Allocate: account already in use". Reading the
  // address off the program keeps the two in step through any redeploy.
  const programId = opts.programId ?? program.programId;

  return { connection, program, programId, cluster, signer };
}

/** Throws if the client was built without a signer. Used by mutating helpers. */
export function requireAgenCSigner(client: AgenCClient): Keypair {
  if (!client.signer) {
    throw new Error(
      "AgenC client is read-only — pass `signer` in createAgenCClient() to mutate.",
    );
  }
  return client.signer;
}
