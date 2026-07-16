// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    IScaledUIAmount,
    IScaledUIAmountNewUIMultiplier,
    ERC8056InterfaceIds
} from "./IERC8056.sol";

/// Minimal ERC-165 surface (kept local so this file is self-contained).
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// Minimal ERC-20 surface a consumer needs.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}

/// Chainlink AggregatorV3Interface (only what valuation needs).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * ERC8056Consumer - the reference pattern for reading ERC-8056 tokens
 * correctly from another contract. Pure views; deploy anywhere or copy the
 * two rules into your own protocol:
 *
 *   RULE 1 - positions: a raw `balanceOf` UNDERSTATES a holding whenever the
 *   multiplier moved. The true position in underlying units is
 *   `raw * uiMultiplier / 1e18`.
 *
 *   RULE 2 - valuation: know what your price feed prices. Robinhood Chain's
 *   Chainlink Stock Token feeds answer the price of one TOKEN - the
 *   multiplier is already applied upstream ("The Chainlink price already
 *   includes the corporate-action multiplier" -
 *   docs.robinhood.com/chain/building-with-stock-tokens). So value is
 *   `raw balance * feed price` and applying the multiplier AGAIN
 *   double-counts every split and dividend. Only a price quoted per
 *   UNDERLYING SHARE (e.g. an off-chain equity feed) gets multiplied.
 *
 * Both rules were verified against live mainnet state during development
 * (chain 4663, block 10745112, 2026-07-15): SGOV's multiplier was
 * 1000957519890990718, its feed answered 100.62147097 USD, and the Uniswap
 * v3 SGOV/USDG pool priced the token at 100.6075 USD - the feed tracks the
 * TOKEN price (0.014% from the pool), not the 100.5252 USD share price.
 */
contract ERC8056Consumer {
    /// 18-decimal fixed-point one, the multiplier's scale.
    uint256 internal constant ONE = 1e18;

    /// `token` implements ERC-8056 (via the MANDATORY ERC-165 route).
    /// A staticcall keeps this a safe probe on arbitrary addresses: a plain
    /// ERC-20 without ERC-165 returns false instead of reverting.
    function supportsErc8056(address token) public view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeCall(IERC165.supportsInterface, (ERC8056InterfaceIds.SCALED_UI_AMOUNT))
        );
        return ok && data.length == 32 && abi.decode(data, (bool));
    }

    /// The active multiplier, or exactly 1e18 for tokens that do not
    /// implement ERC-8056 (a plain ERC-20 IS a multiplier-1 token: one raw
    /// unit displays as one unit, forever).
    function multiplierOrOne(address token) public view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeCall(IScaledUIAmount.uiMultiplier, ()));
        if (!ok || data.length != 32) return ONE;
        uint256 m = abi.decode(data, (uint256));
        return m == 0 ? ONE : m;
    }

    /// RULE 1: the true position in underlying units, floored exactly like
    /// the deployed `Stock` implementation floors `balanceOfUI`.
    function trueBalance(address token, address account) public view returns (uint256) {
        uint256 raw = IERC20Minimal(token).balanceOf(account);
        return raw * multiplierOrOne(token) / ONE;
    }

    /**
     * RULE 2, adjusted-price branch: value a holding with a feed whose
     * answer is per TOKEN (multiplier already applied) - every Chainlink
     * Stock Token feed on Robinhood Chain. The multiplier appears NOWHERE
     * in this function; that absence is the entire point.
     *
     * Returns USD scaled by the feed's own decimals (8 on Robinhood Chain),
     * with the token's 18 decimals divided out. Reverts on a non-positive
     * answer or an answer older than `maxAge` seconds (stock feeds follow
     * 24/5 market hours - pass at least 3 days to tolerate weekends).
     */
    function valueWithAdjustedFeed(address token, IAggregatorV3 feed, address account, uint256 maxAge)
        public
        view
        returns (uint256 usdValue)
    {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        require(answer > 0, "ERC8056Consumer: invalid feed answer");
        require(block.timestamp - updatedAt <= maxAge, "ERC8056Consumer: stale feed");
        uint256 raw = IERC20Minimal(token).balanceOf(account);
        // raw (18 decimals) * answer (feed decimals) / 1e18 = USD in feed decimals.
        // No uiMultiplier here - the feed already applied it.
        return raw * uint256(answer) / ONE;
    }

    /**
     * RULE 2, raw-price branch: value a holding with a price quoted per
     * UNDERLYING SHARE (no multiplier applied), e.g. an off-chain equity
     * quote pushed on-chain by your own oracle. Here - and ONLY here - the
     * multiplier is applied, once, to convert raw tokens into shares.
     *
     * `sharePrice` uses `priceDecimals`; returns USD in the same decimals.
     */
    function valueWithSharePrice(address token, address account, uint256 sharePrice)
        public
        view
        returns (uint256 usdValue)
    {
        uint256 shares = trueBalance(token, account); // raw * multiplier / 1e18
        return shares * sharePrice / ONE;
    }

    /**
     * A scheduled-but-not-yet-effective corporate action, if any.
     * `pending` is false for core-only implementers (no extension), for
     * tokens with no ERC-8056 at all, and after a scheduled change has
     * activated (the deployed implementation keeps `newUIMultiplier` and
     * `effectiveAt` populated with the last applied values).
     */
    function pendingMultiplier(address token)
        public
        view
        returns (bool pending, uint256 nextMultiplier, uint256 effectiveAtTimestamp)
    {
        (bool okNew, bytes memory dataNew) =
            token.staticcall(abi.encodeCall(IScaledUIAmountNewUIMultiplier.newUIMultiplier, ()));
        (bool okAt, bytes memory dataAt) =
            token.staticcall(abi.encodeCall(IScaledUIAmountNewUIMultiplier.effectiveAt, ()));
        if (!okNew || !okAt || dataNew.length != 32 || dataAt.length != 32) {
            return (false, 0, 0);
        }
        nextMultiplier = abi.decode(dataNew, (uint256));
        effectiveAtTimestamp = abi.decode(dataAt, (uint256));
        pending = effectiveAtTimestamp > block.timestamp && nextMultiplier != multiplierOrOne(token);
    }
}
