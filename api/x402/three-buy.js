// POST /api/x402/three-buy
//
// The x402 micro-buy service: one settled payment → one small, real on-chain buy
// of $THREE. It is the high-frequency, small-ticket sibling of the daily buyback
// (api/cron/run-three-buyback) — where that lane deploys revenue in a few large
// buys per day, this lane fires many tiny buys per minute so the platform shows
// continuous, verifiable buy pressure on $THREE. Driven by api/cron/three-buy-loop.
//
// HOW IT SETTLES. The caller pays the small x402 toll (X402_PRICE_THREE_BUY, default
// $0.001) in USDC to the ring treasury (X402_PAY_TO_SOLANA), exactly like every
// other ring endpoint. The toll is NOT the buy funding — on a paid call the handler
// executes a separate USDC→$THREE swap funded by the micro-buy wallet
// (api/_lib/token/microbuy.js). Two independent, auditable money streams.
//
// BUY-ONLY. The service never sells $THREE. Bought tokens accrue in the micro-buy
// wallet and are swept to the treasury by the loop; there is no sell path.
//
// FAIL-CLOSED ON THE TOLL. The endpoint takes the toll ONLY when a buy actually
// broadcasts. When the engine is disabled, unfunded, or the UTC-daily cap is
// reached, the handler re-emits the 402 challenge (X402Error 402) so settlement
// never runs and the caller keeps their funds — the platform never charges a toll
// for a buy it didn't make. This also caps the amplification a direct payer could
// force: they can trigger buys only up to the same daily ceiling the loop obeys.
//
// discoverable:false — internal buy-pressure machinery, not an organic third-party
// service, so it is not advertised on the public x402 bazaar (same stance as
// ring-settle).

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { X402Error } from '../_lib/x402-spec.js';
import { priceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { logger } from '../_lib/usage.js';
import { TOKEN_MINT } from '../_lib/token/config.js';
import {
	isEnabled,
	ensureMicrobuySchema,
	hasDailyBudget,
	loadMicrobuySigner,
	planMicrobuy,
	executeMicrobuy,
	usdcAtomicsToUsd,
	threeAtomicsToTokens,
} from '../_lib/token/microbuy.js';

const log = logger('x402-three-buy');
const ROUTE = '/api/x402/three-buy';

// Default $0.001 — a deliberately tiny toll: this endpoint's value is the on-chain
// buy it triggers, not the toll itself. Operators tune it with X402_PRICE_THREE_BUY.
const DEFAULT_PRICE_ATOMICS = 1_000;

const DESCRIPTION =
	'three.ws internal $THREE micro-buy primitive. A settled x402 payment triggers ' +
	'one small, real on-chain market buy of $THREE on Jupiter (buy-only); bought ' +
	'tokens are swept to the treasury. High-frequency sibling of the daily buyback. ' +
	'Not a public service.';

const INPUT_EXAMPLE = { note: 'microbuy' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		note: { type: 'string', description: 'Optional label echoed into the receipt.' },
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	kind: 'three-buy',
	status: 'confirmed',
	mint: TOKEN_MINT,
	buySignature: '5x8…',
	spentUsd: 0.01,
	boughtThree: 5.1956,
	priceUsd: 0.001924,
	boughtAt: '2026-07-17T18:42:09.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'kind', 'status', 'mint', 'buySignature', 'boughtAt'],
	properties: {
		ok: { type: 'boolean', const: true },
		kind: { type: 'string', const: 'three-buy' },
		status: { type: 'string', enum: ['submitted', 'confirmed', 'pending'] },
		mint: { type: 'string' },
		buySignature: { type: 'string' },
		spentUsd: { type: ['number', 'null'] },
		boughtThree: { type: ['number', 'null'] },
		priceUsd: { type: ['number', 'null'] },
		boughtAt: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: false,
	info: {
		input: { type: 'http', method: 'POST', body: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// Re-emit the 402 challenge so the wrapper never settles the toll — used whenever a
// buy will not happen (disabled, unfunded, cap reached). The caller keeps its funds.
function refuseToll(reason) {
	return new X402Error('three_buy_unavailable', `three-buy: ${reason}`, 402);
}

// Record every buy (and skipped/failed reason) into three_microbuy_runs — never a
// silent no-op. Wrapped so a DB fault never fails a buy that already landed.
async function record(status, fields = {}) {
	try {
		const [row] = await sql`
			INSERT INTO three_microbuy_runs
				(status, reason, usdc_spent_atomics, three_bought_atomics, price_usd,
				 slippage_bps, buy_signature)
			VALUES
				(${status}, ${fields.reason ?? null}, ${fields.usdcSpentAtomics ?? 0},
				 ${fields.threeBoughtAtomics ?? 0}, ${fields.priceUsd ?? null},
				 ${fields.slippageBps ?? null}, ${fields.buySignature ?? null})
			RETURNING id
		`;
		return row?.id ?? null;
	} catch (err) {
		log.warn('three_microbuy_record_failed', { status, message: err?.message });
		return null;
	}
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('three-buy', DEFAULT_PRICE_ATOMICS),
	networks: ['solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	async handler() {
		// Self-heal the ledger table so record() + the daily-cap DB fallback always
		// work, even on a fresh/behind database (best-effort — never blocks a buy).
		try { await ensureMicrobuySchema(); } catch { /* migration owns it in prod */ }

		// Gate: a scheduled/paid call is a recorded no-op — and the toll is refused —
		// until an operator funds the wallet and opts in.
		if (!isEnabled()) {
			await record('skipped', { reason: 'disabled' });
			throw refuseToll('engine disabled (set THREE_MICROBUY_ENABLED)');
		}
		const signer = await loadMicrobuySigner();
		if (!signer) {
			await record('skipped', { reason: 'not_configured' });
			throw refuseToll('signer not configured (set THREE_MICROBUY_SECRET_KEY_B64 or THREE_BUYBACK_SECRET_KEY_B64)');
		}

		// Cheap pre-check: refuse the toll before quoting Jupiter once the day's
		// budget is spent. The atomic reserve in executeMicrobuy is the real guard.
		if (!(await hasDailyBudget())) {
			await record('skipped', { reason: 'daily_cap_reached' });
			throw refuseToll('daily_cap_reached');
		}

		let plan;
		try {
			plan = await planMicrobuy(signer.publicKey.toBase58());
		} catch (err) {
			await record('failed', { reason: err.code || 'plan_failed' });
			throw refuseToll(`plan failed (${err.code || err.message})`);
		}
		if (!plan.ok) {
			await record('skipped', { reason: plan.reason });
			throw refuseToll(plan.reason);
		}

		let receipt;
		try {
			receipt = await executeMicrobuy(signer, plan);
		} catch (err) {
			// daily_cap_reached / swap_failed / tx_reverted all reclaim any reservation
			// inside executeMicrobuy and mean no buy went out → refuse the toll.
			await record('failed', {
				reason: err.code || 'execute_failed',
				usdcSpentAtomics: 0,
			});
			throw refuseToll(err.code || 'execute_failed');
		}

		// A buy broadcast (confirmed or in-flight) — the toll is earned; let the
		// wrapper settle it.
		await record(receipt.status, {
			usdcSpentAtomics: receipt.spendUsdcAtomics.toString(),
			threeBoughtAtomics: receipt.boughtAtomics.toString(),
			priceUsd: receipt.priceUsd,
			slippageBps: null,
			buySignature: receipt.buySignature,
		});

		return {
			ok: true,
			kind: 'three-buy',
			status: receipt.status,
			mint: TOKEN_MINT,
			buySignature: receipt.buySignature,
			spentUsd: usdcAtomicsToUsd(receipt.spendUsdcAtomics),
			boughtThree:
				receipt.boughtAtomics > 0n ? threeAtomicsToTokens(receipt.boughtAtomics) : null,
			priceUsd: receipt.priceUsd ?? null,
			boughtAt: new Date().toISOString(),
		};
	},
});
