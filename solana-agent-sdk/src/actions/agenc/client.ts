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
 * Devnet AgenC program ID validated by the protocol team on 2026-03-22.
 * Source: https://docs.agenc.tech/docs/runtime/api/.
 */
export const AGENC_DEVNET_PROGRAM_ID = new PublicKey(
  "6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab",
);

/**
 * Mainnet AgenC program ID. `PROGRAM_ID` exported from `@tetsuo-ai/sdk`
 * points at mainnet; we re-export here for clarity at call sites.
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
  if (signer instanceof Keypair) return signer;
  if (typeof signer === "string") {
    return Keypair.fromSecretKey(bs58.decode(signer));
  }
  return Keypair.fromSecretKey(Uint8Array.from(signer));
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

  const programId =
    opts.programId ??
    (cluster === "devnet"
      ? AGENC_DEVNET_PROGRAM_ID
      : AGENC_MAINNET_PROGRAM_ID);

  const idl = AGENC_COORDINATION_IDL as unknown as Idl;
  const program = new Program(idl, provider);

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
