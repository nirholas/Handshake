// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {WorldMoves} from "../src/WorldMoves.sol";

contract WorldMovesTest is Test {
    WorldMoves internal wm;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint32 internal constant WORLD = 1;

    function setUp() public {
        wm = new WorldMoves();
    }

    // ── move: event correctness ──────────────────────────────────────────

    /// WM-2 (positive half): a move inside the inclusive bounds emits exactly
    /// the coordinates, facing, and block metadata the indexer relies on.
    function testMoveEmitsExactArgsAndBlockMetadata() public {
        vm.roll(12345);
        vm.warp(1_700_000_000);

        vm.expectEmit(true, true, false, true, address(wm));
        emit WorldMoves.Moved(WORLD, alice, 100, -200, 300, 90, 12345, 1_700_000_000);

        vm.prank(alice);
        wm.move(WORLD, 100, -200, 300, 90);
    }

    function testMoveEmitsPerCallerIndependently() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(wm));
        emit WorldMoves.Moved(WORLD, alice, 1, 2, 3, 0, block.number, block.timestamp);
        wm.move(WORLD, 1, 2, 3, 0);

        vm.prank(bob);
        vm.expectEmit(true, true, false, true, address(wm));
        emit WorldMoves.Moved(WORLD, bob, 4, 5, 6, 180, block.number, block.timestamp);
        wm.move(WORLD, 4, 5, 6, 180);
    }

    /// WM-1 (storage half): move() writes no checkpoint state.
    function testMoveDoesNotWriteAnyCheckpointStorage() public {
        vm.prank(alice);
        wm.move(WORLD, 10, 20, 30, 1);

        (,,,,,, bool exists) = wm.getCheckpoint(WORLD, alice);
        assertFalse(exists, "move() must never populate checkpoint storage");
    }

    // ── move: coordinate bounds ──────────────────────────────────────────

    function testMoveAtExactBoundsSucceeds() public {
        int32 min = wm.COORD_MIN();
        int32 max = wm.COORD_MAX();

        vm.startPrank(alice);
        wm.move(WORLD, min, min, min, 0);
        wm.move(WORLD, max, max, max, 0);
        vm.stopPrank();
    }

    /// WM-2 (negative half): a coordinate one past the max on any axis reverts
    /// instead of being clamped.
    function testMoveRevertsXAboveMax() public {
        int32 max = wm.COORD_MAX();
        vm.expectRevert(WorldMoves.CoordinateOutOfBounds.selector);
        wm.move(WORLD, max + 1, 0, 0, 0);
    }

    function testMoveRevertsYBelowMin() public {
        int32 min = wm.COORD_MIN();
        vm.expectRevert(WorldMoves.CoordinateOutOfBounds.selector);
        wm.move(WORLD, 0, min - 1, 0, 0);
    }

    function testMoveRevertsZAboveMax() public {
        int32 max = wm.COORD_MAX();
        vm.expectRevert(WorldMoves.CoordinateOutOfBounds.selector);
        wm.move(WORLD, 0, 0, max + 1, 0);
    }

    function testMoveRevertsInt32ExtremeGriefInput() public {
        // Classic overflow/griefing input: type(int32).min / max, far outside
        // the 24-bit bound. Must revert, never silently clamp or wrap.
        vm.expectRevert(WorldMoves.CoordinateOutOfBounds.selector);
        wm.move(WORLD, type(int32).min, 0, 0, 0);

        vm.expectRevert(WorldMoves.CoordinateOutOfBounds.selector);
        wm.move(WORLD, 0, type(int32).max, 0, 0);
    }

    function testMoveAcceptsAnyFacingValue() public {
        vm.startPrank(alice);
        wm.move(WORLD, 0, 0, 0, 0);
        wm.move(WORLD, 0, 0, 0, type(uint16).max);
        vm.stopPrank();
    }

    // ── join / leave presence events ─────────────────────────────────────

    function testJoinEmitsPresenceEvent() public {
        vm.warp(1_700_000_100);
        vm.expectEmit(true, true, false, true, address(wm));
        emit WorldMoves.Joined(WORLD, alice, 1_700_000_100);

        vm.prank(alice);
        wm.join(WORLD);
    }

    function testLeaveEmitsPresenceEvent() public {
        vm.warp(1_700_000_200);
        vm.expectEmit(true, true, false, true, address(wm));
        emit WorldMoves.Left(WORLD, bob, 1_700_000_200);

        vm.prank(bob);
        wm.leave(WORLD);
    }

    function testJoinAndLeaveAreRepeatable() public {
        vm.startPrank(alice);
        wm.join(WORLD);
        wm.join(WORLD); // no membership check — freely repeatable
        wm.leave(WORLD);
        wm.leave(WORLD);
        vm.stopPrank();
    }

    // ── checkpoint: opt-in queryable state ───────────────────────────────

    function testCheckpointPersistsAndIsReadable() public {
        vm.roll(999);
        vm.warp(1_700_000_500);

        vm.prank(alice);
        wm.checkpoint(WORLD, 7, 8, 9, 45);

        (int32 x, int32 y, int32 z, uint16 facing, uint64 bn, uint64 ts, bool exists) = wm.getCheckpoint(WORLD, alice);
        assertEq(x, 7);
        assertEq(y, 8);
        assertEq(z, 9);
        assertEq(facing, 45);
        assertEq(bn, 999);
        assertEq(ts, 1_700_000_500);
        assertTrue(exists);
    }

    function testCheckpointOverwritesPreviousValue() public {
        vm.startPrank(alice);
        wm.checkpoint(WORLD, 1, 1, 1, 1);
        wm.checkpoint(WORLD, 2, 2, 2, 2);
        vm.stopPrank();

        (int32 x, int32 y, int32 z, uint16 facing,,,) = wm.getCheckpoint(WORLD, alice);
        assertEq(x, 2);
        assertEq(y, 2);
        assertEq(z, 2);
        assertEq(facing, 2);
    }

    /// WM-3: a checkpoint is keyed by (worldId, caller) only; neither another
    /// world nor another player ever sees it.
    function testCheckpointIsPerWorldAndPerPlayer() public {
        vm.startPrank(alice);
        wm.checkpoint(WORLD, 1, 1, 1, 1);
        wm.checkpoint(2, 9, 9, 9, 9);
        vm.stopPrank();

        (int32 x1,,,,,,) = wm.getCheckpoint(WORLD, alice);
        (int32 x2,,,,,,) = wm.getCheckpoint(2, alice);
        (,,,,,, bool bobExists) = wm.getCheckpoint(WORLD, bob);

        assertEq(x1, 1);
        assertEq(x2, 9);
        assertFalse(bobExists);
    }

    function testCheckpointRevertsOutOfBounds() public {
        int32 max = wm.COORD_MAX();
        vm.expectRevert(WorldMoves.CoordinateOutOfBounds.selector);
        wm.checkpoint(WORLD, max + 1, 0, 0, 0);
    }

    function testGetCheckpointUnsetReturnsZeroedFalse() public view {
        (int32 x, int32 y, int32 z, uint16 facing, uint64 bn, uint64 ts, bool exists) = wm.getCheckpoint(WORLD, alice);
        assertEq(x, 0);
        assertEq(y, 0);
        assertEq(z, 0);
        assertEq(facing, 0);
        assertEq(bn, 0);
        assertEq(ts, 0);
        assertFalse(exists);
    }

    // ── gas: the whole point of this contract ────────────────────────────

    /// WM-1 (gas half): move() must never touch storage (event-only), so gas
    /// stays flat and cheap across repeated calls from the same caller, back
    /// to back, exactly the spam pattern a ~0.45s block cadence produces.
    /// Asserted well under a plain ERC-20 transfer (~51k gas) to prove the
    /// "minimal gas per move" design goal.
    function testGasPerMoveIsFlatAndLow() public {
        vm.prank(alice);
        wm.move(WORLD, 1, 1, 1, 1); // warm up: first call ever, cold access is irrelevant to steady state

        vm.startPrank(alice);
        uint256 gasBefore1 = gasleft();
        wm.move(WORLD, 100, 200, 300, 10);
        uint256 gasUsed1 = gasBefore1 - gasleft();

        uint256 gasBefore2 = gasleft();
        wm.move(WORLD, -400, 500, -600, 20);
        uint256 gasUsed2 = gasBefore2 - gasleft();

        uint256 gasBefore3 = gasleft();
        wm.move(WORLD, 700, -800, 900, 30);
        uint256 gasUsed3 = gasBefore3 - gasleft();
        vm.stopPrank();

        console.log("move() gas (call 1):", gasUsed1);
        console.log("move() gas (call 2):", gasUsed2);
        console.log("move() gas (call 3):", gasUsed3);

        // Event-only, no SSTORE: budget 30k gas covers CALL overhead + 4
        // indexed/non-indexed log topics comfortably, with headroom, while
        // still proving it's far cheaper than any storage-writing call.
        assertLt(gasUsed1, 30_000, "move() gas exceeds flat-cost budget");
        assertLt(gasUsed2, 30_000, "move() gas exceeds flat-cost budget");
        assertLt(gasUsed3, 30_000, "move() gas exceeds flat-cost budget");

        // Flat: repeated calls from the same warmed-up caller must cost
        // (near-)identical gas regardless of coordinate values — no growing
        // storage per move. A few gas of drift is expected and fine: EVM
        // non-zero data bytes cost more than zero bytes in both CALLDATACOPY
        // and LOG, so differing coordinate magnitudes shift cost by single
        // digits. What must NOT happen is growth from state accumulation.
        assertApproxEqAbs(gasUsed1, gasUsed2, 100, "move() gas must stay flat across calls");
        assertApproxEqAbs(gasUsed2, gasUsed3, 100, "move() gas must stay flat across calls");
    }

    /// WM-4: there is no admin surface to strengthen against. What can be
    /// proven is that checkpoint's storage cost stays meaningfully above the
    /// event-only move, so the immutable split keeps saving callers real gas.
    function testCheckpointCostsMoreThanMove() public {
        vm.startPrank(alice);
        wm.move(WORLD, 1, 1, 1, 1);
        wm.checkpoint(WORLD, 1, 1, 1, 1); // warm up cold SSTORE slot access

        uint256 gasBeforeMove = gasleft();
        wm.move(WORLD, 2, 2, 2, 2);
        uint256 moveGas = gasBeforeMove - gasleft();

        uint256 gasBeforeCheckpoint = gasleft();
        wm.checkpoint(WORLD, 3, 3, 3, 3);
        uint256 checkpointGas = gasBeforeCheckpoint - gasleft();
        vm.stopPrank();

        console.log("move() gas (warm):      ", moveGas);
        console.log("checkpoint() gas (warm):", checkpointGas);

        assertGt(checkpointGas, moveGas, "checkpoint() should cost more than event-only move()");
    }
}
