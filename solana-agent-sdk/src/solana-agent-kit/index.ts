/**
 * solana-agent-kit plugin for @three-ws/solana-agent
 *
 * Usage with solana-agent-kit v2:
 * ```ts
 * import { SolanaAgentKit } from "solana-agent-kit";
 * import { SolanaAgentPlugin } from "@three-ws/solana-agent/solana-agent-kit";
 *
 * const agent = new SolanaAgentKit(privateKey, rpcUrl, {});
 * agent.use(SolanaAgentPlugin);
 * ```
 *
 * Or use the actions directly with SolanaAgent:
 * ```ts
 * import { SolanaAgent } from "@three-ws/solana-agent";
 * import { allActions } from "@three-ws/solana-agent/solana-agent-kit";
 *
 * const agent = SolanaAgent.fromKeypair(key, rpcUrl);
 * const result = await swapAction.handler(agent, { inputMint: ..., outputMint: ..., amount: ... });
 * ```
 */

import type { Plugin, SolanaAgentLike } from "./types.js";
import { allActions } from "./actions.js";
import { transferSol } from "../actions/transfer-sol.js";
import { transferSpl } from "../actions/transfer-spl.js";
import { jupiterSwap, getSwapQuote } from "../actions/swap.js";
import { getOrCreateAta } from "../actions/ata.js";
import { PublicKey } from "@solana/web3.js";

export const SolanaAgentPlugin: Plugin = {
  name: "solana-agent",

  methods: {
    transferSol: (agent: SolanaAgentLike, to: string, amount: number) =>
      transferSol(agent.wallet, agent.connection, { to: new PublicKey(to), amount }),

    transferSpl: (agent: SolanaAgentLike, mint: string, to: string, amount: bigint) =>
      transferSpl(agent.wallet, agent.connection, { mint: new PublicKey(mint), to: new PublicKey(to), amount }),

    swap: (agent: SolanaAgentLike, inputMint: string, outputMint: string, amount: bigint, slippageBps?: number) =>
      jupiterSwap(agent.wallet, agent.connection, { inputMint, outputMint, amount, slippageBps }),

    getSwapQuote: (_agent: SolanaAgentLike, inputMint: string, outputMint: string, amount: bigint) =>
      getSwapQuote({ inputMint, outputMint, amount }),

    getOrCreateAta: (agent: SolanaAgentLike, mint: string, owner?: string) =>
      getOrCreateAta(agent.wallet, agent.connection, { mint, owner }),

    getBalance: (agent: SolanaAgentLike) =>
      agent.connection.getBalance(agent.publicKey),
  },

  actions: allActions,
};

export {
  transferSolAction,
  transferSplAction,
  swapAction,
  getSwapQuoteAction,
  getBalanceAction,
  createAtaAction,
  stakeSolAction,
  unstakeSolAction,
  getStakeAccountsAction,
  allActions,
} from "./actions.js";

export type { Action, ActionExample, ActionHandler, Plugin, SolanaAgentLike } from "./types.js";
