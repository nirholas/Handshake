// /trading, the autonomous-trading hub.
//
// Two things are worth pinning here.
//
// 1. LINK INTEGRITY. The hub exists because the trading surfaces had no front
//    door; a front door full of dead links is worse than none. The directory is
//    data, so every href is asserted against data/pages.json (for site routes)
//    and the docs tree (for doc routes). A renamed page fails this test instead
//    of silently becoming a dead card.
//
// 2. THE PURE FORMATTERS. describeFleet() encodes the judgement that a beating
//    worker with a silent feed is NOT healthy, and sparkPath() refuses to draw a
//    line it cannot honestly draw. Both are easy to regress and neither needs a
//    DOM to test.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { SURFACES, LEARN } from '../src/trading-hub-data.js';
import {
	describeFleet,
	formatSol,
	formatPct,
	formatAgo,
	formatUptime,
	sparkPath,
} from '../src/trading-hub-format.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sitePaths() {
	const json = JSON.parse(readFileSync(join(ROOT, 'data', 'pages.json'), 'utf8'));
	const out = new Set();
	const walk = (node) => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (node && typeof node === 'object') {
			if (typeof node.path === 'string') out.add(node.path);
			Object.values(node).forEach(walk);
		}
	};
	walk(json);
	return out;
}

const ALL = [...SURFACES, ...LEARN];

describe('trading hub directory', () => {
	it('lists both product surfaces and docs', () => {
		expect(SURFACES.length).toBeGreaterThanOrEqual(8);
		expect(LEARN.length).toBeGreaterThanOrEqual(6);
	});

	it('gives every entry the fields the card template renders', () => {
		for (const item of ALL) {
			expect(typeof item.kicker, `kicker on ${item.href}`).toBe('string');
			expect(item.kicker.length, `kicker on ${item.href}`).toBeGreaterThan(0);
			expect(item.title.length, `title on ${item.href}`).toBeGreaterThan(0);
			expect(item.body.length, `body on ${item.href}`).toBeGreaterThan(0);
			expect(item.href.startsWith('/'), `href on ${item.title}`).toBe(true);
		}
	});

	it('never lists the same destination twice', () => {
		const hrefs = ALL.map((i) => i.href);
		expect(new Set(hrefs).size).toBe(hrefs.length);
	});

	it('points every doc link at a markdown file that exists', () => {
		const docLinks = ALL.filter((i) => i.href.startsWith('/docs/') || i.href.startsWith('/tutorials/'));
		expect(docLinks.length).toBeGreaterThan(0);
		for (const { href } of docLinks) {
			const rel = href.startsWith('/tutorials/')
				? join('docs', 'tutorials', `${href.slice('/tutorials/'.length)}.md`)
				: join('docs', `${href.slice('/docs/'.length)}.md`);
			expect(existsSync(join(ROOT, rel)), `${href} -> ${rel}`).toBe(true);
		}
	});

	it('declares every destination in data/pages.json so it reaches the sitemap', () => {
		const known = sitePaths();
		for (const { href } of ALL) {
			expect(known.has(href), `${href} missing from data/pages.json`).toBe(true);
		}
	});

	it('declares the hub itself', () => {
		expect(sitePaths().has('/trading')).toBe(true);
	});
});

describe('describeFleet', () => {
	const base = {
		mode: 'live',
		strategies: 13,
		openPositions: 2,
		feedLive: true,
		feedSilent: false,
		lastEventAgeMs: 2000,
		bootAt: '2026-07-26T22:48:15.757Z',
	};
	const NOW = Date.UTC(2026, 6, 30, 22, 48, 15);

	it('reports a healthy live fleet as live', () => {
		const d = describeFleet(base, NOW);
		expect(d.tone).toBe('live');
		expect(d.label).toBe('Trading live');
		expect(d.feedTone).toBe('live');
	});

	it('does NOT call a silent feed healthy', () => {
		// The trap this guards: connected, beating, green everywhere, seeing nothing.
		const d = describeFleet({ ...base, feedSilent: true }, NOW);
		expect(d.tone).not.toBe('live');
		expect(d.feedTone).toBe('warn');
		expect(d.feedLabel).toBe('Silent');
	});

	it('reports a disconnected feed as down', () => {
		const d = describeFleet({ ...base, feedLive: false }, NOW);
		expect(d.feedTone).toBe('down');
		expect(d.feedLabel).toBe('Disconnected');
	});

	it('lets the kill switch override everything else', () => {
		const d = describeFleet({ ...base, globalKill: true }, NOW);
		expect(d.tone).toBe('down');
		expect(d.label).toBe('Fleet halted');
	});

	it('distinguishes simulate from live', () => {
		const d = describeFleet({ ...base, mode: 'simulate' }, NOW);
		expect(d.tone).toBe('muted');
		expect(d.label).toBe('Simulating');
	});

	it('degrades to unknown rather than inventing a state', () => {
		for (const input of [null, undefined, {}, { mode: 'nonsense' }]) {
			const d = describeFleet(input, NOW);
			expect(d.tone).toBe('unknown');
			expect(d.label).toBe('Fleet status unknown');
		}
	});

	it('reports uptime in the coarsest honest unit', () => {
		expect(describeFleet(base, NOW).uptimeLabel).toBe('4d');
	});
});

describe('formatters', () => {
	it('never renders a missing number as zero', () => {
		for (const bad of [null, undefined, 'abc', NaN]) {
			expect(formatSol(bad)).toBe('·');
			expect(formatPct(bad)).toBe('·');
		}
		expect(formatUptime(null)).toBe('·');
		expect(formatUptime('not-a-date')).toBe('·');
	});

	it('signs positive values and widens precision for dust', () => {
		expect(formatSol(0.17254)).toBe('+0.173 SOL');
		expect(formatSol(-0.152)).toBe('-0.152 SOL');
		expect(formatSol(0.0006)).toBe('+0.0006 SOL');
		expect(formatSol(0)).toBe('0.000 SOL');
		expect(formatSol(1.5, { signed: false })).toBe('1.500 SOL');
	});

	it('formats percentages with a sign only when asked', () => {
		expect(formatPct(10.2)).toBe('+10.2%');
		expect(formatPct(-40.3)).toBe('-40.3%');
		expect(formatPct(50, { signed: false })).toBe('50.0%');
	});

	it('formats relative time without depending on the clock', () => {
		const now = Date.UTC(2026, 6, 30, 12, 0, 0);
		expect(formatAgo(null, now)).toBe('never');
		expect(formatAgo(new Date(now - 30_000).toISOString(), now)).toBe('just now');
		expect(formatAgo(new Date(now - 15 * 60_000).toISOString(), now)).toBe('15m ago');
		expect(formatAgo(new Date(now - 5 * 3_600_000).toISOString(), now)).toBe('5h ago');
		expect(formatAgo(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3d ago');
	});

	it('treats a future timestamp as now rather than negative time', () => {
		const now = Date.UTC(2026, 6, 30, 12, 0, 0);
		expect(formatAgo(new Date(now + 60_000).toISOString(), now)).toBe('just now');
	});
});

describe('sparkPath', () => {
	it('draws nothing when there is nothing honest to draw', () => {
		// A single point is not a trend; a flat line would imply one.
		expect(sparkPath([])).toBe('');
		expect(sparkPath([1])).toBe('');
		expect(sparkPath(null)).toBe('');
		expect(sparkPath('nope')).toBe('');
	});

	it('draws a path across the full width for a real series', () => {
		const d = sparkPath([0.005, 0.01, 0.015, -0.038, 0.186, 0.172], 120, 32);
		expect(d.startsWith('M0.00')).toBe(true);
		expect(d).toContain('L120.00');
		expect(d.split('L').length).toBe(6);
	});

	it('centres a flat series instead of dividing by zero', () => {
		const d = sparkPath([2, 2, 2], 100, 40);
		expect(d).not.toContain('NaN');
		expect(d).toContain('20.00');
	});

	it('ignores non-numeric points rather than emitting NaN', () => {
		const d = sparkPath([1, 'x', 3, null, 5]);
		expect(d).not.toContain('NaN');
		expect(d.split(/[ML]/).filter(Boolean).length).toBe(3);
	});

	it('keeps every coordinate inside the viewport', () => {
		const w = 120;
		const h = 32;
		const d = sparkPath([-5, 12, 0, 7], w, h);
		const coords = [...d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
		expect(coords.length).toBe(4);
		for (const [x, y] of coords) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(w);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(h);
		}
	});
});
