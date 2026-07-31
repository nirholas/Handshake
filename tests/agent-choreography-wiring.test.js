/**
 * The choreography feature is only real if all four of its ends stay connected:
 * the studio composes a routine, the API stores it, the manifest publishes it,
 * and the embed plays it. Each end lives in a different file, and each one on
 * its own looks finished while the chain is broken. That is the exact failure mode
 * that shipped `meta.edits.animations` with a writer and no reader
 * (tests/agent-animation-slots.test.js documents that one).
 *
 * So this file asserts the seams, in the same source-reading style as that
 * test: importing the handler would drag in the DB client and the session
 * layer, and the point here is the wiring, not the SQL.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeRoutines, MAX_ROUTINES, MAX_STEPS } from '../src/runtime/choreography.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const SUB = read('../api/agents/_id/_sub.js');

describe('the API validates with the runtime module, not a second opinion', () => {
	it('imports the shared normalizer instead of restating the shape in zod', () => {
		expect(SUB).toMatch(/from '\.\.\/\.\.\/\.\.\/src\/runtime\/choreography\.js'/);
		expect(SUB).toContain('normalizeRoutines(list)');
	});

	it('accepts what the studio produces', () => {
		const fromStudio = [
			{ id: 'welcome', name: 'Welcome', steps: [{ slot: 'wave', clip: null, hold: 2, speed: 1 }] },
		];
		expect(normalizeRoutines(fromStudio)).toEqual([
			{ id: 'welcome', name: 'Welcome', loop: false, steps: [{ slot: 'wave', clip: null, hold: 2, speed: 1 }] },
		]);
	});

	it('rejects at the boundary what the avatar could not play', () => {
		expect(() => normalizeRoutines([{ name: 'Bad', steps: [{ slot: 'moonwalk' }] }])).toThrow();
		expect(() => normalizeRoutines([{ name: 'Empty', steps: [] }])).toThrow();
		expect(() =>
			normalizeRoutines([{ name: 'Path', steps: [{ slot: 'wave', clip: '../../etc/passwd' }] }]),
		).toThrow();
	});

	it('caps both dimensions so one agent cannot store an unbounded blob', () => {
		const many = Array.from({ length: MAX_ROUTINES + 1 }, (_, i) => ({
			name: `R${i}`,
			steps: [{ slot: 'wave' }],
		}));
		expect(() => normalizeRoutines(many)).toThrow(/at most/);
		const long = [
			{ name: 'Long', steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ slot: 'wave' })) },
		];
		expect(() => normalizeRoutines(long)).toThrow(/at most/);
	});

	it('an empty array is the documented way to clear them', () => {
		expect(normalizeRoutines([])).toEqual([]);
	});
});

describe('the handler stores and returns them', () => {
	it('writes to meta.choreographies', () => {
		expect(SUB).toContain("'{choreographies}'");
	});

	it('leaves them alone when the request omits the field', () => {
		// The same non-destructive rule as every other field on this endpoint: a
		// slot-only save must not wipe an agent's routines.
		expect(SUB).toContain("has('choreographies')");
	});

	it('reads the stored value back into the response rather than echoing input', () => {
		expect(SUB).toMatch(/meta->'choreographies' AS choreographies/);
		expect(SUB).toContain('choreographies: row?.choreographies ?? []');
	});

	it('lists the field in the "send at least one of" guard', () => {
		expect(SUB).toContain('b.choreographies !== undefined');
	});
});

describe('the manifest publishes them and the embed plays them', () => {
	it('the public manifest carries the routines', () => {
		expect(SUB).toContain('choreographies: Array.isArray(row.meta?.choreographies)');
	});

	it('the embed registers the manifest routines on the avatar', () => {
		const element = read('../src/element.js');
		expect(element).toContain('manifest.choreographies');
		expect(element).toContain('this._avatar.setChoreographies(_routines)');
	});

	it('the embed exposes a public play method', () => {
		const element = read('../src/element.js');
		expect(element).toContain('playRoutine(nameOrRoutine');
		expect(element).toContain('stopRoutine()');
		// A routine asked for before boot has to land after it, or every host page
		// that calls it from its own load handler silently does nothing.
		expect(element).toContain('_applyPendingRoutine');
	});

	it('the avatar drives routines from the same frame hook as everything else', () => {
		const avatar = read('../src/agent-avatar.js');
		expect(avatar).toContain('this._routinePlayer?.update(dt)');
		// The gate that stops an autonomous reflex cutting into a performance.
		expect(avatar).toContain('!this._isPlayingOneShot && !this._routinePlayer');
	});
});

describe('the studio is reachable and wired', () => {
	it('the page is registered as a build input and a route', () => {
		expect(read('../vite.config.js')).toContain("choreograph: resolve(__dirname, 'pages/choreograph.html')");
		expect(read('../vercel.json')).toContain('/choreograph.html');
	});

	it('the gesture page links into it, carrying the staged gesture', () => {
		const gestures = read('../src/gestures-page.js');
		expect(gestures).toContain('/choreograph?r=');
		expect(read('../pages/gestures.html')).toContain('data-role="override-sequence"');
	});

	it('the studio saves through the documented endpoint', () => {
		const page = read('../src/choreograph-page.js');
		expect(page).toContain('/api/agents/${agentId}/animations');
		expect(page).toContain('choreographies: merged');
	});

	it('the studio previews with the shared runtime player, not its own timer', () => {
		const page = read('../src/choreograph-page.js');
		expect(page).toContain("from './runtime/choreography.js'");
		expect(page).toContain('new RoutinePlayer(');
	});

	it('the page is declared in data/pages.json so the sitemap and changelog see it', () => {
		const pages = JSON.parse(read('../data/pages.json'));
		const all = pages.sections.flatMap((s) => s.pages || []);
		const entry = all.find((p) => p.path === '/choreograph');
		expect(entry, '/choreograph missing from data/pages.json').toBeTruthy();
		expect(entry.title).toBeTruthy();
		expect(entry.description.length).toBeGreaterThan(40);
	});

	it('the developer reference exists and is linked from the page', () => {
		expect(read('../docs/choreography.md').length).toBeGreaterThan(1000);
		expect(read('../pages/choreograph.html')).toContain('/docs/choreography');
	});
});
