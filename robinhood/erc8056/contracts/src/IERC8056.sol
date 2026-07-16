// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ERC-8056: Scaled UI Amount Extension for ERC-20 Tokens.
 * https://eips.ethereum.org/EIPS/eip-8056 (Draft, created 2025-10-20).
 *
 * A token issuer applies an updatable 18-decimal fixed-point multiplier to
 * the DISPLAY amount of a token (splits, reinvested distributions) without
 * minting, burning, or moving raw balances. `balanceOf` and `totalSupply`
 * never change on a corporate action; only the multiplier does.
 *
 * Compliant contracts MUST implement ERC-165 and answer `true` for the
 * `IScaledUIAmount` interface ID `0xa60bf13d`; optional extensions each have
 * their own ID (constants below, all re-derived from selector XOR and
 * confirmed by live `supportsInterface` reads against canonical Stock Tokens
 * on Robinhood Chain, chain ID 4663).
 */

/// Core interface (required). Interface ID: 0xa60bf13d (= uiMultiplier() selector).
interface IScaledUIAmount {
    /**
     * MUST be emitted whenever the multiplier is changed.
     * All parameters are non-indexed. topic0:
     * 0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055
     */
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    /**
     * OPTIONAL event pairing each transfer's raw amount with its UI amount.
     * NOTE: this is the spec draft's name. Robinhood's deployed `Stock`
     * implementation emits `TransferWithScaledUI(address,address,uint256,uint256)`
     * instead (topic0 0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802).
     * Events do not affect ERC-165 interface IDs, so both are conformant;
     * indexers must subscribe to the deployed flavor's topic.
     */
    event TransferWithUIAmount(address indexed from, address indexed to, uint256 amount, uint256 uiAmount);

    /**
     * The current UI multiplier as 18-decimal fixed point: 1e18 means 1.0
     * (one token displays as one underlying unit). After a 2-for-1 split the
     * issuer sets ~2e18 and every raw balance DISPLAYS doubled.
     */
    function uiMultiplier() external view returns (uint256);
}

/// Pending-multiplier extension (scheduled corporate actions). Interface ID: 0x4bd27648.
interface IScaledUIAmountNewUIMultiplier {
    /// The multiplier that becomes active once `effectiveAt()` passes.
    /// Robinhood's implementation keeps this equal to the LAST APPLIED value
    /// after activation (observed on-chain), so "a change is pending" means
    /// `effectiveAt() > block.timestamp && newUIMultiplier() != uiMultiplier()`.
    function newUIMultiplier() external view returns (uint256);

    /// Unix timestamp at which `newUIMultiplier()` takes effect (0 if never scheduled).
    function effectiveAt() external view returns (uint256);
}

/// Conversion extension. Interface ID: 0x57854fc3.
/// NOT implemented by Robinhood's deployed `Stock` contract - calls revert
/// and `supportsInterface(0x57854fc3)` returns false on every canonical
/// Stock Token. Compute conversions locally: ui = raw * multiplier / 1e18.
interface IScaledUIAmountConversion {
    /// Raw base units -> UI (display / underlying-share) units.
    function toUIAmount(uint256 rawAmount) external view returns (uint256);

    /// UI units -> raw base units.
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}

/// UI-balance extension. Interface ID: 0xd890fd71.
interface IScaledUIAmountBalances {
    /// `balanceOf(account) * uiMultiplier() / 1e18` computed on-chain.
    function balanceOfUI(address account) external view returns (uint256);

    /// `totalSupply() * uiMultiplier() / 1e18` computed on-chain.
    function totalSupplyUI() external view returns (uint256);
}

/// ERC-165 interface identifiers for every ERC-8056 surface.
library ERC8056InterfaceIds {
    /// IScaledUIAmount (required).
    bytes4 internal constant SCALED_UI_AMOUNT = 0xa60bf13d;
    /// IScaledUIAmountNewUIMultiplier.
    bytes4 internal constant NEW_UI_MULTIPLIER = 0x4bd27648;
    /// IScaledUIAmountConversion.
    bytes4 internal constant CONVERSION = 0x57854fc3;
    /// IScaledUIAmountBalances.
    bytes4 internal constant BALANCES = 0xd890fd71;
}
