// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentPayments
 * @notice EVM port of the Solana `pump_agent_payments` program
 *         (`AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7`). It is the on-chain
 *         engine behind three.ws **agent tokens**: users pay an agent in any
 *         ERC-20 (or native) currency, the agent's authority withdraws its
 *         share, and a configurable slice is routed to a buyback that swaps the
 *         received currency into the agent's own token and burns it.
 *
 *         One deployment serves every agent token on a chain. State is keyed by
 *         `(agentToken, currencyToken)` exactly like the Solana program keys by
 *         `(tokenMint, currencyMint)` PDAs:
 *
 *           - paymentVault   — incoming payments, not yet distributed
 *           - buybackVault   — distributed share earmarked for buyback+burn
 *           - withdrawVault   — distributed share the agent authority withdraws
 *
 *         Native currency (ETH/BNB/AVAX) is accounted under the EIP-7528
 *         sentinel `0xEee…EeE`, matching `NATIVE_TOKEN_ADDRESS` in the SDK.
 *
 *         ABI is byte-for-byte the SDK's `AGENT_PAYMENTS_ABI`
 *         (agent-payments-sdk/src/evm/abi.ts). Invoice IDs are computed
 *         identically to `getInvoiceId()` so an ID derived off-chain matches the
 *         one stored on-chain:
 *           keccak256(abi.encode(agentToken, currencyToken, amount, memo, startTime, endTime))
 *
 *         Website: https://three.ws/agents
 */
contract AgentPayments is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    /// @notice EIP-7528 native-asset sentinel. Mirrors `NATIVE_TOKEN_ADDRESS` in the SDK.
    address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Burn sink for bought-back agent tokens (most ERC-20s have no burn()).
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Basis-points denominator.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    struct AgentConfig {
        address authority; // who may withdraw + update this agent
        uint16 buybackBps; // share of each distribution routed to buyback (0..10000)
        bool exists;
    }

    struct CurrencyAccount {
        uint256 paymentVault; // accrued, awaiting distribution
        uint256 buybackVault; // distributed, awaiting buyback+burn
        uint256 withdrawVault; // distributed, awaiting authority withdrawal
        uint256 totalPayments; // lifetime gross received
        uint256 totalBuybacks; // lifetime currency spent on buybacks
        uint256 totalWithdrawn; // lifetime currency withdrawn by authority
        uint256 tokensBurned; // lifetime agent tokens burned via buyback
    }

    /// @dev agentToken => config
    mapping(address => AgentConfig) private _agents;

    /// @dev agentToken => currencyToken => accounting
    mapping(address => mapping(address => CurrencyAccount)) private _accounts;

    /// @dev invoiceId => settled. Prevents double-payment, mirrors the InvoiceId PDA.
    mapping(bytes32 => bool) public isInvoicePaid;

    /// @dev Allow-listed swap routers usable by buybackTrigger. Owner-managed.
    ///      Constraining the buyback call to known DEX routers (and forbidding
    ///      the currency/agent token as a "router") closes the only path by
    ///      which the buyback authority could abuse payer ERC-20 allowances.
    mapping(address => bool) public allowedRouters;

    // ── Events (match AGENT_PAYMENTS_ABI) ───────────────────────────────────

    event AgentCreated(address indexed agentToken, address indexed authority, uint16 buybackBps);
    event PaymentAccepted(
        address indexed agentToken,
        address indexed payer,
        address currencyToken,
        uint256 amount,
        uint64 memo,
        bytes32 invoiceId
    );
    event PaymentsDistributed(
        address indexed agentToken, address currencyToken, uint256 buybackAmount, uint256 withdrawAmount
    );
    event BuybackTriggered(
        address indexed agentToken, address currencyToken, uint256 currencySpent, uint256 tokensBurned
    );
    event Withdrawn(
        address indexed agentToken, address indexed authority, address currencyToken, uint256 amount, address receiver
    );
    event AuthorityUpdated(address indexed agentToken, address oldAuthority, address newAuthority);
    event BuybackBpsUpdated(address indexed agentToken, uint16 oldBps, uint16 newBps);

    // Operational (not in the SDK ABI, but standard hygiene)
    event RouterAllowed(address indexed router, bool allowed);

    // ── Errors ──────────────────────────────────────────────────────────────

    error AgentExists();
    error AgentUnknown();
    error NotAgentAuthority();
    error ZeroAddress();
    error InvalidBps();
    error InvalidCurrency();
    error InvoiceAlreadyPaid();
    error InvoiceWindowClosed();
    error NativeValueMismatch();
    error NothingToProcess();
    error RouterNotAllowed();
    error SwapFailed();
    error NoTokensBought();
    error NativeTransferFailed();

    /// @dev A zero `initialOwner` is rejected by `Ownable`'s constructor with
    ///      `OwnableInvalidOwner`, which runs before this body, so there is no
    ///      second check to add here: an unreachable one would only look like
    ///      protection that is never exercised.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Agent registration ───────────────────────────────────────────────────

    /**
     * @notice Register an agent token. Callable by the platform owner (on behalf
     *         of a user) or self-registered when `agentAuthority == msg.sender`,
     *         which prevents registration front-running with a foreign authority.
     */
    function createAgent(address agentToken, address agentAuthority, uint16 buybackBps) external {
        if (agentToken == address(0) || agentAuthority == address(0)) revert ZeroAddress();
        if (buybackBps > BPS_DENOMINATOR) revert InvalidBps();
        if (msg.sender != owner() && msg.sender != agentAuthority) revert NotAgentAuthority();
        if (_agents[agentToken].exists) revert AgentExists();

        _agents[agentToken] = AgentConfig({authority: agentAuthority, buybackBps: buybackBps, exists: true});
        emit AgentCreated(agentToken, agentAuthority, buybackBps);
    }

    // ── Payment acceptance ────────────────────────────────────────────────────

    /**
     * @notice Pay an agent in an ERC-20 currency. Caller must have approved this
     *         contract for `amount` of `currencyToken`. Returns the invoice ID.
     */
    function acceptPayment(
        address agentToken,
        address currencyToken,
        uint256 amount,
        uint64 memo,
        int64 startTime,
        int64 endTime
    ) external nonReentrant returns (bytes32 invoiceId) {
        if (currencyToken == address(0) || currencyToken == NATIVE_TOKEN) revert InvalidCurrency();

        // Balance-diff accounting tolerates fee-on-transfer tokens: credit only
        // what actually arrived, never the requested amount.
        IERC20 token = IERC20(currencyToken);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;

        invoiceId = _settle(agentToken, currencyToken, amount, received, memo, startTime, endTime, msg.sender);
    }

    /**
     * @notice Pay an agent in the chain's native currency. `msg.value` is the
     *         amount; accounting is keyed under the native sentinel.
     */
    function acceptPaymentNative(address agentToken, uint64 memo, int64 startTime, int64 endTime)
        external
        payable
        nonReentrant
        returns (bytes32 invoiceId)
    {
        invoiceId = _settle(agentToken, NATIVE_TOKEN, msg.value, msg.value, memo, startTime, endTime, msg.sender);
    }

    /**
     * @dev Shared settlement: validates the invoice window, enforces single-use,
     *      credits the payment vault, and records stats. `amount` is the invoice
     *      face value (used in the invoice ID, matching the SDK), `received` is
     *      the amount actually credited.
     */
    function _settle(
        address agentToken,
        address currencyToken,
        uint256 amount,
        uint256 received,
        uint64 memo,
        int64 startTime,
        int64 endTime,
        address payer
    ) private returns (bytes32 invoiceId) {
        if (!_agents[agentToken].exists) revert AgentUnknown();
        if (received == 0) revert NothingToProcess();

        // A zero bound disables that side of the window (matches the SDK, which
        // may emit 0 to mean "unbounded"). Non-zero bounds are enforced.
        if (startTime != 0 && block.timestamp < uint256(uint64(startTime))) revert InvoiceWindowClosed();
        if (endTime != 0 && block.timestamp > uint256(uint64(endTime))) revert InvoiceWindowClosed();

        invoiceId = computeInvoiceId(agentToken, currencyToken, amount, memo, startTime, endTime);
        if (isInvoicePaid[invoiceId]) revert InvoiceAlreadyPaid();
        isInvoicePaid[invoiceId] = true;

        CurrencyAccount storage acct = _accounts[agentToken][currencyToken];
        acct.paymentVault += received;
        acct.totalPayments += received;

        emit PaymentAccepted(agentToken, payer, currencyToken, received, memo, invoiceId);
    }

    // ── Distribution + buyback ─────────────────────────────────────────────────

    /**
     * @notice Split the payment vault into the buyback and withdraw vaults using
     *         the agent's `buybackBps`. Permissionless — anyone may crank it.
     */
    function distributePayments(address agentToken, address currencyToken) external {
        if (!_agents[agentToken].exists) revert AgentUnknown();
        CurrencyAccount storage acct = _accounts[agentToken][currencyToken];

        uint256 amount = acct.paymentVault;
        if (amount == 0) revert NothingToProcess();

        uint256 buybackAmount = (amount * _agents[agentToken].buybackBps) / BPS_DENOMINATOR;
        uint256 withdrawAmount = amount - buybackAmount;

        acct.paymentVault = 0;
        acct.buybackVault += buybackAmount;
        acct.withdrawVault += withdrawAmount;

        emit PaymentsDistributed(agentToken, currencyToken, buybackAmount, withdrawAmount);
    }

    /**
     * @notice Spend the buyback vault: swap the held currency into the agent's
     *         own token via an allow-listed router, then burn what was bought.
     *         Restricted to the protocol owner (the global buyback authority,
     *         mirroring the Solana buyback-authority PDA).
     *
     * @param swapRouter  Allow-listed DEX router (e.g. Uniswap/0x). Must differ
     *                    from the currency and agent tokens.
     * @param swapData    Pre-built calldata that swaps `buybackVault` of
     *                    `currencyToken` into `agentToken`, delivering the bought
     *                    tokens to this contract.
     */
    function buybackTrigger(address agentToken, address currencyToken, address swapRouter, bytes calldata swapData)
        external
        onlyOwner
        nonReentrant
        returns (uint256 tokensBurned)
    {
        if (!_agents[agentToken].exists) revert AgentUnknown();
        if (!allowedRouters[swapRouter]) revert RouterNotAllowed();
        // Forbid pointing the "router" at a token contract — that is the only
        // way the call could abuse the maxUint256 allowances payers grant us.
        if (swapRouter == currencyToken || swapRouter == agentToken) revert RouterNotAllowed();

        CurrencyAccount storage acct = _accounts[agentToken][currencyToken];
        uint256 spend = acct.buybackVault;
        if (spend == 0) revert NothingToProcess();

        // Effects before interactions. Both accounting writes that are knowable
        // up front happen here; only `tokensBurned` has to wait, because the
        // amount bought is not knowable until the swap returns.
        acct.buybackVault = 0;
        acct.totalBuybacks += spend;

        uint256 agentBefore = IERC20(agentToken).balanceOf(address(this));

        if (currencyToken == NATIVE_TOKEN) {
            (bool ok,) = swapRouter.call{value: spend}(swapData);
            if (!ok) revert SwapFailed();
        } else {
            IERC20(currencyToken).forceApprove(swapRouter, spend);
            (bool ok,) = swapRouter.call(swapData);
            if (!ok) revert SwapFailed();
            IERC20(currencyToken).forceApprove(swapRouter, 0); // never leave standing allowance
        }

        uint256 bought = IERC20(agentToken).balanceOf(address(this)) - agentBefore;
        if (bought == 0) revert NoTokensBought();

        IERC20(agentToken).safeTransfer(BURN_ADDRESS, bought);
        tokensBurned = bought;

        acct.tokensBurned += bought;

        emit BuybackTriggered(agentToken, currencyToken, spend, tokensBurned);
    }

    // ── Withdrawal ─────────────────────────────────────────────────────────────

    /**
     * @notice Withdraw the agent's accumulated share to `receiver`. Restricted to
     *         the agent's authority.
     */
    function withdraw(address agentToken, address currencyToken, address receiver)
        external
        nonReentrant
        returns (uint256 amount)
    {
        AgentConfig storage cfg = _agents[agentToken];
        if (!cfg.exists) revert AgentUnknown();
        if (msg.sender != cfg.authority) revert NotAgentAuthority();
        if (receiver == address(0)) revert ZeroAddress();

        CurrencyAccount storage acct = _accounts[agentToken][currencyToken];
        amount = acct.withdrawVault;
        if (amount == 0) revert NothingToProcess();

        acct.withdrawVault = 0;
        acct.totalWithdrawn += amount;

        if (currencyToken == NATIVE_TOKEN) {
            (bool ok,) = receiver.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currencyToken).safeTransfer(receiver, amount);
        }

        emit Withdrawn(agentToken, cfg.authority, currencyToken, amount, receiver);
    }

    // ── Config updates ─────────────────────────────────────────────────────────

    /// @notice Change the buyback split. Restricted to the agent's authority.
    function updateBuybackBps(address agentToken, uint16 buybackBps) external {
        AgentConfig storage cfg = _agents[agentToken];
        if (!cfg.exists) revert AgentUnknown();
        if (msg.sender != cfg.authority) revert NotAgentAuthority();
        if (buybackBps > BPS_DENOMINATOR) revert InvalidBps();

        uint16 old = cfg.buybackBps;
        cfg.buybackBps = buybackBps;
        emit BuybackBpsUpdated(agentToken, old, buybackBps);
    }

    /// @notice Transfer agent authority. Restricted to the current authority.
    function updateAuthority(address agentToken, address newAuthority) external {
        AgentConfig storage cfg = _agents[agentToken];
        if (!cfg.exists) revert AgentUnknown();
        if (msg.sender != cfg.authority) revert NotAgentAuthority();
        if (newAuthority == address(0)) revert ZeroAddress();

        address old = cfg.authority;
        cfg.authority = newAuthority;
        emit AuthorityUpdated(agentToken, old, newAuthority);
    }

    // ── Router allow-list (owner) ────────────────────────────────────────────

    /// @notice Allow or disallow a swap router for buybacks.
    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = allowed;
        emit RouterAllowed(router, allowed);
    }

    // ── Views (match AGENT_PAYMENTS_ABI) ─────────────────────────────────────

    function getAgentConfig(address agentToken)
        external
        view
        returns (address authority, uint16 buybackBps, bool exists)
    {
        AgentConfig storage cfg = _agents[agentToken];
        return (cfg.authority, cfg.buybackBps, cfg.exists);
    }

    function getBalances(address agentToken, address currencyToken)
        external
        view
        returns (uint256 paymentVault, uint256 buybackVault, uint256 withdrawVault)
    {
        CurrencyAccount storage acct = _accounts[agentToken][currencyToken];
        return (acct.paymentVault, acct.buybackVault, acct.withdrawVault);
    }

    function getPaymentStats(address agentToken, address currencyToken)
        external
        view
        returns (uint256 totalPayments, uint256 totalBuybacks, uint256 totalWithdrawn, uint256 tokensBurned)
    {
        CurrencyAccount storage acct = _accounts[agentToken][currencyToken];
        return (acct.totalPayments, acct.totalBuybacks, acct.totalWithdrawn, acct.tokensBurned);
    }

    /**
     * @notice Deterministic invoice ID. Identical to the SDK's `getInvoiceId()`,
     *         so an ID computed off-chain equals the one settled on-chain.
     */
    function computeInvoiceId(
        address agentToken,
        address currencyToken,
        uint256 amount,
        uint64 memo,
        int64 startTime,
        int64 endTime
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(agentToken, currencyToken, amount, memo, startTime, endTime));
    }
}
