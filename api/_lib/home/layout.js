// The authored floorplan: validation and storage.
//
// A layout is user-authored JSON that drives a renderer, which makes it
// untrusted input on a path where "it is only our own UI writing this" has
// never once been true for long. Everything here validates before it stores and
// validates again before it renders, with hard caps rather than best effort.
//
// The document shape is the contract src/home/scene-model.js already reads:
// buildSceneModel(graph, { layout }) looks up layout[roomId] and takes
// { x, z, w, d } in metres, where x and z are the room's centre on its floor and
// w and d are its footprint. This module stores that map under a `rooms` key
// with a version tag beside it, so the document can gain fields (rotation, wall
// openings, polygons) without the renderer's lookup changing.

import { sql } from '../db.js';
import { withDbRetry } from '../db-retry.js';

/** The document format, not the row's optimistic-concurrency version. */
export const LAYOUT_FORMAT = 1;

/**
 * Caps. Every one of these is a refusal, not a clamp: silently moving a room a
 * user placed is worse than telling them the number was rejected.
 */
export const LIMITS = Object.freeze({
	/** Rooms in one document. A very large house is ~60; 200 is generous. */
	maxRooms: 200,
	/** Metres from the origin, per axis. The default grid never exceeds ~80. */
	maxCoord: 500,
	/** Metres. Below 1.5 a room cannot hold its own label; above 60 is a field. */
	minSize: 1.5,
	maxSize: 60,
	/** Bytes of serialized JSON. A 200-room document is under 20 KB. */
	maxBytes: 64 * 1024,
	/** Characters in a room id. Home Assistant area ids are far shorter. */
	maxIdLength: 128,
});

/**
 * A Home Assistant area id, or one of the scene's own synthetic room ids. The
 * synthetic bucket (`__unassigned__`) is a real room on screen, so a user can
 * place it, and it therefore has to survive validation.
 */
const ROOM_ID_RE = /^(?:__[a-z_]+__|[A-Za-z0-9_.:-]+)$/;

const ROOM_KEYS = new Set(['x', 'z', 'w', 'd']);
const DOC_KEYS = new Set(['format', 'units', 'rooms']);

/** Thrown for every rejection, so a route maps one class to one status. */
export class LayoutInvalid extends Error {
	constructor(message, field = null) {
		super(message);
		this.name = 'LayoutInvalid';
		this.field = field;
	}
}

/**
 * Validate and normalize a layout document.
 *
 * Returns a NEW object built key by key from what was validated, never the
 * caller's object with extra keys deleted. That difference is the whole point:
 * an unknown key cannot survive a rebuild, and it can survive a delete list that
 * somebody forgets to extend.
 *
 * @param {unknown} input
 * @returns {{ format: number, units: 'm', rooms: Record<string, {x:number,z:number,w:number,d:number}> }}
 * @throws {LayoutInvalid}
 */
export function validateLayout(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new LayoutInvalid('A layout must be an object.');
	}

	for (const key of Object.keys(input)) {
		if (!DOC_KEYS.has(key)) throw new LayoutInvalid(`Unknown field "${key}" in the layout.`, key);
	}

	if (input.format != null && input.format !== LAYOUT_FORMAT) {
		throw new LayoutInvalid(`Unsupported layout format ${input.format}; this server writes ${LAYOUT_FORMAT}.`, 'format');
	}
	if (input.units != null && input.units !== 'm') {
		throw new LayoutInvalid('Layout units are metres; "m" is the only accepted value.', 'units');
	}

	const rooms = input.rooms;
	if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) {
		throw new LayoutInvalid('A layout needs a "rooms" object keyed by room id.', 'rooms');
	}

	const ids = Object.keys(rooms);
	if (ids.length > LIMITS.maxRooms) {
		throw new LayoutInvalid(`A layout holds at most ${LIMITS.maxRooms} rooms; this one has ${ids.length}.`, 'rooms');
	}

	const out = {};
	for (const id of ids) {
		if (id.length > LIMITS.maxIdLength || !ROOM_ID_RE.test(id)) {
			throw new LayoutInvalid(`"${id.slice(0, 40)}" is not a usable room id.`, `rooms.${id}`);
		}
		const room = rooms[id];
		if (!room || typeof room !== 'object' || Array.isArray(room)) {
			throw new LayoutInvalid(`Room "${id}" must be an object.`, `rooms.${id}`);
		}
		for (const key of Object.keys(room)) {
			if (!ROOM_KEYS.has(key)) throw new LayoutInvalid(`Unknown field "${key}" on room "${id}".`, `rooms.${id}.${key}`);
		}
		out[id] = {
			x: coord(room.x, `rooms.${id}.x`),
			z: coord(room.z, `rooms.${id}.z`),
			w: size(room.w, `rooms.${id}.w`),
			d: size(room.d, `rooms.${id}.d`),
		};
	}

	const doc = { format: LAYOUT_FORMAT, units: 'm', rooms: out };
	const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
	if (bytes > LIMITS.maxBytes) {
		throw new LayoutInvalid(`That layout is ${bytes} bytes; the limit is ${LIMITS.maxBytes}.`, 'rooms');
	}
	return doc;
}

function coord(value, field) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new LayoutInvalid(`${field} must be a finite number.`, field);
	if (Math.abs(n) > LIMITS.maxCoord) {
		throw new LayoutInvalid(`${field} is ${round(n)} m; the limit is ${LIMITS.maxCoord} m from the origin.`, field);
	}
	return round(n);
}

function size(value, field) {
	if (value == null) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n)) throw new LayoutInvalid(`${field} must be a finite number.`, field);
	if (n < LIMITS.minSize || n > LIMITS.maxSize) {
		throw new LayoutInvalid(`${field} is ${round(n)} m; a room is between ${LIMITS.minSize} and ${LIMITS.maxSize} m.`, field);
	}
	return round(n);
}

/** Centimetre precision. Nobody places a wall to a micrometre and floats drift. */
function round(n) {
	return Math.round(n * 100) / 100;
}

/**
 * The layout for a home, or null when nobody has authored one.
 *
 * Validated on the way OUT as well as in, because a row can predate a cap and a
 * renderer must never be handed a document this version would refuse to store.
 * A row that fails validation is reported as unreadable rather than thrown, so
 * one bad document degrades to the default arrangement instead of taking the
 * page down.
 *
 * @param {string} homeId
 * @returns {Promise<{ version: number, layout: object, updatedAt: string, updatedBy: string, unreadable?: string } | null>}
 */
export async function getLayout(homeId) {
	const [row] = await withDbRetry(
		() => sql`
			SELECT version, layout, updated_by, updated_at
			FROM home_layouts
			WHERE home_id = ${homeId}
		`,
	);
	if (!row) return null;
	try {
		return {
			version: row.version,
			layout: validateLayout(row.layout),
			updatedAt: row.updated_at,
			updatedBy: row.updated_by,
		};
	} catch (err) {
		return {
			version: row.version,
			layout: { format: LAYOUT_FORMAT, units: 'm', rooms: {} },
			updatedAt: row.updated_at,
			updatedBy: row.updated_by,
			unreadable: err.message,
		};
	}
}

/**
 * Write a layout, refusing a stale write.
 *
 * `expectedVersion` is the version the editor loaded. A write whose expectation
 * does not match the row is refused with the current document attached, so the
 * caller can show a real choice instead of a lost edit. A first write passes
 * `expectedVersion: 0`, which is also what a caller sends when it believes no
 * row exists; if one appeared in between, that is a conflict and it is reported
 * as one rather than overwritten.
 *
 * @returns {Promise<{ ok: true, version: number, layout: object } | { ok: false, conflict: true, current: object }>}
 */
export async function putLayout({ homeId, layout, updatedBy, expectedVersion }) {
	const doc = validateLayout(layout);
	const expected = Number.isFinite(expectedVersion) ? Number(expectedVersion) : 0;

	if (expected <= 0) {
		// A first write. ON CONFLICT DO NOTHING rather than upsert: if a row
		// appeared since the editor loaded, the caller's "there is nothing here"
		// is stale and they need to be told.
		const [inserted] = await withDbRetry(
			() => sql`
				INSERT INTO home_layouts (home_id, version, layout, updated_by)
				VALUES (${homeId}, 1, ${JSON.stringify(doc)}::jsonb, ${updatedBy})
				ON CONFLICT (home_id) DO NOTHING
				RETURNING version, layout
			`,
		);
		if (inserted) return { ok: true, version: inserted.version, layout: doc };
		return { ok: false, conflict: true, current: await getLayout(homeId) };
	}

	const [updated] = await withDbRetry(
		() => sql`
			UPDATE home_layouts
			SET layout = ${JSON.stringify(doc)}::jsonb,
			    version = version + 1,
			    updated_by = ${updatedBy},
			    updated_at = now()
			WHERE home_id = ${homeId} AND version = ${expected}
			RETURNING version, layout
		`,
	);
	if (updated) return { ok: true, version: updated.version, layout: doc };
	return { ok: false, conflict: true, current: await getLayout(homeId) };
}

/** Remove the authored layout. The scene falls back to the default arrangement. */
export async function deleteLayout(homeId) {
	const rows = await withDbRetry(
		() => sql`DELETE FROM home_layouts WHERE home_id = ${homeId} RETURNING home_id`,
	);
	return rows.length > 0;
}

/**
 * Which authored rooms no longer exist in the house, and which house rooms have
 * never been placed.
 *
 * Both are ordinary states rather than errors: an area deleted in Home Assistant
 * leaves an orphan, and a new area appears unplaced. The editor needs to show
 * each of them, and the renderer needs to ignore orphans without discarding the
 * user's other work.
 *
 * @param {object} layoutDoc a validated document
 * @param {object} graph the room graph
 */
export function reconcileLayout(layoutDoc, graph) {
	const placed = new Set(Object.keys(layoutDoc?.rooms || {}));
	const live = new Set();
	for (const room of graph?.rooms || []) live.add(room.id);
	if ((graph?.unassigned || []).length) live.add('__unassigned__');

	return {
		orphaned: [...placed].filter((id) => !live.has(id)).sort(),
		unplaced: [...live].filter((id) => !placed.has(id)).sort(),
	};
}
