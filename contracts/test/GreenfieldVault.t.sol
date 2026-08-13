// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GreenfieldVault} from "../src/GreenfieldVault.sol";
import {IPermissionHub} from "../src/greenfield/IPermissionHub.sol";
import {MockCrossChain, MockPermissionHub, MockGnfdAccessControl} from "./mocks/MockGreenfield.sol";
import {Reentrant} from "./mocks/Reentrant.sol";

/// @notice Counterparty with no `receive`, so any ETH the vault sends it fails.
///         Proves the payout-failure branches of `buy`, `revoke`, and
///         `withdraw` revert instead of silently discarding the credit.
contract EthRejector {
    function doList(GreenfieldVault vault, bytes32 objectId, uint256 price) external {
        vault.list(objectId, price, address(this));
    }

    function doBuy(GreenfieldVault vault, bytes32 objectId, bytes calldata policyData) external payable {
        vault.buy{value: msg.value}(objectId, policyData);
    }

    function doRevoke(GreenfieldVault vault, uint256 saleId) external payable {
        vault.revoke{value: msg.value}(saleId);
    }

    function doWithdraw(GreenfieldVault vault) external {
        vault.withdraw();
    }
}

/// @dev Invariants under proof: GV-1 .. GV-8 of
///      `specs/ECONOMY_CONTRACT_INVARIANTS.md`.
contract GreenfieldVaultTest is Test {
    MockCrossChain internal crossChain;
    MockPermissionHub internal permissionHub;
    MockGnfdAccessControl internal accessControl;
    GreenfieldVault internal vault;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal buyer2 = makeAddr("buyer2");

    bytes32 internal constant OBJECT_ID = keccak256("three-ws/vault/object-1");
    bytes32 internal constant OBJECT_ID_2 = keccak256("three-ws/vault/object-2");
    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant RELAY_FEE = 0.001 ether;
    uint256 internal constant ACK_RELAY_FEE = 0.0005 ether;
    uint256 internal constant TOTAL_FEE = RELAY_FEE + ACK_RELAY_FEE;
    uint256 internal constant TOTAL_REQUIRED = PRICE + TOTAL_FEE;

    // Opaque stand-in for an off-chain-built Greenfield permission payload
    // (real protobuf principal/resource/statements — see GreenfieldVault.buy natspec).
    bytes internal constant POLICY_DATA = hex"0102030405";

    uint32 internal constant STATUS_SUCCESS = 0;
    uint32 internal constant STATUS_FAILED = 1;

    event Listed(bytes32 indexed objectId, address indexed seller, uint256 price);
    event Delisted(bytes32 indexed objectId, address indexed seller);
    event Purchased(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint256 price);
    event PolicyGranted(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint256 policyId);
    event PolicyGrantFailed(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint32 status);
    event RevokeRequested(bytes32 indexed objectId, uint256 indexed saleId, uint256 policyId);
    event Withdrawn(address indexed seller, uint256 amount);

    function setUp() public {
        crossChain = new MockCrossChain(RELAY_FEE, ACK_RELAY_FEE);
        permissionHub = new MockPermissionHub(crossChain);
        accessControl = new MockGnfdAccessControl();
        vault = new GreenfieldVault(address(permissionHub), address(crossChain), address(accessControl));

        vm.deal(seller, 10 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(buyer2, 10 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _grantRole(address _seller) internal {
        bytes32 role = vault.ROLE_CREATE();
        vm.prank(_seller);
        accessControl.grantRole(role, address(vault), 0);
    }

    function _list(address _seller, bytes32 objectId, uint256 price) internal {
        _grantRole(_seller);
        vm.prank(_seller);
        vault.list(objectId, price, _seller);
    }

    function _buy(address _buyer, bytes32 objectId) internal returns (uint256 saleId) {
        vm.prank(_buyer);
        saleId = vault.buy{value: TOTAL_REQUIRED}(objectId, POLICY_DATA);
    }

    // ── constructor ──────────────────────────────────────────────────────

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(GreenfieldVault.ZeroAddress.selector);
        new GreenfieldVault(address(0), address(crossChain), address(accessControl));

        vm.expectRevert(GreenfieldVault.ZeroAddress.selector);
        new GreenfieldVault(address(permissionHub), address(0), address(accessControl));

        vm.expectRevert(GreenfieldVault.ZeroAddress.selector);
        new GreenfieldVault(address(permissionHub), address(crossChain), address(0));
    }

    // ── list / delist ────────────────────────────────────────────────────

    function testListRequiresRoleGrant() public {
        vm.prank(seller);
        vm.expectRevert(GreenfieldVault.NotAuthorizedByObjectOwner.selector);
        vault.list(OBJECT_ID, PRICE, seller);
    }

    function testListOnlySeller() public {
        _grantRole(seller);
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.OnlySeller.selector);
        vault.list(OBJECT_ID, PRICE, seller);
    }

    function testListRejectsBadInput() public {
        _grantRole(seller);
        vm.startPrank(seller);
        vm.expectRevert(GreenfieldVault.BadObjectId.selector);
        vault.list(bytes32(0), PRICE, seller);

        vm.expectRevert(GreenfieldVault.BadPrice.selector);
        vault.list(OBJECT_ID, 0, seller);

        vm.expectRevert(GreenfieldVault.ZeroAddress.selector);
        vault.list(OBJECT_ID, PRICE, address(0));
        vm.stopPrank();
    }

    function testListEmitsAndStores() public {
        _grantRole(seller);
        vm.prank(seller);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Listed(OBJECT_ID, seller, PRICE);
        vault.list(OBJECT_ID, PRICE, seller);

        (address listedSeller, uint256 price, bool active) = vault.listings(OBJECT_ID);
        assertEq(listedSeller, seller);
        assertEq(price, PRICE);
        assertTrue(active);
    }

    function testRelistBySameSellerUpdatesPrice() public {
        _list(seller, OBJECT_ID, PRICE);
        vm.prank(seller);
        vault.list(OBJECT_ID, PRICE * 2, seller);
        (, uint256 price,) = vault.listings(OBJECT_ID);
        assertEq(price, PRICE * 2);
    }

    function testListByAnotherSellerReverts() public {
        _list(seller, OBJECT_ID, PRICE);
        _grantRole(buyer);
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.ListedByAnotherSeller.selector);
        vault.list(OBJECT_ID, PRICE, buyer);
    }

    function testDelist() public {
        _list(seller, OBJECT_ID, PRICE);
        vm.prank(seller);
        vm.expectEmit(true, true, false, true, address(vault));
        emit Delisted(OBJECT_ID, seller);
        vault.delist(OBJECT_ID);

        (,, bool active) = vault.listings(OBJECT_ID);
        assertFalse(active);
    }

    function testDelistOnlySeller() public {
        _list(seller, OBJECT_ID, PRICE);
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.OnlySeller.selector);
        vault.delist(OBJECT_ID);
    }

    function testDelistNotListedReverts() public {
        vm.expectRevert(GreenfieldVault.NotListed.selector);
        vault.delist(OBJECT_ID);
    }

    // ── buy ──────────────────────────────────────────────────────────────

    function testBuyHappyPathAndSettlement() public {
        _list(seller, OBJECT_ID, PRICE);

        vm.prank(buyer);
        vm.expectEmit(true, true, true, true, address(vault));
        emit Purchased(OBJECT_ID, buyer, 1, PRICE);
        uint256 saleId = vault.buy{value: TOTAL_REQUIRED}(OBJECT_ID, POLICY_DATA);

        assertEq(saleId, 1);
        assertEq(vault.pendingWithdrawals(seller), PRICE);
        assertEq(vault.saleIdOf(OBJECT_ID, buyer), 1);

        (
            bytes32 objId,
            address buy_,
            address sell_,
            uint256 price_,
            uint256 policyId_,
            GreenfieldVault.SaleStatus status_
        ) = vault.sales(1);
        assertEq(objId, OBJECT_ID);
        assertEq(buy_, buyer);
        assertEq(sell_, seller);
        assertEq(price_, PRICE);
        assertEq(policyId_, 0);
        assertEq(uint8(status_), uint8(GreenfieldVault.SaleStatus.Pending));

        // Simulate the real Greenfield relayer settling the ack.
        vm.expectEmit(true, true, true, true, address(vault));
        emit PolicyGranted(OBJECT_ID, buyer, 1, 1);
        permissionHub.settleCreatePolicy(1, STATUS_SUCCESS);

        (,,,, uint256 policyIdAfter, GreenfieldVault.SaleStatus statusAfter) = vault.sales(1);
        assertEq(policyIdAfter, 1);
        assertEq(uint8(statusAfter), uint8(GreenfieldVault.SaleStatus.Granted));
    }

    function testBuyUnlistedReverts() public {
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.NotListed.selector);
        vault.buy{value: TOTAL_REQUIRED}(OBJECT_ID, POLICY_DATA);
    }

    function testBuyEmptyPolicyDataReverts() public {
        _list(seller, OBJECT_ID, PRICE);
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.EmptyPolicyData.selector);
        vault.buy{value: TOTAL_REQUIRED}(OBJECT_ID, "");
    }

    function testBuyUnderpaymentReverts() public {
        _list(seller, OBJECT_ID, PRICE);
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.InsufficientPayment.selector);
        vault.buy{value: TOTAL_REQUIRED - 1}(OBJECT_ID, POLICY_DATA);
    }

    function testBuyMissingCrossChainFeeReverts() public {
        _list(seller, OBJECT_ID, PRICE);
        // Pays the exact list price but covers none of the relay fee.
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.InsufficientPayment.selector);
        vault.buy{value: PRICE}(OBJECT_ID, POLICY_DATA);
    }

    function testBuyDoesNotHalfExecuteOnUnderpayment() public {
        _list(seller, OBJECT_ID, PRICE);
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.InsufficientPayment.selector);
        vault.buy{value: PRICE}(OBJECT_ID, POLICY_DATA);

        // Nothing was recorded: no sale, no pending withdrawal, no saleIdOf entry.
        assertEq(vault.nextSaleId(), 1);
        assertEq(vault.pendingWithdrawals(seller), 0);
        assertEq(vault.saleIdOf(OBJECT_ID, buyer), 0);
    }

    function testBuyRefundsExcessPayment() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 overpay = TOTAL_REQUIRED + 0.5 ether;
        uint256 before = buyer.balance;

        vm.prank(buyer);
        vault.buy{value: overpay}(OBJECT_ID, POLICY_DATA);

        assertEq(buyer.balance, before - TOTAL_REQUIRED);
    }

    /// GV-2 (negative half): a (objectId, buyer) pair may not buy twice while
    /// a purchase is open. The retry-after-failure and resell-after-revoke
    /// halves are proven by testSettlementFailureAllowsRetry and
    /// testRevokeHappyPath.
    function testDoubleBuySameBuyerReverts() public {
        _list(seller, OBJECT_ID, PRICE);
        _buy(buyer, OBJECT_ID);

        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.AlreadyPurchased.selector);
        vault.buy{value: TOTAL_REQUIRED}(OBJECT_ID, POLICY_DATA);
    }

    /// GV-2 (positive half): distinct buyers are independent pairs and may
    /// each hold an open purchase on the same object.
    function testDifferentBuyersCanEachPurchase() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId1 = _buy(buyer, OBJECT_ID);
        uint256 saleId2 = _buy(buyer2, OBJECT_ID);
        assertTrue(saleId1 != saleId2);
        assertEq(vault.pendingWithdrawals(seller), PRICE * 2);
    }

    function testSettlementFailureAllowsRetry() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId = _buy(buyer, OBJECT_ID);

        vm.expectEmit(true, true, true, true, address(vault));
        emit PolicyGrantFailed(OBJECT_ID, buyer, saleId, STATUS_FAILED);
        permissionHub.settleCreatePolicy(saleId, STATUS_FAILED);

        (,,,,, GreenfieldVault.SaleStatus status) = vault.sales(saleId);
        assertEq(uint8(status), uint8(GreenfieldVault.SaleStatus.Failed));
        assertEq(vault.saleIdOf(OBJECT_ID, buyer), 0);

        // Buyer can now retry.
        uint256 saleId2 = _buy(buyer, OBJECT_ID);
        assertTrue(saleId2 != saleId);
    }

    // ── GV-6: greenfieldCall access control ────────────────────────────────

    /// GV-6 (negative half): only the PermissionHub contract may deliver an ack.
    function testGreenfieldCallOnlyPermissionHub() public {
        vm.expectRevert(GreenfieldVault.OnlyPermissionHub.selector);
        vault.greenfieldCall(STATUS_SUCCESS, 0x07, 2, 1, abi.encode(uint256(1)));
    }

    /// GV-6 (negative half): only the permission channel is accepted.
    function testGreenfieldCallBadChannelReverts() public {
        vm.prank(address(permissionHub));
        vm.expectRevert(GreenfieldVault.BadChannel.selector);
        vault.greenfieldCall(STATUS_SUCCESS, 0x05, 2, 1, abi.encode(uint256(1)));
    }

    /// GV-6 (negative half): an ack for a sale that does not exist reverts.
    function testGreenfieldCallUnknownSaleReverts() public {
        vm.prank(address(permissionHub));
        vm.expectRevert(GreenfieldVault.UnknownSale.selector);
        vault.greenfieldCall(STATUS_SUCCESS, 0x07, 2, 999, abi.encode(uint256(999)));
    }

    // ── GV-9: a declined hub request is never treated as accepted ──────────

    /// GV-9 (negative half): `createPolicy` returning false (the hub declining
    /// without reverting) unwinds the whole purchase. Nothing is credited to the
    /// seller, no sale id is retained, and the buyer keeps their money.
    function testBuyRevertsWhenHubDeclinesCreatePolicy() public {
        _list(seller, OBJECT_ID, PRICE);
        permissionHub.setRejectOnCreate(true);

        uint256 buyerBalanceBefore = buyer.balance;
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.PolicyRequestRejected.selector);
        vault.buy{value: TOTAL_REQUIRED}(OBJECT_ID, POLICY_DATA);

        assertEq(buyer.balance, buyerBalanceBefore);
        assertEq(vault.pendingWithdrawals(seller), 0);
        assertEq(vault.saleIdOf(OBJECT_ID, buyer), 0);
        assertEq(address(vault).balance, 0);
    }

    /// GV-9 (positive half): once the hub stops declining, the same buyer can
    /// purchase normally, so the rejection left no poisoned state behind.
    function testBuySucceedsAfterHubStopsDeclining() public {
        _list(seller, OBJECT_ID, PRICE);
        permissionHub.setRejectOnCreate(true);
        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.PolicyRequestRejected.selector);
        vault.buy{value: TOTAL_REQUIRED}(OBJECT_ID, POLICY_DATA);

        permissionHub.setRejectOnCreate(false);
        uint256 saleId = _buy(buyer, OBJECT_ID);
        assertEq(vault.saleIdOf(OBJECT_ID, buyer), saleId);
        assertEq(vault.pendingWithdrawals(seller), PRICE);
    }

    /// GV-9 (negative half, revoke side): `deletePolicy` returning false leaves
    /// the sale Granted rather than marking it Revoked while the buyer still
    /// holds a live Greenfield grant.
    function testRevokeRevertsWhenHubDeclinesDeletePolicy() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId = _buy(buyer, OBJECT_ID);
        permissionHub.settleCreatePolicy(saleId, STATUS_SUCCESS);

        permissionHub.setRejectOnDelete(true);
        vm.prank(seller);
        vm.expectRevert(GreenfieldVault.PolicyRequestRejected.selector);
        vault.revoke{value: TOTAL_FEE}(saleId);

        (,,,,, GreenfieldVault.SaleStatus status) = vault.sales(saleId);
        assertEq(uint8(status), uint8(GreenfieldVault.SaleStatus.Granted));
        assertEq(vault.saleIdOf(OBJECT_ID, buyer), saleId);
    }

    // ── revoke ───────────────────────────────────────────────────────────

    function testRevokeHappyPath() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId = _buy(buyer, OBJECT_ID);
        permissionHub.settleCreatePolicy(saleId, STATUS_SUCCESS);

        vm.prank(seller);
        vm.expectEmit(true, true, false, true, address(vault));
        emit RevokeRequested(OBJECT_ID, saleId, saleId); // policyId == saleId here (both start at 1)
        vault.revoke{value: TOTAL_FEE}(saleId);

        (,,,,, GreenfieldVault.SaleStatus status) = vault.sales(saleId);
        assertEq(uint8(status), uint8(GreenfieldVault.SaleStatus.Revoked));
        assertEq(vault.saleIdOf(OBJECT_ID, buyer), 0);
        assertTrue(permissionHub.deletedPolicies(saleId));

        // Buyer can be resold access.
        uint256 saleId2 = _buy(buyer, OBJECT_ID);
        assertTrue(saleId2 != saleId);
    }

    function testRevokeOnlySaleSeller() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId = _buy(buyer, OBJECT_ID);
        permissionHub.settleCreatePolicy(saleId, STATUS_SUCCESS);

        vm.prank(buyer);
        vm.expectRevert(GreenfieldVault.NotSaleSeller.selector);
        vault.revoke{value: TOTAL_FEE}(saleId);
    }

    function testRevokeUnknownSaleReverts() public {
        vm.prank(seller);
        vm.expectRevert(GreenfieldVault.UnknownSale.selector);
        vault.revoke{value: TOTAL_FEE}(999);
    }

    function testRevokeRequiresGrantedStatus() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId = _buy(buyer, OBJECT_ID);
        // Still Pending — never settled.
        vm.prank(seller);
        vm.expectRevert(GreenfieldVault.SaleNotGranted.selector);
        vault.revoke{value: TOTAL_FEE}(saleId);
    }

    function testRevokeInsufficientFeeReverts() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId = _buy(buyer, OBJECT_ID);
        permissionHub.settleCreatePolicy(saleId, STATUS_SUCCESS);

        vm.prank(seller);
        vm.expectRevert(GreenfieldVault.InsufficientRelayFee.selector);
        vault.revoke{value: TOTAL_FEE - 1}(saleId);
    }

    function testRevokeRefundsExcessFee() public {
        _list(seller, OBJECT_ID, PRICE);
        uint256 saleId = _buy(buyer, OBJECT_ID);
        permissionHub.settleCreatePolicy(saleId, STATUS_SUCCESS);

        uint256 before = seller.balance;
        vm.prank(seller);
        vault.revoke{value: TOTAL_FEE + 0.2 ether}(saleId);
        assertEq(seller.balance, before - TOTAL_FEE);
    }

    // ── withdraw ─────────────────────────────────────────────────────────

    function testWithdrawHappyPath() public {
        _list(seller, OBJECT_ID, PRICE);
        _buy(buyer, OBJECT_ID);

        uint256 before = seller.balance;
        vm.prank(seller);
        vm.expectEmit(true, false, false, true, address(vault));
        emit Withdrawn(seller, PRICE);
        uint256 amount = vault.withdraw();

        assertEq(amount, PRICE);
        assertEq(seller.balance, before + PRICE);
        assertEq(vault.pendingWithdrawals(seller), 0);
    }

    function testWithdrawNothingReverts() public {
        vm.prank(seller);
        vm.expectRevert(GreenfieldVault.NothingToWithdraw.selector);
        vault.withdraw();
    }

    /// GV-4: a seller that cannot receive ETH gets a revert, not a silent
    /// zeroing of its credited balance.
    function testWithdrawToARejectingSellerReverts() public {
        EthRejector badSeller = new EthRejector();
        bytes32 role = vault.ROLE_CREATE();
        vm.prank(address(badSeller));
        accessControl.grantRole(role, address(vault), 0);
        badSeller.doList(vault, OBJECT_ID, PRICE);

        _buy(buyer, OBJECT_ID);
        assertEq(vault.pendingWithdrawals(address(badSeller)), PRICE);

        vm.expectRevert(GreenfieldVault.TransferFailed.selector);
        badSeller.doWithdraw(vault);

        assertEq(vault.pendingWithdrawals(address(badSeller)), PRICE, "GV-4: the credit survives a failed payout");
    }

    /// GV-3: a buyer that cannot receive its refund gets a revert, so the
    /// purchase never half-lands.
    function testBuyRefundFailureRevertsTheWholePurchase() public {
        _list(seller, OBJECT_ID, PRICE);

        EthRejector badBuyer = new EthRejector();
        vm.deal(address(badBuyer), 10 ether);

        vm.expectRevert(GreenfieldVault.TransferFailed.selector);
        badBuyer.doBuy{value: TOTAL_REQUIRED + 1 ether}(vault, OBJECT_ID, POLICY_DATA);

        assertEq(vault.saleIdOf(OBJECT_ID, address(badBuyer)), 0, "GV-3: no sale may survive a failed refund");
        assertEq(vault.pendingWithdrawals(seller), 0);
    }

    /// GV-7: same for a seller's excess relay fee on revoke.
    function testRevokeRefundFailureReverts() public {
        EthRejector badSeller = new EthRejector();
        bytes32 role = vault.ROLE_CREATE();
        vm.prank(address(badSeller));
        accessControl.grantRole(role, address(vault), 0);
        badSeller.doList(vault, OBJECT_ID, PRICE);
        vm.deal(address(badSeller), 10 ether);

        uint256 saleId = _buy(buyer, OBJECT_ID);
        // Settle through the mock hub, not a pranked greenfieldCall: the hub
        // must record the vault as the policy owner or its deletePolicy
        // rejects the revoke before the refund path under test is reached.
        permissionHub.settleCreatePolicy(saleId, STATUS_SUCCESS);

        vm.expectRevert(GreenfieldVault.TransferFailed.selector);
        badSeller.doRevoke{value: TOTAL_FEE + 1 ether}(vault, saleId);

        (,,,,, GreenfieldVault.SaleStatus status) = vault.sales(saleId);
        assertEq(uint8(status), uint8(GreenfieldVault.SaleStatus.Granted), "the sale stays Granted");
    }

    // ── GV-5: the vault always holds enough to pay every seller ──────────────

    function testVaultBalanceCoversEveryPendingWithdrawal() public {
        _list(seller, OBJECT_ID, PRICE);
        _list(seller, OBJECT_ID_2, 2 ether);

        _buy(buyer, OBJECT_ID);
        vm.prank(buyer2);
        vault.buy{value: 2 ether + TOTAL_FEE}(OBJECT_ID_2, POLICY_DATA);

        assertEq(vault.pendingWithdrawals(seller), 3 ether);
        assertGe(address(vault).balance, vault.pendingWithdrawals(seller), "GV-5: held ETH must cover every credit");

        vm.prank(seller);
        vault.withdraw();
        assertGe(address(vault).balance, vault.pendingWithdrawals(seller));
    }

    // ── views ────────────────────────────────────────────────────────────

    function testQuoteRelayFee() public view {
        (uint256 relayFee, uint256 minAckRelayFee, uint256 total) = vault.quoteRelayFee();
        assertEq(relayFee, RELAY_FEE);
        assertEq(minAckRelayFee, ACK_RELAY_FEE);
        assertEq(total, TOTAL_FEE);
    }

    // ── re-entrancy ──────────────────────────────────────────────────────

    /// Proves `nonReentrant` blocks a *cross-function* reentrant call: an
    /// attacker buying object A, whose refund callback tries to buy an
    /// entirely separate, validly listed object B. Absent the guard this
    /// nested `buy()` would succeed outright (B is listed, unpurchased, fully
    /// funded) — instead the whole outer transaction reverts, proving the
    /// lock (not incidental state) is what stopped it.
    function testReentrantBuyBlocked() public {
        _list(seller, OBJECT_ID, PRICE);
        _list(seller, OBJECT_ID_2, PRICE);

        Reentrant attacker = new Reentrant(vault);
        vm.deal(address(attacker), 10 ether);

        attacker.arm(abi.encodeWithSelector(GreenfieldVault.buy.selector, OBJECT_ID_2, POLICY_DATA), TOTAL_REQUIRED);

        uint256 overpay = TOTAL_REQUIRED + TOTAL_REQUIRED; // enough refund to fund the nested attempt
        // The outer buy() itself succeeds — the low-level refund call only
        // reverts if the *callee* (receive()) reverts, and receive() swallows
        // the nested call's failure via a low-level `.call`. What proves the
        // guard fired is that the nested call captured inside `attacker`
        // failed with exactly `ReentrancyGuardReentrantCall`.
        attacker.doBuy{value: overpay}(OBJECT_ID, POLICY_DATA);

        assertTrue(attacker.reentryAttempted());
        assertFalse(attacker.reentryOk());
        assertEq(bytes4(attacker.reentryReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);

        // The nested buy never happened: object B is still unpurchased.
        assertEq(vault.saleIdOf(OBJECT_ID_2, address(attacker)), 0);
    }

    /// Same proof against `withdraw()`: a malicious seller's payout callback
    /// tries to re-enter `withdraw()` itself.
    function testReentrantWithdrawBlocked() public {
        Reentrant attacker = new Reentrant(vault);
        bytes32 role = vault.ROLE_CREATE();
        vm.prank(address(attacker));
        accessControl.grantRole(role, address(vault), 0);
        attacker.doList(OBJECT_ID, PRICE);

        _buy(buyer, OBJECT_ID);
        assertEq(vault.pendingWithdrawals(address(attacker)), PRICE);

        attacker.arm(abi.encodeWithSelector(GreenfieldVault.withdraw.selector), 0);

        attacker.doWithdraw();

        assertTrue(attacker.reentryAttempted());
        assertFalse(attacker.reentryOk());
        assertEq(bytes4(attacker.reentryReturnData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }
}
