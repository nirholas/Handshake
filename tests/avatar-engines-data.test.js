/**
 * Avatar Engines Atlas — dataset integrity tests.
 *
 * The /avatar-engines page renders straight from avatar-engines-data.js, so the
 * data IS the product. These tests guard the invariants the page relies on:
 * unique ids, valid enum fields, real links, and the licensing rule that keeps
 * non-commercial research engines out of the commercial generation pipeline.
 */

import { describe, it, expect } from 'vitest';
import {
	ENGINES,
	FAMILIES,
	INTEGRATIONS,
	REPRESENTATIONS,
	enginesByFamily,
	engineStats,
	isRetired,
} from '../src/avatar-engines-data.js';

const FAMILY_IDS = new Set(FAMILIES.map((f) => f.id));
const INTEGRATION_IDS = new Set(Object.keys(INTEGRATIONS));
const REP_IDS = new Set(Object.keys(REPRESENTATIONS));

describe('avatar-engines dataset', () => {
	it('has a healthy number of engines across every family', () => {
		expect(ENGINES.length).toBeGreaterThanOrEqual(20);
		for (const fam of FAMILIES) {
			expect(enginesByFamily(fam.id).length, `family ${fam.id} should not be empty`).toBeGreaterThan(0);
		}
	});

	it('has unique ids', () => {
		const ids = ENGINES.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every engine has valid enum fields and required text', () => {
		for (const e of ENGINES) {
			expect(FAMILY_IDS.has(e.family), `${e.id}: bad family ${e.family}`).toBe(true);
			expect(REP_IDS.has(e.representation), `${e.id}: bad representation ${e.representation}`).toBe(true);
			expect(INTEGRATION_IDS.has(e.integration), `${e.id}: bad integration ${e.integration}`).toBe(true);
			expect(typeof e.commercial, `${e.id}: commercial must be boolean`).toBe('boolean');
			for (const field of ['name', 'org', 'input', 'output', 'license', 'compute', 'blurb', 'integrationNote', 'venue']) {
				expect(typeof e[field], `${e.id}: missing ${field}`).toBe('string');
				expect(e[field].length, `${e.id}: empty ${field}`).toBeGreaterThan(0);
			}
			expect(Number.isInteger(e.year), `${e.id}: year`).toBe(true);
		}
	});

	it('every engine links to a real repo and an http(s) or internal demo', () => {
		for (const e of ENGINES) {
			expect(e.links?.repo, `${e.id}: no repo`).toMatch(/^https?:\/\//);
			if (e.links?.paper) expect(e.links.paper).toMatch(/^https?:\/\//);
			if (e.links?.docs) expect(e.links.docs).toMatch(/^https?:\/\//);
			if (e.links?.demo) expect(e.links.demo).toMatch(/^(https?:\/\/|\/)/);
		}
	});

	it('a link labelled Paper points at a paper, not at a project homepage', () => {
		// The card labels links.paper "Paper". A docs site or a marketing homepage
		// parked in that field tells the reader they are opening something they
		// are not; those belong in links.docs, which renders as "Docs".
		const PAPER_HOSTS = /(arxiv\.org|\.pdf$|doi\.org|dl\.acm\.org|is\.mpg\.de\/publications|openaccess\.thecvf\.com|files\.is\.tue\.mpg\.de)/;
		for (const e of ENGINES) {
			if (!e.links?.paper) continue;
			expect(e.links.paper, `${e.id}: links.paper is not a paper, move it to links.docs`).toMatch(PAPER_HOSTS);
		}
	});

	it('a retired project keeps its card but never claims the present tense', () => {
		// Engines are marked when they die, not deleted: readers still hold the
		// assets they produced. What they lose is any live integration claim.
		for (const e of ENGINES) {
			if (!isRetired(e)) continue;
			expect(['live', 'forge'], `${e.id} is retired but claims integration=${e.integration}`).not.toContain(e.integration);
			expect(e.cta, `${e.id} is retired but still has a call-to-action`).toBeUndefined();
			expect(e.integrationNote, `${e.id}: a retired entry must say what shut down`).toMatch(/shut down|discontinued|retired|closed/i);
		}
		expect(engineStats().retired).toBe(ENGINES.filter(isRetired).length);
	});

	it('only commercially-licensed engines may deep-link into the generation pipeline (/forge)', () => {
		// Routing a non-commercial research model into the paid pipeline would
		// violate its license — the page must never do it.
		for (const e of ENGINES) {
			const ctaHref = e.cta?.href || '';
			if (ctaHref.startsWith('/forge')) {
				expect(e.commercial, `${e.id} deep-links to /forge but is not commercial-licensed`).toBe(true);
			}
			if (e.integration === 'forge' || e.integration === 'live') {
				// live/forge integrations are the ones we actively run; they must be commercial.
				expect(e.commercial, `${e.id} is integration=${e.integration} but not commercial-licensed`).toBe(true);
			}
		}
	});

	it('engines flagged for the splat viewer produce a splat/neural representation', () => {
		for (const e of ENGINES) {
			if (e.integration === 'splat') {
				expect(['gaussian', 'nerf'], `${e.id}: splat integration needs gaussian/nerf output`).toContain(e.representation);
			}
		}
	});

	it('engineStats reflects the dataset', () => {
		const s = engineStats();
		expect(s.total).toBe(ENGINES.length);
		expect(s.families).toBe(FAMILIES.length);
		expect(s.commercial).toBe(ENGINES.filter((e) => e.commercial).length);
		expect(s.splat).toBe(ENGINES.filter((e) => e.integration === 'splat').length);
	});

	it('references no token other than $THREE', () => {
		const blob = JSON.stringify(ENGINES).toLowerCase();
		// guard against accidental coin tickers slipping into copy
		for (const bad of ['$sol ', '$btc', '$eth ', '$pump', '$bonk', '$wif']) {
			expect(blob.includes(bad), `dataset mentions ${bad}`).toBe(false);
		}
	});
});
