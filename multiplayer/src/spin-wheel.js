// Wheel of Fortune — the authoritative prize table for the Mainland casino spin
// (Task 19).
//
// The SERVER owns the outcome. The 20 segments and their weights live here and
// nowhere else; both the free spin and the paid spin roll through `rollSpin()`,
// and the client only ever receives the chosen index to animate toward — it
// never decides a prize. The display list (`spinSegments()`) is the same table
// with weights surfaced as honest odds, so the wheel the player sees is exactly
// the wheel the server rolls.
//
// Distribution: gold is the jackpot at a true 1/20 (the gold leg's weight is
// 1/20 of the total). The remaining 19 segments pay wood, stone, or coal in
// varying amounts, weighted so small hauls are common and big ones are rare.

import crypto from 'node:crypto';

// Each segment is { kind:'gold'|'item', item?, qty?, gold?, weight }. Order here
// is the order around the wheel (index 0 at the top, clockwise). Weights sum to
// 100, with the single gold leg at weight 5 → exactly P(gold) = 5/100 = 1/20.
const SEGMENTS = [
	{ kind: 'gold', gold: 200, weight: 5 },   // 0 — jackpot, ~1/20
	{ kind: 'item', item: 'wood', qty: 5, weight: 12 },
	{ kind: 'item', item: 'coal', qty: 6, weight: 6 },
	{ kind: 'item', item: 'stone', qty: 10, weight: 9 },
	{ kind: 'item', item: 'wood', qty: 25, weight: 4 },
	{ kind: 'item', item: 'coal', qty: 3, weight: 9 },
	{ kind: 'item', item: 'stone', qty: 5, weight: 11 },
	{ kind: 'item', item: 'wood', qty: 50, weight: 2 },
	{ kind: 'item', item: 'coal', qty: 15, weight: 3 },
	{ kind: 'item', item: 'stone', qty: 25, weight: 4 },
	{ kind: 'item', item: 'wood', qty: 10, weight: 10 },
	{ kind: 'item', item: 'coal', qty: 25, weight: 2 },
	{ kind: 'item', item: 'stone', qty: 15, weight: 6 },
	{ kind: 'item', item: 'wood', qty: 15, weight: 7 },
	{ kind: 'item', item: 'coal', qty: 10, weight: 4 },
	{ kind: 'item', item: 'stone', qty: 50, weight: 2 },
	{ kind: 'item', item: 'wood', qty: 100, weight: 1 }, // wood jackpot
	{ kind: 'item', item: 'coal', qty: 40, weight: 1 },
	{ kind: 'item', item: 'stone', qty: 80, weight: 1 },
	{ kind: 'item', item: 'coal', qty: 60, weight: 1 }, // coal jackpot
];

const TOTAL_WEIGHT = SEGMENTS.reduce((s, seg) => s + seg.weight, 0);

const ITEM_LABEL = { wood: 'Wood', stone: 'Stone', coal: 'Coal' };

// Human-readable label for a segment, computed once so the client and any toast
// describe a prize identically. "200 Gold", "25 Wood", …
function segmentLabel(seg) {
	if (seg.kind === 'gold') return `${seg.gold} Gold`;
	return `${seg.qty} ${ITEM_LABEL[seg.item] || seg.item}`;
}

/**
 * The wheel as the client should render it: one entry per segment in wheel
 * order, with the prize, a label, and the segment's true probability (odds are
 * shown openly — the wheel isn't a black box). No secret state; safe to send.
 * @returns {{ index:number, kind:string, item:string|null, qty:number|null,
 *   gold:number|null, label:string, oddsPct:number }[]}
 */
export function spinSegments() {
	return SEGMENTS.map((seg, index) => ({
		index,
		kind: seg.kind,
		item: seg.kind === 'item' ? seg.item : null,
		qty: seg.kind === 'item' ? seg.qty : null,
		gold: seg.kind === 'gold' ? seg.gold : null,
		label: segmentLabel(seg),
		oddsPct: Math.round((seg.weight / TOTAL_WEIGHT) * 1000) / 10,
	}));
}

/**
 * Roll one outcome using a cryptographically strong weighted draw. Returns the
 * winning segment index plus its reward, normalized to { gold } or { item, qty }.
 * This is the only place a spin's prize is decided.
 * @returns {{ index:number, kind:string, item:string|null, qty:number, gold:number, label:string }}
 */
export function rollSpin() {
	// randomInt is uniform over [0, TOTAL_WEIGHT) with no modulo bias.
	let roll = crypto.randomInt(0, TOTAL_WEIGHT);
	let index = 0;
	for (let i = 0; i < SEGMENTS.length; i++) {
		if (roll < SEGMENTS[i].weight) { index = i; break; }
		roll -= SEGMENTS[i].weight;
	}
	const seg = SEGMENTS[index];
	return {
		index,
		kind: seg.kind,
		item: seg.kind === 'item' ? seg.item : null,
		qty: seg.kind === 'item' ? seg.qty : 0,
		gold: seg.kind === 'gold' ? seg.gold : 0,
		label: segmentLabel(seg),
	};
}

export const SEGMENT_COUNT = SEGMENTS.length;
// 12h between free spins, tracked per account in the persisted profile.
export const FREE_SPIN_COOLDOWN_MS = 12 * 60 * 60 * 1000;
// Minimum average skill level required to spin (free or paid).
export const SPIN_MIN_AVG_LEVEL = 5;
// USD cost of one paid spin, settled in $THREE (50% burned / 50% to treasury).
export const PAID_SPIN_USD = 3;

// --- paid-spin replay guard (process-wide) ---------------------------------
//
// A settled payment signature must roll at most one prize, ever. Rooms are
// independent objects, so an in-room set wouldn't stop a player from settling
// the same signature again after a portal handoff to another realm. This shared
// map is the single source of truth across every room in the process; entries
// are swept after a TTL well beyond the 90s quote window so it never grows
// unbounded. (Horizontal scale would back this with the same Redis the
// presence/profile layers use; the interface stays identical.)
const _settledSigs = new Map(); // txSig -> settledAt(ms)
const SETTLED_TTL_MS = 60 * 60 * 1000;

export function isSpinSettled(txSig) {
	const at = _settledSigs.get(txSig);
	if (at == null) return false;
	if (Date.now() - at > SETTLED_TTL_MS) { _settledSigs.delete(txSig); return false; }
	return true;
}

export function markSpinSettled(txSig) {
	_settledSigs.set(txSig, Date.now());
}

setInterval(() => {
	const now = Date.now();
	for (const [sig, at] of _settledSigs) if (now - at > SETTLED_TTL_MS) _settledSigs.delete(sig);
}, 10 * 60 * 1000).unref?.();
