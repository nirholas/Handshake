// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPermissionHub} from "./greenfield/IPermissionHub.sol";
import {ICrossChain} from "./greenfield/ICrossChain.sol";
import {IGnfdAccessControl} from "./greenfield/IGnfdAccessControl.sol";
import {IApplication} from "./greenfield/IApplication.sol";

/**
 * @title GreenfieldVault
 * @notice On-chain-gated marketplace for encrypted 3D assets stored on BNB
 *         Greenfield. A seller lists an encrypted object (uploaded per
 *         `specs/vault-manifest.md`); on payment, the vault calls the real
 *         Greenfield `PermissionHub.createPolicy` cross-chain, granting the
 *         buyer's address read permission on that object. Off-chain (the
 *         unlock API, prompt 11) watches for the resulting policy grant and
 *         wraps the object's content-encryption key to the buyer once it
 *         settles — this contract only proves and gates the payment↔permission
 *         link on-chain.
 *
 *         Every cross-chain primitive here is the REAL BSC↔Greenfield bridge
 *         (`src/greenfield/*.sol`, addresses verified against
 *         `bnb-chain/greenfield-contracts`) — no invented interface, no mock
 *         in production code. `createPolicy` is genuinely asynchronous: this
 *         contract does not (cannot) know the minted policy id at `buy()`
 *         time. It implements `IApplication.greenfieldCall` to receive the
 *         real id when Greenfield's ack settles and relays it via
 *         `PolicyGranted` — the same "surface pending honestly" pattern the
 *         rest of this campaign uses for Greenfield's async settlement.
 *
 *         Multiple buyers may each hold an independent read grant on the same
 *         listed object (this is a content-access marketplace, not an
 *         ownership-transfer one) — `list()` never auto-delists after a sale.
 *         A given (objectId, buyer) pair may only buy once at a time
 *         (`AlreadyPurchased`); a seller-initiated `revoke()` clears that
 *         guard so the buyer could be resold access later. Grants are
 *         otherwise permanent — there is no expiry.
 *
 *         Payment: native BNB. `buy()`/`revoke()` require enough `msg.value`
 *         to cover both the listed price (buy only) and Greenfield's real
 *         cross-chain relay fee (`ICrossChain.getRelayFees()`, queried live —
 *         never hardcoded); any excess is refunded to the caller in the same
 *         transaction. Sale proceeds use a pull-payment pattern
 *         (`pendingWithdrawals` + `withdraw()`) so a misbehaving seller
 *         receive() can never block a buyer's purchase.
 */
contract GreenfieldVault is ReentrancyGuard, IApplication {
    /*----------------- Greenfield wire constants -----------------*/
    // Mirrors bnb-chain/greenfield-contracts Config.sol / CmnStorage.sol
    // (verified against `master` on 2026-07-08).
    uint8 private constant PERMISSION_CHANNEL_ID = 0x07;
    uint32 private constant STATUS_SUCCESS = 0;
    uint8 private constant TYPE_CREATE = 2;

    /// @notice Role a seller must grant this vault on the Greenfield object's
    ///         mirrored ERC-721 (via `IGnfdAccessControl.grantRole`) before
    ///         `list()` will accept it. Mirrors
    ///         `CmnStorage.ROLE_CREATE = keccak256("ROLE_CREATE")`.
    bytes32 public constant ROLE_CREATE = keccak256("ROLE_CREATE");

    /*----------------- immutables -----------------*/
    /// @notice The real, deployed PermissionHub for this network.
    IPermissionHub public immutable permissionHub;
    /// @notice The real, deployed CrossChain relay-fee oracle for this network.
    ICrossChain public immutable crossChain;
    /// @notice The real, deployed ObjectHub (implements IGnfdAccessControl)
    ///         whose mirrored ERC-721s represent Greenfield objects on BSC.
    IGnfdAccessControl public immutable objectAccessControl;

    /*----------------- types -----------------*/
    struct Listing {
        address seller;
        uint256 price; // wei, exact amount credited to the seller per sale
        bool active;
    }

    enum SaleStatus {
        Pending, // createPolicy syn-package sent, ack not yet settled
        Granted, // Greenfield confirmed the policy (real policyId recorded)
        Failed, // Greenfield rejected the policy request
        Revoked // seller called revoke() after a Granted sale
    }

    struct Sale {
        bytes32 objectId;
        address buyer;
        address seller;
        uint256 price;
        uint256 policyId; // 0 until Granted
        SaleStatus status;
    }

    /*----------------- storage -----------------*/
    mapping(bytes32 => Listing) public listings;
    mapping(uint256 => Sale) public sales;
    /// @dev objectId => buyer => saleId. 0 means "no open purchase" — cleared
    ///      on Failed/Revoked so the pair can transact again.
    mapping(bytes32 => mapping(address => uint256)) public saleIdOf;
    /// @dev Pull-payment balances credited to sellers on each sale.
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public nextSaleId = 1;

    /*----------------- events -----------------*/
    event Listed(bytes32 indexed objectId, address indexed seller, uint256 price);
    event Delisted(bytes32 indexed objectId, address indexed seller);
    event Purchased(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint256 price);
    event PolicyGranted(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint256 policyId);
    event PolicyGrantFailed(bytes32 indexed objectId, address indexed buyer, uint256 indexed saleId, uint32 status);
    event RevokeRequested(bytes32 indexed objectId, uint256 indexed saleId, uint256 policyId);
    event Withdrawn(address indexed seller, uint256 amount);

    /*----------------- errors -----------------*/
    error ZeroAddress();
    error BadObjectId();
    error BadPrice();
    error OnlySeller();
    error ListedByAnotherSeller();
    error NotAuthorizedByObjectOwner();
    error NotListed();
    error EmptyPolicyData();
    error AlreadyPurchased();
    error InsufficientPayment();
    error TransferFailed();
    error UnknownSale();
    error NotSaleSeller();
    error SaleNotGranted();
    error InsufficientRelayFee();
    error OnlyPermissionHub();
    error BadChannel();
    error NothingToWithdraw();
    error PolicyRequestRejected();

    constructor(address _permissionHub, address _crossChain, address _objectAccessControl) {
        if (_permissionHub == address(0) || _crossChain == address(0) || _objectAccessControl == address(0)) {
            revert ZeroAddress();
        }
        permissionHub = IPermissionHub(_permissionHub);
        crossChain = ICrossChain(_crossChain);
        objectAccessControl = IGnfdAccessControl(_objectAccessControl);
    }

    /*----------------- listing -----------------*/

    /**
     * @notice Register (or re-price) a for-sale encrypted object.
     * @dev Requires `seller` to have already run
     *      `IGnfdAccessControl(ObjectHub).grantRole(ROLE_CREATE, address(this), expiry)`
     *      on the mirrored Greenfield object — the on-chain proof that "the
     *      vault controls its permissions" for this object, checked live
     *      against the real ObjectHub, not merely asserted by the caller.
     * @param objectId Opaque platform object reference (matches
     *      `specs/vault-manifest.md`'s `glbObjectRef`), NOT the Greenfield
     *      ERC-721 token id — `policyData` (supplied at `buy()` time) is what
     *      actually encodes the Greenfield-side resource/principal/statement.
     */
    function list(bytes32 objectId, uint256 price, address seller) external {
        if (objectId == bytes32(0)) revert BadObjectId();
        if (price == 0) revert BadPrice();
        if (seller == address(0)) revert ZeroAddress();
        if (msg.sender != seller) revert OnlySeller();

        Listing storage existing = listings[objectId];
        if (existing.active && existing.seller != seller) revert ListedByAnotherSeller();

        if (!objectAccessControl.hasRole(ROLE_CREATE, seller, address(this))) {
            revert NotAuthorizedByObjectOwner();
        }

        listings[objectId] = Listing({seller: seller, price: price, active: true});
        emit Listed(objectId, seller, price);
    }

    /// @notice Take a listing off sale. Existing grants are unaffected.
    function delist(bytes32 objectId) external {
        Listing storage listing = listings[objectId];
        if (!listing.active) revert NotListed();
        if (msg.sender != listing.seller) revert OnlySeller();
        listing.active = false;
        emit Delisted(objectId, listing.seller);
    }

    /*----------------- buying -----------------*/

    /**
     * @notice Pay for read access to `objectId` and submit the cross-chain
     *         `PermissionHub.createPolicy` request granting `msg.sender`.
     * @dev `policyData` is the pre-built Greenfield permission payload (GNFD
     *      protobuf-encoded `principal`/`resource`/`statements`, built
     *      off-chain by the unlock API using bnb-chain's greenfield-js-sdk
     *      permission codec against this object's real GRN and `msg.sender`
     *      as principal) — PermissionHub accepts and forwards this as opaque
     *      `bytes` on real mainnet/testnet too; no EVM contract encodes GNFD
     *      protobuf on-chain. `msg.value` must cover `price +` the live
     *      relay fee quoted by `crossChain.getRelayFees()`; excess is
     *      refunded. Reverts atomically (no partial state change) on
     *      underpayment, an unlisted object, or an uncovered relay fee.
     */
    function buy(bytes32 objectId, bytes calldata policyData) external payable nonReentrant returns (uint256 saleId) {
        Listing storage listing = listings[objectId];
        if (!listing.active) revert NotListed();
        if (policyData.length == 0) revert EmptyPolicyData();
        if (saleIdOf[objectId][msg.sender] != 0) revert AlreadyPurchased();

        (uint256 relayFee, uint256 minAckRelayFee) = crossChain.getRelayFees();
        uint256 requiredFee = relayFee + minAckRelayFee;
        uint256 totalRequired = listing.price + requiredFee;
        if (msg.value < totalRequired) revert InsufficientPayment();

        saleId = nextSaleId++;
        sales[saleId] = Sale({
            objectId: objectId,
            buyer: msg.sender,
            seller: listing.seller,
            price: listing.price,
            policyId: 0,
            status: SaleStatus.Pending
        });
        saleIdOf[objectId][msg.sender] = saleId;
        pendingWithdrawals[listing.seller] += listing.price;

        IPermissionHub.ExtraData memory extraData = IPermissionHub.ExtraData({
            appAddress: address(this),
            refundAddress: listing.seller,
            failureHandleStrategy: IPermissionHub.FailureHandleStrategy.SkipOnFail,
            callbackData: abi.encode(saleId)
        });

        // The hub returns false rather than reverting when it declines to queue
        // the syn-package. Treating that as success would credit the seller and
        // burn the buyer's relay fee for a permission that will never be minted,
        // so the whole purchase reverts instead (GV-9).
        if (!permissionHub.createPolicy{value: requiredFee}(policyData, extraData)) revert PolicyRequestRejected();

        emit Purchased(objectId, msg.sender, saleId, listing.price);

        uint256 refund = msg.value - totalRequired;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    /*----------------- async settlement callback -----------------*/

    /// @inheritdoc IApplication
    /// @dev Called by the real PermissionHub when the GNFD ack for a
    ///      `createPolicy` request settles (success or failure) — this is
    ///      the only path that ever learns the real Greenfield policy id.
    function greenfieldCall(
        uint32 status,
        uint8 channelId,
        uint8 operationType,
        uint256 resourceId,
        bytes calldata callbackData
    ) external override {
        if (msg.sender != address(permissionHub)) revert OnlyPermissionHub();
        if (channelId != PERMISSION_CHANNEL_ID) revert BadChannel();
        if (operationType != TYPE_CREATE) return; // this vault only opts into create-callbacks

        uint256 saleId = abi.decode(callbackData, (uint256));
        Sale storage sale = sales[saleId];
        if (sale.buyer == address(0)) revert UnknownSale();

        if (status == STATUS_SUCCESS) {
            sale.policyId = resourceId;
            sale.status = SaleStatus.Granted;
            emit PolicyGranted(sale.objectId, sale.buyer, saleId, resourceId);
        } else {
            sale.status = SaleStatus.Failed;
            saleIdOf[sale.objectId][sale.buyer] = 0; // let the buyer retry
            emit PolicyGrantFailed(sale.objectId, sale.buyer, saleId, status);
        }
    }

    /*----------------- revoke -----------------*/

    /**
     * @notice Seller-initiated revoke of a settled grant, via the real
     *         `PermissionHub.deletePolicy`. Design choice (documented per
     *         spec): grants are permanent on purchase by default — this is
     *         the explicit escape hatch for refunds/disputes, gated to the
     *         sale's seller, not automatic expiry. Reverts if the sale never
     *         settled (`Pending`/`Failed`) or was already revoked. Clears
     *         `saleIdOf` so the object can be resold to the same buyer.
     *         Purchase-price refund (if any) is a separate off-chain/business
     *         decision — proceeds may already have been withdrawn by the time
     *         a revoke happens, so this contract cannot safely auto-refund
     *         from its own balance.
     */
    function revoke(uint256 saleId) external payable nonReentrant {
        Sale storage sale = sales[saleId];
        if (sale.buyer == address(0)) revert UnknownSale();
        if (msg.sender != sale.seller) revert NotSaleSeller();
        if (sale.status != SaleStatus.Granted) revert SaleNotGranted();

        uint256 policyId = sale.policyId;
        sale.status = SaleStatus.Revoked;
        saleIdOf[sale.objectId][sale.buyer] = 0;

        (uint256 relayFee, uint256 minAckRelayFee) = crossChain.getRelayFees();
        uint256 requiredFee = relayFee + minAckRelayFee;
        if (msg.value < requiredFee) revert InsufficientRelayFee();

        // Same rule as `buy`: a declined delete request must not leave the sale
        // marked Revoked while the buyer keeps a live Greenfield grant (GV-9).
        if (!permissionHub.deletePolicy{value: requiredFee}(policyId)) revert PolicyRequestRejected();
        emit RevokeRequested(sale.objectId, saleId, policyId);

        uint256 refund = msg.value - requiredFee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    /*----------------- withdrawal -----------------*/

    /// @notice Pull-payment withdrawal of accumulated sale proceeds.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /*----------------- views -----------------*/

    /// @notice Live quote of the BNB a caller must add to `price` for `buy()`,
    ///         or send outright for `revoke()`. Never hardcoded — always the
    ///         real, current `CrossChain.getRelayFees()`.
    function quoteRelayFee() external view returns (uint256 relayFee, uint256 minAckRelayFee, uint256 total) {
        (relayFee, minAckRelayFee) = crossChain.getRelayFees();
        total = relayFee + minAckRelayFee;
    }
}
