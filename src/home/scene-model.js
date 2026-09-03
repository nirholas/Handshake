/**
 * The room graph, turned into a scene.
 *
 * Everything geometric about /home/:id is decided here, as a pure function of
 * the graph `packages/home-bridge` already builds. No Three.js, no DOM, no
 * clock: the same model drives the WebGL renderer and the 2D fallback, and a
 * test can assert the whole layout of a real house without a GPU.
 *
 * Two rules shape it:
 *
 *   1. A real house has no geometry in Home Assistant. Areas and floors are
 *      registries with names and levels, and nothing else, so the default
 *      arrangement here has to be good enough to use before anyone authors a
 *      floorplan. Rooms are packed per floor in name order, which is stable
 *      across reconnects and matches how the list beside the scene reads.
 *   2. A room with sixty entities is not sixty objects. People care about
 *      lights, locks, doors and temperature; a humidity sensor is a number,
 *      not a thing you walk up to. Objects are ranked, capped and the rest are
 *      summarized, so a busy room stays legible instead of becoming gravel.
 */

import { summarizeClimate, summarizeLighting, summarizeSecurity } from '../../packages/home-bridge/src/rooms.js';

/** Metres between floor slabs. Tall enough to read a room from the side. */
export const FLOOR_HEIGHT = 4.6;

/** One room occupies this cell; the room box sits inside it with a gap. */
export const CELL = 7.2;
const ROOM_GAP = 1.5;
const WALL_HEIGHT = 2.7;

/** Per room, before the rest is summarized into a readout. */
const MAX_CEILING = 6;
const MAX_WALL = 10;
const MAX_FLOOR = 6;

/**
 * What a person cares about first, in order. Ranking is the whole reason a
 * sixty-entity room is readable: the cap below cuts from the bottom of this
 * list, never from the top, so the lights and the locks are always drawn.
 */
const RANK = {
	light: 0,
	lock: 1,
	cover: 2,
	climate: 3,
	alarm_control_panel: 4,
	media_player: 5,
	fan: 6,
	camera: 7,
	vacuum: 8,
	switch: 9,
	binary_sensor: 10,
	sensor: 11,
};

/** Binary sensors that are openings: they belong to the security story. */
const OPENING_CLASSES = new Set(['door', 'window', 'garage_door', 'opening']);

/**
 * Where a domain lives in a room. Ceiling objects hang, wall objects mount on
 * the perimeter, floor objects stand on the slab. This is the only place that
 * decides it, so the renderer and the fallback legend cannot disagree.
 */
export function placementOf(entity) {
	const domain = entity?.domain;
	if (domain === 'light') return 'ceiling';
	if (domain === 'fan') return entity.deviceClass === 'ceiling' || /ceiling/i.test(entity.name || '') ? 'ceiling' : 'floor';
	if (domain === 'cover' || domain === 'lock' || domain === 'camera' || domain === 'switch') return 'wall';
	if (domain === 'media_player' || domain === 'alarm_control_panel') return 'wall';
	if (domain === 'binary_sensor') return OPENING_CLASSES.has(entity.deviceClass) ? 'wall' : null;
	if (domain === 'climate' || domain === 'vacuum') return 'floor';
	return null;
}

/**
 * The visual kind the renderer draws. Deliberately coarser than the domain: a
 * `switch` and a `media_player` are both panels on a wall, and giving each
 * domain its own mesh would be a bestiary nobody can read at a glance.
 */
export function kindOf(entity) {
	switch (entity.domain) {
		case 'light':
			return 'lamp';
		case 'fan':
			return 'fan';
		case 'lock':
			return 'lock';
		case 'cover':
			return entity.deviceClass === 'garage' || entity.deviceClass === 'door' ? 'door' : 'window';
		case 'binary_sensor':
			return entity.deviceClass === 'garage_door' || entity.deviceClass === 'door' ? 'door' : 'window';
		case 'climate':
			return 'thermostat';
		case 'media_player':
			return 'screen';
		case 'camera':
			return 'camera';
		case 'alarm_control_panel':
			return 'alarm';
		case 'vacuum':
			return 'puck';
		case 'switch':
			return 'plate';
		default:
			return 'plate';
	}
}

/**
 * Is this entity currently "active" in the way its kind means it?
 *
 * A light is on, a cover is open, a lock is UNLOCKED, a media player is
 * playing. The lock inversion is deliberate and load-bearing: unlocked is the
 * state a person needs to spot from across the room, so it is the one that
 * lights up.
 */
export function activityOf(entity) {
	const state = entity.state;
	if (state === 'unavailable' || state === 'unknown') return 0;
	switch (entity.domain) {
		case 'light':
		case 'switch':
		case 'fan':
			return state === 'on' ? 1 : 0;
		case 'lock':
			return state === 'unlocked' || state === 'open' || state === 'opening' ? 1 : 0;
		case 'cover': {
			const position = Number(entity.attributes?.current_position);
			if (Number.isFinite(position)) return clamp01(position / 100);
			return state === 'open' || state === 'opening' ? 1 : 0;
		}
		case 'binary_sensor':
			return state === 'on' ? 1 : 0;
		case 'media_player':
			return state === 'playing' ? 1 : state === 'paused' || state === 'on' ? 0.5 : 0;
		case 'climate':
			return state && state !== 'off' ? 1 : 0;
		case 'vacuum':
			return state === 'cleaning' || state === 'returning' ? 1 : 0;
		case 'alarm_control_panel':
			return state && state !== 'disarmed' ? 1 : 0;
		default:
			return 0;
	}
}

/** True when Home Assistant is telling us this device is not answering. */
export function isUnavailable(entity) {
	return entity.state === 'unavailable' || entity.state === 'unknown' || entity.state == null;
}

/**
 * The room's own light: what colour it is and how bright, from the lights that
 * are actually on. `summarizeLighting` already averages brightness and colour;
 * this turns that into something a renderer and a CSS gradient can both use.
 *
 * Off means genuinely dark. A room whose lights are all off must not read as
 * "dimmed": that is the difference between a model of a house and a picture of
 * one.
 */
export function lightOf(room) {
	const lighting = room.lighting || { total: 0, on: 0, brightness: 0, rgb: null };
	const on = lighting.on > 0;
	const brightness = on ? clamp01(lighting.brightness || 0.8) : 0;
	const rgb = on ? lighting.rgb || [255, 236, 202] : [120, 132, 168];
	return {
		on,
		total: lighting.total,
		count: lighting.on,
		brightness,
		rgb,
		hex: rgbToHex(rgb),
		// A dark room still needs enough ambient to be readable, so the floor of
		// the range is the moonlight a screen has to have, not zero.
		intensity: on ? 0.35 + brightness * 1.5 : 0.06,
	};
}

/**
 * Warm or cool, from the room's own measured temperature. Neutral below the
 * comfort band's width so an ordinary room is not permanently tinted.
 */
export function climateOf(room, unit = null) {
	const climate = room.climate;
	if (!climate || !Number.isFinite(climate.temperature)) return null;
	const t = climate.temperature;
	// The comfort band is centred where the house measures it. Home Assistant
	// reports whatever unit the instance is configured in, so a Fahrenheit house
	// must not read as permanently freezing because 70 is nowhere near 21.
	const fahrenheit = String(unit || '').includes('F');
	const centre = fahrenheit ? 70 : 21;
	const span = fahrenheit ? 11 : 6;
	const offset = clamp(-1, 1, (t - centre) / span);
	return {
		temperature: t,
		sources: climate.sources,
		unit: unit || null,
		// -1 fully cool, +1 fully warm. The renderer and the 2D card both read it.
		tint: Number(offset.toFixed(3)),
		label: `${t.toFixed(1)}${unit || '°'}`,
	};
}

/** Sensors are numbers, not objects: they become one readout line per room. */
export function readoutsOf(entities) {
	const out = [];
	for (const entity of entities) {
		if (entity.domain !== 'sensor') continue;
		const value = Number(entity.state);
		if (!Number.isFinite(value)) continue;
		out.push({
			entityId: entity.entityId,
			name: entity.name,
			deviceClass: entity.deviceClass || null,
			value,
			unit: entity.attributes?.unit_of_measurement || '',
		});
	}
	return out.sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 6);
}

/**
 * Build the scene.
 *
 * @param {object} graph the room graph from buildHomeGraph()
 * @param {object} [options]
 * @param {string} [options.focusRoomId] the room the camera and the agent are on
 * @param {Record<string, {x:number,z:number,w?:number,d?:number}>} [options.layout]
 *   an authored floorplan (order 07). Absent, rooms pack by floor in name order.
 * @returns {object} the scene model
 */
export function buildSceneModel(graph, options = {}) {
	const source = graph && typeof graph === 'object' ? graph : {};
	const rawRooms = Array.isArray(source.rooms) ? source.rooms : [];
	const unassigned = Array.isArray(source.unassigned) ? source.unassigned : [];
	const layout = options.layout || null;

	// Every entity the house has that nobody put in an area is still somebody's
	// device. A house with zero assigned areas is the common case, not an edge
	// case, so it renders as one honest room rather than a blank floor.
	const rooms = [...rawRooms];
	if (unassigned.length) {
		rooms.push({
			id: '__unassigned__',
			name: rawRooms.length ? 'Not in a room' : 'Everything',
			floorId: null,
			icon: null,
			synthetic: true,
			entities: unassigned,
			// The rollups a real area gets, applied to the bucket nobody filed.
			// Same functions the graph builder uses, so one shape flows through.
			lighting: summarizeLighting(unassigned),
			climate: summarizeClimate(unassigned, source.temperatureUnit || null),
			secured: summarizeSecurity(unassigned),
		});
	}

	const floors = planFloors(source.floors, rooms);
	const placed = [];
	for (const floor of floors) {
		const cells = packCells(floor.rooms.length);
		floor.rooms.forEach((room, index) => {
			const authored = layout?.[room.id];
			const cell = cells[index];
			const x = Number.isFinite(authored?.x) ? authored.x : cell.x * CELL;
			const z = Number.isFinite(authored?.z) ? authored.z : cell.z * CELL;
			placed.push(buildRoom(room, { ...floor, temperatureUnit: source.temperatureUnit || null }, { x, z, w: authored?.w, d: authored?.d }));
		});
	}

	const bounds = boundsOf(placed);
	const focusRoomId = pickFocusRoom(placed, options.focusRoomId);
	const drawn = placed.reduce((n, r) => n + r.objects.length, 0);
	const total = placed.reduce((n, r) => n + r.entityCount, 0);

	return {
		floors: floors.map((f) => ({ id: f.id, name: f.name, level: f.level, y: f.y, roomIds: f.rooms.map((r) => r.id) })),
		rooms: placed,
		bounds,
		focusRoomId,
		agent: agentStand(placed, focusRoomId),
		// A house where nothing is assigned to an area is a designed state, not a
		// failure, and the page has to be able to tell the two apart.
		needsLayout: rawRooms.length === 0 && unassigned.length > 0,
		empty: total === 0,
		stats: { floors: floors.length, rooms: placed.length, entities: total, drawn, summarized: total - drawn },
	};
}

/** Floors, with every room slotted onto one, ordered by level then by name. */
function planFloors(rawFloors, rooms) {
	const declared = (Array.isArray(rawFloors) ? rawFloors : []).map((f) => ({
		id: f.id,
		name: f.name,
		level: Number.isFinite(f.level) ? f.level : 0,
		rooms: [],
	}));
	const byId = new Map(declared.map((f) => [f.id, f]));
	let loose = null;

	for (const room of [...rooms].sort(byName)) {
		const floor = room.floorId && byId.get(room.floorId);
		if (floor) {
			floor.rooms.push(room);
			continue;
		}
		// A house with no floor registry, or a room nobody placed on a floor.
		// It joins the lowest declared floor rather than getting a phantom one
		// beneath the house: a floor labelled "Unplaced" hanging under the ground
		// floor reads as a basement the user does not have, and it dragged the
		// default camera and the agent down into it.
		if (!loose) {
			loose = lowestFloor(declared) || { id: '__ground__', name: 'Home', level: 0, rooms: [] };
			if (!byId.has(loose.id)) {
				declared.push(loose);
				byId.set(loose.id, loose);
			}
		}
		loose.rooms.push(room);
	}

	const used = declared.filter((f) => f.rooms.length).sort((a, b) => a.level - b.level || String(a.name).localeCompare(String(b.name)));
	used.forEach((floor, index) => {
		floor.y = index * FLOOR_HEIGHT;
	});
	return used;
}

function lowestFloor(floors) {
	return floors.reduce((low, f) => (!low || f.level < low.level ? f : low), null);
}

/**
 * Pack n rooms into a grid centred on the origin. Wider than tall, because a
 * screen is, and a house read from a 3/4 camera reads better in rows.
 */
export function packCells(n) {
	// Never wider than there are rooms: the 1.35 bias makes a grid landscape,
	// but applied to a single-room house it produced a two-column grid with one
	// room sitting half a cell off centre.
	const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 1.35))));
	const rows = Math.max(1, Math.ceil(n / cols));
	const out = [];
	for (let i = 0; i < n; i += 1) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		out.push({ x: col - (cols - 1) / 2, z: row - (rows - 1) / 2 });
	}
	return out;
}

function buildRoom(room, floor, cell) {
	const entities = Array.isArray(room.entities) ? room.entities : [];
	const w = Number.isFinite(cell.w) ? cell.w : CELL - ROOM_GAP;
	const d = Number.isFinite(cell.d) ? cell.d : CELL - ROOM_GAP;

	const ranked = [...entities].sort(
		(a, b) => (RANK[a.domain] ?? 99) - (RANK[b.domain] ?? 99) || String(a.name).localeCompare(String(b.name)),
	);

	const slots = { ceiling: [], wall: [], floor: [] };
	const caps = { ceiling: MAX_CEILING, wall: MAX_WALL, floor: MAX_FLOOR };
	const overflow = [];
	for (const entity of ranked) {
		const where = placementOf(entity);
		if (!where) continue;
		if (slots[where].length >= caps[where]) {
			overflow.push(entity);
			continue;
		}
		slots[where].push(entity);
	}

	const objects = [];
	slots.ceiling.forEach((entity, i) => objects.push(placeObject(entity, ceilingSlot(i, slots.ceiling.length, w, d))));
	slots.wall.forEach((entity, i) => objects.push(placeObject(entity, wallSlot(i, slots.wall.length, w, d))));
	slots.floor.forEach((entity, i) => objects.push(placeObject(entity, floorSlot(i, slots.floor.length, w, d))));

	const secured = room.secured || null;
	return {
		id: room.id,
		name: room.name,
		floorId: floor.id,
		level: floor.level,
		synthetic: Boolean(room.synthetic),
		x: cell.x,
		y: floor.y,
		z: cell.z,
		w,
		d,
		h: WALL_HEIGHT,
		light: lightOf(room),
		climate: climateOf(room, floor.temperatureUnit),
		security: secured
			? { ...secured, unlocked: secured.unlocked || [], open: secured.open || [] }
			: null,
		objects,
		readouts: readoutsOf(entities),
		entityCount: entities.length,
		hiddenCount: overflow.length,
		unavailableCount: entities.filter(isUnavailable).length,
	};
}

function placeObject(entity, slot) {
	return {
		entityId: entity.entityId,
		name: entity.name,
		domain: entity.domain,
		deviceClass: entity.deviceClass || null,
		kind: kindOf(entity),
		placement: slot.placement,
		x: round(slot.x),
		y: round(slot.y),
		z: round(slot.z),
		rotation: round(slot.rotation),
		state: entity.state,
		activity: activityOf(entity),
		available: !isUnavailable(entity),
		attributes: entity.attributes || {},
	};
}

/** Ceiling objects hang in a row across the room, just under the slab. */
function ceilingSlot(i, n, w, d) {
	const span = w * 0.62;
	const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
	return { placement: 'ceiling', x, y: WALL_HEIGHT - 0.42, z: n > 3 && i % 2 ? d * 0.16 : -d * 0.12, rotation: 0 };
}

/**
 * Wall objects walk the perimeter clockwise from the front-left corner, so two
 * doors never land on the same spot and a room reads the same way every time
 * it rebuilds.
 */
function wallSlot(i, n, w, d) {
	const perimeter = 2 * (w + d);
	const t = ((i + 0.5) / Math.max(1, n)) * perimeter;
	const halfW = w / 2 - 0.12;
	const halfD = d / 2 - 0.12;
	const y = 1.15;
	if (t < w) return { placement: 'wall', x: -halfW + (t / w) * (w - 0.24), y, z: -halfD, rotation: 0 };
	if (t < w + d) return { placement: 'wall', x: halfW, y, z: -halfD + ((t - w) / d) * (d - 0.24), rotation: -Math.PI / 2 };
	if (t < 2 * w + d) return { placement: 'wall', x: halfW - ((t - w - d) / w) * (w - 0.24), y, z: halfD, rotation: Math.PI };
	return { placement: 'wall', x: -halfW, y, z: halfD - ((t - 2 * w - d) / d) * (d - 0.24), rotation: Math.PI / 2 };
}

/** Floor objects stand in a shallow arc toward the front of the room. */
function floorSlot(i, n, w, d) {
	const span = w * 0.5;
	const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
	return { placement: 'floor', x, y: 0, z: d * 0.24, rotation: 0 };
}

function boundsOf(rooms) {
	if (!rooms.length) return { minX: -CELL, maxX: CELL, minZ: -CELL, maxZ: CELL, minY: 0, maxY: FLOOR_HEIGHT, width: CELL * 2, depth: CELL * 2 };
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	let maxY = 0;
	for (const room of rooms) {
		minX = Math.min(minX, room.x - room.w / 2);
		maxX = Math.max(maxX, room.x + room.w / 2);
		minZ = Math.min(minZ, room.z - room.d / 2);
		maxZ = Math.max(maxZ, room.z + room.d / 2);
		maxY = Math.max(maxY, room.y + room.h);
	}
	return { minX, maxX, minZ, maxZ, minY: 0, maxY, width: maxX - minX, depth: maxZ - minZ };
}

function pickFocusRoom(rooms, requested) {
	if (requested && rooms.some((r) => r.id === requested)) return requested;
	if (!rooms.length) return null;
	// Default to the busiest real room on the lowest floor: it is where a person
	// walks in, and it is the room most likely to make the first frame legible.
	// The unassigned bucket is never the default focus while a real room exists,
	// however many entities it holds, because it is a filing cabinet and not a
	// place in the house.
	const real = rooms.filter((r) => !r.synthetic);
	const pool0 = real.length ? real : rooms;
	const lowest = Math.min(...pool0.map((r) => r.level));
	const candidates = pool0.filter((r) => r.level === lowest);
	const pool = candidates.length ? candidates : pool0;
	return pool.reduce((best, room) => (room.objects.length > best.objects.length ? room : best), pool[0]).id;
}

/** Where the agent's body stands, and which way it faces. */
function agentStand(rooms, focusRoomId) {
	const room = rooms.find((r) => r.id === focusRoomId) || rooms[0];
	if (!room) return { roomId: null, x: 0, y: 0, z: 0, facing: 0 };
	return {
		roomId: room.id,
		x: round(room.x - room.w * 0.22),
		y: room.y,
		z: round(room.z + room.d * 0.2),
		// Facing out of the room toward the default camera, so it reads as
		// standing in the house and looking at you rather than at a wall.
		facing: 0,
	};
}

/**
 * Diff two scene models by entity id. The renderer uses it to touch only what
 * changed: a burst of a hundred state updates must not rebuild a hundred
 * meshes, and a ten-minute session must not grow the heap by one object.
 */
export function diffScene(previous, next) {
	const before = objectIndex(previous);
	const after = objectIndex(next);
	const changed = [];
	const added = [];
	const removed = [];
	for (const [id, object] of after) {
		const old = before.get(id);
		if (!old) {
			added.push(object);
			continue;
		}
		if (old.activity !== object.activity || old.state !== object.state || old.available !== object.available) changed.push(object);
	}
	for (const [id, object] of before) if (!after.has(id)) removed.push(object);

	const roomsChanged = [];
	const beforeRooms = new Map((previous?.rooms || []).map((r) => [r.id, r]));
	for (const room of next?.rooms || []) {
		const old = beforeRooms.get(room.id);
		if (!old) {
			roomsChanged.push(room.id);
			continue;
		}
		if (
			old.light.intensity !== room.light.intensity ||
			old.light.hex !== room.light.hex ||
			old.climate?.temperature !== room.climate?.temperature ||
			old.security?.secure !== room.security?.secure
		) {
			roomsChanged.push(room.id);
		}
	}
	return { added, changed, removed, roomsChanged };
}

function objectIndex(model) {
	const map = new Map();
	for (const room of model?.rooms || []) for (const object of room.objects) map.set(object.entityId, object);
	return map;
}

// ── small helpers ────────────────────────────────────────────────────────────

function byName(a, b) {
	return String(a.name).localeCompare(String(b.name));
}

function clamp01(n) {
	return clamp(0, 1, n);
}

function clamp(min, max, n) {
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function round(n) {
	return Math.round(n * 1000) / 1000;
}

export function rgbToHex(rgb) {
	const [r, g, b] = rgb;
	return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
