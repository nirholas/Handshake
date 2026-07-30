// Tests for /api/x402/dance-tip — the Pole Club tip endpoint.
//
// Pure-logic only — we exercise the exported helpers (STYLES, pickStyle,
// pickDancer, buildTicket, BAZAAR_SCHEMA) rather than the paidEndpoint HTTP
// wrapper. That keeps tests off the network and off the database while still
// covering everything the wire format depends on.
//
// Coverage:
//   • STYLES keys + shape (free-floor single-clip vs. pole sequence styles)
//   • pickStyle resolves both shapes and rejects unknown styles
//   • pickDancer enforces the slot allowlist
//   • buildTicket emits `sequence` for sequence styles and omits it otherwise
//   • The bazaar schema advertises the new `dance` enum values + sequence shape

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	STYLES,
	pickStyle,
	pickDancer,
	buildTicket,
	BAZAAR_SCHEMA,
} from '../../api/x402/dance-tip.js';

const FREE_FLOOR_KEYS = ['hiphop', 'rumba', 'silly', 'thriller', 'capoeira'];
const POLE_KEYS = ['spin', 'climb', 'combo'];

describe('STYLES — registry', () => {
	it('keeps the existing free-floor single-clip styles', () => {
		for (const key of FREE_FLOOR_KEYS) {
			const style = STYLES[key];
			expect(style, `${key} missing from STYLES`).toBeTruthy();
			expect(typeof style.clip).toBe('string');
			expect(style.loop).toBe(true);
			expect(typeof style.durationSec).toBe('number');
			expect(style.sequence).toBeUndefined();
		}
	});

	it('declares the three choreographed sequence styles', () => {
		for (const key of POLE_KEYS) {
			const style = STYLES[key];
			expect(style, `${key} missing from STYLES`).toBeTruthy();
			expect(Array.isArray(style.sequence)).toBe(true);
			expect(style.sequence.length).toBeGreaterThan(0);
			expect(style.track).toBe('pole');
			expect(typeof style.label).toBe('string');
			// Each step must name a clip + a positive duration so playSequence
			// has something to crossfade to and a non-zero sleep between steps.
			for (const step of style.sequence) {
				expect(typeof step.clip).toBe('string');
				expect(step.clip.length).toBeGreaterThan(0);
				expect(step.durationSec).toBeGreaterThan(0);
			}
			// durationSec must equal the sum of the steps so the ticket's
			// endsAt and the audio loop stay aligned with the choreography.
			const total = style.sequence.reduce((acc, s) => acc + s.durationSec, 0);
			expect(total, `${key} durationSec must equal its step sum`).toBe(style.durationSec);
		}
	});

	// Invariant that would have caught the shipped-but-unperformable bug: every
	// clip a paid style chains MUST be a real, deployed manifest clip the dancer
	// rig can drive — otherwise the tip settles and the dancer stands frozen.
	// `idle`/`walk` are stage transitions, not danceable styles, so they're not
	// valid routine clips.
	it('only references clips that exist in the deployed animation manifest', () => {
		// Read the shipped manifest rather than a hand-kept list: a hardcoded set
		// goes stale the moment a new routine is added, which turns this guard
		// into a false alarm instead of the real check its name promises.
		const manifest = JSON.parse(
			readFileSync(new URL('../../public/animations/manifest.json', import.meta.url), 'utf8'),
		);
		const entries = Array.isArray(manifest) ? manifest : manifest.animations || manifest.clips || [];
		const PERFORMABLE = new Set(entries.map((a) => a.name || a.id).filter(Boolean));
		// `idle`/`walk` ship in the manifest as stage transitions, so exclude them:
		// a paid routine that only stands or walks is the frozen-dancer bug.
		PERFORMABLE.delete('idle');
		PERFORMABLE.delete('walk');
		for (const [key, style] of Object.entries(STYLES)) {
			const clips = style.sequence ? style.sequence.map((s) => s.clip) : [style.clip];
			for (const clip of clips) {
				expect(PERFORMABLE.has(clip), `${key} references undeployed clip "${clip}"`).toBe(true);
			}
		}
	});

	it('spin chains capoeira → dance', () => {
		expect(STYLES.spin.sequence).toEqual([
			{ clip: 'capoeira', durationSec: 6 },
			{ clip: 'dance',    durationSec: 4 },
		]);
		expect(STYLES.spin.durationSec).toBe(10);
	});

	it('climb chains thriller → capoeira → dance', () => {
		expect(STYLES.climb.sequence).toEqual([
			{ clip: 'thriller', durationSec: 7 },
			{ clip: 'capoeira', durationSec: 4 },
			{ clip: 'dance',    durationSec: 3 },
		]);
		expect(STYLES.climb.durationSec).toBe(14);
	});

	it('combo chains rumba → capoeira → thriller → silly → dance', () => {
		expect(STYLES.combo.sequence.map((s) => s.clip)).toEqual([
			'rumba',
			'capoeira',
			'thriller',
			'silly',
			'dance',
		]);
		expect(STYLES.combo.durationSec).toBe(18);
		// Sum of step durations matches the advertised total.
		const total = STYLES.combo.sequence.reduce((acc, s) => acc + s.durationSec, 0);
		expect(total).toBe(18);
	});

	it('STYLES is frozen so the bazaar enum cannot drift at runtime', () => {
		expect(Object.isFrozen(STYLES)).toBe(true);
	});
});

describe('pickStyle', () => {
	it('returns a normalized descriptor for a free-floor style', () => {
		const s = pickStyle('rumba');
		expect(s.key).toBe('rumba');
		expect(s.clip).toBe('rumba');
		expect(s.loop).toBe(true);
		expect(s.durationSec).toBe(14);
		expect(s.track).toBe('rumba');
		expect(s.sequence).toBeUndefined();
	});

	it('returns sequence + first-step clip for a choreographed style', () => {
		const s = pickStyle('spin');
		expect(s.key).toBe('spin');
		expect(s.clip).toBe('capoeira'); // first step lifted as legacy `clip`
		expect(s.loop).toBe(false);
		expect(s.track).toBe('pole');
		expect(s.sequence).toEqual([
			{ clip: 'capoeira', durationSec: 6 },
			{ clip: 'dance',    durationSec: 4 },
		]);
	});

	it('lowercases + trims user input before lookup', () => {
		expect(pickStyle('  SPIN  ').key).toBe('spin');
		expect(pickStyle('Rumba').key).toBe('rumba');
	});

	it('throws unknown_dance with status=400 for unregistered names', () => {
		const calls = [
			() => pickStyle('breakdance'),
			() => pickStyle(''),
			() => pickStyle(null),
			() => pickStyle(undefined),
		];
		for (const fn of calls) {
			let caught;
			try { fn(); } catch (e) { caught = e; }
			expect(caught).toBeInstanceOf(Error);
			expect(caught.status).toBe(400);
			expect(caught.code).toBe('unknown_dance');
			// The error message enumerates valid styles so the caller can recover.
			expect(caught.message).toMatch(/spin/);
			expect(caught.message).toMatch(/rumba/);
		}
	});
});

describe('pickDancer', () => {
	it('accepts the four stage slot ids', () => {
		for (const id of ['1', '2', '3', '4']) {
			expect(pickDancer(id)).toBe(id);
		}
	});

	it('rejects anything outside the allowlist with status=400', () => {
		const bad = ['0', '5', 'one', '', null, undefined, '  '];
		for (const v of bad) {
			let caught;
			try { pickDancer(v); } catch (e) { caught = e; }
			expect(caught, `expected throw for ${JSON.stringify(v)}`).toBeInstanceOf(Error);
			expect(caught.status).toBe(400);
			expect(caught.code).toBe('unknown_dancer');
		}
	});

	it('trims numeric strings before validation', () => {
		expect(pickDancer(' 2 ')).toBe('2');
	});
});

describe('buildTicket', () => {
	const REQUIREMENT = {
		network: 'solana',
		amount: '1000',
		asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	};

	it('emits a single-clip ticket without a sequence field for free-floor styles', () => {
		const style = pickStyle('rumba');
		const now = new Date('2026-05-21T00:00:00.000Z');
		const ticket = buildTicket({
			dancer: '2',
			style,
			now,
			payer: 'wwwPqsM4',
			requirement: REQUIREMENT,
			ticketId: 'tkt-1',
		});
		expect(ticket.ok).toBe(true);
		expect(ticket.ticketId).toBe('tkt-1');
		expect(ticket.dance).toBe('rumba');
		expect(ticket.clip).toBe('rumba');
		expect(ticket.loop).toBe(true);
		expect(ticket.durationSec).toBe(14);
		expect(ticket.track).toBe('rumba');
		expect(ticket.sequence).toBeUndefined();
		expect(ticket.startsAt).toBe('2026-05-21T00:00:00.000Z');
		expect(ticket.endsAt).toBe('2026-05-21T00:00:14.000Z');
		expect(ticket.network).toBe('solana');
		expect(ticket.amountAtomics).toBe('1000');
	});

	it('emits a sequence ticket for pole styles with the chain attached', () => {
		const style = pickStyle('climb');
		const ticket = buildTicket({
			dancer: '3',
			style,
			now: new Date('2026-05-21T00:00:00.000Z'),
			payer: 'wwwPqsM4',
			requirement: REQUIREMENT,
			ticketId: 'tkt-2',
		});
		expect(ticket.dance).toBe('climb');
		// `clip` carries the first step's clip for legacy consumers + the
		// club_tips ledger row.
		expect(ticket.clip).toBe('thriller');
		expect(ticket.loop).toBe(false);
		expect(ticket.durationSec).toBe(14);
		expect(ticket.track).toBe('pole');
		expect(ticket.sequence).toEqual([
			{ clip: 'thriller', durationSec: 7 },
			{ clip: 'capoeira', durationSec: 4 },
			{ clip: 'dance',    durationSec: 3 },
		]);
		expect(ticket.endsAt).toBe('2026-05-21T00:00:14.000Z');
	});

	it('defaults payer + requirement fields to null when absent', () => {
		const ticket = buildTicket({
			dancer: '1',
			style: pickStyle('hiphop'),
			ticketId: 'tkt-3',
		});
		expect(ticket.payer).toBe(null);
		expect(ticket.network).toBe(null);
		expect(ticket.amountAtomics).toBe(null);
		expect(ticket.asset).toBe(null);
	});

	it('flags pole styles so the stage turns the dancer into the pole', () => {
		const ticket = buildTicket({
			dancer: '1',
			style: pickStyle('twerk'),
			ticketId: 'tkt-4',
		});
		expect(ticket.dance).toBe('twerk');
		expect(ticket.clip).toBe('twerk');
		expect(ticket.pole).toBe(true);
		// Single-clip pole style — no choreographed chain.
		expect(ticket.sequence).toBeUndefined();
	});

	it('omits the pole flag entirely for free-floor styles', () => {
		const ticket = buildTicket({
			dancer: '1',
			style: pickStyle('rumba'),
			ticketId: 'tkt-5',
		});
		expect(ticket.pole).toBeUndefined();
	});
});

describe('twerk — pole style', () => {
	it('is a single-clip, looping pole style on a real manifest clip', () => {
		const style = STYLES.twerk;
		expect(style).toBeTruthy();
		expect(style.clip).toBe('twerk');
		expect(style.loop).toBe(true);
		expect(style.pole).toBe(true);
		expect(style.sequence).toBeUndefined();
	});

	it('pickStyle surfaces the pole flag', () => {
		expect(pickStyle('twerk').pole).toBe(true);
		// Free-floor + sequence styles report pole: false.
		expect(pickStyle('rumba').pole).toBe(false);
		expect(pickStyle('spin').pole).toBe(false);
	});

	it('is advertised in the input `dance` enum', () => {
		expect(JSON.stringify(BAZAAR_SCHEMA.schema)).toContain('"twerk"');
	});
});

describe('Bazaar discovery schema', () => {
	it('marks the endpoint as delisted (internal-use, not agent-discoverable)', () => {
		expect(BAZAAR_SCHEMA.discoverable).toBe(false);
	});

	it("advertises every STYLES key in the input `dance` enum", () => {
		// The bazaar schema wraps the inner queryParams JSON Schema — locate
		// the `dance` property however the wrapper nests it.
		const wireSchema = JSON.stringify(BAZAAR_SCHEMA.schema);
		for (const key of [...FREE_FLOOR_KEYS, ...POLE_KEYS]) {
			expect(wireSchema, `dance enum missing "${key}"`).toContain(`"${key}"`);
		}
	});

	it('advertises the sequence ticket shape (clip + durationSec items)', () => {
		const wireSchema = JSON.stringify(BAZAAR_SCHEMA.schema);
		// The output schema lists a `sequence` array of {clip, durationSec}.
		expect(wireSchema).toContain('"sequence"');
		expect(wireSchema).toContain('"clip"');
		expect(wireSchema).toContain('"durationSec"');
	});

	it('exposes a sequence-style OUTPUT_EXAMPLE so bazaar clients see the shape', () => {
		const example = BAZAAR_SCHEMA.info.output.example;
		expect(example.ok).toBe(true);
		expect(Array.isArray(example.sequence)).toBe(true);
		expect(example.sequence.length).toBeGreaterThan(0);
	});
});
