/**
 * GET /api/cosmetics/catalog — the avatar cosmetics shop catalog (R21).
 *
 * Returns every shop item with its shop fields (id, name, slot, rarity, price,
 * previewImage, owned/locked) and the rig payload the live preview needs. The
 * base accessory pack is owned/free; premium emotes + skins are locked until
 * purchased over the R22 x402 USDC rail. The item's value is quoted in $THREE
 * (`price`/`currency`); checkout charges USDC (`priceUsdc`/`priceUsdcAtomics`).
 *
 * Query params:
 *   rarity=common|rare|epic|legendary  — optional filter to one tier.
 *   account=<wallet|guest id>          — optional; when present, premium items
 *                                        this account has purchased read as owned.
 */

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { buildCatalog, RARITIES } from '../_lib/cosmetics.js';
import { readOwnedCosmetics, normalizeAccountId } from '../_lib/cosmetics-ownership.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const rarity = url.searchParams.get('rarity');
	if (rarity && !RARITIES.includes(rarity)) {
		return error(res, 400, 'bad_rarity', `rarity must be one of: ${RARITIES.join(', ')}`);
	}

	// When the caller identifies an account, fold in the cosmetics it has bought
	// over the R22 x402 rail so premium items it owns render as owned, not locked.
	// Anonymous callers (no account) see every premium item locked.
	const account = normalizeAccountId(url.searchParams.get('account'));
	const ownedIds = account ? await readOwnedCosmetics(account) : [];

	const items = buildCatalog({ rarity: rarity || null, ownedIds });

	// Per-account responses must not be shared at the edge; the anonymous catalog
	// is static and cacheable. The two can never cross: `account` is part of the
	// URL, so it is part of every shared cache's key, and the per-account variant
	// is additionally marked private/no-store so no shared cache retains it.
	const cacheControl = account
		? 'private, no-store'
		: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
	return json(res, 200, { items, rarities: RARITIES }, { 'cache-control': cacheControl });
});
