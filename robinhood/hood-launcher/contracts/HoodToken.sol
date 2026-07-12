// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title HoodToken
 * @notice The direct-rail ERC-20 for hood-launcher's Robinhood Chain (4663)
 *         memecoin launches.
 * @dev Deliberately minimal and audited-pattern:
 *      - OpenZeppelin v5 `ERC20` (no custom transfer/fee/tax logic).
 *      - Fixed supply, minted once in the constructor to the deployer.
 *      - No `mint` function exists anywhere in the contract — supply cannot
 *        grow after deployment.
 *      - No owner, no `Ownable`, no privileged functions of any kind. There
 *        is nothing to renounce because there is nothing to renounce from.
 *      This is intentionally the entire contract: 18 lines, one inherited
 *      base, zero attack surface beyond what OpenZeppelin's `ERC20` itself
 *      carries.
 */
contract HoodToken is ERC20 {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address recipient_
    ) ERC20(name_, symbol_) {
        _mint(recipient_, totalSupply_);
    }
}
