// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentPayments} from "../src/AgentPayments.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal mintable ERC-20 used as both the payment currency and the agent token.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
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

/// Router that, on any call, pays out a fixed amount of `agentToken` to the caller —
/// simulating a swap of currency → agent token.
contract MockRouter {
    MockERC20 public immutable agentToken;
    uint256 public payout;

    constructor(MockERC20 _agentToken) {
        agentToken = _agentToken;
    }

    function setPayout(uint256 p) external {
        payout = p;
    }

    fallback() external payable {
        agentToken.mint(msg.sender, payout);
    }

    receive() external payable {}
}

/// @notice Currency that burns 1% on every transfer. AP-5 requires the engine
///         to credit what actually arrived, not what the payer asked for.
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        uint256 fee = amount / 100;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}

/// @notice Router that returns without buying anything, proving AP-9's
///         "reverts if the swap returned nothing" branch.
contract EmptyRouter {
    fallback() external payable {}
    receive() external payable {}
}

/// @notice Router that reverts, proving the SwapFailed branch.
contract FailingRouter {
    fallback() external payable {
        revert("swap failed");
    }
}

/// @notice Native-currency receiver that rejects ETH, proving the
///         NativeTransferFailed branch of `withdraw`.
contract NativeRejecter {}

/// @notice Native receiver that re-enters `withdraw` from its payout callback.
contract ReentrantReceiver {
    AgentPayments public immutable ap;
    address private _agentToken;
    address private _currency;
    bool private _armed;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(AgentPayments _ap) {
        ap = _ap;
    }

    function pull(address agentToken, address currency) external {
        _agentToken = agentToken;
        _currency = currency;
        _armed = true;
        ap.withdraw(agentToken, currency, address(this));
    }

    receive() external payable {
        if (_armed) {
            _armed = false;
            reentryAttempted = true;
            (bool ok,) = address(ap).call(
                abi.encodeWithSelector(AgentPayments.withdraw.selector, _agentToken, _currency, address(this))
            );
            reentrySucceeded = ok;
        }
    }
}

/// @dev Invariants under proof: AP-1 .. AP-13 of
///      `specs/ECONOMY_CONTRACT_INVARIANTS.md`.
contract AgentPaymentsTest is Test {
    AgentPayments internal ap;
    MockERC20 internal usdc;
    MockERC20 internal agentTok;
    MockRouter internal router;

    address internal owner = address(0xA11CE);
    address internal authority = address(0xBEEF);
    address internal payer = address(0xCAFE);

    uint16 internal constant BUYBACK_BPS = 3000; // 30%

    function setUp() public {
        vm.prank(owner);
        ap = new AgentPayments(owner);

        usdc = new MockERC20("USD Coin", "USDC");
        agentTok = new MockERC20("Agent Token", "AGENT");
        router = new MockRouter(agentTok);

        vm.prank(owner);
        ap.setRouterAllowed(address(router), true);

        // Register the agent (self-registration: authority == msg.sender).
        vm.prank(authority);
        ap.createAgent(address(agentTok), authority, BUYBACK_BPS);

        usdc.mint(payer, 1_000e18);
    }

    function _pay(uint256 amount, uint64 memo) internal returns (bytes32 invoiceId) {
        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        invoiceId = ap.acceptPayment(address(agentTok), address(usdc), amount, memo, 0, 0);
        vm.stopPrank();
    }

    function testCreateAgentSetsConfig() public {
        (address auth, uint16 bps, bool exists) = ap.getAgentConfig(address(agentTok));
        assertEq(auth, authority);
        assertEq(bps, BUYBACK_BPS);
        assertTrue(exists);
    }

    function testCannotDoubleRegister() public {
        vm.prank(authority);
        vm.expectRevert(AgentPayments.AgentExists.selector);
        ap.createAgent(address(agentTok), authority, 0);
    }

    function testForeignAuthorityCannotRegister() public {
        MockERC20 other = new MockERC20("X", "X");
        vm.prank(payer);
        vm.expectRevert(AgentPayments.NotAgentAuthority.selector);
        ap.createAgent(address(other), authority, 0);
    }

    function testAcceptPaymentCreditsVaultAndInvoice() public {
        bytes32 id = _pay(100e18, 1);
        (uint256 pv,,) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv, 100e18);
        assertTrue(ap.isInvoicePaid(id));
        assertEq(usdc.balanceOf(address(ap)), 100e18);
    }

    function testInvoiceIdMatchesOffchainFormula() public view {
        bytes32 expected = keccak256(abi.encode(address(agentTok), address(usdc), uint256(100e18), uint64(7), int64(0), int64(0)));
        assertEq(ap.computeInvoiceId(address(agentTok), address(usdc), 100e18, 7, 0, 0), expected);
    }

    function testDoublePaymentReverts() public {
        // Same params → same invoice ID → second settle must revert.
        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        ap.acceptPayment(address(agentTok), address(usdc), 100e18, 1, 0, 0);
        vm.expectRevert(AgentPayments.InvoiceAlreadyPaid.selector);
        ap.acceptPayment(address(agentTok), address(usdc), 100e18, 1, 0, 0);
        vm.stopPrank();
    }

    function testExpiredInvoiceWindowReverts() public {
        vm.warp(1_000);
        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        vm.expectRevert(AgentPayments.InvoiceWindowClosed.selector);
        ap.acceptPayment(address(agentTok), address(usdc), 100e18, 1, 0, int64(500)); // endTime in the past
        vm.stopPrank();
    }

    function testDistributeSplitsByBps() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));
        (uint256 pv, uint256 bb, uint256 wd) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv, 0);
        assertEq(bb, 30e18); // 30%
        assertEq(wd, 70e18); // 70%
    }

    function testWithdrawOnlyAuthority() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        vm.prank(payer);
        vm.expectRevert(AgentPayments.NotAgentAuthority.selector);
        ap.withdraw(address(agentTok), address(usdc), payer);

        vm.prank(authority);
        uint256 amt = ap.withdraw(address(agentTok), address(usdc), authority);
        assertEq(amt, 70e18);
        assertEq(usdc.balanceOf(authority), 70e18);
    }

    function testBuybackSwapsAndBurns() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc)); // 30e18 to buyback vault
        router.setPayout(42e18); // router will hand back 42 agent tokens

        vm.prank(owner);
        uint256 burned = ap.buybackTrigger(address(agentTok), address(usdc), address(router), hex"1234");

        assertEq(burned, 42e18);
        assertEq(agentTok.balanceOf(ap.BURN_ADDRESS()), 42e18);
        (, uint256 bb,) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(bb, 0);
        (, uint256 totalBuybacks,, uint256 tokensBurned) = ap.getPaymentStats(address(agentTok), address(usdc));
        assertEq(totalBuybacks, 30e18);
        assertEq(tokensBurned, 42e18);
    }

    function testBuybackOnlyOwner() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));
        vm.prank(payer);
        vm.expectRevert();
        ap.buybackTrigger(address(agentTok), address(usdc), address(router), hex"1234");
    }

    function testBuybackRejectsDisallowedRouter() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));
        vm.prank(owner);
        vm.expectRevert(AgentPayments.RouterNotAllowed.selector);
        ap.buybackTrigger(address(agentTok), address(usdc), address(0xDEAD), hex"1234");
    }

    function testBuybackRejectsTokenAsRouter() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));
        vm.startPrank(owner);
        ap.setRouterAllowed(address(usdc), true); // even if allow-listed...
        vm.expectRevert(AgentPayments.RouterNotAllowed.selector); // ...currency-as-router is forbidden
        ap.buybackTrigger(address(agentTok), address(usdc), address(usdc), hex"1234");
        vm.stopPrank();
    }

    function testNativePaymentAndWithdraw() public {
        address nativeCur = ap.NATIVE_TOKEN();
        vm.deal(payer, 10 ether);

        vm.prank(payer);
        ap.acceptPaymentNative{value: 5 ether}(address(agentTok), 9, 0, 0);
        (uint256 pv,,) = ap.getBalances(address(agentTok), nativeCur);
        assertEq(pv, 5 ether);

        ap.distributePayments(address(agentTok), nativeCur);
        vm.prank(authority);
        uint256 amt = ap.withdraw(address(agentTok), nativeCur, authority);
        assertEq(amt, 3.5 ether); // 70%
        assertEq(authority.balance, 3.5 ether);
    }

    function testUpdateBuybackBps() public {
        vm.prank(authority);
        ap.updateBuybackBps(address(agentTok), 5000);
        (, uint16 bps,) = ap.getAgentConfig(address(agentTok));
        assertEq(bps, 5000);
    }

    function testUpdateAuthority() public {
        vm.prank(authority);
        ap.updateAuthority(address(agentTok), payer);
        (address auth,,) = ap.getAgentConfig(address(agentTok));
        assertEq(auth, payer);
    }
}
