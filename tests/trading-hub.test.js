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
	describeSolvency,
	formatSol,
	formatPct,
	formatAgo,
	formatUptime,
	isNumeric,
	sparkPath,
} from '../src/trading-hub-format.js';
import { deriveSniperState } from '../api/_lib/sniper-solvency.js';

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

	// The failure this page exists to catch, one level up from the silent feed:
	// the worker is up, the feed is connected, strategies are armed, and no
	// wallet can afford an entry. /api/sniper/status resolves that into `state`
	// and the hub must not publish a greener verdict than its own source.
	it('never reports a healthier state than the endpoint resolved', () => {
		for (const state of ['down', 'starved', 'degraded']) {
			const d = describeFleet({ ...base, state }, NOW);
			expect(d.tone, state).not.toBe('live');
			expect(d.label, state).not.toBe('Trading live');
		}
	});

	it('calls an out-of-SOL fleet what it is, however healthy the feed looks', () => {
		const d = describeFleet(
			{ ...base, state: 'starved', solvency: { state: 'starved', agents: 12, tradeable: 0, starved: 12, deficitSol: 0.4, masterCanCover: false } },
			NOW,
		);
		expect(d.tone).toBe('down');
		expect(d.label).toBe('Out of SOL');
		expect(d.detail).toContain('a person has to move SOL in');
		// The feed is genuinely fine and must keep saying so; the headline is
		// wrong about the cause if it blames the feed for an empty wallet.
		expect(d.feedTone).toBe('live');
	});

	it('blames solvency, not the feed, when solvency is what degraded', () => {
		const d = describeFleet(
			{ ...base, state: 'degraded', solvency: { state: 'degraded', agents: 12, tradeable: 8, starved: 4, shrunk: 0, deficitSol: 0.12, masterCanCover: true } },
			NOW,
		);
		expect(d.tone).toBe('warn');
		expect(d.label).toBe('Live, wallets underfunded');
		expect(d.solvency.label).toBe('8 of 12 can trade');
	});

	it('still blames the feed when the feed is what degraded', () => {
		const d = describeFleet({ ...base, state: 'degraded', feedSilent: true, solvency: { state: 'funded', agents: 12, tradeable: 12 } }, NOW);
		expect(d.label).toBe('Live, feed degraded');
	});

	it('reports a stopped worker as offline rather than as live', () => {
		const d = describeFleet({ ...base, state: 'down' }, NOW);
		expect(d.tone).toBe('down');
		expect(d.label).toBe('Worker offline');
	});

	it('lets the kill switch outrank even a live state', () => {
		const d = describeFleet({ ...base, state: 'live', globalKill: true }, NOW);
		expect(d.label).toBe('Fleet halted');
	});

	it('honours simulate mode when the endpoint calls the worker live', () => {
		const d = describeFleet({ ...base, state: 'live', mode: 'simulate' }, NOW);
		expect(d.label).toBe('Simulating');
		expect(d.detail).toContain('no broadcast');
	});

	// The hub's verdict is a rendering of the endpoint's, not a second opinion.
	// Agreeing here is what stops the two drifting apart on the next change.
	it('agrees with deriveSniperState across the state matrix', () => {
		const cases = [
			{ alive: true, feedLive: true, feedSilent: false, solvencyState: 'funded' },
			{ alive: true, feedLive: true, feedSilent: false, solvencyState: 'degraded' },
			{ alive: true, feedLive: true, feedSilent: false, solvencyState: 'starved' },
			{ alive: true, feedLive: true, feedSilent: true, solvencyState: 'funded' },
			{ alive: false, feedLive: true, feedSilent: false, solvencyState: 'funded' },
		];
		for (const c of cases) {
			const state = deriveSniperState(c);
			const d = describeFleet(
				{ ...base, state, feedLive: c.feedLive, feedSilent: c.feedSilent, solvency: { state: c.solvencyState, agents: 12, tradeable: 8, starved: 4, shrunk: 0 } },
				NOW,
			);
			expect(d.tone === 'live', `${state} ${JSON.stringify(c)}`).toBe(state === 'live');
		}
	});
});

describe('describeSolvency', () => {
	it('claims nothing when no balances were measured', () => {
		for (const input of [null, undefined, {}, { state: 'unknown', agents: 0 }]) {
			const d = describeSolvency(input);
			expect(d.tone).toBe('muted');
			expect(d.label).toBe('·');
		}
	});

	it('counts tradeable wallets rather than armed strategies', () => {
		const d = describeSolvency({ state: 'degraded', agents: 12, tradeable: 8, starved: 3, shrunk: 1, deficitSol: 0.25, masterCanCover: true });
		expect(d.tone).toBe('warn');
		expect(d.label).toBe('8 of 12 can trade');
		expect(d.sub).toBe('3 starved, 1 sized down');
		expect(d.detail).toContain('0.250 SOL');
		expect(d.detail).toContain('refill them automatically');
	});

	it('says a fully funded fleet is funded', () => {
		const d = describeSolvency({ state: 'funded', agents: 5, tradeable: 5, starved: 0, shrunk: 0, deficitSol: 0 });
		expect(d.tone).toBe('live');
		expect(d.label).toBe('5 of 5 can trade');
	});

	it('names a human as the fix when the funding wallet cannot cover the gap', () => {
		const d = describeSolvency({ state: 'starved', agents: 4, tradeable: 0, starved: 4, shrunk: 0, deficitSol: 1.5, masterCanCover: false });
		expect(d.tone).toBe('down');
		expect(d.label).toBe('0 of 4 can trade');
		expect(d.detail).toContain('a person has to move SOL in');
	});
});

describe('formatters', () => {
	// Number(null), Number(undefined via ??) and Number('') coerce to 0 or NaN in
	// ways that make a bare Number.isFinite() check accept a missing value as a
	// real zero. Every "do we have a number?" decision on this page goes through
	// isNumeric so exactly one of them can be wrong.
	it('rejects nullish before coercing, not after', () => {
		for (const bad of [null, undefined, '', 'abc', NaN, {}, []]) {
			expect(isNumeric(bad), String(bad)).toBe(false);
		}
		for (const good of [0, -1, 0.0001, '42', 1e-9]) {
			expect(isNumeric(good), String(good)).toBe(true);
		}
	});

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
