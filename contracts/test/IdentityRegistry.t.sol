// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";

/// @notice Recipient with no `receive`, used to prove ID-9: an ETH payout that
///         cannot be delivered reverts the whole call rather than debiting the
///         agent's balance into nowhere.
contract EthRejectingRecipient {}

/// @notice Spender that re-enters `spend` from the payout callback. Proves the
///         ID-10 guard, not merely that ordering happens to be safe.
contract ReentrantSpender {
    IdentityRegistry public immutable reg;
    uint256 private _agentId;
    uint256 private _amount;
    bool private _armed;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(IdentityRegistry _reg) {
        reg = _reg;
    }

    function drain(uint256 agentId, uint256 amount) external {
        _agentId = agentId;
        _amount = amount;
        _armed = true;
        reg.spend(agentId, payable(address(this)), amount, "first");
    }

    receive() external payable {
        if (_armed) {
            _armed = false;
            reentryAttempted = true;
            (bool ok,) = address(reg).call(
                abi.encodeWithSelector(
                    IdentityRegistry.spend.selector, _agentId, payable(address(this)), _amount, "second"
                )
            );
            reentrySucceeded = ok;
        }
    }
}

/// @dev Invariants under proof: ID-1 .. ID-11 of
///      `specs/ECONOMY_CONTRACT_INVARIANTS.md`.
contract IdentityRegistryTest is Test {
    IdentityRegistry reg;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA701);
    address spender = address(0x5EED);
    uint256 alicePk = 0xA11CE;
    uint256 bobPk = 0xB0B;

    function setUp() public {
        reg = new IdentityRegistry();
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    /// @dev Build a valid EIP-712 `SetAgentWallet` signature for `pk`.
    function _signSetWallet(uint256 pk, address signer, uint256 id, address delegate, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("SetAgentWallet(uint256 agentId,address newWallet,uint256 nonce,uint256 deadline)"),
                id,
                delegate,
                reg.nonces(signer),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reg.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function testRegisterAssignsIncrementingIds() public {
        vm.prank(alice);
        uint256 id1 = reg.register("ipfs://abc");
        assertEq(id1, 1);

        vm.prank(bob);
        uint256 id2 = reg.register("ipfs://def");
        assertEq(id2, 2);

        assertEq(reg.ownerOf(1), alice);
        assertEq(reg.ownerOf(2), bob);
        assertEq(reg.tokenURI(1), "ipfs://abc");
        assertEq(reg.tokenURI(2), "ipfs://def");
        assertEq(reg.totalSupply(), 2);
    }

    function testRegisterEmptyURI() public {
        vm.prank(alice);
        uint256 id = reg.register();
        assertEq(id, 1);
        assertEq(reg.tokenURI(1), "");
    }

    function testRegisterWithMetadata() public {
        IdentityRegistry.MetadataEntry[] memory m = new IdentityRegistry.MetadataEntry[](2);
        m[0] = IdentityRegistry.MetadataEntry("role", bytes("agent"));
        m[1] = IdentityRegistry.MetadataEntry("ver", bytes("1.0"));

        vm.prank(alice);
        uint256 id = reg.register("ipfs://x", m);

        assertEq(reg.getMetadata(id, "role"), bytes("agent"));
        assertEq(reg.getMetadata(id, "ver"), bytes("1.0"));
    }

    function testSetAgentURIOnlyOwner() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://old");

        vm.prank(bob);
        vm.expectRevert(IdentityRegistry.NotAgentOwner.selector);
        reg.setAgentURI(id, "ipfs://hacked");

        vm.prank(alice);
        reg.setAgentURI(id, "ipfs://new");
        assertEq(reg.tokenURI(id), "ipfs://new");
    }

    function testSetMetadataOnlyOwner() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        vm.prank(bob);
        vm.expectRevert(IdentityRegistry.NotAgentOwner.selector);
        reg.setMetadata(id, "k", bytes("v"));

        vm.prank(alice);
        reg.setMetadata(id, "k", bytes("v"));
        assertEq(reg.getMetadata(id, "k"), bytes("v"));
    }

    function testSetAgentWalletWithValidSignature() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        uint256 deadline = block.timestamp + 1 days;
        address delegate = address(0xDE1);
        uint256 nonce = reg.nonces(alice);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("SetAgentWallet(uint256 agentId,address newWallet,uint256 nonce,uint256 deadline)"),
                id,
                delegate,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", reg.DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        reg.setAgentWallet(id, delegate, deadline, sig);
        assertEq(reg.getAgentWallet(id), delegate);
        assertEq(reg.nonces(alice), nonce + 1);
    }

    function testSetAgentWalletExpired() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        vm.warp(1000);
        vm.expectRevert(IdentityRegistry.SignatureExpired.selector);
        reg.setAgentWallet(id, address(0xDE1), 500, hex"");
    }

    function testGetAgentWalletFallsBackToOwner() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        assertEq(reg.getAgentWallet(id), alice);
    }

    function testUnsetAgentWallet() public {
        testSetAgentWalletWithValidSignature();
        vm.prank(alice);
        reg.unsetAgentWallet(1);
        assertEq(reg.getAgentWallet(1), alice);
    }

    function testTokenURIUnknownReverts() public {
        vm.expectRevert();
        reg.tokenURI(999);
    }

    function testIsAgent() public {
        assertFalse(reg.isAgent(1));
        vm.prank(alice);
        reg.register("ipfs://x");
        assertTrue(reg.isAgent(1));
    }

    // ── ID-3: the delegation signature is owner-bound and single-use ─────────

    function testSetAgentWalletRejectsNonOwnerSignature() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        uint256 deadline = block.timestamp + 1 days;
        // Bob signs over alice's nonce slot; the digest is well-formed but the
        // recovered signer is not the agent owner.
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("SetAgentWallet(uint256 agentId,address newWallet,uint256 nonce,uint256 deadline)"),
                id,
                address(0xDE1),
                reg.nonces(alice),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reg.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bobPk, digest);

        vm.expectRevert(IdentityRegistry.InvalidSignature.selector);
        reg.setAgentWallet(id, address(0xDE1), deadline, abi.encodePacked(r, s, v));
        assertEq(reg.getAgentWallet(id), alice, "ID-3: a foreign signature must change nothing");
    }

    function testSetAgentWalletSignatureIsSingleUse() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signSetWallet(alicePk, alice, id, address(0xDE1), deadline);

        reg.setAgentWallet(id, address(0xDE1), deadline, sig);

        // Replaying the identical signature must fail: the nonce moved on.
        vm.expectRevert(IdentityRegistry.InvalidSignature.selector);
        reg.setAgentWallet(id, address(0xDE1), deadline, sig);
    }

    function testSetAgentWalletSignatureIsBoundToTheWallet() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _signSetWallet(alicePk, alice, id, address(0xDE1), deadline);

        // Same signature, different delegate: the struct hash no longer matches.
        vm.expectRevert(IdentityRegistry.InvalidSignature.selector);
        reg.setAgentWallet(id, address(0xBAD), deadline, sig);
    }

    function testSetAgentWalletAtExactDeadlineSucceeds() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        vm.warp(1_000);
        uint256 deadline = block.timestamp;
        bytes memory sig = _signSetWallet(alicePk, alice, id, address(0xDE1), deadline);

        reg.setAgentWallet(id, address(0xDE1), deadline, sig);
        assertEq(reg.getAgentWallet(id), address(0xDE1));
    }

    function testUnsetAgentWalletOnlyOwner() public {
        testSetAgentWalletWithValidSignature();

        vm.prank(bob);
        vm.expectRevert(IdentityRegistry.NotAgentOwner.selector);
        reg.unsetAgentWallet(1);

        assertEq(reg.getAgentWallet(1), address(0xDE1));
    }

    // ── ID-2: NFT transfer carries every right with it ───────────────────────

    function testNftTransferMovesControl() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        vm.prank(alice);
        reg.transferFrom(alice, bob, id);

        vm.prank(alice);
        vm.expectRevert(IdentityRegistry.NotAgentOwner.selector);
        reg.setAgentURI(id, "ipfs://stale-owner");

        vm.prank(bob);
        reg.setAgentURI(id, "ipfs://new-owner");
        assertEq(reg.tokenURI(id), "ipfs://new-owner");
        assertEq(reg.getAgentWallet(id), bob, "ID-4: the fallback follows the current owner");
    }

    // ── ID-5: ETH only enters through deposit ────────────────────────────────

    function testBareEthTransferReverts() public {
        vm.prank(alice);
        (bool ok,) = address(reg).call{value: 1 ether}("");
        assertFalse(ok, "ID-5: receive() must reject unattributed ETH");
        assertEq(address(reg).balance, 0);
    }

    function testUnknownSelectorWithValueReverts() public {
        vm.prank(alice);
        (bool ok,) = address(reg).call{value: 1 ether}(abi.encodeWithSignature("nope()"));
        assertFalse(ok, "ID-5: fallback() must reject unattributed ETH");
        assertEq(address(reg).balance, 0);
    }

    function testDepositCreditsTheNamedAgent() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        // Anyone may fund an agent, including a third party operator.
        vm.prank(carol);
        reg.deposit{value: 3 ether}(id);

        assertEq(reg.agentBalance(id), 3 ether);
        assertEq(address(reg).balance, 3 ether);
    }

    function testDepositToUnknownAgentReverts() public {
        vm.prank(alice);
        vm.expectRevert(IdentityRegistry.UnknownAgent.selector);
        reg.deposit{value: 1 ether}(999);
    }

    function testZeroDepositReverts() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        vm.prank(alice);
        vm.expectRevert(IdentityRegistry.ZeroDeposit.selector);
        reg.deposit{value: 0}(id);
    }

    // ── ID-6 / ID-8: per-agent balances are isolated ─────────────────────────

    function testAgentBalancesAreIsolated() public {
        vm.prank(alice);
        uint256 a = reg.register("ipfs://a");
        vm.prank(bob);
        uint256 b = reg.register("ipfs://b");

        vm.prank(alice);
        reg.deposit{value: 5 ether}(a);
        vm.prank(bob);
        reg.deposit{value: 1 ether}(b);

        // Alice authorizes a spender generously on HER agent only.
        vm.prank(alice);
        reg.setSpendAllowance(a, spender, 5 ether);

        // That spender has no standing on bob's agent, whatever the allowance.
        vm.prank(spender);
        vm.expectRevert(bytes("allowance exceeded"));
        reg.spend(b, payable(spender), 1 ether, "cross-agent drain");

        assertEq(reg.agentBalance(b), 1 ether, "ID-8: another agent's balance is untouchable");
        assertGe(address(reg).balance, reg.agentBalance(a) + reg.agentBalance(b), "ID-6: held ETH covers every agent");
    }

    function testSpendCannotExceedTheAgentsOwnBalance() public {
        vm.prank(alice);
        uint256 a = reg.register("ipfs://a");
        vm.prank(bob);
        uint256 b = reg.register("ipfs://b");

        vm.prank(alice);
        reg.deposit{value: 1 ether}(a);
        vm.prank(bob);
        reg.deposit{value: 9 ether}(b);

        // Allowance is larger than the agent's own deposit; the deposit wins.
        vm.prank(alice);
        reg.setSpendAllowance(a, spender, 10 ether);

        vm.prank(spender);
        vm.expectRevert(IdentityRegistry.InsufficientAgentBalance.selector);
        reg.spend(a, payable(spender), 2 ether, "over-draw");

        assertEq(address(reg).balance, 10 ether);
    }

    // ── ID-7: allowance is a ceiling, not a mint ─────────────────────────────

    function testSpendDebitsAllowanceAndBalanceTogether() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 4 ether}(id);
        vm.prank(alice);
        reg.setSpendAllowance(id, spender, 3 ether);

        vm.prank(spender);
        reg.spend(id, payable(carol), 1 ether, "invoice-1");

        assertEq(reg.spendAllowance(id, spender), 2 ether);
        assertEq(reg.agentBalance(id), 3 ether);
        assertEq(carol.balance, 101 ether);

        // Exhaust the allowance, then prove it is really exhausted.
        vm.prank(spender);
        reg.spend(id, payable(carol), 2 ether, "invoice-2");
        assertEq(reg.spendAllowance(id, spender), 0);

        vm.prank(spender);
        vm.expectRevert(bytes("allowance exceeded"));
        reg.spend(id, payable(carol), 1 wei, "invoice-3");
    }

    function testSpendWithoutAllowanceReverts() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 1 ether}(id);

        vm.prank(bob);
        vm.expectRevert(bytes("allowance exceeded"));
        reg.spend(id, payable(bob), 1 wei, "unauthorized");
    }

    function testSetSpendAllowanceOnlyOwner() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");

        vm.prank(bob);
        vm.expectRevert(IdentityRegistry.NotAgentOwner.selector);
        reg.setSpendAllowance(id, bob, 100 ether);

        assertEq(reg.spendAllowance(id, bob), 0);
    }

    function testAllowanceCanBeRevokedToZero() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 1 ether}(id);
        vm.prank(alice);
        reg.setSpendAllowance(id, spender, 1 ether);

        vm.prank(alice);
        reg.setSpendAllowance(id, spender, 0);

        vm.prank(spender);
        vm.expectRevert(bytes("allowance exceeded"));
        reg.spend(id, payable(spender), 1 wei, "revoked");
    }

    // ── ID-2 / ID-9 / ID-11: withdrawal guards ───────────────────────────────

    function testWithdrawOnlyOwnerAndOnlyOwnBalance() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 2 ether}(id);

        vm.prank(bob);
        vm.expectRevert(IdentityRegistry.NotAgentOwner.selector);
        reg.withdraw(id, payable(bob), 1 ether);

        vm.prank(alice);
        vm.expectRevert(IdentityRegistry.InsufficientAgentBalance.selector);
        reg.withdraw(id, payable(alice), 3 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        reg.withdraw(id, payable(alice), 2 ether);
        assertEq(alice.balance - before, 2 ether);
        assertEq(reg.agentBalance(id), 0);
    }

    function testWithdrawRejectsZeroRecipient() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 1 ether}(id);

        vm.prank(alice);
        vm.expectRevert(IdentityRegistry.ZeroRecipient.selector);
        reg.withdraw(id, payable(address(0)), 1 ether);

        assertEq(reg.agentBalance(id), 1 ether, "ID-11: the balance survives a rejected payout");
    }

    function testSpendRejectsZeroRecipient() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 1 ether}(id);
        vm.prank(alice);
        reg.setSpendAllowance(id, spender, 1 ether);

        vm.prank(spender);
        vm.expectRevert(IdentityRegistry.ZeroRecipient.selector);
        reg.spend(id, payable(address(0)), 1 ether, "burn");

        assertEq(reg.agentBalance(id), 1 ether);
        assertEq(reg.spendAllowance(id, spender), 1 ether);
    }

    function testPayoutFailureRevertsTheWholeCall() public {
        EthRejectingRecipient sink = new EthRejectingRecipient();

        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 1 ether}(id);

        vm.prank(alice);
        vm.expectRevert(IdentityRegistry.EthTransferFailed.selector);
        reg.withdraw(id, payable(address(sink)), 1 ether);

        assertEq(reg.agentBalance(id), 1 ether, "ID-9: accounting must not drift from the ETH actually held");
        assertEq(address(reg).balance, 1 ether);
    }

    // ── ID-10: reentrancy ────────────────────────────────────────────────────

    function testReentrantSpendIsBlocked() public {
        vm.prank(alice);
        uint256 id = reg.register("ipfs://x");
        vm.prank(alice);
        reg.deposit{value: 4 ether}(id);

        ReentrantSpender attacker = new ReentrantSpender(reg);
        vm.prank(alice);
        reg.setSpendAllowance(id, address(attacker), 4 ether);

        attacker.drain(id, 1 ether);

        assertTrue(attacker.reentryAttempted(), "the attack must actually have been attempted");
        assertFalse(attacker.reentrySucceeded(), "ID-10: nonReentrant must reject the second entry");
        assertEq(address(attacker).balance, 1 ether, "only one payout may land");
        assertEq(reg.agentBalance(id), 3 ether);
        assertEq(reg.spendAllowance(id, address(attacker)), 3 ether);
    }

    // ── ID-1: id assignment ──────────────────────────────────────────────────

    function testAgentIdsNeverRepeatAcrossOwners() public {
        vm.prank(alice);
        uint256 first = reg.register("a");
        vm.prank(alice);
        uint256 second = reg.register("b");
        vm.prank(bob);
        uint256 third = reg.register("c");

        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(third, 3);
        assertFalse(reg.isAgent(4));
        assertEq(reg.balanceOf(alice), 2);
        assertEq(reg.totalSupply(), 3);
    }

    function testGetMetadataOnUnknownAgentReverts() public {
        vm.expectRevert();
        reg.getMetadata(999, "k");
    }

    function testGetAgentWalletOnUnknownAgentReverts() public {
        vm.expectRevert();
        reg.getAgentWallet(999);
    }
}
