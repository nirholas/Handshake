// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IApplication
/// @notice Real ABI of the Greenfield middle-layer async-callback surface.
///         `GreenfieldVault` implements this so `PermissionHub.handleAckPackage`
///         can deliver the real, GNFD-minted policy id once an async
///         `createPolicy` request settles (see `CmnHub._handleCreateAckPackage`
///         in the upstream repo, which calls back into `extraData.appAddress`).
///         Mirrors `bnb-chain/greenfield-contracts/contracts/interface/IApplication.sol`
///         (verified against `master` on 2026-07-08 —
///         https://github.com/bnb-chain/greenfield-contracts).
interface IApplication {
    /**
     * @param status STATUS_SUCCESS (0), STATUS_FAILED (1), or STATUS_UNEXPECTED (2).
     * @param channelId BUCKET_CHANNEL_ID (0x04) / OBJECT_CHANNEL_ID (0x05) /
     *        GROUP_CHANNEL_ID (0x06) / PERMISSION_CHANNEL_ID (0x07).
     * @param operationType TYPE_CREATE (2) / TYPE_DELETE (3) / TYPE_UPDATE (4).
     * @param resourceId The ERC-721 token id of the resource operated on
     *        (for PermissionHub: the created policy id). Not valid when
     *        `status == STATUS_UNEXPECTED`.
     */
    function greenfieldCall(
        uint32 status,
        uint8 channelId,
        uint8 operationType,
        uint256 resourceId,
        bytes calldata callbackData
    ) external;
}
