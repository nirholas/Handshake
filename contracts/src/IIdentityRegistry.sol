// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title IIdentityRegistry
/// @notice The read surface the reputation and validation registries need from
///         whichever ERC-8004 Identity Registry is canonical on their chain.
/// @dev    Deliberately a bound-by-address interface rather than an inheritance
///         relationship with this repo's `IdentityRegistry.sol`: on most chains
///         the canonical registry is the ERC-8004 reference deployment at
///         `0x8004A1...`, not this repo's bytecode (see
///         `contracts/DEPLOYMENTS.md`). Both consumers share this one
///         declaration so the two contracts can never drift onto different
///         signatures for the same call.
interface IIdentityRegistry {
    /// @notice True for an agent id that has been minted and not burned.
    function isAgent(uint256 agentId) external view returns (bool);

    /// @notice Current owner of the agent NFT. Reverts for a nonexistent id.
    function ownerOf(uint256 agentId) external view returns (address);
}
