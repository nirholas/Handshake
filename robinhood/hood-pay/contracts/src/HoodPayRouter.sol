// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title HoodPayRouter
 * @author nirholas (https://x.com/nichxbt)
 * @notice Stateless, non-custodial payment attribution for plain ERC-20s.
 *
 * USDG (Paxos Global Dollar, Robinhood Chain's dollar stablecoin) is a
 * plain ERC-20: no memo field, no EIP-2612 permit. A bare `transfer`
 * therefore cannot say WHICH invoice it settles. `pay` fixes that in one
 * hop: it pulls `amount` of `token` from the caller STRAIGHT to `payTo`
 * (this contract never holds a balance, has no owner, no pause, no
 * upgrade path, and no way to move funds that were not just approved for
 * this exact call) and emits `PaymentReceived` with the merchant's
 * 32-byte reference, which the hood-pay verifier matches exactly.
 *
 * Works with any standard ERC-20, including non-reverting tokens that
 * signal failure by returning false, and legacy tokens that return no
 * data at all.
 */
contract HoodPayRouter {
    /// @notice Emitted for every settled payment; the verifier's source of truth.
    /// @param ref       Merchant-generated 32-byte invoice reference.
    /// @param payer     Buyer (the caller; also the `transferFrom` source).
    /// @param payTo     Merchant receiving address.
    /// @param token     ERC-20 the payment settles in (USDG by default).
    /// @param amount    Raw token units moved.
    event PaymentReceived(
        bytes32 indexed ref,
        address indexed payer,
        address indexed payTo,
        address token,
        uint256 amount
    );

    error ZeroAmount();
    error ZeroAddress();
    error TransferFailed();

    /**
     * @notice Pay `amount` of `token` to `payTo`, attributed to `reference`.
     * @dev Requires a prior `approve(router, amount)` on `token` - USDG has
     *      no permit, so the two-step approve + pay is the only flow.
     *      Reverts unless the token both succeeds and (when it returns
     *      data) returns true.
     */
    function pay(address token, address payTo, uint256 amount, bytes32 ref) external {
        if (amount == 0) revert ZeroAmount();
        if (payTo == address(0) || token == address(0)) revert ZeroAddress();

        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, payTo, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        if (data.length == 0 && token.code.length == 0) revert TransferFailed();

        emit PaymentReceived(ref, msg.sender, payTo, token, amount);
    }
}
