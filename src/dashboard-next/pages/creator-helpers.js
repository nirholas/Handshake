// Pure, side-effect-free logic for the Creator Studio page (creator.js).
//
// Kept in its own module so the price-editor math, validation, $THREE-holder
// discount ladder, royalty-ledger grouping, and CSV export are unit-testable
// without booting the page IIFE that mounts the dashboard shell.
//
// The discount tiers mirror api/_lib/three-tier.js (the server is authoritative;
// this is the buyer-facing *preview*). Keep TIER_LADDER in sync with TIERS there.

const USDC_DECIMALS = 1_000_000;

// $THREE-holder discount ladder — mirrors TIERS in api/_lib/three-tier.js.
// discountBps is applied to the listed price to show the buyer-facing price each
// holder tier pays. Member (level 0) pays full price.
export const TIER_LADDER = Object.freeze([
	Object.freeze({ id: 'member',  label: 'Member',  minUsd: 0,    discountBps: 0 }),
	Object.freeze({ id: 'bronze',  label: 'Bronze',  minUsd: 25,   discountBps: 500 }),
	Object.freeze({ id: 'silver',  label: 'Silver',  minUsd: 100,  discountBps: 1000 }),
	Object.freeze({ id: 'gold',    label: 'Gold',    minUsd: 500,  discountBps: 2000 }),
	Object.freeze({ id: 'genesis', label: 'Genesis', minUsd: 2500, discountBps: 3000 }),
]);

export const RULE_TYPES = Object.freeze(['first_n_purchases', 'after_n_purchases', 'time_window']);

/** Convert a human USDC amount (e.g. 1.5) to 6-decimal atomic units. */
export function usdcToAtomic(usdc) {
	const n = Number(usdc);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.round(n * USDC_DECIMALS);
}

/** Convert atomic USDC units to a human amount. */
export function atomicToUsdc(atomic) {
	const n = Number(atomic);
	if (!Number.isFinite(n)) return 0;
	return n / USDC_DECIMALS;
}

/**
 * Buyer-facing price after a $THREE-holder discount.
 * @param {number} priceUsdc listed price (human USDC)
 * @param {number} discountBps basis points off (0–10000)
 * @returns {number} discounted price, rounded to 6 decimals (USDC precision)
 */
export function discountedPrice(priceUsdc, discountBps) {
	const p = Number(priceUsdc);
	const bps = Number(discountBps);
	if (!Number.isFinite(p) || p <= 0) return 0;
	if (!Number.isFinite(bps) || bps <= 0) return roundUsdc(p);
	const clamped = Math.min(Math.max(bps, 0), 10_000);
	return roundUsdc(p * (1 - clamped / 10_000));
}

/** Round to USDC's 6-decimal precision, avoiding binary-float dust. */
export function roundUsdc(n) {
	return Math.round(Number(n) * USDC_DECIMALS) / USDC_DECIMALS;
}

/**
 * The price each holder tier pays for a listed price — the real buyer-facing
 * preview (no fake numbers; uses the canonical tier bps).
 * @returns {Array<{ id, label, discountBps, price, saves }>}
 */
export function buyerPriceLadder(priceUsdc) {
	const p = Number(priceUsdc);
	return TIER_LADDER.map((t) => {
		const price = discountedPrice(p, t.discountBps);
		return {
			id: t.id,
			label: t.label,
			discountBps: t.discountBps,
			price,
			saves: roundUsdc(Math.max(0, (Number.isFinite(p) ? p : 0) - price)),
		};
	});
}

/**
 * Validate a per-call price input.
 * @returns {{ ok: boolean, value?: number, error?: string }}
 */
export function validatePrice(raw) {
	if (raw === '' || raw === null || raw === undefined) {
		return { ok: false, error: 'Enter a price.' };
	}
	const n = Number(raw);
	if (!Number.isFinite(n)) return { ok: false, error: 'Price must be a number.' };
	if (n < 0) return { ok: false, error: 'Price cannot be negative.' };
	if (n > 0 && usdcToAtomic(n) < 1) {
		return { ok: false, error: 'Price is below the $0.000001 minimum.' };
	}
	if (n > 1_000_000) return { ok: false, error: 'Price exceeds the $1,000,000 maximum.' };
	return { ok: true, value: roundUsdc(n) };
}

/**
 * Validate a dynamic pricing rule before sending it to
 * /api/agents/:id/pricing-rules. Mirrors the server zod schema.
 * @param {{ rule_type, threshold?, price_usdc?, start_at?, end_at? }} rule
 * @returns {{ ok: boolean, error?: string, payload?: object }}
 */
export function validateRule(rule) {
	if (!rule || !RULE_TYPES.includes(rule.rule_type)) {
		return { ok: false, error: 'Choose a valid rule type.' };
	}
	const priceCheck = validatePrice(rule.price_usdc);
	if (!priceCheck.ok) return { ok: false, error: priceCheck.error };
	if (priceCheck.value <= 0) return { ok: false, error: 'Rule price must be greater than zero.' };

	const payload = {
		rule_type: rule.rule_type,
		price_amount: usdcToAtomic(priceCheck.value),
	};

	if (rule.rule_type === 'time_window') {
		const start = rule.start_at ? new Date(rule.start_at) : null;
		const end = rule.end_at ? new Date(rule.end_at) : null;
		if (!start && !end) return { ok: false, error: 'Set a start or end time for the window.' };
		if (start && isNaN(start.getTime())) return { ok: false, error: 'Invalid start time.' };
		if (end && isNaN(end.getTime())) return { ok: false, error: 'Invalid end time.' };
		if (start && end && end.getTime() <= start.getTime()) {
			return { ok: false, error: 'End time must be after the start time.' };
		}
		if (start) payload.start_at = start.toISOString();
		if (end) payload.end_at = end.toISOString();
	} else {
		const t = Number(rule.threshold);
		if (!Number.isInteger(t) || t < 1) {
			return { ok: false, error: 'Threshold must be a whole number ≥ 1.' };
		}
		payload.threshold = t;
	}
	return { ok: true, payload };
}

/**
 * Mirror of api/_lib/skill-pricing-rules.js resolveSkillPrice — computes the
 * price a buyer pays *right now* given the base price, the active rules, and the
 * current confirmed-sale count. Used to show the real effective price (not a
 * mock) before any $THREE discount.
 * @returns {{ priceUsdc: number, source: string, rule?: object }}
 */
export function effectivePriceNow({ basePriceUsdc, rules = [], saleCount = 0, now = new Date() } = {}) {
	const base = Number(basePriceUsdc) || 0;
	const active = (rules || [])
		.filter((r) => r && r.is_active !== false)
		.slice()
		.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

	const t = now instanceof Date ? now : new Date(now);
	for (const rule of active) {
		const rulePrice = atomicToUsdc(rule.price_amount);
		if (rule.rule_type === 'first_n_purchases' && saleCount < Number(rule.threshold)) {
			return { priceUsdc: rulePrice, source: 'first_n_purchases', rule };
		}
		if (rule.rule_type === 'after_n_purchases' && saleCount >= Number(rule.threshold)) {
			return { priceUsdc: rulePrice, source: 'after_n_purchases', rule };
		}
		if (rule.rule_type === 'time_window') {
			const start = rule.start_at ? new Date(rule.start_at) : null;
			const end = rule.end_at ? new Date(rule.end_at) : null;
			const inWindow = (!start || t >= start) && (!end || t <= end);
			if (inWindow) return { priceUsdc: rulePrice, source: 'time_window', rule };
		}
	}
	return { priceUsdc: base, source: 'base' };
}

const LEDGER_STATUSES = Object.freeze(['pending', 'settling', 'settled', 'failed']);

/**
 * Group royalty-ledger entries by settlement state and total each bucket.
 * @param {Array<{ status, price_usd }>} entries
 */
export function groupLedgerByStatus(entries) {
	const buckets = { pending: [], settling: [], settled: [], failed: [] };
	const totals = { pending: 0, settling: 0, settled: 0, failed: 0 };
	for (const e of entries || []) {
		const status = LEDGER_STATUSES.includes(e?.status) ? e.status : 'pending';
		buckets[status].push(e);
		totals[status] += Number(e?.price_usd) || 0;
	}
	return { buckets, totals };
}

// Which rail earned a ledger entry, in the author's words. `source` comes from
// royalty_ledger.source: 'x402' is a per-call payment on the platform's own
// rail (the money routed to the author's wallet at settle time), while
// 'skill-runtime' is an in-process invocation that settles later through the
// delegated-permission redeem leg. Asset sales ride the same table for display.
const RAIL_LABELS = Object.freeze({
	x402: 'Per-call (x402)',
	'skill-runtime': 'In-app call',
	'asset-sale': 'Asset sale',
});

/**
 * Human label for a royalty entry's earning rail.
 * @param {string|null|undefined} source
 * @returns {string}
 */
export function railLabel(source) {
	return RAIL_LABELS[source] || RAIL_LABELS['skill-runtime'];
}

/**
 * Build a CSV string from royalty-ledger / earnings entries for export.
 * Carries the settlement provenance (rail, chain, transaction) so an exported
 * row can be reconciled against the chain without opening the dashboard.
 */
export function ledgerToCsv(entries, { networkLabel = (n) => n || '' } = {}) {
	const header = ['Date', 'Type', 'Skill', 'Agent', 'Amount (USD)', 'Platform fee (USD)', 'Status', 'Rail', 'Chain', 'Transaction'];
	const rows = (entries || []).map((e) => [
		csvCell(e?.created_at || ''),
		csvCell(e?.kind || 'skill'),
		csvCell(e?.skill_name || ''),
		csvCell(e?.agent_name || ''),
		// Six decimals, matching USDC's precision and the numeric(10,6) ledger
		// column. Per-call royalties are routinely sub-cent, so the previous
		// 4-decimal export rounded real money out of the author's own records.
		csvCell(Number(e?.price_usd ?? 0).toFixed(6)),
		csvCell(e?.platform_fee_usd == null ? '' : Number(e.platform_fee_usd).toFixed(6)),
		csvCell(e?.status || ''),
		csvCell(railLabel(e?.source)),
		csvCell(e?.network ? networkLabel(e.network) : ''),
		csvCell(e?.tx_hash || ''),
	]);
	return [header.map(csvCell).join(','), ...rows.map((r) => r.join(','))].join('\n');
}

function csvCell(v) {
	const s = String(v ?? '');
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Which onboarding step a creator is on — drives the "become a creator → set a
 * price → first sale" path and the funnel events.
 * @returns {'no_agent'|'set_price'|'configure_payout'|'first_sale'|'earning'}
 */
export function funnelStage({ agentCount = 0, priceCount = 0, hasPayout = false, hasSale = false } = {}) {
	if (agentCount <= 0) return 'no_agent';
	if (priceCount <= 0) return 'set_price';
	if (!hasPayout) return 'configure_payout';
	if (!hasSale) return 'first_sale';
	return 'earning';
}
