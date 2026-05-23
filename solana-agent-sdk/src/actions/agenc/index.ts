// AgenC adapter — public barrel.
//
// Lets three.ws agents register on the AgenC coordination protocol
// (agenc.tech, Tetsuo Corp), discover tasks, claim work, and submit
// completions. Wraps `@tetsuo-ai/sdk` so callers don't need to touch
// Anchor's `Program` directly.
//
// Quick start:
//
//   import { createAgenCClient, registerAgenCAgent } from "@three-ws/solana-agent";
//
//   const client = createAgenCClient({ cluster: "devnet", signer: myKeypair });
//   await registerAgenCAgent(client, {
//     agentId: "my-three-ws-bot",
//     capabilities: 1n,
//     endpoint: "https://three.ws/agents/my-bot",
//     stakeAmount: 1_000_000,
//   });

export {
  createAgenCClient,
  requireAgenCSigner,
  AGENC_DEVNET_PROGRAM_ID,
  AGENC_MAINNET_PROGRAM_ID,
  type AgenCClient,
  type AgenCClientOptions,
  type AgenCCluster,
} from "./client.js";

export {
  registerAgenCAgent,
  getAgenCAgent,
  deriveAgenCAgentPda,
  toAgenCAgentId,
  type AgenCAgentIdInput,
  type AgenCRegisterAgentArgs,
  type AgenCRegisterAgentResult,
} from "./agents.js";

export {
  createAgenCTask,
  getAgenCTask,
  getAgenCTaskLifecycle,
  listAgenCTasksByCreator,
  claimAgenCTask,
  completeAgenCTask,
  generateAgenCTaskId,
  toAgenCTaskId,
  encodeAgenCDescription,
  formatTaskState,
  AGENC_TASK_TYPE,
  type AgenCTaskTypeName,
  type AgenCTaskIdInput,
  type AgenCCreateTaskArgs,
  type AgenCCreateTaskResult,
  type AgenCClaimTaskArgs,
  type AgenCClaimTaskResult,
  type AgenCCompleteTaskArgs,
  type AgenCCompleteTaskResult,
} from "./tasks.js";

// Re-exports from the upstream SDK that round out the surface for advanced
// callers. Anything you can't do via this adapter, you can still reach via
// `@tetsuo-ai/sdk` directly.
export type {
  AgentState,
  TaskStatus,
  TaskLifecycleSummary,
  TaskState,
} from "@tetsuo-ai/sdk";
