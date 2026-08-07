import type { X402Hook, X402HookResult, X402PaymentRequirements } from '../types/runtime.js';
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
export declare function createX402Hook(hourlyBudgetUsd?: number): X402Hook;
/**
 * Re-exports the x402 payment requirements type so callers can use
 * it without importing from the types module directly.
 */
export type { X402Hook, X402HookResult, X402PaymentRequirements };
