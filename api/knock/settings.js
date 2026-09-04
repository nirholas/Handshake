// GET  /api/knock/settings  → the owner's door, exactly as they configured it.
// PATCH /api/knock/settings → change any subset of it.
//
// The one endpoint where a payout address is readable, and only by the account
// that owns it. Price is accepted as a human amount ("0.05", "$0.05") and
// stored in USDC atomic units, so nobody has to think in millionths to open a
// door.

import { z } from 'zod';
import { getRequestUser } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { env } from '../_lib/env.js';
import { formatUsdc, parsePrice } from '../_lib/knock/policy.js';
import { getDoor, updateDoor, inboxTotals, listBlocks, addBlock, removeBlock } from '../_lib/knock/store.js';
import { sql } from '../_lib/db.js';

const patchBody = z.object({
	open: z.boolean().optional(),
	// Accepted as a string so "0.05" survives the trip without float rounding.
	price: z.string().max(24).optional(),
	pay_to_solana: z.string().trim().max(64).nullable().optional(),
	pay_to_base: z.string().trim().max(64).nullable().optional(),
	headline: z.string().trim().max(120).nullable().optional(),
	greeting: z.string().trim().max(600).nullable().optional(),
	max_chars: z.number().int().min(40).max(2000).optional(),
	daily_cap: z.number().int().min(1).max(1000).optional(),
	listed: z.boolean().optional(),
	// The escrowed lane. Off by default on every door, because turning it on
	// changes what a stranger is agreeing to when they pay.
	escrow_enabled: z.boolean().optional(),
	// Bounded to the same 1-hour..30-day band the program enforces, so a door
	// cannot advertise a window the chain would refuse.
	escrow_window_hours: z.number().int().min(1).max(720).optional(),
	block: z.string().trim().min(1).max(120).optional(),
	unblock: z.string().uuid().optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PATCH,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PATCH'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	if (req.method === 'GET') {
		const rl = await limits.knockRead(user.id);
		if (!rl.success) return rateLimited(res, rl);
		return json(res, 200, await ownerView(user));
	}

	if (!(await requireCsrf(req, res, user.id))) return;
	const rl = await limits.knockWrite(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(patchBody, await readJson(req));

	if (body.block) await addBlock(user.id, body.block);
	if (body.unblock) await removeBlock(user.id, body.unblock);

	const patch = {};
	if (body.open !== undefined) patch.open = body.open;
	if (body.price !== undefined) {
		try {
			patch.price_atomics = parsePrice(body.price).toString();
		} catch (err) {
			return error(res, 400, err.code || 'bad_price', err.message);
		}
	}
	for (const key of ['pay_to_solana', 'pay_to_base', 'headline', 'greeting']) {
		if (body[key] !== undefined) patch[key] = body[key] || null;
	}
	if (body.max_chars !== undefined) patch.max_chars = body.max_chars;
	if (body.daily_cap !== undefined) patch.daily_cap = body.daily_cap;
	if (body.listed !== undefined) patch.listed = body.listed;
	if (body.escrow_enabled !== undefined) patch.escrow_enabled = body.escrow_enabled;
	if (body.escrow_window_hours !== undefined) patch.escrow_window_hours = body.escrow_window_hours;

	// Opening a door with a price and nowhere to send the money would take
	// payments into the platform's own wallet. Refuse instead of quietly
	// pocketing a stranger's USDC.
	const merged = { ...(await getDoor(user.id)), ...patch };
	if (merged.open && String(merged.price_atomics) !== '0' && !merged.pay_to_solana && !merged.pay_to_base) {
		return error(
			res,
			400,
			'missing_payout',
			'add the wallet that should receive the USDC before opening a priced door',
		);
	}

	// An escrowed door's PDA is derived from the owner's Solana address, and an
	// answer pays out to it. Without one there is no on-chain door to knock at,
	// so enabling the lane would advertise something that cannot work.
	if (merged.escrow_enabled && !merged.pay_to_solana) {
		return error(
			res,
			400,
			'missing_solana_payout',
			'the escrowed lane needs a Solana address: it is where an answer pays out, and half of the door\'s on-chain address',
		);
	}

	if (Object.keys(patch).length) await updateDoor(user.id, patch);
	return json(res, 200, await ownerView(user));
});

async function ownerView(user) {
	const [door, totals, blocks, handleRow] = await Promise.all([
		getDoor(user.id),
		inboxTotals(user.id),
		listBlocks(user.id),
		sql`select username from users where id = ${user.id}`,
	]);
	const handle = handleRow?.[0]?.username || null;
	return {
		door: {
			...door,
			price: formatUsdc(door.price_atomics),
			free: String(door.price_atomics) === '0',
		},
		handle,
		// The link the owner shares. Null until they pick a username, which is
		// what the settings page tells them to do first.
		url: handle ? `${env.APP_ORIGIN}/knock/${handle}` : null,
		endpoint: handle ? `${env.APP_ORIGIN}/api/x402/knock?to=${handle}` : null,
		totals: {
			pending: totals.pending,
			total: totals.total,
			earned_atomics: totals.earned_atomics,
			earned: formatUsdc(totals.earned_atomics),
		},
		blocks,
	};
}
