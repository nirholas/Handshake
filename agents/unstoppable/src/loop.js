// Loop — main lifecycle called by the cron dispatcher.
//
// Each tick:
//   1. Sense — read treasury + recent activity
//   2. Think — ask the LLM what to do (budget-gated)
//   3. Act   — execute planned actions (reflect, post_status, idle)
//   4. Settle — recalculate runway + mode

import { getTreasury, recalcRunway, recordSpend, HARD_FLOOR_ATOMICS } from './treasury.js';
import { think } from './inference.js';
import { maybeReflect } from './reflection.js';
import { getEarnings24h, getCosts24h, getRecentActivity, logActivity } from './earnings.js';

// Maximum fraction of balance to spend per tick on thinking.
const THINK_BUDGET_FRACTION = 0.001;
// Hard cap per tick: never spend more than $0.001 on thinking.
const THINK_BUDGET_CAP_ATOMICS = 1_000;

export async function tick() {
	const tickId = crypto.randomUUID();

	// ── 1. Sense ─────────────────────────────────────────────────────────────
	// Re-derive the mode from the CURRENT balance before honouring it. Settling
	// only at the end of a tick made `halted` a one-way trapdoor: a halted agent
	// skipped the tick, so the recalc that could clear the flag never ran, and it
	// stayed halted however much revenue arrived afterwards. Production sat in
	// exactly that state, halted with $8.93 against a $0.10 floor, until this ran
	// first. Halting is a financial condition, not a latch.
	const assessed = await recalcRunway();
	if (assessed.mode === 'halted') {
		console.log(`[loop] tick ${tickId} skipped — halted (balance at or below the hard floor)`);
		return { tickId, skipped: true, reason: 'halted' };
	}

	const treasury = await getTreasury();

	const [earnings24h, costs24h, recentActivity] = await Promise.all([
		getEarnings24h(),
		getCosts24h(),
		getRecentActivity(10),
	]);

	// ── 2. Think ─────────────────────────────────────────────────────────────
	const budgetAtomics = Math.min(
		Math.floor(treasury.balance_usdc_atomics * THINK_BUDGET_FRACTION),
		THINK_BUDGET_CAP_ATOMICS,
	);

	let thoughts;
	let plannedActions;

	if (treasury.balance_usdc_atomics > HARD_FLOOR_ATOMICS) {
		try {
			const thinkResult = await think({
				treasury,
				recentActivity,
				earnings24h,
				costs24h,
				availableBudgetAtomics: budgetAtomics,
			});
			thoughts = thinkResult.thoughts;
			plannedActions = thinkResult.actions;

			// Thinking itself is currently free (no external tool cost billed),
			// but we log it so the activity feed shows the agent is active.
			await logActivity({
				tickId,
				action_type: 'think',
				description: thoughts,
				cost_atomics: 0,
			});
		} catch (err) {
			console.error('[loop] think failed:', err.message);
			thoughts = 'Think failed. Conserving.';
			plannedActions = [{ type: 'idle', description: 'Think step failed.' }];
		}
	} else {
		thoughts = 'Balance below floor. Conserving resources.';
		plannedActions = [{ type: 'idle', description: 'Waiting for revenue to restore balance.' }];
		await logActivity({
			tickId,
			action_type: 'idle',
			description: thoughts,
			cost_atomics: 0,
		});
	}

	// ── 3. Act ───────────────────────────────────────────────────────────────
	let reflectionCreated = false;
	let reflectAttempted = false;

	for (const action of (plannedActions || [])) {
		try {
			if (action.type === 'reflect') {
				reflectAttempted = true;
				const result = await maybeReflect();
				reflectionCreated = result.created;
				await logActivity({
					tickId,
					action_type: 'reflect',
					description: reflectionCreated
						? 'Daily reflection written.'
						: 'Reflection already exists for today.',
					cost_atomics: 0,
				});
			} else if (action.type === 'post_status') {
				// post_status is a free no-op in this implementation — the status
				// endpoint is always live. Log it so the activity feed is rich.
				await logActivity({
					tickId,
					action_type: 'post_status',
					description: action.description || 'Status endpoint is live.',
					cost_atomics: 0,
				});
			} else if (action.type === 'idle') {
				await logActivity({
					tickId,
					action_type: 'idle',
					description: action.description || 'No actions needed.',
					cost_atomics: 0,
				});
			} else if (action.type === 'search') {
				// Future: paid search action. Skipped unless budget is available.
				if (
					treasury.mode === 'normal' &&
					treasury.balance_usdc_atomics > HARD_FLOOR_ATOMICS + 10_000
				) {
					// Reserve 10_000 atomics ($0.01) for the search.
					await recordSpend(10_000);
					await logActivity({
						tickId,
						action_type: 'search',
						description: action.description || 'Search executed.',
						cost_atomics: 10_000,
					});
				}
			} else {
				// Unknown action type — log as idle so it shows in the feed.
				await logActivity({
					tickId,
					action_type: action.type,
					description: action.description || `Action type: ${action.type}`,
					cost_atomics: 0,
				});
			}
		} catch (err) {
			console.error(`[loop] action ${action.type} failed:`, err.message);
		}
	}

	// The daily reflection is a promise this agent makes publicly (the
	// /unstoppable dashboard renders it), so it cannot depend on the planner
	// choosing to ask for it. Left to the LLM's discretion it simply never got
	// planned and the agent went months without writing one. maybeReflect() is
	// idempotent — after the first tick of a day it is one existence check.
	if (!reflectAttempted) {
		try {
			const result = await maybeReflect();
			reflectionCreated = result.created;
			if (reflectionCreated) {
				await logActivity({
					tickId,
					action_type: 'reflect',
					description: 'Daily reflection written.',
					cost_atomics: 0,
				});
			}
		} catch (err) {
			console.error('[loop] daily reflection failed:', err.message);
		}
	}

	// ── 4. Settle ────────────────────────────────────────────────────────────
	const { runwayDays, mode } = await recalcRunway();

	console.log(
		`[loop] tick ${tickId} complete — mode=${mode} runway=${runwayDays.toFixed(1)}d actions=${(plannedActions || []).length}`,
	);

	return {
		tickId,
		thoughts,
		actions: (plannedActions || []).length,
		reflectionCreated,
		mode,
		runwayDays,
	};
}
