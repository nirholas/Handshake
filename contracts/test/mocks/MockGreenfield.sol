// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPermissionHub} from "../../src/greenfield/IPermissionHub.sol";
import {ICrossChain} from "../../src/greenfield/ICrossChain.sol";
import {IGnfdAccessControl} from "../../src/greenfield/IGnfdAccessControl.sol";
import {IApplication} from "../../src/greenfield/IApplication.sol";

/// @notice Minimal, faithful mock of the real `CrossChain` relay-fee oracle.
///         Fees are test-configurable; every other real hub (including the
///         mock PermissionHub below) queries this exactly like production.
contract MockCrossChain is ICrossChain {
    uint256 public relayFee;
    uint256 public minAckRelayFee;

    constructor(uint256 _relayFee, uint256 _minAckRelayFee) {
        relayFee = _relayFee;
        minAckRelayFee = _minAckRelayFee;
    }

    function setFees(uint256 _relayFee, uint256 _minAckRelayFee) external {
        relayFee = _relayFee;
        minAckRelayFee = _minAckRelayFee;
    }

    function sendSynPackage(uint8, bytes calldata, uint256, uint256) external override {}

    function getRelayFees() external view override returns (uint256, uint256) {
        return (relayFee, minAckRelayFee);
    }

    function callbackGasPrice() external pure override returns (uint256) {
        return 0;
    }

    function handleAckPackageFromMultiMessage(bytes calldata, uint8, uint64) external override {}
}

/// @notice Mock of the real `PermissionHub`, faithful to the two-phase
///         syn/ack cross-chain flow: `createPolicy`/`deletePolicy` only
///         accept the request and charge the relay fee (mirroring
///         `AdditionalPermissionHub._prepareCreatePolicy`'s fee check and
///         `appAddress` override to the real caller) — a separate `settle*`
///         call, invoked by the test harness playing the role of the
///         Greenfield relayer, delivers the async ack via
///         `IApplication.greenfieldCall`, exactly like the real
///         `CmnHub._handleCreateAckPackage` does once Greenfield settles.
contract MockPermissionHub is IPermissionHub {
    uint8 private constant PERMISSION_CHANNEL_ID = 0x07;
    uint32 private constant STATUS_SUCCESS = 0;
    uint8 private constant TYPE_CREATE = 2;

    ICrossChain public immutable crossChain;
    uint256 public nextPolicyId = 1;
    bool public revertOnCreate;
    bool public revertOnDelete;
    /// @dev The real hub declines some requests by returning false instead of
    ///      reverting. These toggles reproduce that branch so `GV-9` can be
    ///      proven against a rejection that leaves the transaction alive.
    bool public rejectOnCreate;
    bool public rejectOnDelete;

    /// @dev Revert reason for the `prepare*` overrides. See the note above them.
    string internal constant PREPARE_UNSUPPORTED = "MockPermissionHub: vault does not use the prepare path";

    struct PendingCreate {
        address caller; // becomes the minted policy's owner on success, mirrors real `_doCreate`
        bytes callbackData;
        bool hasCallback;
        bool settled;
    }

    mapping(uint256 => PendingCreate) public pendingCreates;
    mapping(uint256 => address) public policyOwner; // set on successful settle, mirrors ERC721Token.ownerOf
    mapping(uint256 => bool) public deletedPolicies;

    event CreatePolicyRequested(address indexed caller, uint256 indexed policyId, bytes data);
    event DeletePolicyRequested(address indexed caller, uint256 indexed policyId);

    constructor(ICrossChain _crossChain) {
        crossChain = _crossChain;
    }

    function setRevertOnCreate(bool v) external {
        revertOnCreate = v;
    }

    function setRevertOnDelete(bool v) external {
        revertOnDelete = v;
    }

    function setRejectOnCreate(bool v) external {
        rejectOnCreate = v;
    }

    function setRejectOnDelete(bool v) external {
        rejectOnDelete = v;
    }

    /*----------------- IPermissionHub -----------------*/

    function createPolicy(bytes calldata data) external payable override returns (bool) {
        if (rejectOnCreate) return false;
        _createPolicy(data, "", false);
        return true;
    }

    function createPolicy(bytes calldata data, ExtraData memory extraData) external payable override returns (bool) {
        require(extraData.failureHandleStrategy == FailureHandleStrategy.SkipOnFail, "only SkipOnFail");
        if (rejectOnCreate) return false;
        _createPolicy(data, extraData.callbackData, true);
        return true;
    }

    function deletePolicy(uint256 id) external payable override returns (bool) {
        if (rejectOnDelete) return false;
        _deletePolicy(id);
        return true;
    }

    function deletePolicy(uint256 id, ExtraData memory extraData) external payable override returns (bool) {
        require(extraData.failureHandleStrategy == FailureHandleStrategy.SkipOnFail, "only SkipOnFail");
        if (rejectOnDelete) return false;
        _deletePolicy(id);
        return true;
    }

    /*----------------- prepare* : deliberately rejected -----------------*/
    //
    // The real PermissionHub exposes a `prepare*` family used by callers that
    // relay their own cross-chain packages. `GreenfieldVault` never takes that
    // path: it calls `createPolicy` / `deletePolicy` directly and pays the relay
    // fee itself. These four overrides exist because `IPermissionHub` declares
    // them, and they revert so that a future vault change routing through the
    // prepare path fails loudly in the suite instead of silently passing against
    // a mock that guessed at semantics it was never given.

    function prepareCreatePolicy(address, bytes calldata)
        external
        payable
        override
        returns (uint8, bytes memory, uint256, uint256, address)
    {
        revert(PREPARE_UNSUPPORTED);
    }

    function prepareCreatePolicy(address, bytes calldata, ExtraData memory)
        external
        payable
        override
        returns (uint8, bytes memory, uint256, uint256, address)
    {
        revert(PREPARE_UNSUPPORTED);
    }

    function prepareDeletePolicy(address, uint256)
        external
        payable
        override
        returns (uint8, bytes memory, uint256, uint256, address)
    {
        revert(PREPARE_UNSUPPORTED);
    }

    function prepareDeletePolicy(address, uint256, ExtraData memory)
        external
        payable
        override
        returns (uint8, bytes memory, uint256, uint256, address)
    {
        revert(PREPARE_UNSUPPORTED);
    }

    /*----------------- internal -----------------*/

    function _createPolicy(bytes calldata data, bytes memory callbackData, bool hasCallback) internal {
        (uint256 relayFee, uint256 minAckRelayFee) = crossChain.getRelayFees();
        require(msg.value >= relayFee + minAckRelayFee, "not enough fee");
        require(data.length > 0, "empty data");
        if (revertOnCreate) revert("mock: create reverted");

        uint256 policyId = nextPolicyId++;
        pendingCreates[policyId] =
            PendingCreate({caller: msg.sender, callbackData: callbackData, hasCallback: hasCallback, settled: false});
        emit CreatePolicyRequested(msg.sender, policyId, data);
    }

    function _deletePolicy(uint256 id) internal {
        (uint256 relayFee, uint256 minAckRelayFee) = crossChain.getRelayFees();
        require(msg.value >= relayFee + minAckRelayFee, "not enough fee");
        if (revertOnDelete) revert("mock: delete reverted");
        require(policyOwner[id] == msg.sender, "invalid operator");

        deletedPolicies[id] = true;
        emit DeletePolicyRequested(msg.sender, id);
    }

    /*----------------- test harness: simulate the GNFD relayer -----------------*/

    /// @notice Simulate the async ack for `policyId` settling with `status`
    ///         (0 = STATUS_SUCCESS, 1 = STATUS_FAILED). Mirrors
    ///         `CmnHub._handleCreateAckPackage`: mints the policy to the
    ///         original caller on success, then — if the caller opted into a
    ///         callback — invokes `IApplication.greenfieldCall` on it.
    function settleCreatePolicy(uint256 policyId, uint32 status) external {
        PendingCreate storage p = pendingCreates[policyId];
        require(p.caller != address(0), "unknown policy");
        require(!p.settled, "already settled");
        p.settled = true;

        if (status == STATUS_SUCCESS) {
            policyOwner[policyId] = p.caller;
        }

        if (p.hasCallback) {
            IApplication(p.caller).greenfieldCall(status, PERMISSION_CHANNEL_ID, TYPE_CREATE, policyId, p.callbackData);
        }
    }
}

/// @notice Mock of the real `IGnfdAccessControl` surface implemented by
///         ObjectHub. `grantRole`/`revokeRole` key by `msg.sender` as the
///         granter, exactly like the real contract.
contract MockGnfdAccessControl is IGnfdAccessControl {
    // role => granter => account => granted
    mapping(bytes32 => mapping(address => mapping(address => bool))) private _roles;

    function hasRole(bytes32 role, address granter, address account) external view override returns (bool) {
        return _roles[role][granter][account];
    }

    function grantRole(bytes32 role, address grantee, uint256) external override {
        _roles[role][msg.sender][grantee] = true;
    }

    function revokeRole(bytes32 role, address account) external override {
        _roles[role][msg.sender][account] = false;
    }

    function renounceRole(bytes32 role, address granter) external override {
        _roles[role][granter][msg.sender] = false;
    }
}
