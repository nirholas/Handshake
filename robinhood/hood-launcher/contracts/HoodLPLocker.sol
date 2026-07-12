// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title HoodLPLocker
 * @notice Permissionless timelock for Uniswap v3 LP position NFTs. Send a
 *         position NFT here via `safeTransferFrom(from, locker, tokenId,
 *         abi.encode(unlockTimestamp))` — the depositor becomes the lock's
 *         owner and can `withdraw` only after `unlockTimestamp`. Anyone can
 *         lock any NFT for any duration; the contract holds no privileged
 *         role over funds it did not receive, and never touches a locked
 *         position before its unlock time (no admin override, no pause).
 * @dev One shared, reusable deployment — hood-launcher deploys it once per
 *      network and reuses the address for every `lpDisposition: 'lock'`
 *      launch (see `HOOD_LAUNCHER_LP_LOCKER_<NETWORK>` in the direct rail).
 */
contract HoodLPLocker is IERC721Receiver {
    struct Lock {
        address owner;
        uint256 unlockTimestamp;
    }

    /// @dev keyed by keccak256(nftContract, tokenId) so one locker instance serves any NFT collection.
    mapping(bytes32 => Lock) private _locks;

    event Locked(address indexed nftContract, uint256 indexed tokenId, address indexed owner, uint256 unlockTimestamp);
    event Withdrawn(address indexed nftContract, uint256 indexed tokenId, address indexed owner);

    function _key(address nftContract, uint256 tokenId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(nftContract, tokenId));
    }

    /// @notice ERC-721 receiver hook. `data` must be `abi.encode(uint256 unlockTimestamp)`.
    function onERC721Received(
        address, /* operator */
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external override returns (bytes4) {
        uint256 unlockTimestamp = abi.decode(data, (uint256));
        require(unlockTimestamp > block.timestamp, "HoodLPLocker: unlock must be in the future");
        bytes32 key = _key(msg.sender, tokenId);
        require(_locks[key].owner == address(0), "HoodLPLocker: already locked");
        _locks[key] = Lock({owner: from, unlockTimestamp: unlockTimestamp});
        emit Locked(msg.sender, tokenId, from, unlockTimestamp);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Withdraw a locked position after its unlock time. Only the original depositor may call.
    function withdraw(address nftContract, uint256 tokenId) external {
        bytes32 key = _key(nftContract, tokenId);
        Lock memory position = _locks[key];
        require(position.owner == msg.sender, "HoodLPLocker: not lock owner");
        require(block.timestamp >= position.unlockTimestamp, "HoodLPLocker: still locked");
        delete _locks[key];
        IERC721(nftContract).safeTransferFrom(address(this), msg.sender, tokenId);
        emit Withdrawn(nftContract, tokenId, msg.sender);
    }

    function lockInfo(address nftContract, uint256 tokenId) external view returns (address owner, uint256 unlockTimestamp) {
        Lock memory position = _locks[_key(nftContract, tokenId)];
        return (position.owner, position.unlockTimestamp);
    }
}
