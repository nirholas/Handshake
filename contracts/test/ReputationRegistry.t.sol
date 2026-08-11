// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";

/// @notice Staker contract with no `receive`, so its stake refund fails. Proves
///         REP-10: a failed refund reverts the whole call instead of zeroing
///         the recorded balance and losing the ETH.
contract EthRejectingStaker {
    ReputationRegistry public immutable rep;

    constructor(ReputationRegistry _rep) {
        rep = _rep;
    }

    function stake(uint256 agentId, uint8 score) external payable {
        rep.stakeReputation{value: msg.value}(agentId, score, "from-contract");
    }

    function pull(uint256 agentId) external {
        rep.withdrawStake(agentId);
    }
}

/// @notice Staker that re-enters `withdrawStake` from its refund callback.
///         Proves REP-10's guard rather than assuming checks-effects alone.
contract ReentrantStaker {
    ReputationRegistry public immutable rep;
    uint256 private _agentId;
    bool private _armed;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(ReputationRegistry _rep) {
        rep = _rep;
    }

    function stake(uint256 agentId, uint8 score) external payable {
        _agentId = agentId;
        rep.stakeReputation{value: msg.value}(agentId, score, "reentrant");
    }

    function pull() external {
        _armed = true;
        rep.withdrawStake(_agentId);
    }

    receive() external payable {
        if (_armed) {
            _armed = false;
            reentryAttempted = true;
            (bool ok,) = address(rep).call(abi.encodeWithSelector(ReputationRegistry.withdrawStake.selector, _agentId));
            reentrySucceeded = ok;
        }
    }
}

/// @dev Invariants under proof: REP-1 .. REP-10 of
///      `specs/ECONOMY_CONTRACT_INVARIANTS.md`.
contract ReputationRegistryTest is Test {
    IdentityRegistry identity;
    ReputationRegistry rep;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA701);
    address dave = address(0xDA7E);

    function setUp() public {
        identity = new IdentityRegistry();
        rep = new ReputationRegistry(address(identity));

        vm.prank(alice);
        identity.register("ipfs://alice");

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.deal(dave, 10 ether);
    }

    function testSubmitAndQuery() public {
        vm.prank(bob);
        rep.submitFeedback(1, 80, "ipfs://review1");

        vm.prank(carol);
        rep.submitFeedback(1, 60, "ipfs://review2");

        (int256 avgX100, uint256 count) = rep.getReputation(1);
        assertEq(count, 2);
        assertEq(avgX100, 7000); // (80+60)/2 * 100
    }

    function testCannotReviewSelf() public {
        vm.prank(alice);
        vm.expectRevert(ReputationRegistry.SelfReviewForbidden.selector);
        rep.submitFeedback(1, 100, "");
    }

    function testCannotReviewTwice() public {
        vm.prank(bob);
        rep.submitFeedback(1, 50, "");

        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.AlreadyReviewed.selector);
        rep.submitFeedback(1, 60, "");
    }

    function testScoreBounds() public {
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.ScoreOutOfRange.selector);
        rep.submitFeedback(1, 101, "");
    }

    function testUnknownAgentReverts() public {
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.UnknownAgent.selector);
        rep.submitFeedback(999, 50, "");
    }

    function testNegativeScore() public {
        vm.prank(bob);
        rep.submitFeedback(1, -50, "");
        (int256 avgX100,) = rep.getReputation(1);
        assertEq(avgX100, -5000);
    }

    function testFeedbackRange() public {
        vm.prank(bob);
        rep.submitFeedback(1, 30, "a");
        vm.prank(carol);
        rep.submitFeedback(1, 40, "b");

        ReputationRegistry.Feedback[] memory range = rep.getFeedbackRange(1, 0, 10);
        assertEq(range.length, 2);
        assertEq(range[0].score, int8(30));
        assertEq(range[1].score, int8(40));
    }

    // ── REP-2: the other end of the submitFeedback range ─────────────────────

    function testScoreBelowMinimumReverts() public {
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.ScoreOutOfRange.selector);
        rep.submitFeedback(1, -101, "");
    }

    function testScoresAtExactBoundsAreAccepted() public {
        vm.prank(bob);
        rep.submitFeedback(1, 100, "max");
        vm.prank(carol);
        rep.submitFeedback(1, -100, "min");

        (int256 avgX100, uint256 count) = rep.getReputation(1);
        assertEq(count, 2);
        assertEq(avgX100, 0);
    }

    // ── REP-5: the aggregate always matches the stored feedback ──────────────

    function testUnreviewedAgentReadsZero() public view {
        (int256 avgX100, uint256 count) = rep.getReputation(1);
        assertEq(avgX100, 0);
        assertEq(count, 0);
        assertEq(rep.getFeedbackCount(1), 0);
    }

    function testAggregateMatchesStoredFeedback() public {
        vm.prank(bob);
        rep.submitFeedback(1, 90, "b");
        vm.prank(carol);
        rep.submitFeedback(1, -30, "c");
        vm.prank(dave);
        rep.stakeReputation{value: 0.01 ether}(1, 5, "d");

        uint256 count = rep.getFeedbackCount(1);
        int256 sum;
        for (uint256 i = 0; i < count; i++) {
            sum += int256(rep.getFeedback(1, i).score);
        }

        (int256 avgX100, uint256 reportedCount) = rep.getReputation(1);
        assertEq(reportedCount, count, "REP-5: count must equal stored entries");
        assertEq(avgX100, (sum * 100) / int256(count), "REP-5: average must derive from the stored scores");
    }

    function testFeedbackRangeClampsAndPaginates() public {
        vm.prank(bob);
        rep.submitFeedback(1, 10, "b");
        vm.prank(carol);
        rep.submitFeedback(1, 20, "c");

        ReputationRegistry.Feedback[] memory page = rep.getFeedbackRange(1, 1, 5);
        assertEq(page.length, 1);
        assertEq(page[0].score, int8(20));

        assertEq(rep.getFeedbackRange(1, 5, 5).length, 0, "REP-5: out-of-range offset returns empty, not a revert");
        assertEq(rep.getFeedbackRange(1, 0, 0).length, 0);
    }

    function testFeedbackRecordsSenderAndTimestamp() public {
        vm.warp(1_800_000_000);
        vm.prank(bob);
        rep.submitFeedback(1, 55, "ipfs://detail");

        ReputationRegistry.Feedback memory f = rep.getFeedback(1, 0);
        assertEq(f.from, bob);
        assertEq(f.score, int8(55));
        assertEq(f.timestamp, uint64(1_800_000_000));
        assertEq(f.uri, "ipfs://detail");
    }

    // ── REP-1: one review per reviewer, across BOTH entry points ─────────────

    function testStakeAfterFeedbackByTheSameReviewerReverts() public {
        vm.prank(bob);
        rep.submitFeedback(1, 50, "");

        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.AlreadyReviewed.selector);
        rep.stakeReputation{value: 0.01 ether}(1, 5, "");
    }

    function testFeedbackAfterStakeByTheSameReviewerReverts() public {
        vm.prank(bob);
        rep.stakeReputation{value: 0.01 ether}(1, 4, "");

        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.AlreadyReviewed.selector);
        rep.submitFeedback(1, 50, "");
    }

    function testTheSameReviewerCanReviewADifferentAgent() public {
        vm.prank(dave);
        identity.register("ipfs://dave");

        vm.prank(bob);
        rep.submitFeedback(1, 50, "");
        vm.prank(bob);
        rep.submitFeedback(2, 60, "");

        assertEq(rep.getFeedbackCount(1), 1);
        assertEq(rep.getFeedbackCount(2), 1);
    }

    // ── REP-2 / REP-3 / REP-4 / REP-9: stake entry-point guards ──────────────

    function testStakeScoreZeroReverts() public {
        vm.prank(bob);
        vm.expectRevert(bytes("score out of range"));
        rep.stakeReputation{value: 0.01 ether}(1, 0, "");
    }

    function testStakeScoreAboveFiveReverts() public {
        vm.prank(bob);
        vm.expectRevert(bytes("score out of range"));
        rep.stakeReputation{value: 0.01 ether}(1, 6, "");
    }

    function testStakeBelowMinimumReverts() public {
        vm.prank(bob);
        vm.expectRevert(bytes("min stake 0.001 ETH"));
        rep.stakeReputation{value: 0.0009 ether}(1, 5, "");

        assertEq(rep.getTotalStake(1), 0, "REP-9: a rejected stake records nothing");
        assertEq(rep.getFeedbackCount(1), 0);
    }

    function testStakeAtExactMinimumSucceeds() public {
        vm.prank(bob);
        rep.stakeReputation{value: 0.001 ether}(1, 3, "");
        assertEq(rep.getStake(1, bob), 0.001 ether);
    }

    function testStakeSelfReviewForbidden() public {
        vm.prank(alice);
        vm.expectRevert(ReputationRegistry.SelfReviewForbidden.selector);
        rep.stakeReputation{value: 0.01 ether}(1, 5, "");
    }

    function testStakeUnknownAgentReverts() public {
        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.UnknownAgent.selector);
        rep.stakeReputation{value: 0.01 ether}(999, 5, "");
    }

    function testStakeRecordsFeedbackAndEscrow() public {
        vm.prank(bob);
        rep.stakeReputation{value: 0.5 ether}(1, 5, "great agent");

        assertEq(rep.getStake(1, bob), 0.5 ether);
        assertEq(rep.getTotalStake(1), 0.5 ether);
        assertEq(address(rep).balance, 0.5 ether);

        ReputationRegistry.Feedback memory f = rep.getFeedback(1, 0);
        assertEq(f.from, bob);
        assertEq(f.score, int8(5));
        assertEq(f.uri, "great agent");
    }

    // ── REP-6: stake conservation ────────────────────────────────────────────

    function testTotalStakeEqualsTheSumOfIndividualStakes() public {
        vm.prank(bob);
        rep.stakeReputation{value: 0.2 ether}(1, 5, "");
        vm.prank(carol);
        rep.stakeReputation{value: 0.3 ether}(1, 4, "");

        assertEq(
            rep.getTotalStake(1),
            rep.getStake(1, bob) + rep.getStake(1, carol),
            "REP-6: aggregate stake must equal the sum of the parts"
        );
        assertGe(address(rep).balance, rep.getTotalStake(1), "REP-6: held ETH must cover every stake");
    }

    // ── REP-7: a staker reclaims only their own stake, once ──────────────────

    function testWithdrawStakeReturnsExactlyTheStakersOwnDeposit() public {
        vm.prank(bob);
        rep.stakeReputation{value: 0.2 ether}(1, 5, "");
        vm.prank(carol);
        rep.stakeReputation{value: 0.3 ether}(1, 4, "");

        uint256 before = bob.balance;
        vm.prank(bob);
        rep.withdrawStake(1);

        assertEq(bob.balance - before, 0.2 ether);
        assertEq(rep.getStake(1, bob), 0);
        assertEq(rep.getStake(1, carol), 0.3 ether, "REP-7: one withdrawal must not touch another staker");
        assertEq(rep.getTotalStake(1), 0.3 ether);
    }

    function testWithdrawStakeTwiceReverts() public {
        vm.prank(bob);
        rep.stakeReputation{value: 0.2 ether}(1, 5, "");

        vm.prank(bob);
        rep.withdrawStake(1);

        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.NoStakeToWithdraw.selector);
        rep.withdrawStake(1);
    }

    function testWithdrawWithoutStakingReverts() public {
        vm.prank(carol);
        vm.expectRevert(ReputationRegistry.NoStakeToWithdraw.selector);
        rep.withdrawStake(1);
    }

    function testWithdrawIsPerAgent() public {
        vm.prank(dave);
        identity.register("ipfs://dave");

        vm.prank(bob);
        rep.stakeReputation{value: 0.2 ether}(1, 5, "");

        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.NoStakeToWithdraw.selector);
        rep.withdrawStake(2);

        assertEq(rep.getStake(1, bob), 0.2 ether);
    }

    // ── REP-8: reputation is not rentable ────────────────────────────────────

    function testWithdrawingStakeLeavesTheReviewStanding() public {
        vm.prank(bob);
        rep.stakeReputation{value: 0.2 ether}(1, 5, "still counts");

        (int256 avgBefore, uint256 countBefore) = rep.getReputation(1);

        vm.prank(bob);
        rep.withdrawStake(1);

        (int256 avgAfter, uint256 countAfter) = rep.getReputation(1);
        assertEq(avgAfter, avgBefore, "REP-8: withdrawing stake must not move the score");
        assertEq(countAfter, countBefore);
        assertEq(rep.getFeedbackCount(1), 1);
        assertTrue(rep.hasReviewed(1, bob), "REP-8: the reviewer slot stays consumed");

        vm.prank(bob);
        vm.expectRevert(ReputationRegistry.AlreadyReviewed.selector);
        rep.stakeReputation{value: 0.2 ether}(1, 1, "re-review");
    }

    // ── REP-10: refund failure and reentrancy ────────────────────────────────

    function testRefundFailureRevertsAndKeepsTheStake() public {
        EthRejectingStaker staker = new EthRejectingStaker(rep);
        vm.deal(address(staker), 1 ether);
        staker.stake{value: 0.2 ether}(1, 5);

        vm.expectRevert(ReputationRegistry.RefundFailed.selector);
        staker.pull(1);

        assertEq(rep.getStake(1, address(staker)), 0.2 ether, "REP-10: a failed refund must not zero the balance");
        assertEq(rep.getTotalStake(1), 0.2 ether);
    }

    function testReentrantWithdrawIsBlocked() public {
        ReentrantStaker attacker = new ReentrantStaker(rep);
        vm.deal(address(attacker), 1 ether);
        attacker.stake{value: 0.2 ether}(1, 5);

        vm.prank(carol);
        rep.stakeReputation{value: 0.5 ether}(1, 4, "");

        attacker.pull();

        assertTrue(attacker.reentryAttempted(), "the attack must actually have been attempted");
        assertFalse(attacker.reentrySucceeded(), "REP-10: nonReentrant must reject the second entry");
        // The 0.2 ETH stake came from this test contract, so the attacker keeps
        // its dealt balance plus exactly one refund, never two.
        assertEq(address(attacker).balance, 1 ether + 0.2 ether);
        assertEq(rep.getStake(1, address(attacker)), 0);
        assertEq(rep.getStake(1, carol), 0.5 ether, "REP-10: the other staker's escrow is untouched");
    }
}
