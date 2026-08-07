// ─── Default autonomy budget ──────────────────────────────────────────────────
/** Default hourly spend cap per agent in USD before requiring user approval */
const DEFAULT_HOURLY_BUDGET_USD = 5.0;
// ─── Token decimals lookup ───────────────────────────────────────────────────
/** Resolve decimals for the payment asset. USDC, USDT and EURC all use 6. */
function getTokenDecimals(accept) {
    if (typeof accept.decimals === 'number' && Number.isFinite(accept.decimals))
        return accept.decimals;
    return 6;
}
/** Resolve a display name for the chain from a CAIP-2 network string. */
function getChainName(network) {
    if (!network)
        return 'unknown chain';
    const chainNames = {
        'eip155:1': 'Ethereum',
        'eip155:8453': 'Base',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
    };
    return chainNames[network] ?? network;
}
// ─── Factory ──────────────────────────────────────────────────────────────────
/**
 * Creates the default x402 autonomy hook.
 *
 * Decision logic:
 *
 * 1. If `currentBalanceUsdc < amountRequired` → reject (insufficient funds)
 * 2. If `amountSpentThisHourUsdc + amountRequired > hourlyBudgetUsd` → queue for approval
 * 3. Otherwise → pay automatically
 *
 * @param hourlyBudgetUsd - Max USD an agent may spend per hour autonomously
 *   (default: $5). Pass `Infinity` to disable the budget check.
 */
export function createX402Hook(hourlyBudgetUsd = DEFAULT_HOURLY_BUDGET_USD) {
    return async ({ currentBalanceUsdc, amountSpentThisHourUsdc, requirements }) => {
        const accept = requirements.accepts[0];
        if (!accept) {
            return {
                action: 'reject',
                reason: 'No payment scheme in 402 response',
            };
        }
        const decimals = getTokenDecimals(accept);
        const amountRequired = Number(accept.maxAmountRequired) / 10 ** decimals;
        const chainName = getChainName(accept.network);
        // 1. Insufficient balance
        if (currentBalanceUsdc < amountRequired) {
            return {
                action: 'reject',
                reason: `Insufficient balance. Need ${amountRequired.toFixed(4)} but wallet has ${currentBalanceUsdc.toFixed(4)} on ${chainName}.`,
            };
        }
        // 2. Would exceed hourly autonomy budget → queue for user approval
        if (amountSpentThisHourUsdc + amountRequired > hourlyBudgetUsd) {
            return {
                action: 'queue',
                reason: `Payment of ${amountRequired.toFixed(4)} would exceed the agent's hourly autonomy budget of $${hourlyBudgetUsd.toFixed(2)} (already spent: $${amountSpentThisHourUsdc.toFixed(4)} this hour).`,
            };
        }
        // 3. Pay automatically
        return { action: 'pay' };
    };
}
