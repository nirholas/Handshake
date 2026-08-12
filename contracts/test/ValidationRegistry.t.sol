// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";

/// @dev Invariants under proof: VR-1 .. VR-6 of
///      `specs/ECONOMY_CONTRACT_INVARIANTS.md`. The allow-list policy this
///      contract enforces is documented in `specs/VALIDATORS.md`.
contract ValidationRegistryTest is Test {
    IdentityRegistry identity;
    ValidationRegistry validation;
    address owner = address(this);
    address validator = address(0xDA11d);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        identity = new IdentityRegistry();
        validation = new ValidationRegistry(address(identity), owner);

        vm.prank(alice);
        identity.register("ipfs://alice");
    }

    function testAddValidator() public {
        validation.addValidator(validator);
        assertTrue(validation.isValidator(validator));
    }

    function testOnlyOwnerCanAddValidator() public {
        vm.prank(bob);
        vm.expectRevert(ValidationRegistry.NotOwner.selector);
        validation.addValidator(validator);
    }

    function testRecordValidation() public {
        validation.addValidator(validator);

        bytes32 proof = keccak256("report-v1");
        vm.prank(validator);
        validation.recordValidation(1, true, proof, "ipfs://report", "glb-schema");

        assertEq(validation.getValidationCount(1), 1);
        ValidationRegistry.Validation memory v = validation.getValidation(1, 0);
        assertEq(v.validator, validator);
        assertTrue(v.passed);
        assertEq(v.proofHash, proof);
        assertEq(v.kind, "glb-schema");
    }

    function testLatestByKind() public {
        validation.addValidator(validator);

        vm.startPrank(validator);
        validation.recordValidation(1, false, keccak256("a"), "", "glb-schema");
        validation.recordValidation(1, true, keccak256("b"), "", "glb-schema");
        validation.recordValidation(1, true, keccak256("c"), "", "a2a-card");
        vm.stopPrank();

        ValidationRegistry.Validation memory latest = validation.getLatestByKind(1, "glb-schema");
        assertTrue(latest.passed);
        assertEq(latest.proofHash, keccak256("b"));

        ValidationRegistry.Validation memory card = validation.getLatestByKind(1, "a2a-card");
        assertEq(card.proofHash, keccak256("c"));
    }

    function testNonValidatorCannotRecord() public {
        vm.prank(bob);
        vm.expectRevert(ValidationRegistry.NotValidator.selector);
        validation.recordValidation(1, true, bytes32(0), "", "glb-schema");
    }

    /// VR-5: an attestation against an agent id that does not exist in the
    /// Identity Registry reverts; feedback cannot target a non-agent.
    function testUnknownAgentReverts() public {
        validation.addValidator(validator);
        vm.prank(validator);
        vm.expectRevert(ValidationRegistry.UnknownAgent.selector);
        validation.recordValidation(999, true, bytes32(0), "", "glb-schema");
    }

    function testRemoveValidator() public {
        validation.addValidator(validator);
        validation.removeValidator(validator);
        vm.prank(validator);
        vm.expectRevert(ValidationRegistry.NotValidator.selector);
        validation.recordValidation(1, true, bytes32(0), "", "glb-schema");
    }

    // ── VR-2: ownership can never be lost ────────────────────────────────────

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(ValidationRegistry.ZeroAddress.selector);
        new ValidationRegistry(address(identity), address(0));
    }

    function testConstructorRejectsZeroIdentityRegistry() public {
        vm.expectRevert(ValidationRegistry.ZeroAddress.selector);
        new ValidationRegistry(address(0), owner);
    }

    function testTransferOwnershipRejectsZero() public {
        vm.expectRevert(ValidationRegistry.ZeroAddress.selector);
        validation.transferOwnership(address(0));
        assertEq(validation.owner(), owner, "VR-2: the allow-list must never become unmanageable");
    }

    function testTransferOwnershipOnlyOwner() public {
        vm.prank(bob);
        vm.expectRevert(ValidationRegistry.NotOwner.selector);
        validation.transferOwnership(bob);
        assertEq(validation.owner(), owner);
    }

    function testTransferOwnershipMovesEveryRight() public {
        validation.transferOwnership(bob);
        assertEq(validation.owner(), bob);

        vm.expectRevert(ValidationRegistry.NotOwner.selector);
        validation.addValidator(validator);

        vm.prank(bob);
        validation.addValidator(validator);
        assertTrue(validation.isValidator(validator));
    }

    function testOnlyOwnerCanRemoveValidator() public {
        validation.addValidator(validator);

        vm.prank(bob);
        vm.expectRevert(ValidationRegistry.NotOwner.selector);
        validation.removeValidator(validator);

        assertTrue(validation.isValidator(validator));
    }

    // ── VR-1: removal is immediate, re-adding restores ───────────────────────

    function testReAddedValidatorCanRecordAgain() public {
        validation.addValidator(validator);
        validation.removeValidator(validator);
        validation.addValidator(validator);

        vm.prank(validator);
        validation.recordValidation(1, true, keccak256("again"), "", "glb-schema");
        assertEq(validation.getValidationCount(1), 1);
    }

    // ── VR-3: the history is append-only ─────────────────────────────────────

    function testRemovingAValidatorDoesNotEraseItsHistory() public {
        validation.addValidator(validator);
        vm.prank(validator);
        validation.recordValidation(1, true, keccak256("kept"), "ipfs://r", "glb-schema");

        validation.removeValidator(validator);

        assertEq(validation.getValidationCount(1), 1, "VR-3: attestations survive de-listing");
        ValidationRegistry.Validation memory v = validation.getValidation(1, 0);
        assertEq(v.validator, validator);
        assertEq(v.proofHash, keccak256("kept"));
    }

    function testRecordsAccumulateInOrder() public {
        validation.addValidator(validator);
        address second = address(0x5EC0);
        validation.addValidator(second);

        vm.prank(validator);
        validation.recordValidation(1, false, keccak256("first"), "", "glb-schema");
        vm.prank(second);
        validation.recordValidation(1, true, keccak256("second"), "", "glb-schema");

        assertEq(validation.getValidationCount(1), 2);
        assertEq(validation.getValidation(1, 0).proofHash, keccak256("first"));
        assertEq(validation.getValidation(1, 1).proofHash, keccak256("second"));
        assertEq(validation.getValidation(1, 1).validator, second);
    }

    function testRecordStampsTheBlockTimestamp() public {
        validation.addValidator(validator);
        vm.warp(1_800_000_000);
        vm.prank(validator);
        validation.recordValidation(1, true, keccak256("t"), "", "glb-schema");

        assertEq(validation.getValidation(1, 0).timestamp, uint64(1_800_000_000));
    }

    function testValidationsArePerAgent() public {
        vm.prank(bob);
        identity.register("ipfs://bob");

        validation.addValidator(validator);
        vm.prank(validator);
        validation.recordValidation(1, true, keccak256("a1"), "", "glb-schema");

        assertEq(validation.getValidationCount(1), 1);
        assertEq(validation.getValidationCount(2), 0);
    }

    // ── VR-4: kind lookup ────────────────────────────────────────────────────

    function testLatestByKindRevertsWhenAbsent() public {
        validation.addValidator(validator);
        vm.prank(validator);
        validation.recordValidation(1, true, keccak256("a"), "", "glb-schema");

        vm.expectRevert(bytes("no validation"));
        validation.getLatestByKind(1, "never-recorded");
    }

    function testLatestByKindIsExactStringMatch() public {
        validation.addValidator(validator);
        vm.startPrank(validator);
        validation.recordValidation(1, true, keccak256("a"), "", "glb-schema");
        vm.stopPrank();

        vm.expectRevert(bytes("no validation"));
        validation.getLatestByKind(1, "glb-schema ");
    }

    // ── VR-6: pagination never reverts on a large window ─────────────────────

    function testValidationRangeClampsAndPaginates() public {
        validation.addValidator(validator);
        vm.startPrank(validator);
        validation.recordValidation(1, true, keccak256("a"), "", "k");
        validation.recordValidation(1, true, keccak256("b"), "", "k");
        validation.recordValidation(1, true, keccak256("c"), "", "k");
        vm.stopPrank();

        ValidationRegistry.Validation[] memory all = validation.getValidationRange(1, 0, 100);
        assertEq(all.length, 3, "VR-6: an oversized limit clamps to what exists");

        ValidationRegistry.Validation[] memory page = validation.getValidationRange(1, 1, 1);
        assertEq(page.length, 1);
        assertEq(page[0].proofHash, keccak256("b"));

        assertEq(validation.getValidationRange(1, 3, 10).length, 0);
        assertEq(validation.getValidationRange(1, 0, 0).length, 0);
        assertEq(validation.getValidationRange(999, 0, 10).length, 0);
    }

    function testGetValidationOutOfRangeReverts() public {
        vm.expectRevert();
        validation.getValidation(1, 0);
    }
}
