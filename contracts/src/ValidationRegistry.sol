// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title ERC-8004 Validation Registry
/// @notice Allow-listed validators record validation results for agents. Each
///         result is an opaque proof (hash/CID of an off-chain report) plus a
///         boolean pass/fail flag. Useful for third-party attestations —
///         schema checks, behavioral tests, GLB file validation, etc.
contract ValidationRegistry {
    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IIdentityRegistry public immutable identityRegistry;
    address public owner;

    struct Validation {
        address validator;
        bool passed;
        bytes32 proofHash; // hash of the off-chain report (e.g. sha256 of JSON)
        string proofURI;   // optional ipfs:// or https:// pointer
        uint64 timestamp;
        string kind;       // free-form tag, e.g. "glb-schema", "a2a-card"
    }

    mapping(address => bool) public isValidator;
    mapping(uint256 => Validation[]) private _validations;
    // agentId => kind => latest index+1 (0 = none)
    mapping(uint256 => mapping(bytes32 => uint256)) private _latestByKind;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event ValidationRecorded(
        uint256 indexed agentId,
        address indexed validator,
        bool passed,
        bytes32 proofHash,
        string kind
    );
    event OwnershipTransferred(address indexed from, address indexed to);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotValidator();
    error UnknownAgent();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address identityRegistry_, address owner_) {
        if (identityRegistry_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        identityRegistry = IIdentityRegistry(identityRegistry_);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---------------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function addValidator(address v) external onlyOwner {
        isValidator[v] = true;
        emit ValidatorAdded(v);
    }

    function removeValidator(address v) external onlyOwner {
        isValidator[v] = false;
        emit ValidatorRemoved(v);
    }

    /// @notice Hand the allow-list over to a new owner. The zero address is
    ///         rejected: renouncing here would freeze the validator set forever,
    ///         with no way to rotate out a compromised validator key.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    // ---------------------------------------------------------------------
    // Record
    // ---------------------------------------------------------------------

    function recordValidation(
        uint256 agentId,
        bool passed,
        bytes32 proofHash,
        string calldata proofURI,
        string calldata kind
    ) external {
        if (!isValidator[msg.sender]) revert NotValidator();
        if (!identityRegistry.isAgent(agentId)) revert UnknownAgent();

        _validations[agentId].push(
            Validation({
                validator: msg.sender,
                passed: passed,
                proofHash: proofHash,
                proofURI: proofURI,
                timestamp: uint64(block.timestamp),
                kind: kind
            })
        );
        _latestByKind[agentId][keccak256(bytes(kind))] = _validations[agentId].length;

        emit ValidationRecorded(agentId, msg.sender, passed, proofHash, kind);
    }

    // ---------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------

    function getValidationCount(uint256 agentId) external view returns (uint256) {
        return _validations[agentId].length;
    }

    function getValidation(uint256 agentId, uint256 index)
        external
        view
        returns (Validation memory)
    {
        return _validations[agentId][index];
    }

    function getLatestByKind(uint256 agentId, string calldata kind)
        external
        view
        returns (Validation memory)
    {
        uint256 idxPlusOne = _latestByKind[agentId][keccak256(bytes(kind))];
        require(idxPlusOne != 0, "no validation");
        return _validations[agentId][idxPlusOne - 1];
    }

    function getValidationRange(uint256 agentId, uint256 offset, uint256 limit)
        external
        view
        returns (Validation[] memory out)
    {
        Validation[] storage all = _validations[agentId];
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        if (offset >= end) return new Validation[](0);
        out = new Validation[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = all[i];
        }
    }
}
