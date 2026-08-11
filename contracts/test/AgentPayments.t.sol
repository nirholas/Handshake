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

    /// @dev AP-7. Asserts the ledger identity for one (agent, currency) pair.
    function _assertConservation(address agentToken, address currency, uint256 expectedGross) internal view {
        (uint256 pv, uint256 bb, uint256 wd) = ap.getBalances(agentToken, currency);
        (uint256 totalPayments, uint256 totalBuybacks, uint256 totalWithdrawn,) =
            ap.getPaymentStats(agentToken, currency);

        assertEq(totalPayments, expectedGross, "AP-7: lifetime gross must match what was paid in");
        assertEq(
            pv + bb + wd + totalWithdrawn + totalBuybacks,
            totalPayments,
            "AP-7: vaults plus lifetime outflow must equal lifetime inflow"
        );
    }

    // ── AP-1 / AP-2: registration guards ─────────────────────────────────────

    function testCreateAgentRejectsZeroAddresses() public {
        vm.startPrank(owner);
        vm.expectRevert(AgentPayments.ZeroAddress.selector);
        ap.createAgent(address(0), authority, 0);

        vm.expectRevert(AgentPayments.ZeroAddress.selector);
        ap.createAgent(address(0xFEED), address(0), 0);
        vm.stopPrank();
    }

    function testCreateAgentRejectsBpsAboveDenominator() public {
        vm.prank(owner);
        vm.expectRevert(AgentPayments.InvalidBps.selector);
        ap.createAgent(address(0xFEED), authority, 10_001);
    }

    function testCreateAgentAcceptsFullBps() public {
        MockERC20 other = new MockERC20("Y", "Y");
        vm.prank(owner);
        ap.createAgent(address(other), authority, 10_000);
        (, uint16 bps,) = ap.getAgentConfig(address(other));
        assertEq(bps, 10_000);
    }

    function testOwnerCanRegisterOnBehalfOfAUser() public {
        MockERC20 other = new MockERC20("Z", "Z");
        vm.prank(owner);
        ap.createAgent(address(other), authority, 1_000);
        (address auth,, bool exists) = ap.getAgentConfig(address(other));
        assertEq(auth, authority);
        assertTrue(exists);
    }

    function testConstructorRejectsZeroOwner() public {
        // Ownable rejects it before the body runs; assert the exact error so a
        // future refactor cannot silently drop the guard.
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new AgentPayments(address(0));
    }

    // ── AP-2 / AP-12: config updates are authority-gated ─────────────────────

    function testUpdateBuybackBpsOnlyAuthority() public {
        vm.prank(payer);
        vm.expectRevert(AgentPayments.NotAgentAuthority.selector);
        ap.updateBuybackBps(address(agentTok), 100);

        (, uint16 bps,) = ap.getAgentConfig(address(agentTok));
        assertEq(bps, BUYBACK_BPS);
    }

    function testUpdateBuybackBpsRejectsOverflowValue() public {
        vm.prank(authority);
        vm.expectRevert(AgentPayments.InvalidBps.selector);
        ap.updateBuybackBps(address(agentTok), 10_001);
    }

    function testUpdateAuthorityOnlyCurrentAuthority() public {
        vm.prank(payer);
        vm.expectRevert(AgentPayments.NotAgentAuthority.selector);
        ap.updateAuthority(address(agentTok), payer);
    }

    function testUpdateAuthorityRejectsZero() public {
        vm.prank(authority);
        vm.expectRevert(AgentPayments.ZeroAddress.selector);
        ap.updateAuthority(address(agentTok), address(0));

        (address auth,,) = ap.getAgentConfig(address(agentTok));
        assertEq(auth, authority, "AP-12: an agent can never become unmanageable");
    }

    function testAuthorityHandoverIsComplete() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        vm.prank(authority);
        ap.updateAuthority(address(agentTok), payer);

        vm.prank(authority);
        vm.expectRevert(AgentPayments.NotAgentAuthority.selector);
        ap.withdraw(address(agentTok), address(usdc), authority);

        vm.prank(payer);
        assertEq(ap.withdraw(address(agentTok), address(usdc), payer), 70e18);
    }

    function testUnknownAgentIsRejectedEverywhere() public {
        address ghost = address(0x6057);

        vm.expectRevert(AgentPayments.AgentUnknown.selector);
        ap.distributePayments(ghost, address(usdc));

        vm.prank(authority);
        vm.expectRevert(AgentPayments.AgentUnknown.selector);
        ap.withdraw(ghost, address(usdc), authority);

        vm.prank(authority);
        vm.expectRevert(AgentPayments.AgentUnknown.selector);
        ap.updateBuybackBps(ghost, 1);

        vm.prank(authority);
        vm.expectRevert(AgentPayments.AgentUnknown.selector);
        ap.updateAuthority(ghost, payer);

        vm.prank(owner);
        vm.expectRevert(AgentPayments.AgentUnknown.selector);
        ap.buybackTrigger(ghost, address(usdc), address(router), hex"1234");

        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        vm.expectRevert(AgentPayments.AgentUnknown.selector);
        ap.acceptPayment(ghost, address(usdc), 1e18, 1, 0, 0);
        vm.stopPrank();
    }

    // ── AP-3 / AP-4: invoice identity and window ─────────────────────────────

    function testInvoiceIdsDifferPerAgentAndCurrency() public {
        MockERC20 otherCurrency = new MockERC20("DAI", "DAI");
        bytes32 a = ap.computeInvoiceId(address(agentTok), address(usdc), 1e18, 1, 0, 0);
        bytes32 b = ap.computeInvoiceId(address(agentTok), address(otherCurrency), 1e18, 1, 0, 0);
        bytes32 c = ap.computeInvoiceId(address(0xFEED), address(usdc), 1e18, 1, 0, 0);
        bytes32 d = ap.computeInvoiceId(address(agentTok), address(usdc), 1e18, 2, 0, 0);

        assertTrue(a != b && a != c && a != d, "AP-3: every field must bind the id");
    }

    function testDifferentMemoSettlesSeparately() public {
        _pay(100e18, 1);
        _pay(100e18, 2);

        (uint256 pv,,) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv, 200e18);
        _assertConservation(address(agentTok), address(usdc), 200e18);
    }

    function testPaymentBeforeStartTimeReverts() public {
        vm.warp(1_000);
        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        vm.expectRevert(AgentPayments.InvoiceWindowClosed.selector);
        ap.acceptPayment(address(agentTok), address(usdc), 100e18, 1, int64(5_000), 0);
        vm.stopPrank();

        (uint256 pv,,) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv, 0, "AP-4: a payment outside the window credits nothing");
    }

    function testPaymentInsideAnExplicitWindowSucceeds() public {
        vm.warp(1_000);
        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        ap.acceptPayment(address(agentTok), address(usdc), 100e18, 1, int64(500), int64(2_000));
        vm.stopPrank();

        (uint256 pv,,) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv, 100e18);
    }

    function testNativeInvoiceWindowIsEnforced() public {
        vm.warp(1_000);
        vm.deal(payer, 10 ether);
        vm.prank(payer);
        vm.expectRevert(AgentPayments.InvoiceWindowClosed.selector);
        ap.acceptPaymentNative{value: 1 ether}(address(agentTok), 1, 0, int64(500));
    }

    function testZeroValueNativePaymentReverts() public {
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        vm.expectRevert(AgentPayments.NothingToProcess.selector);
        ap.acceptPaymentNative{value: 0}(address(agentTok), 1, 0, 0);
    }

    // ── AP-5: credit what arrived, never what was asked for ──────────────────

    function testFeeOnTransferCurrencyCreditsOnlyWhatArrived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        fot.mint(payer, 1_000e18);

        vm.startPrank(payer);
        fot.approve(address(ap), type(uint256).max);
        ap.acceptPayment(address(agentTok), address(fot), 100e18, 1, 0, 0);
        vm.stopPrank();

        (uint256 pv,,) = ap.getBalances(address(agentTok), address(fot));
        assertEq(pv, 99e18, "AP-5: a 1% fee must reduce the credit, not the ledger's trust in it");
        assertEq(fot.balanceOf(address(ap)), 99e18);
        _assertConservation(address(agentTok), address(fot), 99e18);
    }

    // ── AP-6: currency validation ────────────────────────────────────────────

    function testAcceptPaymentRejectsNativeSentinel() public {
        address sentinel = ap.NATIVE_TOKEN();
        vm.prank(payer);
        vm.expectRevert(AgentPayments.InvalidCurrency.selector);
        ap.acceptPayment(address(agentTok), sentinel, 1e18, 1, 0, 0);
    }

    function testAcceptPaymentRejectsZeroCurrency() public {
        vm.prank(payer);
        vm.expectRevert(AgentPayments.InvalidCurrency.selector);
        ap.acceptPayment(address(agentTok), address(0), 1e18, 1, 0, 0);
    }

    // ── AP-7 / AP-8: distribution is lossless and permissionless ─────────────

    function testConservationHoldsAcrossTheFullLifecycle() public {
        _pay(100e18, 1);
        _assertConservation(address(agentTok), address(usdc), 100e18);

        ap.distributePayments(address(agentTok), address(usdc));
        _assertConservation(address(agentTok), address(usdc), 100e18);

        vm.prank(authority);
        ap.withdraw(address(agentTok), address(usdc), authority);
        _assertConservation(address(agentTok), address(usdc), 100e18);

        router.setPayout(1e18);
        vm.prank(owner);
        ap.buybackTrigger(address(agentTok), address(usdc), address(router), hex"1234");
        _assertConservation(address(agentTok), address(usdc), 100e18);

        (uint256 pv, uint256 bb, uint256 wd) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv + bb + wd, 0, "everything paid in has been distributed and spent");
    }

    function testDistributeIsPermissionless() public {
        _pay(100e18, 1);

        // A random cranker, not the authority and not the owner.
        vm.prank(address(0xC4A17));
        ap.distributePayments(address(agentTok), address(usdc));

        (uint256 pv, uint256 bb, uint256 wd) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv, 0);
        assertEq(bb + wd, 100e18, "AP-8: the split is lossless");
    }

    function testDistributeLeavesNoDustOnAnOddAmount() public {
        // 3 wei at 30% floors to 0 for buyback; the remainder must all land in
        // the withdraw vault rather than being stranded.
        _pay(3, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        (uint256 pv, uint256 bb, uint256 wd) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(pv, 0);
        assertEq(bb, 0);
        assertEq(wd, 3, "AP-8: rounding always favors the withdraw vault, nothing is lost");
        _assertConservation(address(agentTok), address(usdc), 3);
    }

    function testDistributeWithNothingPendingReverts() public {
        vm.expectRevert(AgentPayments.NothingToProcess.selector);
        ap.distributePayments(address(agentTok), address(usdc));
    }

    function testZeroBpsSendsEverythingToTheAuthority() public {
        MockERC20 other = new MockERC20("N", "N");
        vm.prank(authority);
        ap.createAgent(address(other), authority, 0);

        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        ap.acceptPayment(address(other), address(usdc), 50e18, 1, 0, 0);
        vm.stopPrank();

        ap.distributePayments(address(other), address(usdc));
        (, uint256 bb, uint256 wd) = ap.getBalances(address(other), address(usdc));
        assertEq(bb, 0);
        assertEq(wd, 50e18);
    }

    function testFullBpsSendsEverythingToBuyback() public {
        MockERC20 other = new MockERC20("F", "F");
        vm.prank(authority);
        ap.createAgent(address(other), authority, 10_000);

        vm.startPrank(payer);
        usdc.approve(address(ap), type(uint256).max);
        ap.acceptPayment(address(other), address(usdc), 50e18, 1, 0, 0);
        vm.stopPrank();

        ap.distributePayments(address(other), address(usdc));
        (, uint256 bb, uint256 wd) = ap.getBalances(address(other), address(usdc));
        assertEq(bb, 50e18);
        assertEq(wd, 0);
    }

    // ── AP-9 / AP-10: buyback guards ─────────────────────────────────────────

    function testBuybackWithEmptyVaultReverts() public {
        vm.prank(owner);
        vm.expectRevert(AgentPayments.NothingToProcess.selector);
        ap.buybackTrigger(address(agentTok), address(usdc), address(router), hex"1234");
    }

    function testBuybackRejectsAgentTokenAsRouter() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        vm.startPrank(owner);
        ap.setRouterAllowed(address(agentTok), true);
        vm.expectRevert(AgentPayments.RouterNotAllowed.selector);
        ap.buybackTrigger(address(agentTok), address(usdc), address(agentTok), hex"1234");
        vm.stopPrank();
    }

    function testBuybackRevertsWhenNothingWasBought() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        EmptyRouter dead = new EmptyRouter();
        vm.startPrank(owner);
        ap.setRouterAllowed(address(dead), true);
        vm.expectRevert(AgentPayments.NoTokensBought.selector);
        ap.buybackTrigger(address(agentTok), address(usdc), address(dead), hex"1234");
        vm.stopPrank();

        (, uint256 bb,) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(bb, 30e18, "AP-9: a failed buyback must leave the vault intact");
    }

    function testBuybackRevertsWhenTheSwapReverts() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        FailingRouter bad = new FailingRouter();
        vm.startPrank(owner);
        ap.setRouterAllowed(address(bad), true);
        vm.expectRevert(AgentPayments.SwapFailed.selector);
        ap.buybackTrigger(address(agentTok), address(usdc), address(bad), hex"1234");
        vm.stopPrank();

        (, uint256 bb,) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(bb, 30e18);
    }

    function testNativeBuybackRevertsWhenTheSwapReverts() public {
        address nativeCur = ap.NATIVE_TOKEN();
        vm.deal(payer, 10 ether);
        vm.prank(payer);
        ap.acceptPaymentNative{value: 10 ether}(address(agentTok), 1, 0, 0);
        ap.distributePayments(address(agentTok), nativeCur);

        FailingRouter bad = new FailingRouter();
        vm.startPrank(owner);
        ap.setRouterAllowed(address(bad), true);
        vm.expectRevert(AgentPayments.SwapFailed.selector);
        ap.buybackTrigger(address(agentTok), nativeCur, address(bad), hex"1234");
        vm.stopPrank();

        (, uint256 bb,) = ap.getBalances(address(agentTok), nativeCur);
        assertEq(bb, 3 ether, "AP-9: a reverted native swap must leave the vault intact");
        assertEq(address(ap).balance, 10 ether);
    }

    function testBuybackLeavesNoStandingRouterAllowance() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));
        router.setPayout(1e18);

        vm.prank(owner);
        ap.buybackTrigger(address(agentTok), address(usdc), address(router), hex"1234");

        assertEq(
            usdc.allowance(address(ap), address(router)),
            0,
            "AP-10: no ERC-20 allowance may survive a buyback"
        );
    }

    function testRouterAllowListIsOwnerOnly() public {
        vm.prank(payer);
        vm.expectRevert();
        ap.setRouterAllowed(address(0xB0B), true);

        assertFalse(ap.allowedRouters(address(0xB0B)));
    }

    function testRouterAllowListRejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(AgentPayments.ZeroAddress.selector);
        ap.setRouterAllowed(address(0), true);
    }

    function testRouterCanBeRemovedFromTheAllowList() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        vm.startPrank(owner);
        ap.setRouterAllowed(address(router), false);
        vm.expectRevert(AgentPayments.RouterNotAllowed.selector);
        ap.buybackTrigger(address(agentTok), address(usdc), address(router), hex"1234");
        vm.stopPrank();
    }

    function testNativeBuybackSpendsTheVaultBalance() public {
        address nativeCur = ap.NATIVE_TOKEN();
        vm.deal(payer, 10 ether);
        vm.prank(payer);
        ap.acceptPaymentNative{value: 10 ether}(address(agentTok), 1, 0, 0);
        ap.distributePayments(address(agentTok), nativeCur);

        router.setPayout(5e18);
        vm.prank(owner);
        uint256 burned = ap.buybackTrigger(address(agentTok), nativeCur, address(router), hex"1234");

        assertEq(burned, 5e18);
        assertEq(address(router).balance, 3 ether, "the buyback vault (30%) was spent through the router");
        _assertConservation(address(agentTok), nativeCur, 10 ether);
    }

    // ── AP-11 / AP-13: withdrawal guards ─────────────────────────────────────

    function testWithdrawRejectsZeroReceiver() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        vm.prank(authority);
        vm.expectRevert(AgentPayments.ZeroAddress.selector);
        ap.withdraw(address(agentTok), address(usdc), address(0));

        (,, uint256 wd) = ap.getBalances(address(agentTok), address(usdc));
        assertEq(wd, 70e18);
    }

    function testWithdrawWithEmptyVaultReverts() public {
        vm.prank(authority);
        vm.expectRevert(AgentPayments.NothingToProcess.selector);
        ap.withdraw(address(agentTok), address(usdc), authority);
    }

    function testWithdrawTwiceReverts() public {
        _pay(100e18, 1);
        ap.distributePayments(address(agentTok), address(usdc));

        vm.startPrank(authority);
        ap.withdraw(address(agentTok), address(usdc), authority);
        vm.expectRevert(AgentPayments.NothingToProcess.selector);
        ap.withdraw(address(agentTok), address(usdc), authority);
        vm.stopPrank();
    }

    function testNativeWithdrawToARejectingReceiverReverts() public {
        address nativeCur = ap.NATIVE_TOKEN();
        NativeRejecter sink = new NativeRejecter();

        vm.deal(payer, 10 ether);
        vm.prank(payer);
        ap.acceptPaymentNative{value: 5 ether}(address(agentTok), 1, 0, 0);
        ap.distributePayments(address(agentTok), nativeCur);

        vm.prank(authority);
        vm.expectRevert(AgentPayments.NativeTransferFailed.selector);
        ap.withdraw(address(agentTok), nativeCur, address(sink));

        (,, uint256 wd) = ap.getBalances(address(agentTok), nativeCur);
        assertEq(wd, 3.5 ether, "a failed payout must not zero the vault");
    }

    function testReentrantNativeWithdrawIsBlocked() public {
        address nativeCur = ap.NATIVE_TOKEN();
        ReentrantReceiver attacker = new ReentrantReceiver(ap);

        vm.prank(authority);
        ap.updateAuthority(address(agentTok), address(attacker));

        vm.deal(payer, 10 ether);
        vm.prank(payer);
        ap.acceptPaymentNative{value: 5 ether}(address(agentTok), 1, 0, 0);
        ap.distributePayments(address(agentTok), nativeCur);

        attacker.pull(address(agentTok), nativeCur);

        assertTrue(attacker.reentryAttempted(), "the attack must actually have been attempted");
        assertFalse(attacker.reentrySucceeded(), "AP-13: nonReentrant must reject the second entry");
        assertEq(address(attacker).balance, 3.5 ether, "only one payout may land");
        _assertConservation(address(agentTok), nativeCur, 5 ether);
    }
}
