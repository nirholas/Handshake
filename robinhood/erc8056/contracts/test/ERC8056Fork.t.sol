// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC8056Consumer, IAggregatorV3, IERC20Minimal} from "../src/ERC8056Consumer.sol";
import {
    IScaledUIAmount,
    IScaledUIAmountBalances,
    IScaledUIAmountConversion,
    ERC8056InterfaceIds
} from "../src/IERC8056.sol";

interface IERC165View {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC20Supply {
    function totalSupply() external view returns (uint256);
}

/**
 * Fork tests against LIVE Stock Tokens on Robinhood Chain mainnet
 * (chain ID 4663). Read-only - no state changes, no funds:
 *
 *   forge test --fork-url https://rpc.mainnet.chain.robinhood.com
 *
 * Token addresses come from the canonical Stock Token registry (verified on
 * robinhoodchain.blockscout.com; every proxy resolves to the shared beacon
 * 0xe10b6f6B275de231345c20D14Ab812db62151b00). The SGOV holder is a real
 * top-3 holder read from Blockscout on 2026-07-15.
 */
contract ERC8056ForkTest is Test {
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant SGOV = 0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5;
    address constant WEEK = 0xc93a8c440CEa26D7445dF01729f193b27965099f;
    address constant SGOV_FEED = 0xa0DF4ee0fFf975306345875E3548Fcc519577A11;
    address constant SGOV_HOLDER = 0x9c856e12a12689f18109aa2B6728ffb41a65D664;
    /// Canonical Multicall3: deployed code, definitely not ERC-8056.
    address constant NON_IMPLEMENTER = 0xcA11bde05977b3631167028862bE2a173976CA11;

    uint256 constant ONE = 1e18;

    ERC8056Consumer consumer;

    function setUp() public {
        consumer = new ERC8056Consumer();
    }

    function test_everyTokenAnswersMandatoryErc165() public view {
        address[3] memory tokens = [AAPL, SGOV, WEEK];
        for (uint256 i = 0; i < tokens.length; i++) {
            assertTrue(
                IERC165View(tokens[i]).supportsInterface(ERC8056InterfaceIds.SCALED_UI_AMOUNT),
                "core interface 0xa60bf13d"
            );
            assertTrue(
                IERC165View(tokens[i]).supportsInterface(ERC8056InterfaceIds.NEW_UI_MULTIPLIER),
                "pending extension 0x4bd27648"
            );
            assertTrue(
                IERC165View(tokens[i]).supportsInterface(ERC8056InterfaceIds.BALANCES),
                "balances extension 0xd890fd71"
            );
            // The conversion extension is NOT deployed on Robinhood Chain.
            assertFalse(
                IERC165View(tokens[i]).supportsInterface(ERC8056InterfaceIds.CONVERSION),
                "conversion extension 0x57854fc3 must be absent"
            );
            assertTrue(consumer.supportsErc8056(tokens[i]), "consumer detection");
        }
    }

    function test_conversionExtensionCallsRevert() public {
        // Belt and braces: not just undeclared, the selectors truly revert.
        vm.expectRevert();
        IScaledUIAmountConversion(SGOV).toUIAmount(ONE);
    }

    function test_liveMultipliers() public view {
        // AAPL has had no corporate action yet: exactly 1.0.
        assertEq(IScaledUIAmount(AAPL).uiMultiplier(), ONE, "AAPL");
        // SGOV reinvested a dividend effective 2026-07-08T20:14:32Z.
        assertGt(IScaledUIAmount(SGOV).uiMultiplier(), ONE, "SGOV above 1.0");
        // WEEK's multiplier has more than doubled (weekly distributions).
        assertGt(IScaledUIAmount(WEEK).uiMultiplier(), 2 * ONE, "WEEK above 2.0");
    }

    function test_totalSupplyUiMatchesTheDocumentedMath() public view {
        address[2] memory tokens = [SGOV, WEEK];
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 raw = IERC20Supply(tokens[i]).totalSupply();
            uint256 m = IScaledUIAmount(tokens[i]).uiMultiplier();
            assertEq(
                IScaledUIAmountBalances(tokens[i]).totalSupplyUI(),
                raw * m / ONE,
                "totalSupplyUI == totalSupply * uiMultiplier / 1e18"
            );
        }
    }

    function test_trueBalanceMatchesOnChainBalanceOfUi() public view {
        // RULE 1 cross-check on a real top holder: local math == balanceOfUI.
        uint256 raw = IERC20Minimal(SGOV).balanceOf(SGOV_HOLDER);
        assertGt(raw, 0, "holder still holds");
        assertEq(
            consumer.trueBalance(SGOV, SGOV_HOLDER),
            IScaledUIAmountBalances(SGOV).balanceOfUI(SGOV_HOLDER),
            "trueBalance == balanceOfUI"
        );
        // And the multiplier genuinely moved the number.
        assertGt(consumer.trueBalance(SGOV, SGOV_HOLDER), raw, "shares exceed raw tokens");
    }

    function test_valuationNeverReappliesTheMultiplier() public view {
        // RULE 2: the feed already includes the multiplier. The consumer's
        // adjusted-branch valuation must equal raw * answer / 1e18 with the
        // multiplier appearing nowhere.
        (, int256 answer,,,) = IAggregatorV3(SGOV_FEED).latestRoundData();
        assertGt(answer, 0, "live feed answer");
        uint256 raw = IERC20Minimal(SGOV).balanceOf(SGOV_HOLDER);
        uint256 value = consumer.valueWithAdjustedFeed(SGOV, IAggregatorV3(SGOV_FEED), SGOV_HOLDER, 7 days);
        assertEq(value, raw * uint256(answer) / ONE, "no multiplier in the adjusted branch");

        // The double-count bug this package exists to prevent: applying the
        // multiplier on top of the feed price inflates the value.
        uint256 m = IScaledUIAmount(SGOV).uiMultiplier();
        uint256 doubleCounted = value * m / ONE;
        assertGt(doubleCounted, value, "double-counting overstates the position");

        // The raw-price branch agrees with the adjusted branch when given the
        // implied share price (feed / multiplier), modulo flooring dust.
        uint256 impliedSharePrice = uint256(answer) * ONE / m;
        uint256 viaShares = consumer.valueWithSharePrice(SGOV, SGOV_HOLDER, impliedSharePrice);
        assertApproxEqRel(viaShares, value, 1e12, "branches agree within 0.0001%");
    }

    function test_pendingMultiplierReflectsScheduleState() public view {
        // SGOV's 2026-07-08 update is long effective: not pending anymore.
        (bool pending, uint256 nextM, uint256 at) = consumer.pendingMultiplier(SGOV);
        if (at <= block.timestamp) {
            assertFalse(pending, "past effectiveAt is not pending");
            assertEq(nextM, IScaledUIAmount(SGOV).uiMultiplier(), "applied value retained");
        } else {
            assertTrue(pending, "future effectiveAt with differing value is pending");
        }
    }

    function test_nonImplementerIsHandledGracefully() public view {
        assertFalse(consumer.supportsErc8056(NON_IMPLEMENTER), "multicall3 is not ERC-8056");
        assertEq(consumer.multiplierOrOne(NON_IMPLEMENTER), ONE, "plain contracts read as 1.0");
    }
}
