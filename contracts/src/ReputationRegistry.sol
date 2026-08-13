// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title ERC-8004 Reputation Registry
/// @notice Stores signed-by-tx-sender reputation feedback about registered
///         agents. Scores are clamped to [-100, 100]. Aggregates are updated
///         in-place so reads are O(1).
contract ReputationRegistry is ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IIdentityRegistry public immutable identityRegistry;

    struct Feedback {
        address from;
        int8 score;
        uint64 timestamp;
        string uri; // optional ipfs:// pointer to review details
    }

    struct Aggregate {
        int256 sum;
        uint256 count;
    }

    mapping(uint256 => Feedback[]) private _feedback;
    mapping(uint256 => Aggregate) private _aggregate;
    // agentId => reviewer => hasSubmitted (one review per address per agent)
    mapping(uint256 => mapping(address => bool)) public hasReviewed;
    // agentId => aggregate ETH currently staked across all stakers
    mapping(uint256 => uint256) private _totalStake;
    // agentId => staker => their refundable staked ETH. Attributing stake per
    // staker is what makes withdrawStake() access-correct: each staker can only
    // ever reclaim what they personally locked, never another staker's ETH.
    mapping(uint256 => mapping(address => uint256)) public stakeOf;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event FeedbackSubmitted(
        uint256 indexed agentId,
        address indexed from,
        int8 score,
        string uri
    );

    event ReputationStaked(
        uint256 indexed agentId,
        address indexed staker,
        uint8 score,
        uint256 value
    );

    event StakeWithdrawn(
        uint256 indexed agentId,
        address indexed staker,
        uint256 value
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error UnknownAgent();
    error AlreadyReviewed();
    error ScoreOutOfRange();
    error SelfReviewForbidden();
    error NoStakeToWithdraw();
    error RefundFailed();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address identityRegistry_) {
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    // ---------------------------------------------------------------------
    // Submit
    // ---------------------------------------------------------------------

    function submitFeedback(uint256 agentId, int8 score, string calldata uri) external {
        if (score < -100 || score > 100) revert ScoreOutOfRange();
        if (!identityRegistry.isAgent(agentId)) revert UnknownAgent();
        if (identityRegistry.ownerOf(agentId) == msg.sender) revert SelfReviewForbidden();
        if (hasReviewed[agentId][msg.sender]) revert AlreadyReviewed();

        hasReviewed[agentId][msg.sender] = true;
        _feedback[agentId].push(
            Feedback({
                from: msg.sender,
                score: score,
                timestamp: uint64(block.timestamp),
                uri: uri
            })
        );

        Aggregate storage agg = _aggregate[agentId];
        agg.sum += int256(score);
        unchecked {
            agg.count++;
        }

        emit FeedbackSubmitted(agentId, msg.sender, score, uri);
    }

    // ---------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------

    /// @notice Return (average * 100, count) so callers can divide client-side
    ///         without losing precision. Returns (0, 0) for unreviewed agents.
    function getReputation(uint256 agentId) external view returns (int256 avgX100, uint256 count) {
        Aggregate storage agg = _aggregate[agentId];
        count = agg.count;
        if (count == 0) return (0, 0);
        avgX100 = (agg.sum * 100) / int256(count);
    }

    function getFeedbackCount(uint256 agentId) external view returns (uint256) {
        return _feedback[agentId].length;
    }

    function getFeedback(uint256 agentId, uint256 index) external view returns (Feedback memory) {
        return _feedback[agentId][index];
    }

    function getFeedbackRange(uint256 agentId, uint256 offset, uint256 limit)
        external
        view
        returns (Feedback[] memory out)
    {
        Feedback[] storage all = _feedback[agentId];
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        if (offset >= end) return new Feedback[](0);
        out = new Feedback[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = all[i];
        }
    }

    // -------------------------------------------------------------------------
    // Staking
    // -------------------------------------------------------------------------

    /// @notice Submit a reputation score backed by ETH stake (1–5 scale).
    ///         Minimum stake is 0.001 ETH. Stake is held by the contract.
    function stakeReputation(uint256 agentId, uint8 score, string calldata comment) external payable {
        require(score >= 1 && score <= 5, "score out of range");
        require(msg.value >= 0.001 ether, "min stake 0.001 ETH");
        if (!identityRegistry.isAgent(agentId)) revert UnknownAgent();
        if (identityRegistry.ownerOf(agentId) == msg.sender) revert SelfReviewForbidden();
        if (hasReviewed[agentId][msg.sender]) revert AlreadyReviewed();

        hasReviewed[agentId][msg.sender] = true;
        _feedback[agentId].push(
            Feedback({
                from: msg.sender,
                score: int8(uint8(score)),
                timestamp: uint64(block.timestamp),
                uri: comment
            })
        );

        Aggregate storage agg = _aggregate[agentId];
        agg.sum += int256(uint256(score));
        unchecked {
            agg.count++;
        }

        _totalStake[agentId] += msg.value;
        stakeOf[agentId][msg.sender] += msg.value;

        emit FeedbackSubmitted(agentId, msg.sender, int8(uint8(score)), comment);
        emit ReputationStaked(agentId, msg.sender, score, msg.value);
    }

    /// @notice Reclaim the ETH you personally staked on an agent. The review you
    ///         submitted (score + comment) remains on-chain; only your escrowed
    ///         stake is refunded. A staker may withdraw at any time and can only
    ///         ever recover their own deposit.
    function withdrawStake(uint256 agentId) external nonReentrant {
        uint256 amount = stakeOf[agentId][msg.sender];
        if (amount == 0) revert NoStakeToWithdraw();

        stakeOf[agentId][msg.sender] = 0;
        _totalStake[agentId] -= amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert RefundFailed();

        emit StakeWithdrawn(agentId, msg.sender, amount);
    }

    function getTotalStake(uint256 agentId) external view returns (uint256) {
        return _totalStake[agentId];
    }

    /// @notice The refundable stake a specific staker holds on an agent.
    function getStake(uint256 agentId, address staker) external view returns (uint256) {
        return stakeOf[agentId][staker];
    }
}
