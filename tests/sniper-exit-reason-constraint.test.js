/**
 * agent-sniper: every exit reason the worker can emit must be accepted by the
 * agent_sniper_positions.exit_reason CHECK constraint.
 *
 * This guards a failure that is invisible from the code alone. The worker's
 * exit reasons live in JavaScript; the allowlist that decides whether a close
 * can be written lives in SQL. Nothing connected the two, so 'liquidity_decay'
 * shipped as a working exit path whose database write was rejected every single
 * time. Because the sell had already landed on-chain by then, the position was
 * reset to 'open', retried, rejected again, and stayed wedged forever.
 *
 * These tests read both sides from their real sources: the reason literals out
 * of the worker modules, and the accepted values out of the migration that
 * currently defines the constraint. Adding a new exit reason without widening
 * the constraint fails here instead of in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'api/_lib/migrations');

/**
 * The accepted values, taken from the LAST migration (by filename order, which
 * is the order the runner applies them) that redefines the constraint. Later
 * migrations drop and recreate it, so only the final definition is live.
 */
function liveAllowlist() {
	const defining = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.filter((f) => {
			const sql = readFileSync(join(migrationsDir, f), 'utf8');
			return /add\s+constraint\s+agent_sniper_positions_exit_reason_check/i.test(sql);
		});
	expect(defining.length, 'no migration defines the exit_reason constraint').toBeGreaterThan(0);

	const sql = readFileSync(join(migrationsDir, defining[defining.length - 1]), 'utf8');
	const clause = sql
		.slice(sql.search(/add\s+constraint\s+agent_sniper_positions_exit_reason_check/i))
		.match(/check\s*\(\s*exit_reason\s+in\s*\(([^)]*)\)/i);
	expect(clause, 'could not parse the constraint value list').not.toBe(null);
	return new Set([...clause[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

/**
 * Reasons that can land in the exit_reason column. Deliberately narrow: the
 * worker uses the word "reason" for buy aborts and skips too, and those are
 * written to the `error` column where no CHECK applies. Only three routes reach
 * exit_reason, and each is read from the code that owns it:
 *
 *   1. the literal passed at an executeSell call site,
 *   2. whatever decideExit / decideLadderedExit assigns, which positions.js
 *      forwards verbatim as `reason: exit.reason`,
 *   3. a literal written straight into the UPDATE by the executor's give-up path.
 */
function emittedReasons() {
	const found = new Set();

	// 1. executeSell call sites, matched from the opening call to its closing
	//    `})` so a `reason:` elsewhere in the file cannot leak in.
	for (const rel of ['workers/agent-sniper/positions.js', 'api/sniper/close.js']) {
		const src = readFileSync(join(root, rel), 'utf8');
		const calls = [...src.matchAll(/executeSell\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
		expect(calls.length, `no executeSell call found in ${rel}`).toBeGreaterThan(0);
		for (const call of calls) {
			for (const m of call.matchAll(/\breason\s*:\s*'([a-z_]+)'/g)) found.add(m[1]);
		}
	}

	// 2. exit-logic.js is a pure decision module: every reason literal in it is
	//    an exit reason, assigned (`reason = 'x'`) or returned (`reason: 'x'`).
	const logic = readFileSync(join(root, 'workers/agent-sniper/exit-logic.js'), 'utf8');
	for (const m of logic.matchAll(/\breason\s*[:=]\s*'([a-z_]+)'/g)) found.add(m[1]);

	// 3. Literal exit_reason writes in the executor.
	const exec = readFileSync(join(root, 'workers/agent-sniper/executor.js'), 'utf8');
	for (const m of exec.matchAll(/exit_reason\s*=\s*'([a-z_]+)'/g)) found.add(m[1]);

	return found;
}

describe('agent_sniper_positions.exit_reason constraint', () => {
	it('accepts every reason the worker can write', () => {
		const allowed = liveAllowlist();
		const rejected = [...emittedReasons()].filter((r) => !allowed.has(r)).sort();
		expect(rejected, `exit reasons the database would reject: ${rejected.join(', ')}`).toEqual([]);
	});

	it('covers the two reasons that were silently rejected in production', () => {
		const allowed = liveAllowlist();
		expect(allowed.has('liquidity_decay')).toBe(true);
		expect(allowed.has('take_initials')).toBe(true);
	});

	it('still accepts the original reasons, so no existing close path regresses', () => {
		const allowed = liveAllowlist();
		for (const r of [
			'take_profit', 'stop_loss', 'trailing_stop', 'timeout',
			'manual', 'kill_switch', 'graduated', 'error', 'signal_flip',
		]) {
			expect(allowed.has(r), `${r} dropped from the allowlist`).toBe(true);
		}
	});

	it('gives every accepted reason a human label on the trade card', async () => {
		// A reason with no label falls through to a raw underscore-stripped
		// string, which reads as a bug next to "Take-profit" and "Stop-loss".
		const { exitReasonLabel } = await import('../api/_lib/trade-card.js');
		for (const r of liveAllowlist()) {
			expect(exitReasonLabel(r), `${r} has no trade-card label`).not.toBe(r.replace(/_/g, ' '));
		}
	});
});
