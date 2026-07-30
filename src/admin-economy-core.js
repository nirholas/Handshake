// Pure logic behind /admin/economy. No DOM, no fetch, no globals, so the verdict
// rules are unit-testable. That matters because the whole point of the page is
// that the verdict can be trusted without re-deriving it by hand.
//
// The rules encode a real incident (2026-07-30). The Money Pulse read $5.89/24h
// while the activity feed looked perfectly healthy, because the circulation
// engine had been reduced to its FREE actions: reviews and skill trials kept
// running, so every naive "is it alive" signal stayed green while tips,
// payments, trades and launches sat at exactly zero. Two look-alike causes had
// opposite fixes, and telling them apart by eye cost hours:
//   - the budget governor zeroed the paid-action budget (treasury under reserve)
//   - the refuel lane could not READ its USDC balance and reported it as empty
// Both are named explicitly below so nobody has to rediscover them.

/** Action kinds that move real value. Free kinds are excluded on purpose: they
 *  stay green through exactly the outage this page exists to catch. */
export const PAID_KINDS = ['tip', 'payment', 'trade', 'launch'];

/** Every kind the engine records, paid and free, for the lanes table. */
export const ALL_KINDS = [...PAID_KINDS, 'buy_skill', 'buy_asset', 'trial', 'review', 'deploy'];

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Total attempts (ok + skipped + error) for one kind. */
export function attemptsFor(byKind, kind) {
	const k = byKind?.[kind];
	if (!k) return 0;
	return n(k.ok) + n(k.skipped) + n(k.error);
}

/** First human-readable problem across the given kinds, or null. */
export function firstProblem(byKind, kinds = PAID_KINDS) {
	for (const kind of kinds) {
		const p = byKind?.[kind]?.last_problem;
		if (p) return { kind, problem: String(p) };
	}
	return null;
}

/** Round to 6dp so exponent notation never reaches the UI. */
export const sol = (v) => Math.round(n(v) * 1e6) / 1e6;

/** Compact SOL string. Keeps dust legible instead of collapsing it to 0. */
export function fmtSol(v) {
	const x = n(v);
	if (x === 0) return '0';
	if (Math.abs(x) < 0.001) return x.toFixed(6);
	if (Math.abs(x) < 1) return x.toFixed(4);
	return x.toFixed(3);
}

/** Compact USD string that never renders a real amount as $0.00. */
export function fmtUsd(v) {
	const x = n(v);
	if (x === 0) return '$0';
	if (Math.abs(x) < 0.01) return '<$0.01';
	if (Math.abs(x) < 1000) return '$' + x.toFixed(2);
	return '$' + Math.round(x).toLocaleString('en-US');
}

/**
 * Health of one wallet against its floor.
 * @returns {'ok'|'low'|'dry'}
 */
export function linkState(current, floor) {
	const c = n(current);
	const f = n(floor);
	if (f <= 0) return c > 0 ? 'ok' : 'dry';
	if (c >= f) return 'ok';
	if (c >= f * 0.5) return 'low';
	return 'dry';
}

/** Fill ratio 0..1 for the meter under each chain link. */
export function linkFill(current, floor) {
	const f = n(floor);
	if (f <= 0) return n(current) > 0 ? 1 : 0;
	return Math.max(0, Math.min(1, n(current) / f));
}

/**
 * The funding chain, root first. Each link carries its own floor so the UI can
 * show WHY a link is red, not merely that it is.
 *
 * @param {{health?:object, topup?:object}} p
 * @returns {Array<{id:string,label:string,amount:number,unit:string,floor:number,state:string,fill:number,note:string}>}
 */
export function chainLinks({ health, topup } = {}) {
	const links = [];
	const masterFloor = n(topup?.master_operating_sol) + n(topup?.reserve_sol ?? 0.02);

	links.push({
		id: 'master',
		label: 'Economy master',
		amount: sol(topup?.master_sol),
		unit: 'SOL',
		floor: sol(masterFloor),
		state: linkState(topup?.master_sol, masterFloor),
		fill: linkFill(topup?.master_sol, masterFloor),
		note: 'Funding root, and the x402 sponsor: under its floor the ring fails closed too.',
	});

	for (const t of topup?.targets || []) {
		links.push({
			id: `engine:${t.pubkey || t.name}`,
			label: String(t.name || 'engine'),
			amount: sol(t.currentSol),
			unit: 'SOL',
			floor: sol(t.refillToSol),
			state: linkState(t.currentSol, t.refillToSol),
			fill: linkFill(t.currentSol, t.refillToSol),
			note: 'Below its refill target, so the next sweep tops it up.',
		});
	}

	const perRun = n(health?.fuel?.caps?.per_run_usd) || 5;
	const usdc = topup?.fuel?.usdcAvailable;
	const unreadable = topup?.fuel?.reason === 'usdc_read_failed';
	links.push({
		id: 'usdc',
		label: 'Refuel reserve (USDC)',
		amount: unreadable ? 0 : sol(usdc),
		unit: 'USDC',
		floor: perRun,
		state: unreadable ? 'dry' : linkState(usdc, perRun),
		fill: unreadable ? 0 : linkFill(usdc, perRun),
		note: unreadable
			? 'Balance could not be read. Unknown is not the same as empty.'
			: 'Revenue the master converts to SOL when the chain runs short.',
	});

	return links;
}

/**
 * Total SOL the funding chain is short, master plus every under-floor engine.
 * @param {{topup?:object}} p
 */
export function totalDeficit({ topup } = {}) {
	return sol(
		n(topup?.master_deficit_sol)
			+ (topup?.targets || []).reduce((s, t) => s + Math.max(0, n(t.refillToSol) - n(t.currentSol)), 0),
	);
}

/**
 * The one-line answer to "is the Money Pulse healthy, and if not, which link
 * broke". Ordered most-actionable first: a cause that makes every later signal
 * meaningless has to win, or the operator chases a symptom instead of the fault.
 *
 * @param {{stats?:object, health?:object, topup?:object}} p
 * @returns {{level:'good'|'warn'|'bad', title:string, detail:string}}
 */
export function diagnose({ stats, health, topup } = {}) {
	if (!health) {
		return {
			level: 'warn',
			title: 'Engine health unavailable',
			detail: 'Could not read /api/admin/circulation-health, so this verdict is incomplete.',
		};
	}

	if (health.config && health.config.enabled === false) {
		return {
			level: 'bad',
			title: 'Circulation engine is switched off',
			detail: 'CIRCULATION_ENABLED is unset, so the engine is inert by design. Nothing is broken, and nothing will move either.',
		};
	}

	if (health.config && !health.config.treasury_configured) {
		return {
			level: 'bad',
			title: 'No circulation treasury configured',
			detail: 'CIRCULATION_TREASURY_SECRET is unset, so the engine cannot fund a single action.',
		};
	}

	if (health.liveness?.stale) {
		return {
			level: 'bad',
			title: `No circulation action for ${n(health.liveness.minutes_since)} min`,
			detail: 'Either the pulse-tick cron stopped firing or every action returned early. Check Cloud Scheduler before trusting anything below.',
		};
	}

	// The refuel read failure outranks the budget verdict: it makes the treasury
	// look unfundable while the money to fund it sits right there in the wallet.
	if (topup?.fuel?.reason === 'usdc_read_failed') {
		return {
			level: 'bad',
			title: 'Refuel blocked: USDC balance unreadable',
			detail: 'The balance is UNKNOWN, not zero, so this is an RPC fault and not an empty wallet. Check the Solana lanes; do not send funds.',
		};
	}

	const byKind = health.window_24h?.by_kind || {};
	const paidAttempts = PAID_KINDS.reduce((s, k) => s + attemptsFor(byKind, k), 0);
	const paidOk = PAID_KINDS.reduce((s, k) => s + n(byKind[k]?.ok), 0);

	if (paidAttempts === 0) {
		return {
			level: 'bad',
			title: 'Paid lanes never ran in 24h',
			detail: 'The budget governor planned zero paid actions, which means the circulation treasury sat under its reserve. Free actions keep running, so the feed looks alive while no money moves.',
		};
	}

	if (paidOk === 0) {
		const p = firstProblem(byKind);
		return {
			level: 'bad',
			title: 'Every paid action failed in 24h',
			detail: p
				? `Attempts happened but none settled. Last problem on ${p.kind}: ${p.problem}`
				: 'Attempts happened but none settled.',
		};
	}

	const deficit = totalDeficit({ topup });

	if (deficit > 0 && topup?.fuel?.reason === 'no_spare_usdc') {
		return {
			level: 'bad',
			title: 'Funding chain is genuinely dry',
			detail: `A ${fmtSol(deficit)} SOL deficit with no USDC left to convert. This is the one case that really needs the owner to send funds.`,
		};
	}

	if (deficit > 0 && topup?.fuel?.reason === 'daily_cap_reached') {
		return {
			level: 'warn',
			title: 'Refuel paused: daily cap reached',
			detail: `A ${fmtSol(deficit)} SOL deficit remains, but today's USDC conversion cap is spent. It resumes at the next UTC day.`,
		};
	}

	const stalled = PAID_KINDS.filter((k) => attemptsFor(byKind, k) > 0 && n(byKind[k]?.ok) === 0);
	if (stalled.length) {
		const p = firstProblem(byKind, stalled);
		return {
			level: 'warn',
			title: `${stalled.length} paid lane${stalled.length > 1 ? 's' : ''} stalled: ${stalled.join(', ')}`,
			detail: p ? `Last problem on ${p.kind}: ${p.problem}` : 'These lanes attempted but never settled.',
		};
	}

	if (deficit > 0) {
		return {
			level: 'warn',
			title: 'Self-heal in progress',
			detail: `Money is moving, and a ${fmtSol(deficit)} SOL deficit is being closed by reclaim and USDC refuel. No action needed.`,
		};
	}

	return {
		level: 'good',
		title: 'Economy healthy',
		detail: `All paid lanes settling, funding chain above its floors, ${fmtUsd(stats?.volume_24h?.usd)} of pulse volume in the last 24h.`,
	};
}
