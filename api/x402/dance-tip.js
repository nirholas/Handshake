// GET /api/x402/dance-tip?dancer=<id>&dance=<style>
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For $0.001 USDC the caller
// books one dance performance on the three.ws club stage. The /club page
// uses this from the browser via window.X402.pay — when the payment settles,
// the named dancer steps onto the stage and performs the requested style for
// a fixed duration. Agents can also call it programmatically with @x402/fetch
// to drive scripted performances.
//
// Two style shapes are exposed:
//   • single-clip styles  → { clip, label, loop, durationSec, track }
//   • sequence styles     → { sequence: [{ clip, durationSec }, …], label, durationSec, track }
// The settled ticket includes `sequence` when applicable so the /club page
// can chain crossfades; `clip` is always populated (sequence styles surface
// the first step's clip there for legacy single-clip consumers and for the
// club_tips ledger column).

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/dance-tip';

const DESCRIPTION =
	'three.ws club stage — tip a dancer to perform one routine on the 3D ' +
	'stage. Pay $0.001 USDC per performance. Pick a dancer slot (1-4) and a ' +
	'dance style (free-floor: rumba, silly, thriller, capoeira, hiphop; ' +
	'pole choreography: spin, climb, combo). The settled call returns a ' +
	'performance ticket the /club page consumes to spawn the dancer and play ' +
	'the routine — sequence styles chain multiple clips back-to-back.';

// `track` names map to /public/club/audio/<track>.{ogg,mp3} loops the /club
// page crossfades to when the dance starts. The client picks whichever format
// the browser supports — see src/club-audio.js loadBuffer().
export const STYLES = Object.freeze({
	// Free-floor (existing) — single clip looped for the full duration.
	hiphop:   { clip: 'dance',    label: 'Hip Hop',  loop: true, durationSec: 12, track: 'hiphop' },
	rumba:    { clip: 'rumba',    label: 'Rumba',    loop: true, durationSec: 14, track: 'rumba' },
	silly:    { clip: 'silly',    label: 'Silly',    loop: true, durationSec: 10, track: 'silly' },
	thriller: { clip: 'thriller', label: 'Thriller', loop: true, durationSec: 14, track: 'thriller' },
	capoeira: { clip: 'capoeira', label: 'Capoeira', loop: true, durationSec: 12, track: 'capoeira' },

	// Pole choreography (new) — sequences chain clips at PoleStation playback
	// time. The `pole-*` clips live in /public/animations/clips/. The audio
	// loop crossfades to the dedicated `pole` track.
	spin: {
		label: 'Pole Spin',
		durationSec: 10,
		track: 'pole',
		sequence: [
			{ clip: 'pole-spin', durationSec: 8 },
			{ clip: 'pole-bow',  durationSec: 2 },
		],
	},
	climb: {
		label: 'Climb + Invert',
		durationSec: 13,
		track: 'pole',
		sequence: [
			{ clip: 'pole-climb',  durationSec: 5 },
			{ clip: 'pole-invert', durationSec: 6 },
			{ clip: 'pole-bow',    durationSec: 2 },
		],
	},
	combo: {
		label: 'Combo',
		durationSec: 18,
		track: 'pole',
		sequence: [
			{ clip: 'pole-spin',      durationSec: 4 },
			{ clip: 'pole-climb',     durationSec: 4 },
			{ clip: 'pole-invert',    durationSec: 4 },
			{ clip: 'pole-floorwork', durationSec: 4 },
			{ clip: 'pole-bow',       durationSec: 2 },
		],
	},
});

const VALID_DANCERS = new Set(['1', '2', '3', '4']);

const INPUT_EXAMPLE = { dancer: '1', dance: 'rumba' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['dancer', 'dance'],
	properties: {
		dancer: {
			type: 'string',
			enum: ['1', '2', '3', '4'],
			description: 'Stage slot 1-4 — which dancer takes the stage.',
		},
		dance: {
			type: 'string',
			enum: Object.keys(STYLES),
			description:
				'Performance style. Free-floor styles map to a single clip in ' +
				'/animations/manifest.json. Sequence styles (spin, climb, combo) ' +
				'chain multiple pole-* clips back-to-back.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	ticketId: 'a3f3d6c2-1f1b-4f10-9b6c-1b1f5e0c9c34',
	dancer: '1',
	dance: 'spin',
	clip: 'pole-spin',
	label: 'Pole Spin',
	loop: false,
	durationSec: 10,
	track: 'pole',
	sequence: [
		{ clip: 'pole-spin', durationSec: 8 },
		{ clip: 'pole-bow',  durationSec: 2 },
	],
	startsAt: '2026-05-21T18:42:09.000Z',
	endsAt:   '2026-05-21T18:42:19.000Z',
	payer: 'wwwPqsM4N7T9J69tB82nLyzxqsH159j4orftLTQfUGV',
	network: 'solana',
	amountAtomics: '1000',
	asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'ticketId', 'dancer', 'dance', 'clip', 'durationSec', 'startsAt', 'endsAt', 'track'],
	properties: {
		ok: { type: 'boolean', const: true },
		ticketId: { type: 'string', format: 'uuid' },
		dancer: { type: 'string', enum: ['1', '2', '3', '4'] },
		dance: { type: 'string', enum: Object.keys(STYLES) },
		clip: { type: 'string' },
		label: { type: 'string' },
		loop: { type: 'boolean' },
		durationSec: { type: 'integer', minimum: 1, maximum: 60 },
		track: {
			type: 'string',
			enum: ['rumba', 'silly', 'thriller', 'capoeira', 'hiphop', 'pole'],
			description: 'Audio loop name — /public/club/audio/<track>.{ogg,mp3}.',
		},
		sequence: {
			type: 'array',
			description:
				'Present for sequence styles (spin, climb, combo). Each step is a ' +
				'clip name + duration in seconds; the /club page crossfades them in order.',
			items: {
				type: 'object',
				required: ['clip', 'durationSec'],
				properties: {
					clip: { type: 'string' },
					durationSec: { type: 'number', minimum: 0.1, maximum: 60 },
				},
			},
		},
		startsAt: { type: 'string', format: 'date-time' },
		endsAt:   { type: 'string', format: 'date-time' },
		payer:    { type: ['string', 'null'] },
		network:  { type: ['string', 'null'] },
		amountAtomics: { type: ['string', 'null'] },
		asset:    { type: ['string', 'null'] },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'GET', queryParams: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

/**
 * Resolve a raw `dance` query value to a normalized style descriptor.
 * Throws `Error` with status=400 / code='unknown_dance' when the style is
 * not registered.
 *
 * For sequence styles, `clip` is the first step's clip (so single-clip
 * consumers — and the `club_tips.clip` column — still have something
 * meaningful) and `sequence` is the chain.
 */
export function pickStyle(name) {
	const key = String(name || '').trim().toLowerCase();
	const style = STYLES[key];
	if (!style) {
		const err = new Error(
			`unknown dance "${name}". Pick one of: ${Object.keys(STYLES).join(', ')}.`,
		);
		err.status = 400;
		err.code = 'unknown_dance';
		throw err;
	}
	const firstClip = style.clip ?? style.sequence?.[0]?.clip ?? null;
	return {
		key,
		label: style.label,
		durationSec: style.durationSec,
		track: style.track,
		clip: firstClip,
		loop: style.loop ?? false,
		sequence: style.sequence,
	};
}

/**
 * Validate a `dancer` query value against the stage slot allowlist.
 * Throws `Error` with status=400 / code='unknown_dancer'.
 */
export function pickDancer(raw) {
	const id = String(raw ?? '').trim();
	if (VALID_DANCERS.has(id)) return id;
	const err = new Error(`dancer must be one of 1, 2, 3, 4 — got "${raw}"`);
	err.status = 400;
	err.code = 'unknown_dancer';
	throw err;
}

/**
 * Build the ticket body returned on a settled tip. Pure — no I/O. Exported
 * so tests can exercise the full ticket shape without going through the
 * paidEndpoint HTTP wrapper.
 */
export function buildTicket({ dancer, style, now = new Date(), payer = null, requirement = null, ticketId = null }) {
	const ends = new Date(now.getTime() + style.durationSec * 1000);
	const ticket = {
		ok: true,
		ticketId: ticketId ?? crypto.randomUUID(),
		dancer,
		dance: style.key,
		clip: style.clip,
		label: style.label,
		loop: style.loop,
		durationSec: style.durationSec,
		track: style.track,
		startsAt: now.toISOString(),
		endsAt:   ends.toISOString(),
		payer,
		network: requirement?.network ?? null,
		amountAtomics: requirement?.amount ?? null,
		asset:   requirement?.asset ?? null,
	};
	if (style.sequence) ticket.sequence = style.sequence;
	return ticket;
}

export const BAZAAR_SCHEMA = BAZAAR;

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('dance-tip', '1000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Club Stage',
		tags: ['3d', 'dance', 'club', 'tip', 'entertainment'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	siwx: {
		statement: 'Sign in to retrigger a dance you already tipped for.',
		// Permanent grant — once a wallet has tipped on this endpoint, it can
		// retrigger any (dancer, dance) combo for free. The ticket itself is
		// still per-performance (new ticketId each call); SIWX only skips the
		// payment step, the handler still issues a fresh ticket each call.
		ttlSeconds: null,
		expirationSeconds: 300,
	},
	async handler({ req, requirement, payer, bypass }) {
		const dancer = pickDancer(req.query?.dancer);
		const style = pickStyle(req.query?.dance);
		const ticketId = crypto.randomUUID();
		const now = new Date();
		// Bypass callers don't carry a paid `requirement`; mark the ticket so the
		// club_tips ledger + live feed can distinguish free passes from real tips.
		const ticket = buildTicket({
			dancer,
			style,
			now,
			ticketId,
			payer: payer ?? (bypass ? bypass.callerId : null),
			requirement,
		});
		if (bypass) ticket.bypass = bypass.reason;

		// Fire-and-forget: the caller has already paid + the payment is settled
		// by the time we reach this handler. A Neon hiccup must not surface as
		// a 5xx on the dance-tip response — the /api/club/tips backfill will
		// recover from a missing row at worst. Sequence steps aren't persisted
		// — they're deterministic from `dance` + STYLES — but `clip` holds the
		// first step's clip so the live-feed UI has something to display.
		sql`
			insert into club_tips
				(ticket_id, dancer, dance, clip, label, payer, network,
				 amount_atomics, asset, started_at, ends_at)
			values
				(${ticketId}, ${ticket.dancer}, ${ticket.dance}, ${ticket.clip}, ${ticket.label},
				 ${ticket.payer}, ${ticket.network},
				 ${ticket.amountAtomics}, ${ticket.asset},
				 ${ticket.startsAt}, ${ticket.endsAt})
			on conflict (ticket_id) do nothing
		`.catch((err) => console.error('[club-tips] insert failed', err?.message || err));

		return ticket;
	},
});
