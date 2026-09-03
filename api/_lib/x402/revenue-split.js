// @ts-check
// api/_lib/x402/revenue-split.js
//
// External vs internal revenue: the one classifier that decides which settled
// x402 payments count as traction.
//
// three.ws runs a closed dogfooding loop (the x402 ring, docs/x402-ring-economy.md):
// platform-controlled wallets pay platform endpoints on a cron so the payment
// rails stay warm and provably live. That volume is real money moving on real
// chains, and it dwarfs everything else. As of this module landing, 38,613 of
// 38,619 settled payments came from four ring wallets. A gross figure read off
// x402_audit_log is therefore ~100% our own money, and reporting it as revenue
// would be fabricated traction. The operating rule (docs/internal/fable-playbook.md §4)
// is blunt: external revenue only, never report ring volume as traction.
//
// Nothing enforced that rule mechanically until this module. Every consumer of
// the ledger (the readout script, the paid analytics report) now splits
// through one function so the two can never disagree.
//
// Three buckets, not two:
//
//   internal   payer is a platform-controlled wallet (ring roles, the
//              x402_ring_wallets registry, platform signers, USDC ATAs of all
//              of them). Dogfooding. Never traction.
//   synthetic  payer is not a plausible on-chain address at all: a literal
//              like 'PAYER' written by a replay/self-test path. Not a buyer,
//              not revenue, and counting it as external would be worse than
//              counting ring volume, because it is not even money.
//   external   a real address we do not control. This is the only bucket that
//              counts toward the revenue ladder.
//
// ── Why classification is conservative ────────────────────────────────────────
// ringAllowedAddresses() degrades by SHRINKING (an unreachable DB or an
// unconfigured signer drops addresses). For leak scanning that is the safe
// direction, more false leak alerts. For revenue it is the DANGEROUS direction:
// a shrunk controlled set reclassifies our own wallets as external and inflates
// the number we are least allowed to inflate. So this module reports how the set
// was resolved and marks the split `confident: false` when the registry came
// back empty, and every caller is expected to refuse to publish an unconfident
// external figure rather than quietly print a flattering one.

import { ringAllowedAddresses } from './ring-allowlist.js';

/** Solana pubkeys are base58, 32-44 chars. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** EVM addresses are 0x + 40 hex. */
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * True when `payer` looks like an address on a chain we settle on. Anything
 * else (null, '', 'PAYER', 'test-wallet') is a synthetic ledger artifact.
 * @param {unknown} payer
 * @returns {boolean}
 */
export function isPlausibleAddress(payer) {
	if (typeof payer !== 'string') return false;
	const s = payer.trim();
	return BASE58_RE.test(s) || EVM_RE.test(s);
}

/**
 * Resolve the platform-controlled wallet set plus the provenance needed to
 * judge whether an external figure derived from it is publishable.
 *
 * @param {{ sql?: Function }} [deps] inject the sql tag (tests)
 * @returns {Promise<{ addresses: Set<string>, registryRows: number, confident: boolean, reason: string|null }>}
 */
export async function controlledPayers(deps = {}) {
	let addresses = new Set();
	let error = null;
	try {
		addresses = await ringAllowedAddresses(deps);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	// The registry is the dominant source: every wallet that has actually paid
	// lives there, while the env-derived additions are belt-and-braces. An empty
	// registry means the set cannot be trusted to cover our own payers.
	let registryRows = 0;
	try {
		const sql = deps.sql || (await import('../db.js')).sql;
		const rows = await sql`SELECT count(*)::int AS c FROM x402_ring_wallets WHERE enabled = true`;
		registryRows = rows?.[0]?.c || 0;
	} catch {
		registryRows = 0;
	}

	const confident = registryRows > 0 && addresses.size > 0;
	const reason = confident
		? null
		: error
			? `controlled-wallet set unresolved (${error})`
			: 'x402_ring_wallets returned no enabled rows, so ring payers would misclassify as external';

	return { addresses, registryRows, confident, reason };
}

/**
 * Bucket one payer.
 * @param {unknown} payer
 * @param {Set<string>} controlled
 * @returns {'internal'|'synthetic'|'external'}
 */
export function classifyPayer(payer, controlled) {
	if (!isPlausibleAddress(payer)) return 'synthetic';
	const s = String(payer).trim();
	return controlled.has(s) ? 'internal' : 'external';
}

/** Atomic USDC (6dp) → a fixed-precision decimal string. Never floats the sum. */
function atomicsToUsdc(atomics) {
	const n = BigInt(atomics || 0n);
	const neg = n < 0n;
	const abs = neg ? -n : n;
	const whole = abs / 1_000_000n;
	const frac = (abs % 1_000_000n).toString().padStart(6, '0');
	return `${neg ? '-' : ''}${whole}.${frac}`;
}

function emptyBucket() {
	return { calls: 0, volume_atomics: 0n, payers: new Set(), routes: new Map() };
}

function finishBucket(bucket, totalCalls) {
	const routes = [...bucket.routes.entries()]
		.map(([route, v]) => ({ route, calls: v.calls, volume_usdc: atomicsToUsdc(v.atomics) }))
		.sort((a, b) => b.calls - a.calls);
	return {
		calls: bucket.calls,
		volume_atomics: bucket.volume_atomics.toString(),
		volume_usdc: atomicsToUsdc(bucket.volume_atomics),
		unique_payers: bucket.payers.size,
		share_of_calls: totalCalls > 0 ? Number((bucket.calls / totalCalls).toFixed(6)) : 0,
		routes,
	};
}

/**
 * Split settled x402 payments into internal / synthetic / external over a window.
 *
 * Reads x402_audit_log directly (the durable settlement ledger) rather than a
 * pre-aggregated view, because the split is per-payer and no aggregate carries
 * the payer identity forward.
 *
 * @param {{ since?: string|Date|null, sql?: Function }} [opts]
 *   `since` null/undefined = all time.
 * @returns {Promise<{
 *   since: string|null,
 *   generated_at: string,
 *   confident: boolean,
 *   confidence_note: string|null,
 *   controlled_wallets: number,
 *   total: { calls: number, volume_atomics: string, volume_usdc: string, unique_payers: number },
 *   external: object, internal: object, synthetic: object,
 * }>}
 */
export async function revenueSplit({ since = null, sql: injected } = {}) {
	const sql = injected || (await import('../db.js')).sql;
	const sinceIso = since == null ? null : new Date(since).toISOString();

	const { addresses, registryRows, confident, reason } = await controlledPayers({ sql });

	const rows = await sql`
		SELECT
			payer,
			route,
			count(*)::int AS calls,
			coalesce(sum(
				CASE WHEN amount_atomics IS NOT NULL AND amount_atomics ~ '^[0-9]+$'
				THEN amount_atomics::numeric ELSE 0 END
			), 0)::text AS atomics
		FROM x402_audit_log
		WHERE event_type = 'payment_settled'
			AND (${sinceIso}::timestamptz IS NULL OR created_at >= ${sinceIso}::timestamptz)
		GROUP BY payer, route
	`;

	const buckets = { internal: emptyBucket(), synthetic: emptyBucket(), external: emptyBucket() };
	let totalCalls = 0;
	let totalAtomics = 0n;
	const allPayers = new Set();

	for (const row of rows) {
		const calls = Number(row.calls) || 0;
		const atomics = BigInt(String(row.atomics || '0').split('.')[0] || '0');
		const bucket = buckets[classifyPayer(row.payer, addresses)];

		bucket.calls += calls;
		bucket.volume_atomics += atomics;
		if (row.payer) bucket.payers.add(String(row.payer));

		const route = row.route || '(unrouted)';
		const seen = bucket.routes.get(route) || { calls: 0, atomics: 0n };
		seen.calls += calls;
		seen.atomics += atomics;
		bucket.routes.set(route, seen);

		totalCalls += calls;
		totalAtomics += atomics;
		if (row.payer) allPayers.add(String(row.payer));
	}

	return {
		since: sinceIso,
		generated_at: new Date().toISOString(),
		confident,
		confidence_note: reason,
		controlled_wallets: addresses.size,
		registry_rows: registryRows,
		total: {
			calls: totalCalls,
			volume_atomics: totalAtomics.toString(),
			volume_usdc: atomicsToUsdc(totalAtomics),
			unique_payers: allPayers.size,
		},
		external: finishBucket(buckets.external, totalCalls),
		internal: finishBucket(buckets.internal, totalCalls),
		synthetic: finishBucket(buckets.synthetic, totalCalls),
	};
}

export { atomicsToUsdc };
