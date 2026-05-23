// Agent
export { SolanaAgent } from "./agent.js";
export type { SolanaAgentConfig } from "./agent.js";

// Wallet providers
export { KeypairWalletProvider } from "./wallet/keypair.js";
export { BrowserWalletProvider } from "./wallet/browser-server.js";
export { BrowserWalletClient } from "./wallet/browser-client.js";
export { WalletAdapterProvider } from "./wallet/wallet-adapter.js";
export type { WalletProvider, TxMetadata, MetaAwareWallet } from "./wallet/types.js";
export { isMetaAware } from "./wallet/types.js";
export type { BrowserWalletOptions, PendingTx } from "./wallet/browser-server.js";
export type { SignerFn, ApprovalHandler, BrowserWalletClientOptions } from "./wallet/browser-client.js";
export type { WalletAdapterLike } from "./wallet/wallet-adapter.js";

// Actions
export { transferSol } from "./actions/transfer-sol.js";
export type { TransferSolParams } from "./actions/transfer-sol.js";
export { transferSpl } from "./actions/transfer-spl.js";
export type { TransferSplParams } from "./actions/transfer-spl.js";
export { jupiterSwap, getSwapQuote, SOL_MINT } from "./actions/swap.js";
export type { SwapParams, JupiterQuote } from "./actions/swap.js";
export { getOrCreateAta } from "./actions/ata.js";
export type { GetOrCreateAtaParams, GetOrCreateAtaResult } from "./actions/ata.js";
export { getTokenBalance } from "./actions/get-token-balance.js";
export type { TokenBalanceResult } from "./actions/get-token-balance.js";
export { getTokenAccounts } from "./actions/get-token-accounts.js";
export type { TokenAccount } from "./actions/get-token-accounts.js";
export { stakeSOL, unstakeSOL, getStakeAccounts } from "./actions/stake.js";
export type { StakeSolParams, StakeSolResult, UnstakeSolParams, StakeAccountInfo } from "./actions/stake.js";

// Errors
export {
  SolanaAgentError,
  TransactionRejectedError,
  WalletNotConnectedError,
  WalletCapabilityError,
  MissingTokenAccountError,
  SwapError,
  SimulationError,
  ConfirmationTimeoutError,
} from "./errors.js";

// TX utilities
export { buildAndSend, fetchLookupTables, estimatePriorityFee, estimateComputeUnits, priorityFeeIx, computeUnitIx } from "./tx/index.js";
export type { BuildAndSendOptions } from "./tx/build.js";

// Memo
export { memoInstruction, MEMO_PROGRAM_ID } from "./utils/memo.js";

// Format utilities
export { toUiAmount } from "./utils/format.js";

// AgenC adapter — read + write the AgenC coordination protocol (agenc.tech).
export * from "./actions/agenc/index.js";
