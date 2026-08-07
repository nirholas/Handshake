// Plaza stage identity — the deterministic bridge between a /play coin world and
// its Living Stage (stage_world room + the /api/stage record).
//
// A coin world has no stage column to look up and no directory to search: the
// world client must know, offline and before any network call, WHICH stage room
// belongs to the plaza it is standing in. So the id is DERIVED, not discovered:
//
//     plazaStageId(mint) = uuidv5(`three.ws:plaza:<mint>`, PLAZA_STAGE_NAMESPACE)
//
// UUIDv5 is a pure function of (namespace, name), so the browser, the three.ws
// API, and anyone reading a URL all compute the same id from the same mint with
// no shared state. It is a real UUID, so it satisfies `isUuid` and drops
// straight into `stages.id` (the plaza claim in api/stage/index.js inserts the
// row AT this id) and into Colyseus's filterBy(['stageId']) matching, which is
// what puts every attendee of a given coin's plaza in one show.
//
// Imported by the browser client (src/game/plaza-stage.js) and the three.ws API
// (api/stage/index.js), both of which resolve `uuid` from the repo root. The
// Colyseus server never derives an id — it is handed one on join — so this file
// deliberately adds no dependency to the multiplayer workspace. It lives here,
// beside world-features.js, because it is the same kind of thing: one source of
// truth that the world and the platform must agree on exactly.

import { v5 as uuidv5 } from 'uuid';

// Fixed namespace for three.ws plaza stages. NEVER change this: every claimed
// plaza stage row is keyed by an id derived under it, so a new namespace would
// orphan every existing stage.
export const PLAZA_STAGE_NAMESPACE = 'b7b217d3-5802-44f6-a011-6c6f7afeef5d';

// The mainland / home-town world has no coin mint of its own; give it a stable
// name of its own rather than deriving every mintless world to the same id by
// accident.
export const MAINLAND_PLAZA_KEY = 'mainland';

/** The UUIDv5 *name* a coin world's plaza hashes under. Exported for tests. */
export function plazaStageKey(mint) {
	const m = typeof mint === 'string' ? mint.trim() : '';
	return `three.ws:plaza:${m || MAINLAND_PLAZA_KEY}`;
}

/**
 * The stage id for a coin world's plaza. Deterministic, isomorphic, and a valid
 * UUID — the same value on the client, in the API, and in the database.
 * @param {string} mint  the world's coin mint ('' / null ⇒ the mainland world)
 * @returns {string} UUIDv5
 */
export function plazaStageId(mint) {
	return uuidv5(plazaStageKey(mint), PLAZA_STAGE_NAMESPACE);
}

/** True when `id` is exactly the plaza stage id derived from `mint`. */
export function isPlazaStageId(id, mint) {
	return typeof id === 'string' && !!id && id === plazaStageId(mint);
}
