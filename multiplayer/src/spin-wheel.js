// Wheel of Fortune server logic (W09/Task 19) — "Fortune's Folly" in the Mainland
// plaza. Free spin every 12h per account, or pay $3 in $THREE (settled through
// game-token.js's split-payment primitives — the exact pattern the $THREE
// boutique already uses in production: server builds the tx, the wallet signs
// it, the server re-verifies the confirmed transaction on RPC before granting
// anything). The client (src/game/spin-wheel-ui.js) never rolls or decides a
// prize — it renders the wheel and animates to whatever index the server sends.
//
// The 20 wedges the client draws are all the SAME angular size (see
// spin-wheel-ui.js's _drawWheel — one fixed `2π/n` per segment, no variable
// wedge width). For the visual wheel to be honest about the real odds, the
// prize table below MUST stay uniform-probability — one segment, one pick, no
// hidden weighting. Don't "balance" the economy by skewing the RNG; balance it
// by changing the prize amounts instead.

import { addItem, hasRoomFor } from './economy.js';
import { nearestWheel, wheelInRange } from './world-features.js';
import {
	buildSpinPayment, verifySpinPayment, isWalletAddress, tokenConfigured, TOKEN_DECIMALS, TOKEN_SYMBOL,
} from './game-token.js';

export const FREE_SPIN_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const SPIN_COST_USD = 3;
// Average of the 5 tracked skills must clear this before ANY spin (free or
// paid) is offered — a light anti-bot/anti-farm gate tied to actually having
// played, not a hard grind (everyone starts at level 1, so this asks for a
// little real progress, not a lot).
export const MIN_AVG_LEVEL = 3;

// 20 equal-odds wedges (5% each — see the header note on why they must stay
// uniform). Mostly common gather resources at modest quantities (a wheel that
// mainly hands out wood/stone/coal is a fun bonus to the gather loop, not a
// separate economy), three small-to-medium gold prizes, and one rare jackpot.
export const WHEEL_SEGMENTS = [
	{ kind: 'item', item: 'wood', qty: 3, label: '3 Wood', oddsPct: 5 },
	{ kind: 'item', item: 'wood', qty: 4, label: '4 Wood', oddsPct: 5 },
	{ kind: 'item', item: 'wood', qty: 5, label: '5 Wood', oddsPct: 5 },
	{ kind: 'item', item: 'wood', qty: 6, label: '6 Wood', oddsPct: 5 },
	{ kind: 'item', item: 'stone', qty: 3, label: '3 Stone', oddsPct: 5 },
	{ kind: 'item', item: 'stone', qty: 4, label: '4 Stone', oddsPct: 5 },
	{ kind: 'item', item: 'stone', qty: 5, label: '5 Stone', oddsPct: 5 },
	{ kind: 'item', item: 'stone', qty: 6, label: '6 Stone', oddsPct: 5 },
	{ kind: 'item', item: 'wood', qty: 8, label: '8 Wood', oddsPct: 5 },
	{ kind: 'item', item: 'stone', qty: 8, label: '8 Stone', oddsPct: 5 },
	{ kind: 'item', item: 'coal', qty: 1, label: '1 Coal', oddsPct: 5 },
	{ kind: 'item', item: 'coal', qty: 2, label: '2 Coal', oddsPct: 5 },
	{ kind: 'item', item: 'coal', qty: 3, label: '3 Coal', oddsPct: 5 },
	{ kind: 'gold', gold: 5, label: '5 Cash', oddsPct: 5 },
	{ kind: 'gold', gold: 5, label: '5 Cash', oddsPct: 5 },
	{ kind: 'gold', gold: 8, label: '8 Cash', oddsPct: 5 },
	{ kind: 'gold', gold: 8, label: '8 Cash', oddsPct: 5 },
	{ kind: 'gold', gold: 12, label: '12 Cash', oddsPct: 5 },
	{ kind: 'gold', gold: 12, label: '12 Cash', oddsPct: 5 },
	{ kind: 'gold', gold: 100, label: 'JACKPOT — 100 Cash', oddsPct: 5 },
];

function avgLevel(profile) {
	const levels = Object.values(profile.levels || {});
	if (!levels.length) return 1;
	return levels.reduce((a, b) => a + b, 0) / levels.length;
}

// Every distinct item a wedge can award, derived from the paytable itself so a
// new prize kind upstream is covered here without a second list to maintain.
const PRIZE_ITEMS = [...new Set(WHEEL_SEGMENTS.filter((s) => s.kind === 'item').map((s) => s.item))];

// Is there room for at least one of EVERY possible item-type prize this wheel
// can award? Checked before a spin is even offered (free) or paid for (paid) -
// never after rolling - so a completed spin can never have nowhere to put its
// prize. It has to be EVERY prize, not any: a pack whose only free space is a
// half-full wood stack has room for wood and nowhere to put stone, and the roll
// that follows is uniform over both. Gold prizes never need this (gold is a
// scalar balance, not pack space).
function hasRoomForEveryPrize(profile) {
	return PRIZE_ITEMS.every((item) => hasRoomFor(profile, item));
}

function pickSegment() {
	const i = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
	return { index: i, seg: WHEEL_SEGMENTS[i] };
}

// Grant a rolled segment's prize to the profile. Room was already guaranteed by
// hasRoomForEveryPrize() before the roll, so addItem's leftover is expected to
// be 0 - but a defensive fallback still refunds any leftover as its rough gold
// value rather than silently discarding a prize a player (possibly a PAYING
// player) already won. The refund is REPORTED back in the result so the client
// can say what happened; a prize that quietly turned into a few cash reads as a
// broken wheel.
const ITEM_GOLD_VALUE = { wood: 1, stone: 1, coal: 2 };
function grantSegment(profile, seg) {
	if (seg.kind === 'gold') {
		profile.gold = Math.min(0xffffffff, (profile.gold || 0) + seg.gold);
		return { got: seg.gold, lost: 0, refunded: 0 };
	}
	const leftover = addItem(profile, seg.item, seg.qty);
	let refunded = 0;
	if (leftover > 0) {
		refunded = leftover * (ITEM_GOLD_VALUE[seg.item] || 1);
		profile.gold = Math.min(0xffffffff, (profile.gold || 0) + refunded);
	}
	return { got: seg.qty - leftover, lost: leftover, refunded };
}

function infoPayload(room, client, profile) {
	const player = room.state.players.get(client.sessionId);
	const lvl = avgLevel(profile);
	const eligible = lvl >= MIN_AVG_LEVEL;
	const atWheel = player ? !!wheelInRange(player.x, player.z) : false;
	return {
		segments: WHEEL_SEGMENTS,
		now: Date.now(),
		nextFreeSpinAt: profile.nextFreeSpinAt || 0,
		avgLevel: lvl,
		minLevel: MIN_AVG_LEVEL,
		eligible,
		atWheel,
		paidAvailable: tokenConfigured(),
		symbol: TOKEN_SYMBOL,
		costUsd: SPIN_COST_USD,
	};
}

export function handleSpinInfo(room, client) {
	const profile = room.econ.get(client.sessionId);
	if (!profile) return;
	client.send('spinInfo', infoPayload(room, client, profile));
}

export function handleSpinFree(room, client) {
	const player = room.state.players.get(client.sessionId);
	const profile = room.econ.get(client.sessionId);
	if (!player || !profile) return;
	if (!room._actionOk(client.sessionId, 'spinFree')) return;

	if (!wheelInRange(player.x, player.z)) { client.send('spinDenied', { reason: 'not_at_wheel' }); return; }
	const lvl = avgLevel(profile);
	if (lvl < MIN_AVG_LEVEL) { client.send('spinDenied', { reason: 'level', avgLevel: lvl, minLevel: MIN_AVG_LEVEL }); return; }
	const now = Date.now();
	if (now < (profile.nextFreeSpinAt || 0)) {
		client.send('spinDenied', { reason: 'cooldown', nextFreeSpinAt: profile.nextFreeSpinAt });
		return;
	}
	if (!hasRoomForEveryPrize(profile)) { client.send('spinDenied', { reason: 'pack_full' }); return; }

	profile.nextFreeSpinAt = now + FREE_SPIN_COOLDOWN_MS;
	const { index, seg } = pickSegment();
	const { got, lost, refunded } = grantSegment(profile, seg);
	room._sendInv(client, profile);
	client.send('spinResult', {
		mode: 'free', index, label: seg.label, got, lost, refunded, nextFreeSpinAt: profile.nextFreeSpinAt,
	});
	room._questEvent?.(client, profile, { type: 'spin' });
	room._persistEcon(client.sessionId);
}

export async function handleSpinPaidPrep(room, client, payload) {
	const player = room.state.players.get(client.sessionId);
	const profile = room.econ.get(client.sessionId);
	if (!player || !profile) return;
	if (!room._actionOk(client.sessionId, 'spinPaidPrep')) return;

	if (!wheelInRange(player.x, player.z)) { client.send('spinDenied', { reason: 'not_at_wheel' }); return; }
	const lvl = avgLevel(profile);
	if (lvl < MIN_AVG_LEVEL) { client.send('spinDenied', { reason: 'level', avgLevel: lvl, minLevel: MIN_AVG_LEVEL }); return; }
	if (!hasRoomForEveryPrize(profile)) { client.send('spinDenied', { reason: 'pack_full' }); return; }
	if (!tokenConfigured()) { client.send('spinDenied', { reason: 'token_unavailable' }); return; }

	// Same "whoever's wallet fronts it, the unlock lands on this session" model
	// the boutique quote already uses — the wallet rides the request payload,
	// not client.userData, so a spectator can never be charged for someone else.
	const wallet = typeof payload?.wallet === 'string' ? payload.wallet.trim() : '';
	if (!isWalletAddress(wallet)) { client.send('spinDenied', { reason: 'no_wallet' }); return; }

	let built;
	try {
		// forAccount seals the quote to this session's profile so a leaked
		// { quote, txSig } pair can't be redeemed onto a different account.
		built = await buildSpinPayment({ buyerWallet: wallet, usd: SPIN_COST_USD, forAccount: profile.playerId });
	} catch (err) {
		console.warn('[walk_world] spin prep failed:', err?.message);
	}
	if (!built) { client.send('spinDenied', { reason: 'price_unavailable' }); return; }
	client.send('spinPrep', {
		tx: built.txBase64,
		tokenAmount: built.quote.total,
		symbol: TOKEN_SYMBOL,
		costUsd: SPIN_COST_USD,
		quote: built.quoteToken,
	});
}

export async function handleSpinPaidSettle(room, client, payload) {
	const profile = room.econ.get(client.sessionId);
	if (!profile) return;
	if (!room._actionOk(client.sessionId, 'spinPaidSettle')) return;
	const quoteToken = typeof payload?.quote === 'string' ? payload.quote : '';
	const txSig = typeof payload?.txSig === 'string' ? payload.txSig : '';
	if (!quoteToken || !txSig) { client.send('spinDenied', { reason: 'no_signature' }); return; }

	let result;
	try {
		result = await verifySpinPayment({ quoteToken, txSig, forAccount: profile.playerId });
	} catch (err) {
		console.warn('[walk_world] spin settle failed:', err?.message);
		client.send('spinDenied', { reason: 'not_found' });
		return;
	}
	if (!result?.ok) { client.send('spinDenied', { reason: result?.reason || 'not_found' }); return; }

	// Durable, process-wide replay guard (settlement-guard.js): one payment rolls
	// exactly one prize, across every coin world, restart, and instance. The old
	// per-room Map let the same settled tx re-roll in N different rooms.
	const fresh = await consumeSettlement({ nonce: result.nonce, txSig, purpose: 'spin' });
	if (!fresh) { client.send('spinDenied', { reason: 'already_settled' }); return; }

	// The prep-time precheck guaranteed pack space for every item prize, but real
	// time passed while the player was in their wallet approving the transfer, so
	// the pack can have filled since. The payment has ALREADY settled by now, so a
	// denial here would be theft: roll and grant regardless, and let grantSegment's
	// gold-value fallback catch anything that no longer fits. `refunded` rides back
	// on the result so the client states plainly what became of the prize instead of
	// showing a win the pack never received.
	const { index, seg } = pickSegment();
	const { got, lost, refunded } = grantSegment(profile, seg);
	room._sendInv(client, profile);
	client.send('spinResult', { mode: 'paid', index, label: seg.label, got, lost, refunded });
	room._questEvent?.(client, profile, { type: 'spin' });
	room._persistEcon(client.sessionId);
}

// Wire the four intents onto a room, mirroring registerActivityHandlers.
export function registerSpinHandlers(room) {
	room.onMessage('spinInfo', (client) => handleSpinInfo(room, client));
	room.onMessage('spinFree', (client) => handleSpinFree(room, client));
	room.onMessage('spinPaidPrep', (client, payload) => handleSpinPaidPrep(room, client, payload));
	room.onMessage('spinPaidSettle', (client, payload) => handleSpinPaidSettle(room, client, payload));
}
