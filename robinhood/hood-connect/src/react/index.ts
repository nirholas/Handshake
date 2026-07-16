/**
 * hood-connect/react: drop-in components and headless hooks for Robinhood
 * Chain onboarding. Requires React >= 18; the core (`hood-connect`) stays
 * framework-free.
 *
 * @packageDocumentation
 */

export { HoodConnectButton } from './HoodConnectButton.js'
export type { HoodConnectButtonProps } from './HoodConnectButton.js'

export { FundWallet } from './FundWallet.js'
export type { FundWalletProps } from './FundWallet.js'

export { useHoodAccount, useEnsureChain, useWallets } from './hooks.js'
export type { HoodAccount, UseEnsureChainState } from './hooks.js'

export { injectStyles, HOOD_CONNECT_STYLES } from './styles.js'

export { connect, disconnect, subscribe, getSnapshot, isWrongChain } from './store.js'
export type { ConnectionSnapshot, ConnectionStatus } from './store.js'
