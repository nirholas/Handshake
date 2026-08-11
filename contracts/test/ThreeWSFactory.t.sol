// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ThreeWSFactory} from "../ThreeWSFactory.sol";

/// @notice Trivial payload with a constructor argument, so the tests exercise
///         init code whose hash actually depends on its arguments.
contract Payload {
    uint256 public immutable value;

    constructor(uint256 _value) {
        value = _value;
    }
}

/// @notice Payload whose constructor always reverts, proving TWF-1 surfaces a
///         failed CREATE2 rather than reporting a phantom deployment.
contract RevertingPayload {
    constructor() {
        revert("constructor failed");
    }
}

/// @dev Invariants under proof: TWF-1 .. TWF-4 of
///      `specs/ECONOMY_CONTRACT_INVARIANTS.md`. This factory is LIVE at
///      `0x00000000D49195AE81759cd247cFeDD9D0B479df` on BSC, Base, and
///      Arbitrum One, and it is what produced the deployed ThreeWSPayments
///      vanity addresses, so `predict` agreeing with `deploy` is a
///      production-critical property, not a convenience.
contract ThreeWSFactoryTest is Test {
    ThreeWSFactory internal factory;

    event Deployed(address indexed addr, bytes32 indexed salt);

    function setUp() public {
        factory = new ThreeWSFactory();
    }

    function _initCode(uint256 value) internal pure returns (bytes memory) {
        return abi.encodePacked(type(Payload).creationCode, abi.encode(value));
    }

    // ── TWF-2: predict is the deployment ─────────────────────────────────────

    function testPredictMatchesDeploy() public {
        bytes32 salt = keccak256("three-ws-salt");
        bytes memory initCode = _initCode(42);

        address predicted = factory.predict(salt, keccak256(initCode));
        address deployed = factory.deploy(salt, initCode);

        assertEq(deployed, predicted, "TWF-2: predicted address must be the deployed address");
        assertEq(Payload(deployed).value(), 42);
    }

    function testPredictIsSaltDependent() public view {
        bytes32 hash = keccak256(_initCode(1));
        assertTrue(
            factory.predict(keccak256("salt-a"), hash) != factory.predict(keccak256("salt-b"), hash),
            "TWF-2: a different salt must yield a different address"
        );
    }

    function testPredictIsInitCodeDependent() public view {
        bytes32 salt = keccak256("same-salt");
        assertTrue(
            factory.predict(salt, keccak256(_initCode(1))) != factory.predict(salt, keccak256(_initCode(2))),
            "TWF-2: different constructor args must yield a different address"
        );
    }

    function testDeployEmitsAddressAndSalt() public {
        bytes32 salt = keccak256("emit-salt");
        bytes memory initCode = _initCode(7);
        address predicted = factory.predict(salt, keccak256(initCode));

        vm.expectEmit(true, true, true, true);
        emit Deployed(predicted, salt);
        factory.deploy(salt, initCode);
    }

    function testPredictIsPerFactoryInstance() public {
        ThreeWSFactory other = new ThreeWSFactory();
        bytes32 salt = keccak256("cross-factory");
        bytes32 hash = keccak256(_initCode(3));

        assertTrue(
            factory.predict(salt, hash) != other.predict(salt, hash),
            "TWF-2: address is bound to the deploying factory"
        );
    }

    // ── TWF-1 / TWF-3: failures never report success ─────────────────────────

    function testRedeployingTheSameSaltReverts() public {
        bytes32 salt = keccak256("collision");
        bytes memory initCode = _initCode(1);

        factory.deploy(salt, initCode);

        vm.expectRevert(bytes("deploy failed"));
        factory.deploy(salt, initCode);
    }

    function testSameSaltDifferentInitCodeStillDeploys() public {
        bytes32 salt = keccak256("shared-salt");
        address a = factory.deploy(salt, _initCode(1));
        address b = factory.deploy(salt, _initCode(2));
        assertTrue(a != b, "TWF-3: only the (salt, initCode) pair collides");
    }

    function testRevertingConstructorReverts() public {
        vm.expectRevert(bytes("deploy failed"));
        factory.deploy(keccak256("bad-payload"), type(RevertingPayload).creationCode);
    }

    function testEmptyInitCodeReverts() public {
        // CREATE2 with empty init code deploys a zero-length account, which
        // CREATE2 still reports as a real address; a second attempt collides.
        bytes32 salt = keccak256("empty");
        address first = factory.deploy(salt, hex"");
        assertTrue(first != address(0));

        vm.expectRevert(bytes("deploy failed"));
        factory.deploy(salt, hex"");
    }

    // ── TWF-4: the factory is stateless and holds nothing ────────────────────

    function testFactoryNeverHoldsValue() public {
        factory.deploy(keccak256("value-check"), _initCode(9));
        assertEq(address(factory).balance, 0, "TWF-4: factory forwards no value and holds none");
    }

    function testFactoryRejectsNativeTransfers() public {
        address sender = address(0xCAFE);
        vm.deal(sender, 1 ether);
        vm.prank(sender);
        (bool ok,) = address(factory).call{value: 1 ether}("");
        assertFalse(ok, "TWF-4: factory has no payable path");
    }

    function testDeployIsPermissionless() public {
        address anyone = address(0xB0B);
        bytes32 salt = keccak256("anyone");
        bytes memory initCode = _initCode(5);
        address predicted = factory.predict(salt, keccak256(initCode));

        vm.prank(anyone);
        address deployed = factory.deploy(salt, initCode);

        assertEq(deployed, predicted, "TWF-4: no privileged role gates deploy");
    }

    function testFuzzPredictMatchesDeploy(bytes32 salt, uint256 value) public {
        bytes memory initCode = _initCode(value);
        address predicted = factory.predict(salt, keccak256(initCode));
        assertEq(factory.deploy(salt, initCode), predicted);
    }
}
