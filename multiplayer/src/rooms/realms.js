// Mainland realm definition — the authoritative map the GameRoom validates
// against. The client renders the *same* layout from this data (it's also
// imported browser-side), so the visual world and the walkable world can never
// drift apart. Coordinates are tile indices on a GRID×GRID board.

export const GRID = 48;

// Solid, non-walkable rectangles (inclusive bounds). Buildings and the plaza
// fountain. The map border is implicitly solid (see inBounds).
const BLOCKED_RECTS = [
	{ x0: 8, y0: 8, x1: 12, y1: 11 }, // bank building footprint
	{ x0: 23, y0: 23, x1: 24, y1: 24 }, // plaza fountain (2×2)
];

// Hand-placed so the client and server agree exactly. Trees cluster in a grove
// to the west; the rock/coal field sits to the northeast like a small mine.
const TREES = [
	[12, 28], [14, 30], [16, 29], [13, 33], [15, 35], [11, 31], [18, 34], [20, 30],
	[17, 37], [19, 38], [10, 36], [22, 36], [8, 30], [9, 33], [21, 40], [13, 40],
];
const ROCKS = [
	[34, 14], [36, 16], [38, 13], [40, 15], [35, 18], [39, 18], [42, 12], [33, 16],
];
const COAL = [
	[37, 20], [41, 20], [34, 21], [39, 22],
];

function nodesFrom(coords, kind, prefix) {
	return coords.map(([tx, ty], i) => ({ id: `${prefix}${i}`, kind, tx, ty }));
}

export const MAINLAND = {
	name: 'mainland',
	grid: GRID,
	spawn: { tx: 24, ty: 30 },
	fountain: { tx: 23, ty: 23 }, // top-left of the 2×2 plaza fountain

	// Tiles where standing lets you open bank storage (the counter row directly
	// south of the bank building). Must be walkable.
	bankZone: [
		{ tx: 8, ty: 12 }, { tx: 9, ty: 12 }, { tx: 10, ty: 12 },
		{ tx: 11, ty: 12 }, { tx: 12, ty: 12 },
	],

	nodes: [
		...nodesFrom(TREES, 'tree', 't'),
		...nodesFrom(ROCKS, 'rock', 'r'),
		...nodesFrom(COAL, 'coal', 'c'),
	],

	// Training dummies near the armory ground (northeast of spawn).
	mobs: [
		{ id: 'd0', kind: 'dummy', tx: 36, ty: 34, hp: 50 },
		{ id: 'd1', kind: 'dummy', tx: 38, ty: 34, hp: 50 },
		{ id: 'd2', kind: 'dummy', tx: 37, ty: 36, hp: 50 },
	],
};

export function inBounds(tx, ty) {
	return tx >= 0 && ty >= 0 && tx < GRID && ty < GRID;
}

export function isBlocked(tx, ty) {
	for (const r of BLOCKED_RECTS) {
		if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) return true;
	}
	return false;
}

export const BANK_BUILDING = BLOCKED_RECTS[0];
export const FOUNTAIN_RECT = BLOCKED_RECTS[1];
