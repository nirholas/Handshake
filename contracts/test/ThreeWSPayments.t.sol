// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ThreeWSPayments} from "../ThreeWSPayments.sol";

/// @notice Standard, well-behaved ERC-20 (returns true, reverts on shortfall).
contract GoodToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice The dangerous shape: moves nothing and returns `false` instead of
///         reverting. USDT-era tokens and several bridged assets behave this
///         way, which is exactly what TWP-1 exists to defend against.
contract SilentFailToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @notice Returns no data at all (pre-ERC-20-finalization tokens). A transfer
///         that does not revert and returns nothing must count as success.
contract NoReturnDataToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external {}

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice Reverts outright on transfer.
contract RevertingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("nope");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("nope");
    }
}

/// @dev Invariants under proof: TWP-1 .. TWP-6 of
///      `specs/ECONOMY_CONTRACT_INVARIANTS.md`. This contract is LIVE on BSC,
///      Base, and Arbitrum One and custodies real USDC, so every branch of it
///      is exercised here, including the non-compliant-token paths that the
///      settlement server's trust in the `Payment` event depends on.
contract ThreeWSPaymentsTest is Test {
    ThreeWSPayments internal pay;
    GoodToken internal usdc;

    address internal owner = address(0xA11CE);
    address internal agent = address(0xCAFE);
    address internal stranger = address(0xB0B);

    event Payment(address indexed payer, uint256 amount, bytes32 indexed ref);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);

    function setUp() public {
        usdc = new GoodToken();
        pay = new ThreeWSPayments(owner, address(usdc));
        usdc.mint(agent, 1_000_000);
    }

    // ── TWP-5: constructor rejects zero owner / zero token ───────────────────

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(ThreeWSPayments.ZeroAddress.selector);
        new ThreeWSPayments(address(0), address(usdc));
    }

    function testConstructorRejectsZeroToken() public {
        vm.expectRevert(ThreeWSPayments.ZeroAddress.selector);
        new ThreeWSPayments(owner, address(0));
    }

    function testConstructorStoresOwnerAndToken() public view {
        assertEq(pay.owner(), owner);
        assertEq(address(pay.USDC()), address(usdc));
        assertEq(pay.pricePerCall(), 1_000);
    }

    // ── TWP-1 / TWP-2: pay() moves exactly the price, and only emits on success ─

    function testPayTransfersExactPriceAndEmits() public {
        bytes32 ref = keccak256("jsonrpc-body");

        vm.prank(agent);
        usdc.approve(address(pay), type(uint256).max);

        vm.expectEmit(true, true, true, true);
        emit Payment(agent, 1_000, ref);

        vm.prank(agent);
        pay.pay(ref);

        assertEq(usdc.balanceOf(address(pay)), 1_000);
        assertEq(usdc.balanceOf(agent), 999_000);
    }

    function testPayUsesCurrentPriceNotCallerChoice() public {
        vm.prank(owner);
        pay.setPrice(5_000);

        vm.startPrank(agent);
        usdc.approve(address(pay), type(uint256).max);
        pay.pay(keccak256("a"));
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(pay)), 5_000);
    }

    function testPayRevertsWithoutAllowance() public {
        vm.prank(agent);
        vm.expectRevert();
        pay.pay(keccak256("no-approval"));

        assertEq(usdc.balanceOf(address(pay)), 0);
    }

    /// TWP-1 negative case: a token that returns false without reverting must
    /// NOT produce a receipt. If this regressed, the settlement server would
    /// credit a tool call that was never paid for.
    function testPayRevertsOnSilentlyFailingToken() public {
        SilentFailToken bad = new SilentFailToken();
        ThreeWSPayments p = new ThreeWSPayments(owner, address(bad));
        bad.mint(agent, 1_000_000);

        vm.prank(agent);
        vm.expectRevert(ThreeWSPayments.TransferFailed.selector);
        p.pay(keccak256("silent-fail"));
    }

    function testPayRevertsOnRevertingToken() public {
        RevertingToken bad = new RevertingToken();
        ThreeWSPayments p = new ThreeWSPayments(owner, address(bad));

        vm.prank(agent);
        vm.expectRevert(ThreeWSPayments.TransferFailed.selector);
        p.pay(keccak256("hard-revert"));
    }

    /// A token that returns no data at all is compliant-enough: the payment
    /// must go through, or three.ws could not accept several bridged USDCs.
    function testPayAcceptsNoReturnDataToken() public {
        NoReturnDataToken quiet = new NoReturnDataToken();
        ThreeWSPayments p = new ThreeWSPayments(owner, address(quiet));
        quiet.mint(agent, 10_000);

        vm.prank(agent);
        p.pay(keccak256("no-return-data"));

        assertEq(quiet.balanceOf(address(p)), 1_000);
    }

    function testDistinctRefsBothSettle() public {
        vm.startPrank(agent);
        usdc.approve(address(pay), type(uint256).max);
        pay.pay(keccak256("call-1"));
        pay.pay(keccak256("call-2"));
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(pay)), 2_000);
    }

    // ── TWP-3: owner-only mutators ───────────────────────────────────────────

    function testSetPriceOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ThreeWSPayments.NotOwner.selector);
        pay.setPrice(1);

        assertEq(pay.pricePerCall(), 1_000);
    }

    function testSetPriceEmitsOldAndNew() public {
        vm.expectEmit(true, true, true, true);
        emit PriceUpdated(1_000, 2_500);
        vm.prank(owner);
        pay.setPrice(2_500);
        assertEq(pay.pricePerCall(), 2_500);
    }

    function testWithdrawOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ThreeWSPayments.NotOwner.selector);
        pay.withdraw();
    }

    function testTransferOwnershipOnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ThreeWSPayments.NotOwner.selector);
        pay.transferOwnership(stranger);

        assertEq(pay.owner(), owner);
    }

    function testTransferOwnershipRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(ThreeWSPayments.ZeroAddress.selector);
        pay.transferOwnership(address(0));

        assertEq(pay.owner(), owner);
    }

    function testTransferOwnershipMovesEveryRight() public {
        vm.prank(owner);
        pay.transferOwnership(stranger);
        assertEq(pay.owner(), stranger);

        // Old owner is fully demoted.
        vm.prank(owner);
        vm.expectRevert(ThreeWSPayments.NotOwner.selector);
        pay.setPrice(7);

        vm.prank(stranger);
        pay.setPrice(7);
        assertEq(pay.pricePerCall(), 7);
    }

    // ── TWP-4: withdraw drains to the current owner ──────────────────────────

    function testWithdrawSendsFullBalanceToOwner() public {
        vm.startPrank(agent);
        usdc.approve(address(pay), type(uint256).max);
        pay.pay(keccak256("a"));
        pay.pay(keccak256("b"));
        vm.stopPrank();

        vm.prank(owner);
        pay.withdraw();

        assertEq(usdc.balanceOf(address(pay)), 0);
        assertEq(usdc.balanceOf(owner), 2_000);
    }

    function testWithdrawGoesToTheNewOwnerAfterTransfer() public {
        vm.startPrank(agent);
        usdc.approve(address(pay), type(uint256).max);
        pay.pay(keccak256("a"));
        vm.stopPrank();

        vm.prank(owner);
        pay.transferOwnership(stranger);

        vm.prank(stranger);
        pay.withdraw();

        assertEq(usdc.balanceOf(stranger), 1_000);
        assertEq(usdc.balanceOf(owner), 0);
    }

    function testWithdrawRevertsOnFailingToken() public {
        SilentFailToken bad = new SilentFailToken();
        ThreeWSPayments p = new ThreeWSPayments(owner, address(bad));
        bad.mint(address(p), 5_000);

        vm.prank(owner);
        vm.expectRevert(ThreeWSPayments.TransferFailed.selector);
        p.withdraw();

        assertEq(bad.balanceOf(address(p)), 5_000);
    }

    function testWithdrawOfEmptyBalanceIsANoop() public {
        vm.prank(owner);
        pay.withdraw();
        assertEq(usdc.balanceOf(owner), 0);
    }

    // ── TWP-6: no native-currency path ───────────────────────────────────────

    function testContractRejectsNativeTransfers() public {
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        (bool ok,) = address(pay).call{value: 1 ether}("");
        assertFalse(ok, "TWP-6: contract must not accept native currency");
        assertEq(address(pay).balance, 0);
    }

    function testUnknownSelectorReverts() public {
        (bool ok,) = address(pay).call(abi.encodeWithSignature("doesNotExist()"));
        assertFalse(ok, "TWP-6: no fallback path");
    }
}
