/**
 * Fund-moving tool registry + the domain-guard contract.
 *
 * The upstream runtime hardwired these registries to its own tool catalog and
 * shipped a concrete EVM DeFi guard. Here the registries are seeded with the
 * three.ws tool surface (Solana first) and the guard is only a contract: any
 * object implementing {@link DeFiGuard} can occupy the `defi_guard` layer of
 * the GuardChain, so the platform can wire its own trade/risk analysis without
 * this package knowing about chains at all.
 *
 * Both Sets are intentionally mutable: a host installing a new fund-moving
 * tool registers it at boot via {@link registerMutatingApi} /
 * {@link registerFundMovingTool}. An unregistered fund-moving tool is not
 * "unguarded by design", it is a blind spot, and GuardChain reports it as one.
 */
/**
 * API names that mutate on-chain state. Checked against the `apiName` of a
 * tool call. Generic action names cover manifest-style tools; the exact names
 * cover the three.ws chat tool registry.
 */
export const MUTATING_APIS = new Set([
    // Generic action names
    'executeSwap',
    'executeTrade',
    'createDCA',
    'cancelDCA',
    'createLimitOrder',
    'cancelLimitOrder',
    'supply',
    'borrow',
    'repay',
    'withdraw',
    'deposit',
    'stake',
    'unstake',
    'approve',
    'revoke',
    'revokeApproval',
    'revokeAllApprovals',
    'bridge',
    'bridgeTokens',
    'executeBridge',
    'mint',
    'redeem',
    'addLiquidity',
    'removeLiquidity',
    'claimRewards',
    'sendPayment',
    'placeOrder',
    'cancelOrder',
    // three.ws chat tools (identifier == apiName in the flat registry)
    'solana_transfer',
    'solana_swap',
    'evm_transfer',
    'evm_swap',
    'pumpfunBuy',
    'pumpfunSell',
    'pumpfunSellAll',
    'LaunchPumpToken',
    'MintScene',
    'agentPaymentsDistribute',
    'agentPaymentsWithdraw',
]);
/**
 * Tool identifiers whose calls a wired domain guard should analyze. In the
 * three.ws chat registry tools are flat, so the identifier equals the API
 * name; manifest-style hosts register their package identifiers instead.
 */
export const DEFI_TOOL_IDENTIFIERS = new Set([
    'solana_transfer',
    'solana_swap',
    'evm_transfer',
    'evm_swap',
    'pumpfunBuy',
    'pumpfunSell',
    'pumpfunSellAll',
    'LaunchPumpToken',
    'MintScene',
    'agentPaymentsDistribute',
    'agentPaymentsWithdraw',
]);
/** Register an additional mutating API name at host boot. */
export function registerMutatingApi(apiName) {
    MUTATING_APIS.add(apiName);
}
/** Register an additional fund-moving tool identifier at host boot. */
export function registerFundMovingTool(identifier) {
    DEFI_TOOL_IDENTIFIERS.add(identifier);
}
