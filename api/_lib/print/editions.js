// @ts-check
// Edition scarcity for Materialize prints.
//
// A print is a collectible only if its supply is knowable. The creator of a
// forge model sets one number: how many physical copies of it may ever exist.
// Null (every model's default) is an open edition, which is the honest state
// for a model nobody has capped, not a missing value to be filled in later.
//
// The cap is read in two places and written in one:
//   - the quote path calls assertEditionAvailable() BEFORE any money moves, so
//     a sold-out model refuses at the price, never after the payment;
//   - the certificate issuer claims the next edition number atomically at ship
//     time (api/_lib/print/certificate.js) and freezes the cap onto the row,
//   - the creator sets it through setEditionLimit(), which refuses to cap a
//     series below what has already shipped.
//
// The series a number is claimed from is NOT always a creation: a direct GLB
// upload has no forge row. Those series are keyed by the content hash, so two
// prints of identical bytes belong to one series rather than each minting its
// own "edition 1 of 1".

import { sql } from '../db.js';

export const EDITION_LIMIT_MIN = 1;
export const EDITION_LIMIT_MAX = 10_000;

/** Typed failure so handlers can map a cause to a status code and a message. */
export class PrintEditionError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [extra]
	 */
	constructor(code, message, extra = {}) {
		super(message);
		this.name = 'PrintEditionError';
		this.code = code;
		Object.assign(this, extra);
	}
}

/**
 * The key a series of editions is numbered under.
 * @param {{ creationId?: string|null, glbSha256?: string|null }} input
 * @returns {string}
 */
export function seriesKeyFor({ creationId = null, glbSha256 = null }) {
	if (creationId) return String(creationId);
	if (glbSha256 && /^[0-9a-f]{64}$/.test(glbSha256)) return `sha256:${glbSha256}`;
	throw new PrintEditionError(
		'series_key_underivable',
		'an edition series needs either a creation id or the printed asset hash',
	);
}

/**
 * Normalize a caller-supplied cap. Accepts null/'' (open edition) and refuses
 * anything that is not a whole number inside the allowed band, so the column
 * constraint is never the first thing a user hears about.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function normalizeEditionLimit(raw) {
	if (raw === null || raw === undefined || raw === '') return null;
	const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
	if (!Number.isInteger(n)) {
		throw new PrintEditionError('edition_limit_invalid', 'edition size must be a whole number');
	}
	if (n < EDITION_LIMIT_MIN || n > EDITION_LIMIT_MAX) {
		throw new PrintEditionError(
			'edition_limit_out_of_range',
			`edition size must be between ${EDITION_LIMIT_MIN} and ${EDITION_LIMIT_MAX}`,
		);
	}
	return n;
}

/**
 * How many certificates a series has already issued.
 * @param {string} seriesKey
 * @returns {Promise<number>}
 */
export async function issuedCount(seriesKey) {
	const [row] = await sql`
		select count(*)::int as n from print_certificates where series_key = ${seriesKey}
	`;
	return row?.n ?? 0;
}

/**
 * The cap a creation currently declares, or null for an open edition.
 * @param {string|null} creationId
 * @returns {Promise<number|null>}
 */
export async function editionLimitFor(creationId) {
	if (!creationId) return null;
	const [row] = await sql`
		select print_edition_limit from forge_creations where id = ${creationId} limit 1
	`;
	return row?.print_edition_limit ?? null;
}

/**
 * Everything a surface needs to render scarcity: the cap, what is gone, and
 * what is left. `limit: null` means open, and `remaining` is null with it.
 * @param {{ creationId?: string|null, glbSha256?: string|null }} input
 * @returns {Promise<{ seriesKey: string, limit: number|null, issued: number, remaining: number|null, soldOut: boolean }>}
 */
export async function editionState({ creationId = null, glbSha256 = null }) {
	const seriesKey = seriesKeyFor({ creationId, glbSha256 });
	const [limit, issued] = await Promise.all([editionLimitFor(creationId), issuedCount(seriesKey)]);
	const remaining = limit === null ? null : Math.max(0, limit - issued);
	return { seriesKey, limit, issued, remaining, soldOut: remaining !== null && remaining <= 0 };
}

/**
 * The quote-time gate. Throws PrintEditionError('edition_sold_out') when the
 * requested quantity cannot be served by what is left of the series.
 *
 * Deliberately runs against issued certificates rather than open orders: an
 * order that never ships releases its slot, so a cancelled checkout can never
 * strand the last copy of a 25-piece edition.
 *
 * @param {{ creationId?: string|null, glbSha256?: string|null, quantity?: number }} input
 * @returns {Promise<{ seriesKey: string, limit: number|null, issued: number, remaining: number|null, soldOut: boolean }>}
 */
export async function assertEditionAvailable({ creationId = null, glbSha256 = null, quantity = 1 }) {
	const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
	const state = await editionState({ creationId, glbSha256 });
	if (state.limit === null) return state;
	if (state.remaining !== null && state.remaining < qty) {
		throw new PrintEditionError(
			'edition_sold_out',
			state.remaining === 0
				? `This edition is sold out. All ${state.limit} copies have shipped.`
				: `Only ${state.remaining} of this ${state.limit}-piece edition ${state.remaining === 1 ? 'is' : 'are'} left, so ${qty} cannot be ordered.`,
			{ limit: state.limit, issued: state.issued, remaining: state.remaining },
		);
	}
	return state;
}

/**
 * Set (or clear) a creation's edition cap. Owner-only: the caller must be the
 * signed-in creator, or, for a model forged before sign-in existed on that
 * browser, the browser that forged it.
 *
 * A cap below what already shipped is refused rather than silently clamped:
 * shrinking a series under its own history would make an already-printed
 * certificate read "edition 7 of 5".
 *
 * @param {{ creationId: string, userId?: string|null, clientKey?: string|null, limit: unknown }} input
 */
export async function setEditionLimit({ creationId, userId = null, clientKey = null, limit }) {
	const value = normalizeEditionLimit(limit);
	const [creation] = await sql`
		select id, user_id, client_key, glb_url, status
		from forge_creations where id = ${creationId} limit 1
	`;
	if (!creation) throw new PrintEditionError('creation_not_found', 'no such model');

	const ownedByUser = Boolean(userId) && creation.user_id === userId;
	const ownedByBrowser = !creation.user_id && Boolean(clientKey) && creation.client_key === clientKey;
	if (!ownedByUser && !ownedByBrowser) {
		throw new PrintEditionError('not_creation_owner', 'only the creator of this model can set its edition size');
	}

	const issued = await issuedCount(seriesKeyFor({ creationId }));
	if (value !== null && value < issued) {
		throw new PrintEditionError(
			'edition_limit_below_issued',
			`${issued} ${issued === 1 ? 'copy has' : 'copies have'} already shipped, so the edition cannot be capped below ${issued}.`,
			{ issued },
		);
	}

	await sql`update forge_creations set print_edition_limit = ${value}, updated_at = now() where id = ${creationId}`;
	return editionState({ creationId });
}
