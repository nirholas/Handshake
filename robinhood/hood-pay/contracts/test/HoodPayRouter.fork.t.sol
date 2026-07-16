// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HoodPayRouter} from "../src/HoodPayRouter.sol";

interface Vm {
    function prank(address sender) external;
    function expectEmit(bool t1, bool t2, bool t3, bool data) external;
    function skip(bool shouldSkip) external;
}

interface IERC20 {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * Fork suite: runs against the REAL USDG contract and REAL balances on
 * Robinhood Chain mainnet (chain 4663), inside forge's local fork EVM -
 * nothing is signed or broadcast to the real network.
 *
 *   npm run forge:test:fork
 *   (forge test --root contracts --match-path 'test/*.fork.t.sol' \
 *      --fork-url https://rpc.mainnet.chain.robinhood.com -vv)
 *
 * WHALE is the largest USDG EOA holder at the time of writing (verified on
 * Blockscout, ~50M USDG); the fork lets tests act as that address locally.
 */
contract HoodPayRouterForkTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant WHALE = 0x2d4d2A025b10C09BDbd794B4FCe4F7ea8C7d7bB4;
    address internal constant MERCHANT = address(0xCAFE);
    bytes32 internal constant REF = keccak256("fork-invoice-1");
    uint256 internal constant AMOUNT = 25_000_000; // 25 USDG

    event PaymentReceived(
        bytes32 indexed ref,
        address indexed payer,
        address indexed payTo,
        address token,
        uint256 amount
    );

    /// Skip cleanly when running without --fork-url (plain `forge test`).
    modifier onlyFork() {
        vm.skip(USDG.code.length == 0);
        _;
    }

    function test_RealUsdgHasSixDecimalsAndSymbol() public onlyFork {
        require(IERC20(USDG).decimals() == 6, "USDG must have 6 decimals");
        require(
            keccak256(bytes(IERC20(USDG).symbol())) == keccak256(bytes("USDG")),
            "symbol must be USDG"
        );
    }

    function test_PayWithRealUsdg() public onlyFork {
        HoodPayRouter router = new HoodPayRouter();
        uint256 whaleBefore = IERC20(USDG).balanceOf(WHALE);
        require(whaleBefore >= AMOUNT, "whale drained since research; pick a new holder");
        uint256 merchantBefore = IERC20(USDG).balanceOf(MERCHANT);

        vm.prank(WHALE);
        IERC20(USDG).approve(address(router), AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit PaymentReceived(REF, WHALE, MERCHANT, USDG, AMOUNT);
        vm.prank(WHALE);
        router.pay(USDG, MERCHANT, AMOUNT, REF);

        require(IERC20(USDG).balanceOf(MERCHANT) == merchantBefore + AMOUNT, "merchant not paid");
        require(IERC20(USDG).balanceOf(WHALE) == whaleBefore - AMOUNT, "whale not debited");
        require(IERC20(USDG).balanceOf(address(router)) == 0, "router must never hold USDG");
    }
}
