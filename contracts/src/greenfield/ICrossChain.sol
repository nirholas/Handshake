// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title ICrossChain
/// @notice Real ABI of BNB Greenfield's CrossChain contract — the relayer-fee
///         oracle every middle-layer hub (PermissionHub included) queries
///         before submitting a syn-package to Greenfield. Mirrors
///         `bnb-chain/greenfield-contracts/contracts/interface/ICrossChain.sol`
///         (verified against `master` on 2026-07-08 —
///         https://github.com/bnb-chain/greenfield-contracts).
///
///         Deployed addresses (bytecode-verified 2026-07-07, `00-CONTEXT.md`,
///         and that repo's README "Contract Entrypoint" for testnet):
///           mainnet(56) CrossChain `0x77e719b714be09F70D484AB81F70D02B0E182f7d`
///           testnet(97) CrossChain `0xa5B2c9194131A4E0BFaCbF9E5D6722c873159cb7`
interface ICrossChain {
    function sendSynPackage(uint8 channelId, bytes calldata msgBytes, uint256 relayFee, uint256 ackRelayFee) external;

    /// @return relayFee The BNB fee for relaying the syn-package to Greenfield.
    /// @return minAckRelayFee The minimum BNB fee for relaying the ack back to BSC.
    function getRelayFees() external view returns (uint256 relayFee, uint256 minAckRelayFee);

    function callbackGasPrice() external returns (uint256);

    function handleAckPackageFromMultiMessage(
        bytes calldata multiMessagePayload,
        uint8 packageType,
        uint64 multiMessageSequence
    ) external;
}
