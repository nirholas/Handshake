// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HoodPayRouter} from "../src/HoodPayRouter.sol";

/// Foundry cheatcode surface used by these tests. Declared inline so the
/// contracts folder has ZERO dependencies (no forge-std submodule to
/// install); forge exposes the cheatcode contract at the well-known address.
interface Vm {
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool t1, bool t2, bool t3, bool data) external;
}

/// Complete minimal ERC-20 used as the payment token in local tests
/// (6 decimals, like USDG). The fork suite exercises the REAL USDG.
contract TestToken {
    string public constant name = "Test Global Dollar";
    string public constant symbol = "tUSDG";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// A token that signals failure by RETURNING FALSE instead of reverting -
/// the router must reject it.
contract FalseReturningToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// A no-return-data token (USDT-style ABI). Success = no revert, no data.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract HoodPayRouterTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event PaymentReceived(
        bytes32 indexed ref,
        address indexed payer,
        address indexed payTo,
        address token,
        uint256 amount
    );

    HoodPayRouter internal router;
    TestToken internal token;
    address internal constant BUYER = address(0xB0B);
    address internal constant MERCHANT = address(0xCAFE);
    bytes32 internal constant REF = keccak256("invoice-7");
    uint256 internal constant AMOUNT = 12_500_000; // 12.50 with 6 decimals

    function setUp() public {
        router = new HoodPayRouter();
        token = new TestToken();
        token.mint(BUYER, 100_000_000);
        vm.prank(BUYER);
        token.approve(address(router), AMOUNT);
    }

    function test_PayMovesFundsDirectlyToMerchant() public {
        vm.prank(BUYER);
        router.pay(address(token), MERCHANT, AMOUNT, REF);
        require(token.balanceOf(MERCHANT) == AMOUNT, "merchant not paid");
        require(token.balanceOf(BUYER) == 100_000_000 - AMOUNT, "buyer not debited");
        require(token.balanceOf(address(router)) == 0, "router must never hold funds");
    }

    function test_PayEmitsPaymentReceivedWithExactFields() public {
        vm.expectEmit(true, true, true, true);
        emit PaymentReceived(REF, BUYER, MERCHANT, address(token), AMOUNT);
        vm.prank(BUYER);
        router.pay(address(token), MERCHANT, AMOUNT, REF);
    }

    function test_RevertWhen_AmountIsZero() public {
        vm.expectRevert(HoodPayRouter.ZeroAmount.selector);
        vm.prank(BUYER);
        router.pay(address(token), MERCHANT, 0, REF);
    }

    function test_RevertWhen_PayToIsZero() public {
        vm.expectRevert(HoodPayRouter.ZeroAddress.selector);
        vm.prank(BUYER);
        router.pay(address(token), address(0), AMOUNT, REF);
    }

    function test_RevertWhen_TokenIsZero() public {
        vm.expectRevert(HoodPayRouter.ZeroAddress.selector);
        vm.prank(BUYER);
        router.pay(address(0), MERCHANT, AMOUNT, REF);
    }

    function test_RevertWhen_AllowanceMissing() public {
        vm.expectRevert(HoodPayRouter.TransferFailed.selector);
        vm.prank(BUYER);
        router.pay(address(token), MERCHANT, AMOUNT + 1, REF);
    }

    function test_RevertWhen_TokenReturnsFalse() public {
        FalseReturningToken bad = new FalseReturningToken();
        vm.expectRevert(HoodPayRouter.TransferFailed.selector);
        vm.prank(BUYER);
        router.pay(address(bad), MERCHANT, AMOUNT, REF);
    }

    function test_RevertWhen_TokenHasNoCode() public {
        vm.expectRevert(HoodPayRouter.TransferFailed.selector);
        vm.prank(BUYER);
        router.pay(address(0xDEAD), MERCHANT, AMOUNT, REF);
    }

    function test_NoReturnDataTokenSucceeds() public {
        NoReturnToken usdtStyle = new NoReturnToken();
        usdtStyle.mint(BUYER, AMOUNT);
        vm.prank(BUYER);
        usdtStyle.approve(address(router), AMOUNT);
        vm.expectEmit(true, true, true, true);
        emit PaymentReceived(REF, BUYER, MERCHANT, address(usdtStyle), AMOUNT);
        vm.prank(BUYER);
        router.pay(address(usdtStyle), MERCHANT, AMOUNT, REF);
        require(usdtStyle.balanceOf(MERCHANT) == AMOUNT, "merchant not paid");
    }

    function testFuzz_PayAnyAmountAndReference(uint96 amount, bytes32 invoiceRef) public {
        uint256 value = uint256(amount) % 100_000_000;
        if (value == 0) value = 1;
        vm.prank(BUYER);
        token.approve(address(router), value);
        vm.expectEmit(true, true, true, true);
        emit PaymentReceived(invoiceRef, BUYER, MERCHANT, address(token), value);
        vm.prank(BUYER);
        router.pay(address(token), MERCHANT, value, invoiceRef);
    }
}
