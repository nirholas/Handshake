// GET /api/x402-ring — net-position report for the closed-loop agent economy.
//
// The honest scoreboard for the self-cycled x402 ring: how much gross volume the
// platform-controlled wallets moved through the platform's own endpoints, how
// many transactions that took, and — the number that actually matters — how much
// SOL the sponsor burned to do it. Because every wallet is ours, the principal
// recirculates; this report exists to prove at a glance that the only real cost
// is network fees, and that no money left three.ws.
//
//   GET /api/x402-ring                 — 24h window
//   GET /api/x402-ring?period=all      — lifetime
//   GET /api/x402-ring?period=7d
//
// Reads x402_self_facilitator_log (settlements + fees) and x402_ring_ledger
// (sweeps), plus live on-chain balances for the treasury / payer / sponsor. Every
// row is a real settled payment — if the ring is idle the report is honestly
// empty. This is internal/dogfooding volume and is labeled as such; it is NOT
// organic buyer revenue.

import { cors, error, json, method, wrap } from './_lib/http.js';
import { sql, isDbUnavailableError } from './_lib/db.js';
import { env } from './_lib/env.js';
import { PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { solanaConnection } from './_lib/solana/connection.js';
import { solPriceUsd } from './_lib/sol-price.js';
import { loadSeedKeypair, USDC_MINT } from './_lib/x402/pay.js';
import { SELF_FACILITATOR_ENABLED, SPONSOR_SOL_FLOOR_LAMPORTS } from './_lib/x402/self-facilitator.js';
import { validateRingConfig, warnIfRingRoutesExternal } from './_lib/x402/ring-config.js';

const PERIOD_HOURS = { '24h': 24, '7d': 168, '30d': 720 };
// 'all' is the documented lifetime window; every other key is a windowed report.
// An unrecognized value is rejected rather than quietly widened to lifetime: a
// typo (`?period=alll`) silently answering with an unbounded full-ledger scan is
// both a wrong answer and the most expensive query this endpoint can run.
export const PERIODS = [...Object.keys(PERIOD_HOURS), 'all'];

// Resolve ?period= to an ISO cutoff (or null for lifetime). Returned as a bound
// parameter — the Neon tagged template does NOT compose SQL fragments, so the
// window is a value, not injected SQL.
export function sinceFor(periodKey) {
	const hours = PERIOD_HOURS[periodKey];
	if (!hours) return null;
	return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function usdc(atomic) {
	if (atomic == null) return null;
	return Number(atomic) / 1e6;
}

function sol(lamports) {
	if (lamports == null) return null;
	return Number(lamports) / 1e9;
}

// Best-effort live SOL price for a USD figure on the burn — never blocks the
// report if the quote is unreachable.
//
// This used to be a single keyless GeckoTerminal read, so one throttled host
// silently dropped every USD figure off the ring report. api/_lib/sol-price.js
// already runs the same question across ten providers with a cooldown and a
// short TTL, which is both more reliable and cheaper than a per-request fetch.
async function solUsd() {
	const price = await solPriceUsd();
	return price > 0 ? price : null;
}

async function usdcBalance(conn, ownerB58) {
	if (!ownerB58 || !USDC_MINT) return null;
	try {
		const owner = new PublicKey(ownerB58);
		const mint = new PublicKey(USDC_MINT);
		const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const acc = await getAccount(conn, ata);
		return usdc(acc.amount);
	} catch {
		return 0;
	}
}

async function solBalance(conn, ownerB58) {
	if (!ownerB58) return null;
	try {
		return sol(await conn.getBalance(new PublicKey(ownerB58), 'confirmed'));
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	cors(req, res, { origins: '*', methods: 'GET,OPTIONS' });
	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.end();
		return;
	}
	if (!method(req, res, ['GET'])) return;

	const periodKey = String(req.query?.period || '24h').toLowerCase();
	if (!PERIODS.includes(periodKey)) {
		return error(res, 400, 'invalid_period', `period must be one of: ${PERIODS.join(', ')}`);
	}
	const since = sinceFor(periodKey); // ISO string, or null = lifetime

	let settlements = { count: 0, gross_usdc: 0, avg_call_usdc: null };
	let fees = { tx_count: 0, sol_burned_lamports: 0, sol_burned: 0, per_tx_avg_lamports: null, lamports_per_settlement: null, sol_per_100_usd: null };
	let sweeps = { count: 0, swept_usdc: 0 };
	let recent = [];
	let dbOk = true;

	try {
		const [s] = await sql`
			SELECT count(*)::int AS n,
			       COALESCE(sum(amount_atomic), 0)::bigint AS gross,
			       COALESCE(sum(fee_lamports), 0)::bigint AS fee
			FROM x402_self_facilitator_log
			WHERE action = 'settle' AND ok = true
			  AND (${since}::timestamptz IS NULL OR ts >= ${since}::timestamptz)
		`;
		settlements = {
			count: s.n,
			gross_usdc: usdc(s.gross),
			avg_call_usdc: s.n > 0 ? usdc(Number(s.gross) / s.n) : null,
		};
		// The two fee-efficiency numbers the "lowest fees always" rule is measured
		// on. lamports_per_settlement is the real SOL burned per settled payment
		// (~5,000 at the 1-signature self-pay floor); sol_per_100_usd normalizes
		// the burn against gross volume — the headline "cost of moving a dollar".
		const solBurned = sol(s.fee) || 0;
		const grossUsd = usdc(s.gross) || 0;
		fees = {
			tx_count: s.n,
			sol_burned_lamports: Number(s.fee),
			sol_burned: sol(s.fee),
			per_tx_avg_lamports: s.n > 0 ? Math.round(Number(s.fee) / s.n) : null,
			lamports_per_settlement: s.n > 0 ? Math.round(Number(s.fee) / s.n) : null,
			sol_per_100_usd: grossUsd > 0 ? Number(((solBurned / grossUsd) * 100).toFixed(9)) : null,
		};

		const [w] = await sql`
			SELECT count(*)::int AS n, COALESCE(sum(amount_atomic), 0)::bigint AS swept
			FROM x402_ring_ledger
			WHERE kind = 'sweep'
			  AND (${since}::timestamptz IS NULL OR ts >= ${since}::timestamptz)
		`;
		sweeps = { count: w.n, swept_usdc: usdc(w.swept) };

		recent = await sql`
			SELECT ts, payer, pay_to, amount_atomic, tx_sig, fee_lamports
			FROM x402_self_facilitator_log
			WHERE action = 'settle' AND ok = true
			ORDER BY ts DESC
			LIMIT 20
		`;
	} catch (err) {
		if (isDbUnavailableError(err)) {
			dbOk = false;
		} else {
			throw err;
		}
	}

	// Live balances (best-effort) prove the float is intact.
	const conn = solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	const treasuryAddr = env.X402_PAY_TO_SOLANA || null;
	const sponsorAddr = env.X402_FEE_PAYER_SOLANA || null;
	let payerAddr = null;
	try {
		payerAddr = loadSeedKeypair().publicKey.toBase58();
	} catch { /* payer key not configured in this env */ }

	const [treasuryUsdc, payerUsdc, sponsorSol, price] = await Promise.all([
		usdcBalance(conn, treasuryAddr),
		usdcBalance(conn, payerAddr),
		solBalance(conn, sponsorAddr),
		solUsd(),
	]);

	const ringFloat = (treasuryUsdc || 0) + (payerUsdc || 0);
	const burnedUsd = price != null ? Number((fees.sol_burned * price).toFixed(4)) : null;

	// Config truth. `config_warnings` lists every ring misconfiguration (external
	// routing, missing secrets, price>cap, self-pay off) so an operator sees at a
	// glance whether this deploy actually keeps settlement in-house. Emit the
	// once-per-boot external-routing warning here too, so a mis-enveloped deploy
	// logs it even before the first pipeline tick.
	warnIfRingRoutesExternal('x402-ring');
	const configWarnings = validateRingConfig();

	return json(res, 200, {
		ok: true,
		self_hosted_facilitator: SELF_FACILITATOR_ENABLED,
		config_warnings: configWarnings,
		internal: true,
		note: 'Self-cycled internal ring volume — dogfooding, not organic third-party demand.',
		period: since ? periodKey : 'all',
		db_available: dbOk,
		settlements,
		fees: { ...fees, sol_usd: price, burned_usd: burnedUsd },
		sweeps,
		wallets: {
			treasury: { address: treasuryAddr, usdc: treasuryUsdc },
			payer: { address: payerAddr, usdc: payerUsdc },
			sponsor: {
				address: sponsorAddr,
				sol: sponsorSol,
				floor_sol: sol(SPONSOR_SOL_FLOOR_LAMPORTS),
				below_floor: sponsorSol != null ? sponsorSol < sol(SPONSOR_SOL_FLOOR_LAMPORTS) : null,
			},
		},
		net: {
			ring_float_usdc: ringFloat,
			gross_volume_usdc: settlements.gross_usdc,
			real_cost_usdc: burnedUsd,
			note: 'Principal recirculates between platform wallets; real cost = SOL fees only.',
		},
		recent: recent.map((r) => ({
			ts: r.ts,
			payer: r.payer,
			pay_to: r.pay_to,
			usdc: usdc(r.amount_atomic),
			tx: r.tx_sig,
			fee_lamports: r.fee_lamports != null ? Number(r.fee_lamports) : null,
		})),
	});
});
