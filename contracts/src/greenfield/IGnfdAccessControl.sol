// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title IGnfdAccessControl
/// @notice Real ABI of the role-delegation surface every Greenfield
///         resource-mirror hub (BucketHub/ObjectHub/GroupHub) implements,
///         letting a resource owner authorize a third-party operator (e.g. a
///         marketplace contract) to act cross-chain on their behalf. Mirrors
///         `bnb-chain/greenfield-contracts/contracts/interface/IGnfdAccessControl.sol`
///         (verified against `master` on 2026-07-08 —
///         https://github.com/bnb-chain/greenfield-contracts).
///
///         `GreenfieldVault` reads this against ObjectHub — mainnet(56)
///         `0x634eB9c438b8378bbdd8D0e10970Ec88db0b4d0f`, testnet(97)
///         `0x1b059D8481dEe299713F18601fB539D066553e39` (`00-CONTEXT.md` /
///         that repo's README) — to enforce "the vault must control its
///         permissions" at `list()` time: a seller must
///         `grantRole(ROLE_CREATE, vaultAddress, expiry)` on their mirrored
///         Greenfield object before the vault will list it for sale.
interface IGnfdAccessControl {
    function hasRole(bytes32 role, address granter, address account) external view returns (bool);

    function grantRole(bytes32 role, address grantee, uint256 expireTime) external;

    function revokeRole(bytes32 role, address account) external;

    function renounceRole(bytes32 role, address granter) external;
}
