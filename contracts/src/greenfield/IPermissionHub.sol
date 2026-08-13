// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IPermissionHub
/// @notice Real ABI of BNB Greenfield's PermissionHub — the BSC-side cross-chain
///         entry point for creating/deleting Greenfield "policy" resources
///         (object/bucket/group permission grants). Mirrors
///         `bnb-chain/greenfield-contracts/contracts/interface/IPermissionHub.sol`
///         and the `ExtraData` / `FailureHandleStrategy` types it depends on from
///         `.../middle-layer/resource-mirror/storage/{PermissionStorage,CmnStorage}.sol`
///         and `.../storage/PackageQueue.sol` (verified against `master` on
///         2026-07-08 — https://github.com/bnb-chain/greenfield-contracts).
///
///         Deployed addresses (from that repo's README "Contract Entrypoint"):
///           mainnet(56) PermissionHub `0xe1776006dBE9B60d9eA38C0dDb80b41f2657acE8`
///           testnet(97) PermissionHub `0x25E1eeDb5CaBf288210B132321FBB2d90b4174ad`
///
///         Reproduced here as a minimal interface — not the full upgradeable
///         implementation tree, which depends on OpenZeppelin's upgradeable
///         contracts package (a library this workspace does not otherwise
///         use) — so `GreenfieldVault` can call the real, already deployed
///         contract without inventing any signature or address.
interface IPermissionHub {
    /// @dev Mirrors `PackageQueue.FailureHandleStrategy`. Only `SkipOnFail` is
    ///      accepted by `AdditionalPermissionHub._prepareCreatePolicy`/
    ///      `_prepareDeletePolicy` when an `ExtraData` callback is supplied —
    ///      the other two strategies exist for GNFD-native middle-layer apps
    ///      that need retry/blocking semantics this vault does not use.
    enum FailureHandleStrategy {
        BlockOnFail,
        CacheOnFail,
        SkipOnFail
    }

    /// @dev Mirrors `CmnStorage.ExtraData`. `appAddress` is ALWAYS overwritten
    ///      by `AdditionalPermissionHub` to the effective caller
    ///      (`_erc2771Sender()`) before the syn-package is sent — whatever a
    ///      caller passes for this field is ignored on-chain; the ack callback
    ///      (`IApplication.greenfieldCall`) always targets the real caller.
    struct ExtraData {
        address appAddress;
        address refundAddress;
        FailureHandleStrategy failureHandleStrategy;
        bytes callbackData;
    }

    function createPolicy(bytes calldata data) external payable returns (bool);

    function createPolicy(bytes calldata data, ExtraData memory extraData) external payable returns (bool);

    function deletePolicy(uint256 id) external payable returns (bool);

    function deletePolicy(uint256 id, ExtraData memory extraData) external payable returns (bool);

    function prepareCreatePolicy(address sender, bytes calldata data)
        external
        payable
        returns (uint8, bytes memory, uint256, uint256, address);

    function prepareCreatePolicy(address sender, bytes calldata data, ExtraData memory extraData)
        external
        payable
        returns (uint8, bytes memory, uint256, uint256, address);

    function prepareDeletePolicy(address sender, uint256 id)
        external
        payable
        returns (uint8, bytes memory, uint256, uint256, address);

    function prepareDeletePolicy(address sender, uint256 id, ExtraData memory extraData)
        external
        payable
        returns (uint8, bytes memory, uint256, uint256, address);
}
