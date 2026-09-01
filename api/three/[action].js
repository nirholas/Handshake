// $THREE pay-per-use rail — the canonical HTTP surface every paid compute action
// charges through. One endpoint, one currency.
//
//   GET  /api/three/catalog   — public price list (display)
//   POST /api/three/charge    — issue a $THREE quote, or settle a paid one (auth)
//   GET  /api/three/tier      : the caller's $THREE tier + perks + the public ladder
//                               (session, ?wallet=, or the anonymous Member floor)
//   POST /api/three/tier-pass — mint a signed tier pass for world gating (auth)
//   GET  /api/three/earnings  — creator's settled $THREE earnings ledger (auth)
//   GET  /api/three/name-quote?name=… — rarity + $THREE floor price for a name
//
// The charge → settle handshake reuses api/_lib/pricing/charge-three.js, which
// wraps the token rail (quote → on-chain verify → settle). No action burns; every
// spend routes to treasury + the holder-rewards pool per its split policy.
//
// Lever-1 surfaces (Forge standard/high, voice clone, MCP-3D tools, Granite,
// selfie→avatar) are all catalog actions, so they charge through this one path.
// The always-free lanes (NVIDIA draft, free LLM chat, discovery, social) are on
// the free-forever allowlist and never reach here.

import { z } from 'zod';
import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { publicCatalog, catalogEntry } from '../_lib/pricing/catalog.js';
import { requireThreePayment } from '../_lib/pricing/charge-three.js';
import {
	holderDiscountBps,
	resolveUserTier,
	signTierPass,
	tierForUsd,
	nextTier,
	holderUsd,
	TIERS,
} from '../_lib/three-tier.js';
import { accessFromTierLevel, listGatedFeatures } from '../_lib/three-access.js';
import { isCompedUser, COMP_TIER } from '../_lib/comp-access.js';
import { verifySiwsSignature } from '../_lib/siws.js';
import { creatorEarnings, economyStats, listRewardsDistributions } from '../_lib/token/index.js';
import { priceName, isValidLabel, RARITY_TIERS } from '../_lib/pricing/name-rarity.js';
import { quoteTokenForUsd } from '../_lib/token/price.js';
import { publicConfig, TOKEN_MINT, ATOMICS_PER_TOKEN } from '../_lib/token/config.js';
import { getBalances } from '../_lib/balances.js';

// Live on-chain $THREE balance (atomics) of a platform wallet, for verifiable
// stats. Returns 0n on any failure — a balance hiccup must never 500 the public
// dashboard. The explorer link lets anyone confirm the figure themselves.
async function liveWalletAtomics(address) {
	if (!address) return 0n;
	try {
		const balances = await getBalances({ chain: 'solana', address });
		const entry = (balances?.tokens ?? []).find((t) => t.mint === TOKEN_MINT);
		return BigInt(Math.floor((entry?.amount || 0) * Number(ATOMICS_PER_TOKEN)));
	} catch {
		return 0n;
	}
}
const solscan = (addr) => (addr ? `https://solscan.io/account/${addr}` : null);

const SOLANA_ADDRESS = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid Solana address');

// Build the full /tier response from a resolved tier. Shared by the authed
// (session user) path and the public (?wallet=) path so both return one shape.
function tierPayload({ tier, usd, amount, priceUsd, next, wallet = null, source }) {
	return {
		tier: {
			level: tier.level,
			id: tier.id,
			label: tier.label,
			discount_bps: tier.discountBps,
			perks: tier.perks,
		},
		held_usd: usd,
		held_amount: amount,
		price_usd: priceUsd,
		...(wallet ? { wallet } : {}),
		...(source ? { source } : {}),
		next: next
			? { id: next.id, label: next.label, min_usd: next.minUsd, usd_to_go: Math.max(0, next.minUsd - usd) }
			: null,
		// The full ladder so the UI can render thresholds and what each tier unlocks.
		ladder: TIERS.map((t) => ({
			level: t.level,
			id: t.id,
			label: t.label,
			min_usd: t.minUsd,
			discount_bps: t.discountBps,
			rate_multiplier: t.rateMultiplier,
			perks: t.perks,
		})),
	};
}

// Resolve a tier publicly from a raw wallet's on-chain $THREE (no auth). Never
// throws — holderUsd() degrades to zero held → Member tier on any RPC/price hiccup.
async function resolveWalletTier(wallet) {
	const { usd, amount, priceUsd } = await holderUsd(wallet);
	const tier = tierForUsd(usd);
	return { tier, usd, amount, priceUsd, next: nextTier(tier) };
}

// The canonical message a wallet signs to mint a tier pass without an account.
// Kept byte-identical to the client builder (src/three/holder.js). We validate
// it server-side: it must name our domain, bind to the wallet, and be fresh —
// which blocks replay of an old capture and minting a pass for someone else's bag.
const TIER_PASS_MESSAGE_MAX = 1000;
const TIER_PASS_FRESH_MS = 5 * 60 * 1000; // accept signatures issued in the last 5 min
const TIER_PASS_SKEW_MS = 60 * 1000; // tolerate up to 60s of client clock skew ahead

/** Returns an error code string when the signed message is unacceptable, else null. */
function checkTierPassMessage(message, wallet) {
	if (typeof message !== 'string' || message.length === 0 || message.length > TIER_PASS_MESSAGE_MAX) {
		return 'malformed_message';
	}
	if (!message.includes('three.ws')) return 'malformed_message';
	if (!message.includes(wallet)) return 'wallet_mismatch';
	const m = /Issued At:\s*([^\n]+)/.exec(message);
	if (!m) return 'malformed_message';
	const ts = Date.parse(m[1].trim());
	if (!Number.isFinite(ts)) return 'malformed_message';
	const age = Date.now() - ts;
	if (age > TIER_PASS_FRESH_MS || age < -TIER_PASS_SKEW_MS) return 'stale_message';
	return null;
}

// ── GET /api/three/catalog ─────────────────────────────────────────────────────

async function handleCatalog(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.tokenPriceIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	return json(res, 200, { actions: publicCatalog() });
}

// ── POST /api/three/charge ───────────────────────────────────────────────────────

const chargeSchema = z.object({
	action: z.string().min(1).max(64),
	// Per-call price for variable actions (auctions, marketplace listings). Ignored
	// for fixed-price catalog actions.
	usd: z.number().positive().optional(),
	seller_wallet: SOLANA_ADDRESS.optional(),
	ref_type: z.string().max(64).optional(),
	ref_id: z.string().max(128).optional(),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	// Present together to SETTLE a previously-issued quote.
	quote_token: z.string().min(40).optional(),
	tx_signature: z.string().min(80).max(100).optional(),
	payer_wallet: SOLANA_ADDRESS.optional(),
});

async function handleCharge(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const body = parse(chargeSchema, await readJson(req));
	const settling = Boolean(body.quote_token && body.tx_signature);

	// Reuse the token-rail limiters: settle is the money-moving, on-chain-verifying
	// call (tight, fail-closed); charge issues a signed quote (slightly looser).
	const rl = settling ? await limits.tokenSettle(user.id) : await limits.tokenQuote(user.id);
	if (!rl.success) return rateLimited(res, rl);

	// Holder-tier fee discount (Lever 2): higher $THREE holders pay less on
	// fixed-price compute. Resolved from the user's on-chain balance; degrades to
	// no discount (full price) if the balance can't be priced — never blocks a charge.
	const discountBps = settling ? 0 : await holderDiscountBps(user);

	const result = await requireThreePayment({
		action: body.action,
		user,
		usd: body.usd,
		discountBps,
		sellerWallet: body.seller_wallet ?? null,
		refType: body.ref_type ?? null,
		refId: body.ref_id ?? null,
		network: body.network,
		settle: settling
			? {
					quoteToken: body.quote_token,
					txSignature: body.tx_signature,
					payerWallet: body.payer_wallet ?? user.wallet_address ?? null,
				}
			: null,
	});

	return json(res, result.paid ? 200 : 201, result);
}

// ── GET /api/three/tier ────────────────────────────────────────────────────────

async function handleTier(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	// Public path: ?wallet=<addr> resolves a connected wallet's tier with no
	// account — the common case (a visitor connects Phantom but isn't signed in).
	const walletParam = (new URL(req.url, 'http://x').searchParams.get('wallet') || '').trim();
	if (walletParam) {
		const valid = SOLANA_ADDRESS.safeParse(walletParam);
		if (!valid.success) {
			return error(res, 400, 'invalid_wallet', 'wallet must be a valid Solana address');
		}
		const rl = await limits.tokenPriceIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		const resolved = await resolveWalletTier(walletParam);
		return json(res, 200, tierPayload({ ...resolved, wallet: walletParam, source: 'wallet' }), {
			'cache-control': 'public, max-age=20, s-maxage=20, stale-while-revalidate=60',
		});
	}

	// Authed path: the signed-in user's linked wallet (also carries the discount).
	const user = await getSessionUser(req, res);
	if (!user) {
		// No identity at all. The ladder itself is public information and the /three
		// page draws it for every first-time visitor, so answer with the Member floor
		// (nothing held, Bronze next) instead of a 401 that renders as an outage.
		// Not CDN-cacheable: the same URL answers signed-in sessions with their own tier.
		const rl = await limits.tokenPriceIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		const floor = TIERS[0];
		return json(res, 200, {
			signed_in: false,
			wallet_linked: false,
			...tierPayload({ tier: floor, usd: 0, amount: 0, priceUsd: null, next: nextTier(floor), source: 'public' }),
		});
	}

	const resolved = await resolveUserTier(user);
	return json(res, 200, {
		signed_in: true,
		wallet_linked: Boolean(user.wallet_address),
		...tierPayload({ ...resolved, source: 'session' }),
	});
}

// ── POST /api/three/tier-pass ─────────────────────────────────────────────────────

async function handleTierPass(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const body = (await readJson(req).catch(() => ({}))) || {};

	// ── Signature path (no account): a connected wallet proves ownership by signing
	// a fresh, domain-bound message. The tier is resolved from real on-chain holdings
	// of that wallet, so the pass can only ever reflect what the wallet actually holds.
	if (body.wallet || body.signature || body.message) {
		const valid = SOLANA_ADDRESS.safeParse(String(body.wallet || ''));
		if (!valid.success) {
			return error(res, 400, 'invalid_wallet', 'wallet must be a valid Solana address');
		}
		const wallet = valid.data;
		// Key the limiter by wallet so one wallet can't grind passes; tokenQuote is the
		// existing "issue a signed artifact" bucket.
		const rl = await limits.tokenQuote(wallet);
		if (!rl.success) return rateLimited(res, rl);

		const msgErr = checkTierPassMessage(body.message, wallet);
		if (msgErr) {
			return error(
				res,
				401,
				msgErr,
				msgErr === 'stale_message'
					? 'signed message is expired — sign again'
					: 'signed message is malformed or not bound to this wallet',
			);
		}
		let ok = false;
		try {
			ok = verifySiwsSignature(String(body.message), String(body.signature || ''), wallet);
		} catch {
			ok = false;
		}
		if (!ok) return error(res, 401, 'bad_signature', 'signature does not match the wallet');

		const { tier, usd } = await resolveWalletTier(wallet);
		const pass = signTierPass({ wallet, level: tier.level, tierId: tier.id, usd });
		return json(res, 201, {
			pass,
			tier: { level: tier.level, id: tier.id, label: tier.label },
			held_usd: usd,
		});
	}

	// ── Session path: a signed-in user with a linked wallet.
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in, or POST { wallet, message, signature }');
	if (!user.wallet_address) {
		return error(res, 403, 'wallet_required', 'link a Solana wallet to mint a tier pass');
	}

	const { tier, usd } = await resolveUserTier(user);
	const pass = signTierPass({ wallet: user.wallet_address, level: tier.level, tierId: tier.id, usd });
	return json(res, 201, {
		pass,
		tier: { level: tier.level, id: tier.id, label: tier.label },
		held_usd: usd,
	});
}

// ── GET /api/three/earnings ────────────────────────────────────────────────────

async function handleEarnings(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const user = await getSessionUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	if (!user.wallet_address) {
		return json(res, 200, { total_atomics: '0', sale_count: 0, mint: null, decimals: null, items: [], next_cursor: null });
	}
	const url = new URL(req.url, 'http://x');
	// `before` is a page cursor echoed back from `next_cursor` (a timestamptz). A
	// value that is not a timestamp reaches Postgres as a bad cast, so it is
	// rejected here as the 400 it is rather than surfacing as a 5xx.
	const before = (url.searchParams.get('before') || '').trim();
	if (before && !Number.isFinite(Date.parse(before))) {
		return error(res, 400, 'invalid_cursor', 'before must be an ISO 8601 timestamp from next_cursor');
	}
	const page = await creatorEarnings({
		sellerWallet: user.wallet_address,
		limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200),
		before: before || null,
	});
	return json(res, 200, page);
}

// ── GET /api/three/name-quote ──────────────────────────────────────────────────

async function handleNameQuote(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.tokenPriceIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const name = url.searchParams.get('name') || '';
	if (!isValidLabel(name)) {
		return error(res, 400, 'invalid_label', 'name must be a valid SNS label (a-z, 0-9, hyphen)');
	}
	const priced = priceName(name);
	// Common names are free; only quote $THREE for paid (rare) names.
	let three = null;
	if (!priced.free) {
		const q = await quoteTokenForUsd(priced.usd);
		three = { token_amount: q.tokenAmount, atomics: q.atomics.toString(), price_usd: q.priceUsd ?? null };
	}
	return json(res, 200, {
		...priced,
		full_name: `${priced.label}.threews.sol`,
		three,
		// The full rarity ladder so the UI can show where this name sits.
		ladder: RARITY_TIERS,
	});
}

// ── GET /api/three/stats ───────────────────────────────────────────────────────
// Public, VERIFIABLE economy dashboard data. Beyond settled volume + the per-role
// flow, it surfaces the LIVE on-chain balances of the treasury and rewards wallets
// with Solscan links, plus the real reflected-to-holders history. "Don't trust,
// verify" — every headline number traces to an address anyone can inspect.

// Ten years of ledger. Beyond this a Postgres interval overflows, so a caller
// asking for "everything" is clamped here instead of being handed a 5xx.
const MAX_SINCE_DAYS = 3650;

async function handleStats(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.tokenPriceIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	// `since_days` windows the aggregates. A non-numeric value used to reach
	// Postgres as the interval `NaN days` and surface as a 5xx, so it is rejected
	// here; a real number is clamped into range the same way `earnings` clamps its
	// limit. An empty value means no window, exactly like omitting the param.
	const rawSince = (url.searchParams.get('since_days') || '').trim();
	let sinceDays = null;
	if (rawSince) {
		const n = Number(rawSince);
		if (!Number.isFinite(n)) {
			return error(res, 400, 'invalid_since_days', 'since_days must be a number of days');
		}
		sinceDays = Math.min(Math.max(Math.floor(n), 1), MAX_SINCE_DAYS);
	}
	const cfg = publicConfig();

	// Fan out the independent reads concurrently: ledger aggregates, live wallet
	// balances, and the distribution history. Each degrades independently.
	const [stats, treasuryAtomics, rewardsAtomics, distributions] = await Promise.all([
		economyStats({ sinceDays }),
		liveWalletAtomics(cfg.treasury),
		liveWalletAtomics(cfg.rewards_wallet),
		listRewardsDistributions({ limit: 10 }).catch(() => ({
			total_reflected_atomics: '0',
			run_count: 0,
			items: [],
		})),
	]);

	return json(res, 200, {
		...stats,
		token: { mint: cfg.mint, symbol: cfg.symbol, decimals: cfg.decimals },
		// Verifiable on-chain state: live balances + the addresses + explorer links.
		// This is the answer to a competitor's "trust us, we burned some" — here are
		// the wallets; check them yourself.
		onchain: {
			treasury: {
				address: cfg.treasury,
				configured: cfg.treasury_configured,
				balance_atomics: treasuryAtomics.toString(),
				explorer: solscan(cfg.treasury),
			},
			rewards_pool: {
				address: cfg.rewards_wallet,
				configured: cfg.rewards_configured,
				balance_atomics: rewardsAtomics.toString(),
				explorer: solscan(cfg.rewards_wallet),
			},
			mint_explorer: solscan(cfg.mint),
		},
		// Real reflections, not a burn counter: cumulative $THREE returned to holders
		// across completed distribution runs, with recent run history.
		reflected: {
			total_atomics: distributions.total_reflected_atomics,
			run_count: distributions.run_count,
			recent: distributions.items,
		},
		// The platform never burns supply. Stated plainly in the public data.
		burns: false,
	});
}

// ── GET /api/three/access ──────────────────────────────────────────────────────
// The hold-to-access read the UI consumes. Resolves the caller's $THREE tier ONCE
// and answers, per gated feature, whether they're entitled — plus the exact reason
// (sign in / link wallet / hold more) and the pay-per-use price when a non-holder
// can pay instead. Auth is OPTIONAL: anonymous callers get the Member view so the
// page can render the locked state and a "Get $THREE" path without forcing sign-in.

async function handleAccess(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.tokenPriceIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const walletParam = (url.searchParams.get('wallet') || '').trim();
	if (walletParam && !SOLANA_ADDRESS.safeParse(walletParam).success) {
		return error(res, 400, 'invalid_wallet', 'wallet must be a valid Solana address');
	}

	const user = await getSessionUser(req, res);
	// Identity precedence: an explicit ?wallet= (a connected, account-less visitor)
	// wins over the session's linked wallet so the page reflects the wallet in hand.
	const walletMode = Boolean(walletParam);
	const hasWallet = walletMode || Boolean(user?.wallet_address);

	// A comped account (api/_lib/comp-access.js) is entitled to every gated feature
	// with no wallet, no holding, and no payment. Read here as well as in the
	// enforcement path (require-three.js) so the UI renders those features unlocked
	// instead of showing a lock the server would not actually enforce. It is keyed on
	// the SESSION, so it holds in wallet mode too: a comped user who happens to have
	// a wallet connected must not see a lock the API would let straight through.
	const comped = isCompedUser(user);

	// One tier resolution for the whole request; every feature check below is then a
	// pure level comparison (no extra on-chain reads). Degrades to Member on failure.
	let tier = TIERS[0];
	let usd = 0;
	if (hasWallet) {
		try {
			const r = walletMode ? await resolveWalletTier(walletParam) : await resolveUserTier(user);
			tier = r.tier;
			usd = r.usd;
		} catch {
			tier = TIERS[0];
			usd = 0;
		}
	}
	const heldUsd = Math.round((Number(usd) || 0) * 100) / 100;
	// The level entitlement is checked against. A comp lifts it to the top of the
	// ladder without touching the tier/held figures above, so the badge keeps
	// reporting what the wallet really holds while the features read as unlocked.
	const accessLevel = comped ? Math.max(tier.level, COMP_TIER.level) : tier.level;

	// Attach the catalog price to a pay-per-use action (null for variable-price ones).
	const payInfo = (actionId) => {
		if (!actionId) return null;
		let priceUsd = null;
		try {
			priceUsd = catalogEntry(actionId).usd ?? null;
		} catch {
			priceUsd = null;
		}
		return { action: actionId, usd: priceUsd };
	};
	// Turn a pure level-check into the full UI payload: real held USD + the precise
	// reason for the lock (the pure check only knows eligible/insufficient).
	const decorate = (a) => ({
		...a,
		held: { ...a.held, usd: heldUsd },
		// In wallet mode the wallet is in hand, so a lock is always "hold more" —
		// never "sign in" / "link a wallet" (those are session-only prompts).
		reason: a.eligible
			? 'eligible'
			: walletMode
				? 'insufficient_tier'
				: !user
					? 'sign_in'
					: !hasWallet
						? 'link_wallet'
						: 'insufficient_tier',
		pay_per_use: payInfo(a.pay_per_use),
	});

	// `comped` tells the UI the entitlement came from the allowlist, not a holding,
	// so it can show "Included" instead of a held-USD figure that would read as wrong.
	const tierSummary = { level: tier.level, id: tier.id, label: tier.label, held_usd: heldUsd, comped };
	const feature = url.searchParams.get('feature');

	if (feature) {
		let access;
		try {
			access = accessFromTierLevel(accessLevel, feature);
		} catch (e) {
			if (e.code === 'unknown_feature') {
				return error(res, 404, 'unknown_feature', `unknown gated feature: ${feature}`);
			}
			throw e;
		}
		return json(res, 200, {
			signed_in: Boolean(user),
			wallet_linked: hasWallet,
			tier: tierSummary,
			access: decorate(access),
		});
	}

	const features = listGatedFeatures().map((id) => decorate(accessFromTierLevel(accessLevel, id)));
	return json(res, 200, {
		signed_in: Boolean(user),
		wallet_linked: hasWallet,
		tier: tierSummary,
		features,
	});
}

// ── dispatcher ────────────────────────────────────────────────────────────────────

const DISPATCH = {
	catalog: handleCatalog,
	charge: handleCharge,
	tier: handleTier,
	'tier-pass': handleTierPass,
	access: handleAccess,
	earnings: handleEarnings,
	'name-quote': handleNameQuote,
	stats: handleStats,
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown three action: ${action}`);
	return fn(req, res);
});
