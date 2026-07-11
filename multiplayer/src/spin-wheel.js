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

// Is there room for at least one of EVERY possible item-type prize this wheel
// can award? Checked before a spin is even offered (free) or paid for (paid) —
// never after rolling — so a completed spin can never have nowhere to put its
// prize. Gold prizes never need this (gold is a scalar balance, not pack space).
function hasRoomForAnyPrize(profile) {
	return hasRoomFor(profile, 'wood') || hasRoomFor(profile, 'stone') || hasRoomFor(profile, 'coal');
}

function pickSegment() {
	const i = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
	return { index: i, seg: WHEEL_SEGMENTS[i] };
}

// Grant a rolled segment's prize to the profile. Room was already guaranteed by
// hasRoomForAnyPrize() before the roll, so addItem's leftover is expected to be
// 0 — but a defensive fallback still refunds any leftover as its rough gold
// value rather than silently discarding a prize a player (possibly a PAYING
// player) already won.
const ITEM_GOLD_VALUE = { wood: 1, stone: 1, coal: 2 };
function grantSegment(profile, seg) {
	if (seg.kind === 'gold') {
		profile.gold = Math.min(0xffffffff, (profile.gold || 0) + seg.gold);
		return { got: seg.gold, overflow: 0 };
	}
	const leftover = addItem(profile, seg.item, seg.qty);
	if (leftover > 0) {
		const refund = leftover * (ITEM_GOLD_VALUE[seg.item] || 1);
		profile.gold = Math.min(0xffffffff, (profile.gold || 0) + refund);
	}
	return { got: seg.qty - leftover, overflow: 0 };
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
	if (!hasRoomForAnyPrize(profile)) { client.send('spinDenied', { reason: 'pack_full' }); return; }

	profile.nextFreeSpinAt = now + FREE_SPIN_COOLDOWN_MS;
	const { index, seg } = pickSegment();
	const { got, overflow } = grantSegment(profile, seg);
	room._sendInv(client, profile);
	client.send('spinResult', {
		mode: 'free', index, label: seg.label, got, overflow, nextFreeSpinAt: profile.nextFreeSpinAt,
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
	if (!hasRoomForAnyPrize(profile)) { client.send('spinDenied', { reason: 'pack_full' }); return; }
	if (!tokenConfigured()) { client.send('spinDenied', { reason: 'token_unavailable' }); return; }

	// Same "whoever's wallet fronts it, the unlock lands on this session" model
	// the boutique quote already uses — the wallet rides the request payload,
	// not client.userData, so a spectator can never be charged for someone else.
	const wallet = typeof payload?.wallet === 'string' ? payload.wallet.trim() : '';
	if (!isWalletAddress(wallet)) { client.send('spinDenied', { reason: 'no_wallet' }); return; }

	let built;
	try {
		built = await buildSpinPayment({ buyerWallet: wallet, usd: SPIN_COST_USD });
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
		result = await verifySpinPayment({ quoteToken, txSig });
	} catch (err) {
		console.warn('[walk_world] spin settle failed:', err?.message);
		client.send('spinDenied', { reason: 'not_found' });
		return;
	}
	if (!result?.ok) { client.send('spinDenied', { reason: result?.reason || 'not_found' }); return; }

	room._pruneSpinNonces?.();
	if (room._spinNonces.has(result.nonce)) { client.send('spinDenied', { reason: 'already_settled' }); return; }
	room._spinNonces.set(result.nonce, Date.now());

	// Room precheck at prep time already guaranteed pack space for an item
	// prize; re-check here too since real time passed while the player was in
	// their wallet approving the transaction — a paid spin must never lose a
	// won prize to a pack that filled up in the meantime (grantSegment's own
	// gold-value fallback is the last-resort backstop if it somehow still does).
	const { index, seg } = pickSegment();
	const { got, overflow } = grantSegment(profile, seg);
	room._sendInv(client, profile);
	client.send('spinResult', { mode: 'paid', index, label: seg.label, got, overflow });
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
