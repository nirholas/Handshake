// GET /api/x402/club-cover
//
// Paid endpoint cataloged by the CDP x402 Bazaar — the cover charge at the
// door of the three.ws Pole Club. For $0.01 USDC the caller pays their way in.
// Once the payment settles, the bouncer runs an on-chain check: the payer's
// wallet is looked up against the club ban list (club_bans) and their prior
// club activity (club_tips) is read to assign a door tier (newcomer / regular
// / vip). A banned wallet is turned away (admitted=false); everyone else gets
// an entry pass the /club door consumes to drop the velvet rope.
//
// The wallet identity is proven on-chain by the x402 settlement itself — you
// can only get an `admitted` response by signing a real USDC payment from the
// wallet being vetted. No tip, no entry.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import {
	issueCoverPass,
	PASS_TTL_SEC,
	normalizeWallet,
	findBan,
	visitsFor,
	tierFor,
	membershipSnapshot,
} from '../_lib/club/cover-pass.js';
import { coverRevenueSummary } from '../_lib/club/cover-revenue.js';
import clubCoverListing from '../_lib/service-catalog/services/club-cover.js';

const ROUTE = '/api/x402/club-cover';

// PASS_TTL_SEC + the bouncer (ban/tier/pass) live in ../_lib/club/cover-pass.js
// so the USDC door here and the $THREE door (api/club/cover-three.js) issue an
// identical pass.

// Single source of truth: api/_lib/service-catalog/services/club-cover.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
const DESCRIPTION = clubCoverListing.description;

const INPUT_EXAMPLE = {};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	admitted: true,
	banned: false,
	tier: 'regular',
	visits: 4,
	passId: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
	issuedAt: '2026-06-15T18:42:09.000Z',
	expiresAt: '2026-06-16T00:42:09.000Z',
	payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	network: 'solana',
	amountAtomics: '10000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'admitted', 'banned', 'tier', 'passId', 'issuedAt', 'expiresAt'],
	properties: {
		ok: { type: 'boolean', const: true },
		admitted: { type: 'boolean', description: 'true when the wallet may enter; false when banned.' },
		banned: { type: 'boolean' },
		reason: { type: ['string', 'null'], description: 'Bouncer note when turned away.' },
		tier: {
			type: 'string',
			enum: ['newcomer', 'regular', 'vip', 'banned'],
			description: 'Door tier from prior on-chain club activity.',
		},
		visits: { type: 'integer', minimum: 0, description: 'Settled club tips previously paid by this wallet.' },
		passId: { type: 'string', format: 'uuid' },
		issuedAt: { type: 'string', format: 'date-time' },
		expiresAt: { type: 'string', format: 'date-time' },
		payer: { type: ['string', 'null'] },
		network: { type: ['string', 'null'] },
		amountAtomics: { type: ['string', 'null'] },
		asset: { type: ['string', 'null'] },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// normalizeWallet / findBan / visitsFor / tierFor live in
// ../_lib/club/cover-pass.js so the USDC door here and the $THREE door share
// one bouncer (and one DB-backed ban/tier lookup). Imported above.

export const BAZAAR_SCHEMA = BAZAAR;

const doorEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('club-cover', '10000'), // $0.01 USDC
	networks: ['solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Club Door',
		tags: ['3d', 'club', 'cover', 'entry', 'reputation', 'entertainment'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	siwx: {
		statement: 'Sign in to re-enter the club you already paid cover for tonight.',
		// Once a wallet has paid cover, it can re-enter for free for the pass
		// lifetime — the bouncer still re-runs the ban check on every call, so a
		// wallet banned after paying is turned away on its next re-entry.
		ttlSeconds: PASS_TTL_SEC,
		expirationSeconds: 300,
	},
	async handler({ requirement, payer, bypass }) {
		const wallet = normalizeWallet(payer ?? bypass?.callerId ?? '');
		const now = new Date();

		const ban = await findBan(wallet);
		if (ban) {
			// Turned away at the door. The cover already settled on-chain — you
			// don't get a refund for being on the list — but no pass is issued.
			return {
				ok: true,
				admitted: false,
				banned: true,
				reason: ban.reason || 'Not on the list tonight.',
				tier: 'banned',
				visits: 0,
				passId: crypto.randomUUID(),
				issuedAt: now.toISOString(),
				expiresAt: now.toISOString(),
				payer: payer ?? (bypass ? bypass.callerId : null),
				network: requirement?.network ?? null,
				amountAtomics: requirement?.amount ?? null,
				asset: requirement?.asset ?? null,
			};
		}

		const visits = await visitsFor(wallet);
		const expires = new Date(now.getTime() + PASS_TTL_SEC * 1000);

		return {
			ok: true,
			admitted: true,
			banned: false,
			reason: null,
			tier: tierFor(visits),
			visits,
			passId: crypto.randomUUID(),
			issuedAt: now.toISOString(),
			expiresAt: expires.toISOString(),
			payer: payer ?? (bypass ? bypass.callerId : null),
			network: requirement?.network ?? null,
			amountAtomics: requirement?.amount ?? null,
			asset: requirement?.asset ?? null,
			...(bypass ? { bypass: bypass.reason } : {}),
		};
	},
});

// ── Membership Snapshot (POST) ──────────────────────────────────────────────
//
// The same $0.01 cover charge, but instead of issuing a door pass it sells a
// growth/churn snapshot of the club's membership. Pay, and you get back the
// live member counts read off the club ledger:
//   { member_count, active_last_7d, new_this_week } plus a classified signal
//   (growing / stable / churning / empty) and a headline.
//
// This is the read the x402 autonomous loop pays daily to monitor the
// three_holders club for growth or churn (registry: club-membership-snapshot).
// POST body: { club?: string (default "three_holders"), mode?: "snapshot" }.

const SNAPSHOT_INPUT_EXAMPLE = { club: 'three_holders', mode: 'snapshot' };

const SNAPSHOT_INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		club: { type: 'string', description: 'Club label to snapshot.', default: 'three_holders' },
		mode: { type: 'string', enum: ['snapshot'], default: 'snapshot' },
	},
};

const SNAPSHOT_OUTPUT_EXAMPLE = {
	ok: true,
	club: 'three_holders',
	mode: 'snapshot',
	member_count: 128,
	active_last_7d: 34,
	new_this_week: 9,
	growth_rate: 0.0703,
	active_rate: 0.2656,
	signal: 'growing',
	headline: 'Club growing — 9 new members this week (7% of the base).',
	confidence: 0.95,
	snapshot_at: '2026-06-28T18:42:09.000Z',
	payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	network: 'solana',
	amountAtomics: '10000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const SNAPSHOT_OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'club', 'mode', 'member_count', 'active_last_7d', 'new_this_week', 'signal'],
	properties: {
		ok: { type: 'boolean', const: true },
		club: { type: 'string' },
		mode: { type: 'string', const: 'snapshot' },
		member_count: { type: 'integer', minimum: 0, description: 'Distinct wallets that ever paid into the club.' },
		active_last_7d: { type: 'integer', minimum: 0, description: 'Distinct wallets active in the last 7 days.' },
		new_this_week: { type: 'integer', minimum: 0, description: 'Distinct wallets whose first payment landed in the last 7 days.' },
		growth_rate: { type: 'number', description: 'new_this_week / member_count.' },
		active_rate: { type: 'number', description: 'active_last_7d / member_count.' },
		signal: { type: 'string', enum: ['growing', 'stable', 'churning', 'empty'] },
		headline: { type: 'string' },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		snapshot_at: { type: 'string', format: 'date-time' },
		payer: { type: ['string', 'null'] },
		network: { type: ['string', 'null'] },
		amountAtomics: { type: ['string', 'null'] },
		asset: { type: ['string', 'null'] },
	},
};

const SNAPSHOT_BAZAAR = {
	// Not separately discoverable — the GET door is the catalog entry for this
	// route; the POST snapshot is the same resource sold a second way, so it
	// must not register a duplicate route in the bazaar census.
	discoverable: false,
	info: {
		input: { type: 'json', method: 'POST', example: SNAPSHOT_INPUT_EXAMPLE },
		output: { type: 'json', example: SNAPSHOT_OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: SNAPSHOT_INPUT_SCHEMA,
		outputSchema: SNAPSHOT_OUTPUT_SCHEMA,
	}),
};

const snapshotEndpoint = paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('club-cover', '10000'), // $0.01 USDC — same cover charge
	networks: ['solana'],
	description:
		'three.ws Pole Club — pay $0.01 USDC for a live membership snapshot of the ' +
		'club: all-time member count, members active in the last 7 days, and members ' +
		'new this week, with a growth/churn signal. Pay-per-call in USDC on Solana mainnet.',
	bazaar: SNAPSHOT_BAZAAR,
	service: withService({
		serviceName: 'three.ws Club Membership',
		tags: ['3d', 'club', 'membership', 'analytics', 'growth', 'reputation'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req, requirement, payer, bypass }) {
		let mode = 'snapshot';
		let club = 'three_holders';
		let period = '7d';
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const raw = Buffer.concat(chunks).toString('utf8');
			if (raw) {
				const body = JSON.parse(raw);
				if (body && typeof body.mode === 'string') {
					mode = body.mode.trim().toLowerCase().slice(0, 32);
				}
				if (body && typeof body.club === 'string' && body.club.trim()) {
					club = body.club.trim().slice(0, 64);
				}
				if (body && typeof body.period === 'string' && body.period.trim()) {
					period = body.period.trim().slice(0, 8);
				}
			}
		} catch {
			/* default mode/club — a malformed body snapshots the default ledger */
		}

		const meta = {
			payer: payer ?? (bypass ? bypass.callerId : null),
			network: requirement?.network ?? null,
			amountAtomics: requirement?.amount ?? null,
			asset: requirement?.asset ?? null,
			...(bypass ? { bypass: bypass.reason } : {}),
		};

		// mode:"revenue" — 7-day cover-charge + floor revenue summary.
		// The autonomous loop pays this mode to monitor social-economy health.
		if (mode === 'revenue') {
			// Throws 503 on a ledger error → no settlement, caller not charged.
			const summary = await coverRevenueSummary({ period });
			return { ...summary, ...meta };
		}

		// Default: mode:"snapshot" (membership growth/churn).
		const snap = await membershipSnapshot(club);
		return {
			ok: true,
			mode: 'snapshot',
			...snap,
			snapshot_at: new Date().toISOString(),
			...meta,
		};
	},
});

// One route, two methods. paidEndpoint is single-method, so we dispatch here:
// GET/HEAD → the door pass (unchanged), POST → the membership snapshot. An
// OPTIONS preflight is routed to whichever endpoint matches the requested
// method so the CORS allow-list advertises the right verb.
export default function clubCover(req, res) {
	const method = String(req.method || '').toUpperCase();
	if (method === 'POST') return snapshotEndpoint(req, res);
	if (method === 'OPTIONS') {
		const want = String(req.headers['access-control-request-method'] || '').toUpperCase();
		if (want === 'POST') return snapshotEndpoint(req, res);
	}
	return doorEndpoint(req, res);
}
