// Pure aggregation + threshold helpers for the x402 ring read models.
//
// Zero I/O, zero heavy imports: fixture rows in, shaped payload out. Callers
// (api/_lib/x402/runway-sim.js) do the DB/RPC work and call these to shape the
// response. Keeping the math here means the read model is verifiable without
// standing up Neon or Solana RPC.

// The 1-signature self-pay base fee — the hard floor a settlement can cost.
export const FEE_FLOOR_LAMPORTS = 5000;
// Task 08's guarantee: every catalog endpoint is paid at least hourly. Older
// than 2h means the guarantee broke — the coverage panel shows it amber.
export const ENDPOINT_STALE_MINUTES = 120;
// The pulse strip is always a full hour so a gap in the tick is a visible hole.
export const PULSE_WINDOW_MIN = 60;

// Heartbeat thresholds: ≤1 min green (per-minute tick alive), ≤5 amber (tick
// degraded), >5 red (the ring stopped and someone should look). null = no
// settlement on record, which is red for an armed ring.
export function pulseStatus(minutesSinceLastSettle) {
	if (minutesSinceLastSettle == null) return 'red';
	if (minutesSinceLastSettle <= 1) return 'green';
	if (minutesSinceLastSettle <= 5) return 'amber';
	return 'red';
}

// Zero-fill per-minute settlement counts into a fixed window (oldest → newest)
// so a gap in the tick renders as a visible hole, not a shorter strip.
export function buildPulseStrip(rows, now = new Date(), windowMin = PULSE_WINDOW_MIN) {
	const byMinute = new Map(
		(rows || []).map((r) => [
			new Date(r.minute).setSeconds(0, 0),
			{ count: Number(r.n) || 0, fee_lamports: Number(r.fee) || 0 },
		]),
	);
	const head = new Date(now).setSeconds(0, 0);
	const strip = [];
	for (let i = windowMin - 1; i >= 0; i--) {
		const t = head - i * 60_000;
		const hit = byMinute.get(t);
		strip.push({
			ts: new Date(t).toISOString(),
			count: hit ? hit.count : 0,
			fee_lamports: hit ? hit.fee_lamports : 0,
		});
	}
	return strip;
}

// Classify a paid call by what was bought, off the endpoint path. Buckets match
// the ring catalog's vocabulary: tips, intel, commerce, the ring settle flag-
// ship, and generic paid services for everything else.
export function classifyKind(endpointUrl = '') {
	const path = String(endpointUrl).toLowerCase();
	if (path.includes('ring-settle')) return 'settle';
	if (path.includes('tip')) return 'tip';
	if (/intel|signal|oracle|analytics|reputation|trending/.test(path)) return 'intel';
	if (/skill|checkout|commerce|market|billboard|hire|license/.test(path)) return 'commerce';
	return 'service';
}

// paid | ok (free/settled-elsewhere) | skipped (structured back-pressure, not a
// failure) | failed. Skips stay amber in the UI; failures go red.
export function activityStatus(row) {
	const err = String(row.error_msg || '');
	if (row.success) return Number(row.amount_atomic) > 0 ? 'paid' : 'ok';
	// Structured back-pressure the ring emits on purpose (caps, cooldowns, the
	// task-05 fee ceiling, the SOL floor) — amber, not a red failure.
	if (
		/^(cap_would_exceed|fee_ceiling_exceeded|skipped|cooldown|fee_wallet_below_floor|sol_floor)/.test(
			err,
		)
	)
		return 'skipped';
	return 'failed';
}

// URL → short slug for the activity table ("/api/x402/dance-tip" → "dance-tip").
export function slugFromUrl(endpointUrl = '') {
	try {
		const path = endpointUrl.startsWith('http')
			? new URL(endpointUrl).pathname
			: String(endpointUrl).split('?')[0];
		const parts = path.split('/').filter(Boolean);
		return parts.slice(-1)[0] || path || '—';
	} catch {
		return String(endpointUrl) || '—';
	}
}

// last-paid age + the 2h staleness verdict for a coverage row.
export function endpointAge(lastCalledAt, now = new Date()) {
	if (!lastCalledAt) return { age_minutes: null, stale: true };
	const mins = Math.floor((now.getTime() - new Date(lastCalledAt).getTime()) / 60_000);
	return { age_minutes: mins, stale: mins > ENDPOINT_STALE_MINUTES };
}

// Fee-efficiency panel: how close each settlement runs to the 1-sig floor, what
// $100 of gross volume costs in SOL, and today's burn against the daily budget.
export function buildFeesPanel({
	feeLamports24h = 0,
	settles24h = 0,
	grossUsdc24h = 0,
	burnedTodayLamports = 0,
	budgetLamports = null,
	solUsd = null,
} = {}) {
	const avg = settles24h > 0 ? Math.round(feeLamports24h / settles24h) : null;
	const solBurned24h = feeLamports24h / 1e9;
	return {
		floor_lamports: FEE_FLOOR_LAMPORTS,
		avg_lamports_per_settle: avg,
		floor_ratio: avg != null ? Number((avg / FEE_FLOOR_LAMPORTS).toFixed(2)) : null,
		sol_per_100_usd:
			grossUsdc24h > 0 ? Number(((solBurned24h / grossUsdc24h) * 100).toFixed(6)) : null,
		sol_usd: solUsd,
		burned_today_lamports: burnedTodayLamports,
		daily_budget_lamports: budgetLamports,
		budget_used_pct:
			budgetLamports > 0 ? Math.round((burnedTodayLamports / budgetLamports) * 100) : null,
		over_budget: budgetLamports > 0 ? burnedTodayLamports > budgetLamports : false,
	};
}

// Split reconciliation verdicts into the two integrity streams the panel shows:
// ring leak-scan findings (task 06 writes x402_ring_* sources) and revenue
// reconciliation (autonomous_log / payment_intent sources, task 07).
export function splitIntegrity(bySource = []) {
	const leak = { sources: 0, total: 0, open: 0, last_checked_at: null };
	const reconcile = { sources: 0, total: 0, open: 0, last_checked_at: null };
	for (const s of bySource) {
		const bucket = String(s.source || '').startsWith('x402_ring') ? leak : reconcile;
		bucket.sources += 1;
		bucket.total += Number(s.total) || 0;
		bucket.open += Number(s.open) || 0;
		const at = s.last_checked ? new Date(s.last_checked).toISOString() : null;
		if (at && (!bucket.last_checked_at || at > bucket.last_checked_at)) bucket.last_checked_at = at;
	}
	return { leak_scan: leak, reconcile };
}
