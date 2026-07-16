/**
 * erc8056 - reference implementation of ERC-8056 (Scaled UI Amount /
 * `uiMultiplier()`), the corporate-actions standard used by tokenized
 * equities such as Robinhood Chain Stock Tokens.
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8056
 * Explainer: https://nirholas.github.io/erc8056/
 *
 * @packageDocumentation
 */

export { erc8056Abi, INTERFACE_IDS, MULTIPLIER_ONE } from './abi.js'
export {
  detectErc8056,
  Erc8056NotImplementedError,
  readMultiplierState,
  readUiMultiplier,
  supportsErc8056,
  watchMultiplier,
  type Erc8056Support,
  type MultiplierState,
  type MultiplierUpdate,
} from './client.js'
export {
  adjustedPrice,
  fromUiAmount,
  rawPrice,
  toUiAmount,
  trueBalance,
  trueValue,
  type AdjustedPrice,
  type RawPrice,
  type StockPrice,
  type TrueBalanceArgs,
  type TrueValueArgs,
} from './math.js'
