// AgenC task lifecycle — three.ws-shaped wrappers around @tetsuo-ai/sdk task
// helpers. Covers create / list / get / claim / complete. Mutations require
// a client built with `signer`; reads work on any client.

import { PublicKey } from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import {
  claimTask,
  completeTask,
  createTask,
  deriveTaskPda,
  formatTaskState,
  getTask,
  getTaskLifecycleSummary,
  getTasksByCreator,
  type TaskLifecycleSummary,
  type TaskParams,
  type TaskStatus,
} from "@tetsuo-ai/sdk";
import { toAgenCAgentId, type AgenCAgentIdInput } from "./agents.js";
import {
  requireAgenCSigner,
  type AgenCClient,
} from "./client.js";

/** Public-protocol task type discriminants per AgenC IDL. */
export const AGENC_TASK_TYPE = {
  Exclusive: 0,
  Collaborative: 1,
  Competitive: 2,
} as const;
export type AgenCTaskTypeName = keyof typeof AGENC_TASK_TYPE;

export type AgenCTaskIdInput = Uint8Array | number[] | string;

/**
 * Normalize a task id to its 32-byte form. Mirrors `toAgenCAgentId`:
 * 32-byte raw bytes / 0x-hex / SHA-256 of a UTF-8 label.
 */
export function toAgenCTaskId(input: AgenCTaskIdInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== 32) throw new Error(`taskId must be 32 bytes`);
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length !== 32) throw new Error(`taskId must be 32 bytes`);
    return Uint8Array.from(input);
  }
  const s = input.trim();
  if (s.startsWith("0x") || s.startsWith("0X")) {
    const hex = s.slice(2);
    if (hex.length !== 64) throw new Error(`hex taskId must be 32 bytes`);
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  return Uint8Array.from(createHash("sha256").update(s, "utf8").digest());
}

/** Generate a fresh random 32-byte task id. */
export function generateAgenCTaskId(): Uint8Array {
  return Uint8Array.from(randomBytes(32));
}

/**
 * AgenC's TaskParams.description must be exactly 64 bytes. This helper packs
 * an arbitrary string into that shape: short strings are zero-padded; longer
 * strings are summarized as `sha256(text)` (32 bytes) concatenated with the
 * first 32 bytes of UTF-8 so the on-chain hash both binds the full payload
 * and preserves a readable prefix.
 */
export function encodeAgenCDescription(text: string): Uint8Array {
  const utf8 = Buffer.from(text, "utf8");
  if (utf8.length <= 64) {
    const out = Buffer.alloc(64);
    utf8.copy(out, 0);
    return Uint8Array.from(out);
  }
  const hash = createHash("sha256").update(utf8).digest();
  const prefix = utf8.subarray(0, 32);
  return Uint8Array.from(Buffer.concat([hash, prefix], 64));
}

export interface AgenCCreateTaskArgs {
  /** 32-byte task id; pass `generateAgenCTaskId()` for a random one. */
  taskId?: AgenCTaskIdInput;
  /** Agent id of the creator (32-byte form or label). */
  creatorAgentId: AgenCAgentIdInput;
  /** Required capability bitmask (u64). */
  requiredCapabilities: number | bigint;
  /** Free-form task description; encoded into the on-chain 64-byte slot. */
  description: string | Uint8Array | Buffer;
  /** Reward in lamports (or token base units when `rewardMint` is set). */
  rewardAmount: number | bigint;
  /** Maximum concurrent workers (u8). */
  maxWorkers: number;
  /** Unix timestamp (seconds) the task must be completed by. */
  deadline: number;
  /** Task type: "Exclusive" | "Collaborative" | "Competitive". */
  taskType?: AgenCTaskTypeName;
  /** Minimum reputation a worker needs (u16). Defaults to 0. */
  minReputation?: number;
  /** Optional SPL mint for token-denominated rewards. */
  rewardMint?: PublicKey | null;
  /** Optional creator token account when `rewardMint` is set. */
  creatorTokenAccount?: PublicKey;
}

export interface AgenCCreateTaskResult {
  taskPda: PublicKey;
  taskId: Uint8Array;
  txSignature: string;
}

/** Create a new public AgenC task. */
export async function createAgenCTask(
  client: AgenCClient,
  args: AgenCCreateTaskArgs,
): Promise<AgenCCreateTaskResult> {
  const signer = requireAgenCSigner(client);
  const taskId = args.taskId
    ? toAgenCTaskId(args.taskId)
    : generateAgenCTaskId();
  const description =
    typeof args.description === "string"
      ? encodeAgenCDescription(args.description)
      : (() => {
          const buf = Buffer.isBuffer(args.description)
            ? args.description
            : Buffer.from(args.description);
          if (buf.length !== 64) {
            throw new Error(
              `description bytes must be exactly 64 bytes, got ${buf.length}. Use encodeAgenCDescription(string) to pack arbitrary text.`,
            );
          }
          return Uint8Array.from(buf);
        })();

  const params: TaskParams = {
    taskId,
    requiredCapabilities: args.requiredCapabilities,
    description,
    rewardAmount: args.rewardAmount,
    maxWorkers: args.maxWorkers,
    deadline: args.deadline,
    taskType: AGENC_TASK_TYPE[args.taskType ?? "Exclusive"],
    minReputation: args.minReputation ?? 0,
    rewardMint: args.rewardMint ?? null,
    creatorTokenAccount: args.creatorTokenAccount,
  };

  const result = await createTask(
    client.connection,
    client.program,
    signer,
    toAgenCAgentId(args.creatorAgentId),
    params,
  );

  return {
    taskPda: result.taskPda,
    taskId,
    txSignature: result.txSignature,
  };
}

/** Fetch a single task. Pass either the on-chain PDA or `{creator, taskId}`. */
export async function getAgenCTask(
  client: AgenCClient,
  ref: PublicKey | { creator: PublicKey; taskId: AgenCTaskIdInput },
): Promise<TaskStatus | null> {
  const taskPda =
    ref instanceof PublicKey
      ? ref
      : deriveTaskPda(ref.creator, toAgenCTaskId(ref.taskId), client.programId);
  return getTask(client.program, taskPda);
}

/** Fetch the timeline + current state for a task. */
export async function getAgenCTaskLifecycle(
  client: AgenCClient,
  taskPda: PublicKey,
): Promise<TaskLifecycleSummary | null> {
  return getTaskLifecycleSummary(client.program, taskPda);
}

/** List every task created by a given creator wallet. */
export async function listAgenCTasksByCreator(
  client: AgenCClient,
  creator: PublicKey,
): Promise<TaskStatus[]> {
  return getTasksByCreator(client.program, creator);
}

export interface AgenCClaimTaskArgs {
  taskPda: PublicKey;
  workerAgentId: AgenCAgentIdInput;
}

export interface AgenCClaimTaskResult {
  txSignature: string;
}

/** Claim a public task as a worker. */
export async function claimAgenCTask(
  client: AgenCClient,
  args: AgenCClaimTaskArgs,
): Promise<AgenCClaimTaskResult> {
  const signer = requireAgenCSigner(client);
  const result = await claimTask(
    client.connection,
    client.program,
    signer,
    toAgenCAgentId(args.workerAgentId),
    args.taskPda,
  );
  return { txSignature: result.txSignature };
}

export interface AgenCCompleteTaskArgs {
  taskPda: PublicKey;
  workerAgentId: AgenCAgentIdInput;
  /** 32-byte proof hash. Pass raw bytes or a 0x-hex string. */
  proofHash: Uint8Array | number[] | string;
  /** Optional 64-byte result payload. */
  resultData?: Uint8Array | number[] | null;
}

export interface AgenCCompleteTaskResult {
  txSignature: string;
}

function normalizeProofHash(
  input: AgenCCompleteTaskArgs["proofHash"],
): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input);
  const s = input.trim();
  const hex = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`proofHash must be 32 bytes (64 hex chars)`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Complete a public task (non-private flow — use completeTaskPrivate via @tetsuo-ai/sdk for zk settlement). */
export async function completeAgenCTask(
  client: AgenCClient,
  args: AgenCCompleteTaskArgs,
): Promise<AgenCCompleteTaskResult> {
  const signer = requireAgenCSigner(client);
  const result = await completeTask(
    client.connection,
    client.program,
    signer,
    toAgenCAgentId(args.workerAgentId),
    args.taskPda,
    normalizeProofHash(args.proofHash),
    args.resultData ?? null,
  );
  return { txSignature: result.txSignature };
}

/** Human-readable label for a TaskState enum value (re-exported for convenience). */
export { formatTaskState };
