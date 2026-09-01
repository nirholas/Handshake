/**
 * /timeline dataset integrity tests.
 *
 * The 3D history timeline (src/timeline.js) renders straight from
 * data/timeline.json, so the data IS the product: marker order, color,
 * scale, and every "Read the source" link come from these fields. These
 * tests guard the invariants the page relies on and the production wiring
 * that once silently broke it (the file must reach dist/, see vite.config.js
 * and scripts/check-dist.mjs).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const data = JSON.parse(readFileSync(resolve(root, 'data/timeline.json'), 'utf8'));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

describe('timeline dataset', () => {
	it('declares categories with a label and a hex color', () => {
		const entries = Object.entries(data.categories);
		expect(entries.length).toBeGreaterThan(0);
		for (const [key, meta] of entries) {
			expect(key, 'category key').toMatch(/^[a-z]+$/);
			expect(meta.label.trim().length, `${key} label`).toBeGreaterThan(0);
			expect(meta.color, `${key} color`).toMatch(HEX_COLOR);
		}
	});

	it('has a non-empty, chronologically ordered event list', () => {
		expect(Array.isArray(data.events)).toBe(true);
		expect(data.events.length).toBeGreaterThan(0);
		for (let i = 1; i < data.events.length; i++) {
			const prev = data.events[i - 1];
			const cur = data.events[i];
			expect(cur.date >= prev.date, `${cur.id} (${cur.date}) sorts before ${prev.id} (${prev.date})`).toBe(true);
		}
	});

	it('gives every event a unique id, an ISO date, copy, a known category, and a 1-5 importance', () => {
		const seen = new Set();
		for (const e of data.events) {
			expect(typeof e.id, 'id').toBe('string');
			expect(seen.has(e.id), `duplicate id ${e.id}`).toBe(false);
			seen.add(e.id);
			expect(e.date, `${e.id} date`).toMatch(ISO_DAY);
			expect(e.id.startsWith(e.date), `${e.id} should be prefixed by its date`).toBe(true);
			expect(e.title.trim().length, `${e.id} title`).toBeGreaterThan(0);
			expect(e.summary.trim().length, `${e.id} summary`).toBeGreaterThan(0);
			expect(data.categories[e.category], `${e.id} category ${e.category}`).toBeDefined();
			expect(Number.isInteger(e.importance) && e.importance >= 1 && e.importance <= 5, `${e.id} importance`).toBe(true);
		}
	});

	it('links sources over https or explicitly declares none', () => {
		for (const e of data.events) {
			expect('source_url' in e, `${e.id} must declare source_url`).toBe(true);
			if (e.source_url !== null) {
				expect(e.source_url, `${e.id} source_url`).toMatch(/^https:\/\/[^\s"]+$/);
			}
		}
	});

	it('never carries the banned dash characters into the page', () => {
		for (const e of data.events) {
			for (const field of ['title', 'summary']) {
				expect(/[\u2013\u2014]/.test(e[field]), `${e.id} ${field} uses a banned dash`).toBe(false);
			}
		}
	});

	it('is copied into dist/ by the build and required by check:dist', () => {
		const vite = readFileSync(resolve(root, 'vite.config.js'), 'utf8');
		const checkDist = readFileSync(resolve(root, 'scripts/check-dist.mjs'), 'utf8');
		expect(vite).toContain("name: 'copy-timeline-data'");
		expect(vite).toContain("'dist/data/timeline.json'");
		expect(checkDist).toContain("'dist/data/timeline.json'");
	});
});
