/**
 * ERC-8056 ABI fragments and ERC-165 interface identifiers.
 *
 * Sources, all verified during development (2026-07-15):
 * - The draft spec: https://eips.ethereum.org/EIPS/eip-8056
 *   (ethereum/ERCs `ERCS/erc-8056.md`, status Draft, created 2025-10-20).
 * - The verified `Stock` implementation behind every canonical Robinhood
 *   Chain Stock Token BeaconProxy
 *   (impl `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`, source on
 *   https://robinhoodchain.blockscout.com).
 * - Live `supportsInterface` reads on chain 4663 (AAPL, SGOV, WEEK) confirm
 *   every interface ID below.
 */

/**
 * ERC-165 interface identifiers, from the spec and re-derived from selector
 * XOR during development (`cast sig` outputs shown):
 *
 * - `IScaledUIAmount` = `uiMultiplier()` = `0xa60bf13d`
 * - `IScaledUIAmountNewUIMultiplier` = `newUIMultiplier()` (`0xdc767007`)
 *   XOR `effectiveAt()` (`0x97a4064f`) = `0x4bd27648`
 * - `IScaledUIAmountConversion` = `toUIAmount(uint256)` XOR
 *   `fromUIAmount(uint256)` = `0x57854fc3`
 * - `IScaledUIAmountBalances` = `balanceOfUI(address)` XOR
 *   `totalSupplyUI()` = `0xd890fd71`
 */
export const INTERFACE_IDS = {
  /** Core `IScaledUIAmount` (required by every implementer). */
  scaledUiAmount: '0xa60bf13d',
  /** `IScaledUIAmountNewUIMultiplier` (pending-multiplier extension). */
  newUiMultiplier: '0x4bd27648',
  /** `IScaledUIAmountConversion` (`toUIAmount`/`fromUIAmount`). */
  conversion: '0x57854fc3',
  /** `IScaledUIAmountBalances` (`balanceOfUI`/`totalSupplyUI`). */
  balances: '0xd890fd71',
} as const

/** The multiplier is 18-decimal fixed point: `10n ** 18n` means 1.0. */
export const MULTIPLIER_ONE = 10n ** 18n

/**
 * Full ERC-8056 read surface: core + both view extensions + ERC-165.
 *
 * The conversion extension (`toUIAmount`/`fromUIAmount`) is intentionally
 * absent: Robinhood's deployed `Stock` implementation does not include it
 * (`supportsInterface(0x57854fc3)` returns `false` on-chain and the calls
 * revert), and this package computes the same conversions locally with
 * {@link toUiAmount}/{@link fromUiAmount} instead of a network round-trip.
 */
export const erc8056Abi = [
  {
    type: 'function',
    name: 'uiMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'newUIMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'effectiveAt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOfUI',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupplyUI',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'supportsInterface',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
  },
  /**
   * Emitted whenever the multiplier is changed (spec: MUST be emitted).
   * All three parameters are non-indexed, matching both the spec draft and
   * the deployed Robinhood `Stock` implementation.
   * topic0: 0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055
   */
  {
    type: 'event',
    name: 'UIMultiplierUpdated',
    inputs: [
      { name: 'oldMultiplier', type: 'uint256', indexed: false },
      { name: 'newMultiplier', type: 'uint256', indexed: false },
      { name: 'effectiveAtTimestamp', type: 'uint256', indexed: false },
    ],
  },
  /**
   * The spec draft names this optional event `TransferWithUIAmount`.
   * Robinhood's deployed `Stock` implementation emits `TransferWithScaledUI`
   * instead (verified in its Blockscout ABI). Events do not affect ERC-165
   * interface IDs, so both are conformant; both are included here so log
   * decoding works against either flavor.
   * TransferWithScaledUI topic0:
   * 0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802
   */
  {
    type: 'event',
    name: 'TransferWithUIAmount',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'uiAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TransferWithScaledUI',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'uiValue', type: 'uint256', indexed: false },
    ],
  },
] as const
