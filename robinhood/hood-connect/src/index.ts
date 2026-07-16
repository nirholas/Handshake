/**
 * hood-connect: wallet + onboarding kit for Robinhood Chain (chain ID 4663).
 *
 * Framework-free core: EIP-6963 wallet discovery, EIP-3085 add-network,
 * connect + add + switch in one call, balance bootstrap checks, and a live
 * bridge funding funnel (LI.FI primary, Relay fallback).
 *
 * React components live in `hood-connect/react`, the wagmi config in
 * `hood-connect/wagmi`.
 *
 * @packageDocumentation
 */

// chains
export {
  robinhood,
  robinhoodTestnet,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  chainForNetwork,
  toAddChainParams,
  addNetwork,
  getWalletChainId,
} from './core/chains.js'
export type { AddEthereumChainParameter, AddNetworkOptions, HoodNetwork } from './core/chains.js'

// discovery
export {
  discoverWallets,
  watchWallets,
  legacyProvider,
  legacyProviderDetail,
  LEGACY_RDNS,
} from './core/discovery.js'
export type {
  DiscoveryOptions,
  DiscoverWalletsOptions,
  Eip6963ProviderDetail,
  Eip6963ProviderInfo,
} from './core/discovery.js'

// ensure chain
export { ensureChain } from './core/ensure-chain.js'
export type { EnsureChainOptions, EnsureChainResult, EnsureChainState } from './core/ensure-chain.js'

// bootstrap
export { checkBootstrap, fundingOptionsFor } from './core/bootstrap.js'
export type { BootstrapStatus, CheckBootstrapOptions, FundingOption } from './core/bootstrap.js'

// funding
export {
  getFundingQuote,
  getLifiQuote,
  getRelayQuote,
  getFundingStatus,
  listFundingChains,
  parseLifiQuote,
  parseRelayQuote,
  NATIVE_TOKEN,
  LIFI_API,
  RELAY_API,
} from './core/funding.js'
export type {
  FundingApproval,
  FundingChain,
  FundingQuote,
  FundingQuoteRequest,
  FundingStatus,
  FundingTx,
} from './core/funding.js'

// errors
export {
  HoodConnectError,
  NoProviderError,
  ConnectionRejectedError,
  ChainAddRejectedError,
  ChainSwitchRejectedError,
  FundingRouteError,
  providerErrorCode,
  providerErrorMessage,
  isUserRejection,
  isUnrecognizedChain,
} from './core/errors.js'

// provider types
export type { Eip1193Provider, Eip1193RequestArguments, ProviderRpcError } from './core/provider.js'
