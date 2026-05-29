// Realm definitions — the authoritative maps the GameRoom validates against.
// The client renders the SAME data (sent on join), so the visual world and the
// walkable world never drift apart. Coordinates are tile indices.
//
// Every realm shares one shape:
//   { name, grid, spawn:{tx,ty}, safe:bool, pvp:bool, danger:bool,
//     blocked:[{x0,y0,x1,y1}], bankZone:[{tx,ty}], fountain:{tx,ty}|null,
//     nodes:[{id,kind,tx,ty}], mobs:[{id,kind,tx,ty,hp,roam,aggro}],
//     fishing:[{tx,ty}], cooking:[{tx,ty}], safeCamp:{x0,y0,x1,y1}|null,
//     portals:[{x0,y0,x1,y1,to,toTx,toTy}] }
//
// `danger` realms drop a tombstone on death. `pvp` realms allow player combat
// outside any safeCamp. Resource node ids must be unique WITHIN a realm.

function nodesFrom(coords, kind, prefix) {
	return coords.map(([tx, ty], i) => ({ id: `${prefix}${i}`, kind, tx, ty }));
}
function tiles(coords) {
	return coords.map(([tx, ty]) => ({ tx, ty }));
}

// ---------------------------------------------------------------- Mainland
const MAINLAND = {
	name: 'mainland',
	grid: 48,
	spawn: { tx: 24, ty: 30 },
	safe: true, pvp: false, danger: false,
	blocked: [
		{ x0: 8, y0: 8, x1: 12, y1: 11 }, // bank building
		{ x0: 23, y0: 23, x1: 24, y1: 24 }, // fountain
	],
	fountain: { tx: 23, ty: 23 },
	bankZone: tiles([[8, 12], [9, 12], [10, 12], [11, 12], [12, 12]]),
	nodes: [
		...nodesFrom([[12, 28], [14, 30], [16, 29], [13, 33], [15, 35], [11, 31], [18, 34], [20, 30],
			[17, 37], [19, 38], [10, 36], [22, 36], [8, 30], [9, 33], [21, 40], [13, 40]], 'tree', 't'),
		...nodesFrom([[34, 14], [36, 16], [38, 13], [40, 15], [35, 18], [39, 18], [42, 12], [33, 16]], 'rock', 'r'),
		...nodesFrom([[37, 20], [41, 20], [34, 21], [39, 22]], 'coal', 'c'),
	],
	mobs: [
		{ id: 'd0', kind: 'dummy', tx: 36, ty: 34, hp: 50, roam: false, aggro: false },
		{ id: 'd1', kind: 'dummy', tx: 38, ty: 34, hp: 50, roam: false, aggro: false },
		{ id: 'd2', kind: 'dummy', tx: 37, ty: 36, hp: 50, roam: false, aggro: false },
	],
	fishing: [],
	cooking: [],
	safeCamp: null,
	portals: [
		{ x0: 23, y0: 0, x1: 25, y1: 0, to: 'wilderness', toTx: 20, toTy: 36 }, // north → wilderness safe camp
		{ x0: 23, y0: 47, x1: 25, y1: 47, to: 'whisperwood', toTx: 20, toTy: 2 }, // south → whisperwood
		{ x0: 47, y0: 23, x1: 47, y1: 25, to: 'pond', toTx: 2, toTy: 18 }, // east → pond
	],
};

// ---------------------------------------------------------------- Wilderness
const WILDERNESS = {
	name: 'wilderness',
	grid: 40,
	spawn: { tx: 20, ty: 36 },
	safe: false, pvp: true, danger: true,
	blocked: [],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[10, 20], [14, 16], [26, 18], [30, 22], [8, 12], [32, 14], [18, 10], [22, 24]], 'tree', 't'),
		...nodesFrom([[12, 8], [28, 8], [34, 20], [6, 24], [16, 6]], 'rock', 'r'),
		...nodesFrom([[24, 6], [30, 10], [9, 17]], 'coal', 'c'),
	],
	mobs: [
		{ id: 'g0', kind: 'goblin', tx: 14, ty: 22, hp: 34, roam: true, aggro: true },
		{ id: 'g1', kind: 'goblin', tx: 24, ty: 20, hp: 34, roam: true, aggro: true },
		{ id: 'g2', kind: 'goblin', tx: 18, ty: 14, hp: 34, roam: true, aggro: true },
		{ id: 'g3', kind: 'goblin', tx: 30, ty: 16, hp: 34, roam: true, aggro: true },
		{ id: 'o0', kind: 'ogre', tx: 20, ty: 8, hp: 80, roam: true, aggro: true },
	],
	fishing: [],
	cooking: [],
	// southern fenced safe camp: no PvP, mobs won't enter.
	safeCamp: { x0: 14, y0: 32, x1: 26, y1: 39 },
	portals: [
		{ x0: 19, y0: 39, x1: 21, y1: 39, to: 'mainland', toTx: 24, toTy: 2 }, // south → mainland
	],
};

// ---------------------------------------------------------------- Whisperwood
const WHISPERWOOD = {
	name: 'whisperwood',
	grid: 40,
	spawn: { tx: 20, ty: 3 },
	safe: true, pvp: false, danger: false,
	blocked: [],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[8, 10], [10, 14], [12, 9], [14, 16], [16, 12], [9, 20], [13, 24], [17, 22],
			[24, 10], [28, 14], [26, 20], [30, 18], [22, 26], [32, 24], [11, 30], [27, 28], [19, 32], [23, 34]], 'tree', 't'),
		...nodesFrom([[34, 10], [6, 26], [35, 30], [7, 33]], 'rock', 'r'),
	],
	mobs: [],
	fishing: tiles([[20, 17], [21, 17], [19, 19], [22, 19], [10, 34], [11, 34], [30, 35], [31, 35]]),
	cooking: [],
	safeCamp: null,
	portals: [
		{ x0: 19, y0: 0, x1: 21, y1: 0, to: 'mainland', toTx: 24, toTy: 45 }, // north → mainland
	],
};

// ---------------------------------------------------------------- Pond
const POND = {
	name: 'pond',
	grid: 36,
	spawn: { tx: 3, ty: 18 },
	safe: true, pvp: false, danger: false,
	blocked: [
		{ x0: 14, y0: 12, x1: 22, y1: 22 }, // the large pond (water, non-walkable)
	],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[6, 6], [9, 9], [27, 8], [30, 12], [7, 26], [28, 26], [11, 29], [25, 30]], 'tree', 't'),
	],
	mobs: [],
	// fishable shoreline around the pond rectangle (walk adjacent and cast)
	fishing: tiles([
		[13, 14], [13, 16], [13, 18], [13, 20], [23, 14], [23, 16], [23, 18], [23, 20],
		[15, 11], [17, 11], [19, 11], [21, 11], [15, 23], [17, 23], [19, 23], [21, 23],
	]),
	cooking: tiles([[10, 18], [11, 18], [10, 19], [11, 19]]), // the Roast Pit
	safeCamp: null,
	portals: [
		{ x0: 0, y0: 17, x1: 0, y1: 19, to: 'mainland', toTx: 45, toTy: 24 }, // west → mainland
	],
};

export const REALMS = {
	mainland: MAINLAND,
	wilderness: WILDERNESS,
	whisperwood: WHISPERWOOD,
	pond: POND,
};

export const DEFAULT_REALM = 'mainland';

export function inBounds(realm, tx, ty) {
	return tx >= 0 && ty >= 0 && tx < realm.grid && ty < realm.grid;
}

export function isBlocked(realm, tx, ty) {
	for (const r of realm.blocked) {
		if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) return true;
	}
	return false;
}

export function portalAt(realm, tx, ty) {
	for (const p of realm.portals) {
		if (tx >= p.x0 && tx <= p.x1 && ty >= p.y0 && ty <= p.y1) return p;
	}
	return null;
}

export function inRect(rect, tx, ty) {
	return rect && tx >= rect.x0 && tx <= rect.x1 && ty >= rect.y0 && ty <= rect.y1;
}

// Serializable layout sent to the client on join (static geometry only;
// dynamic objects sync via schema state).
export function realmLayout(realm) {
	return {
		name: realm.name,
		grid: realm.grid,
		spawn: realm.spawn,
		fountain: realm.fountain,
		blocked: realm.blocked,
		bankZone: realm.bankZone,
		fishing: realm.fishing,
		cooking: realm.cooking,
		safeCamp: realm.safeCamp,
		portals: realm.portals.map((p) => ({ x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, to: p.to })),
		safe: realm.safe,
		pvp: realm.pvp,
		danger: realm.danger,
	};
}
