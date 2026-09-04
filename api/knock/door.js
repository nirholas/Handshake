// GET /api/knock/door?handle=<username>
//
// The public face of one person's door: what it costs to reach them, what they
// want you to know before you write, and which lane to use. Unauthenticated on
// purpose. This is the endpoint an agent reads before deciding whether a human
// is worth the money, and the one the /knock/<handle> page renders from.
//
// A handle that matches nobody and a handle whose owner keeps their door shut
// both answer 404 with the same body, so this cannot be used to enumerate
// accounts.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import { KNOCK_ESCROW_PROGRAM_ID, doorId, doorPda } from '../_lib/knock/escrow.js';
import { formatUsdc, normalizeHandle } from '../_lib/knock/policy.js';
import { publicDoorByHandle } from '../_lib/knock/store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.knockPublic(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const handle = normalizeHandle(params.get('handle'));
	if (!handle) return error(res, 400, 'bad_handle', 'pass ?handle=<username>');

	const door = await publicDoorByHandle(handle);
	if (!door) return error(res, 404, 'no_door', 'no open door for that handle');

	return json(res, 200, { door: publicShape(door) }, { 'cache-control': 'public, max-age=30' });
});

/**
 * The stranger-visible door. Exported so the page renderer and the SDK's
 * fixtures agree on one shape, and so a payout address can never be added to
 * it by accident: this function names every field that ships.
 */
export function publicShape(row) {
	const priceAtomics = String(row.price_atomics ?? '0');
	const free = priceAtomics === '0';
	return {
		handle: row.username,
		display_name: row.display_name || row.username,
		avatar_url: row.avatar_url || null,
		verified: row.verified_type || null,
		open: Boolean(row.open),
		free,
		price_atomics: priceAtomics,
		price: formatUsdc(priceAtomics),
		currency: 'USDC',
		networks: free ? [] : networksFor(row),
		headline: row.headline || null,
		greeting: row.greeting || null,
		max_chars: Number(row.max_chars ?? 600),
		// The lane a caller should use. Free doors take a plain POST; priced
		// doors answer 402 first and settle before the message is accepted.
		endpoint: free ? `${env.APP_ORIGIN}/api/knock/send` : `${env.APP_ORIGIN}/api/x402/knock?to=${encodeURIComponent(row.username)}`,
		protocol: free ? 'http' : 'x402',
		// The escrowed lane, advertised only when this door takes it. A caller
		// that cannot escrow ignores the field and uses `endpoint` as before;
		// one that can now knows the option exists without a second request,
		// which is the difference between a lane nobody discovers and a lane
		// agents actually use.
		escrow: escrowShape(row),
	};
}

/**
 * What a stranger needs to know to knock with escrow, or null when this door
 * does not take it.
 *
 * `window_hours` is what the owner is promising to answer within, and the
 * guarantee line says what happens if they do not, because that promise is the
 * entire reason to pick this lane over paying up front.
 */
function escrowShape(row) {
	if (!row.escrow_enabled || !row.escrow_owner) return null;
	return {
		endpoint: `${env.APP_ORIGIN}/api/knock/escrowed`,
		program: KNOCK_ESCROW_PROGRAM_ID,
		network: 'solana',
		// The door's on-chain address. A sender needs it to escrow, and reading
		// the account at it tells them the price, the mint and the window the
		// PROGRAM will enforce, which is the only version of those numbers that
		// can take their money. The owner's own address is not shipped here;
		// this is derived from it, and the account it names carries whatever
		// the owner chose to publish on-chain.
		door: doorPda(row.escrow_owner, doorId(row.username)).toBase58(),
		window_hours: Number(row.escrow_window_hours ?? 24),
		guarantee:
			'Your payment is held on-chain and pays out only if this door answers you. If it refuses, or the window closes, every unit comes back to you and anyone can trigger that refund.',
	};
}

// Solana leads because it is the home chain and the settle path we run
// ourselves. Base is advertised only when the owner set an address for it.
function networksFor(row) {
	const nets = [];
	if (row.has_solana_payout) nets.push('solana');
	if (row.has_base_payout) nets.push('base');
	return nets.length ? nets : ['solana'];
}
