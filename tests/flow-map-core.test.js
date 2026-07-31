// The /flow map is only worth shipping if its reading of the graph is
// trustworthy, so the cases below are the ones that actually decide something:
// the sink/source distinction that names capital dispersion, the filter
// invariant that a drawn edge always has two drawn ends, and the determinism
// that lets an operator compare two windows without the layout reshuffling.

import { describe, it, expect } from 'vitest';
import {
	classifyRole, dispersion, annotate, rankSinks, rankHubs,
	filterGraph, recomputeTotals, throughput, netUsd,
	fmtUsd, fmtSol, fmtPct, relTime,
	seededRandom, nodeRadius, createLayout, fitTransform,
	SOURCE_RATIO, SINK_RATIO, HUB_PARTNERS,
} from '../src/flow-map-core.js';

const node = (o = {}) => ({
	id: 'a:1', kind: 'agent', name: 'Agent',
	in_usd: 0, out_usd: 0, in_sol: 0, out_sol: 0,
	in_count: 0, out_count: 0, partners_in: 0, partners_out: 0,
	...o,
});

describe('classifyRole', () => {
	it('calls a one-way earner a sink, which is the capital-dispersion signature', () => {
		expect(classifyRole(node({ in_usd: 20, out_usd: 1 })).id).toBe('sink');
	});

	it('calls a one-way payer a source', () => {
		expect(classifyRole(node({ in_usd: 1, out_usd: 20 })).id).toBe('source');
	});

	it('does NOT call a zero-flow node a sink', () => {
		// 0/0 would read as "earns and never spends". It moved nothing at all,
		// and mislabelling it would inflate the dispersion number with noise.
		expect(classifyRole(node()).id).toBe('quiet');
		expect(classifyRole(node({ in_usd: 0, out_usd: 0 })).id).toBe('quiet');
	});

	it('separates a hub from a relay by distinct partners, not by volume', () => {
		const busyButNarrow = node({ in_usd: 500, out_usd: 500, partners_in: 1, partners_out: 1 });
		const smallButWide = node({ in_usd: 2, out_usd: 2, partners_in: 3, partners_out: 4 });
		expect(classifyRole(busyButNarrow).id).toBe('relay');
		expect(classifyRole(smallButWide).id).toBe('hub');
	});

	it('honours its documented thresholds exactly at the boundary', () => {
		const atSource = node({ in_usd: 1 - SOURCE_RATIO, out_usd: SOURCE_RATIO });
		const atSink = node({ in_usd: 1 - SINK_RATIO, out_usd: SINK_RATIO });
		expect(classifyRole(atSource).id).toBe('source');
		expect(classifyRole(atSink).id).toBe('sink');
		expect(HUB_PARTNERS).toBeGreaterThan(1);
	});
});

describe('dispersion', () => {
	it('is zero for a closed loop where everything paid out comes back', () => {
		const g = { nodes: [
			node({ id: 'a', in_usd: 10, out_usd: 10, partners_in: 2, partners_out: 2 }),
			node({ id: 'b', in_usd: 10, out_usd: 10, partners_in: 2, partners_out: 2 }),
		] };
		expect(dispersion(g)).toBe(0);
	});

	it('rises toward 1 as value accumulates in nodes that never spend', () => {
		const g = { nodes: [
			node({ id: 'src', in_usd: 0, out_usd: 100 }),
			node({ id: 'stuck', in_usd: 100, out_usd: 0 }),
		] };
		expect(dispersion(g)).toBeCloseTo(1, 6);
	});

	it('stays at zero on an empty graph rather than dividing by nothing', () => {
		expect(dispersion({ nodes: [] })).toBe(0);
		expect(dispersion(null)).toBe(0);
	});
});

describe('annotate / rankings', () => {
	it('attaches the derived reading so renderers cannot disagree with the table', () => {
		const g = annotate({ nodes: [node({ in_usd: 9, out_usd: 1 })] });
		expect(g.nodes[0].role).toBe('sink');
		expect(g.nodes[0].net_usd).toBe(8);
		expect(g.nodes[0].throughput_usd).toBe(10);
	});

	it('ranks sinks by how much capital is stuck in them, worst first', () => {
		const g = { nodes: [
			node({ id: 'small', in_usd: 5, out_usd: 0 }),
			node({ id: 'big', in_usd: 50, out_usd: 1 }),
			node({ id: 'healthy', in_usd: 10, out_usd: 10, partners_in: 3, partners_out: 3 }),
		] };
		const sinks = rankSinks(g);
		expect(sinks.map((s) => s.id)).toEqual(['big', 'small']);
		expect(sinks[0].net_usd).toBe(49);
	});

	it('ranks hubs by reach', () => {
		const g = { nodes: [
			node({ id: 'wide', in_usd: 5, out_usd: 5, partners_in: 6, partners_out: 6 }),
			node({ id: 'narrow', in_usd: 50, out_usd: 50, partners_in: 2, partners_out: 3 }),
		] };
		expect(rankHubs(g)[0].id).toBe('wide');
	});
});

describe('filterGraph', () => {
	const graph = {
		nodes: [node({ id: 'a', name: 'Atlas' }), node({ id: 'b', name: 'Vega' }), node({ id: 'c', name: 'Echo' })],
		edges: [
			{ from: 'a', to: 'b', usd: 5, sol: 0.05, count: 2, kinds: ['payment'] },
			{ from: 'b', to: 'c', usd: 3, sol: 0.03, count: 1, kinds: ['tip'] },
		],
	};

	it('never leaves an edge with an undrawn end', () => {
		const out = filterGraph(graph, { kind: 'tip' });
		const ids = new Set(out.nodes.map((n) => n.id));
		expect(out.edges.length).toBe(1);
		for (const e of out.edges) {
			expect(ids.has(e.from)).toBe(true);
			expect(ids.has(e.to)).toBe(true);
		}
	});

	it('keeps a searched node’s whole neighbourhood, not a line into nowhere', () => {
		const out = filterGraph(graph, { query: 'atlas' });
		expect(out.edges).toHaveLength(1);
		expect(out.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
	});

	it('matches on address as well as name', () => {
		const g = { nodes: [node({ id: 'w', name: 'HuGq…8WsL', address: 'HuGq9RCPxxxx8WsL' })], edges: [] };
		expect(filterGraph({ ...g, edges: [{ from: 'w', to: 'w', kinds: ['tip'], count: 1 }] }, { query: '9rcp' }).edges).toHaveLength(1);
	});

	it('returns an honestly empty graph when nothing matches', () => {
		const out = filterGraph(graph, { query: 'nothing-here' });
		expect(out.nodes).toEqual([]);
		expect(out.edges).toEqual([]);
	});
});

describe('recomputeTotals', () => {
	it('rebuilds per-node numbers from the filtered edges so panels stay truthful', () => {
		const g = recomputeTotals({
			nodes: [node({ id: 'a', in_usd: 999 }), node({ id: 'b', in_usd: 999 })],
			edges: [{ from: 'a', to: 'b', usd: 4, sol: 0.04, count: 3 }],
		});
		const a = g.nodes.find((n) => n.id === 'a');
		const b = g.nodes.find((n) => n.id === 'b');
		expect(a.out_usd).toBe(4);
		expect(a.in_usd).toBe(0);
		expect(b.in_usd).toBe(4);
		expect(b.in_count).toBe(3);
		expect(b.partners_in).toBe(1);
	});
});

describe('formatters', () => {
	it('keeps dust legible instead of collapsing it to zero', () => {
		expect(fmtUsd(0)).toBe('$0');
		expect(fmtUsd(0.004)).toBe('<$0.01');
		expect(fmtUsd(-0.004)).toBe('>-$0.01');
		expect(fmtUsd(24.884)).toBe('$24.88');
		expect(fmtUsd(1234.5)).toBe('$1,235');
		expect(fmtUsd(-12.5)).toBe('-$12.50');
	});

	it('trims SOL without hiding a real balance', () => {
		expect(fmtSol(0)).toBe('0');
		expect(fmtSol(0.000123)).toBe('0.000123');
		expect(fmtSol(0.5)).toBe('0.5');
		expect(fmtSol(5.120517)).toBe('5.121');
	});

	it('never rounds a nonzero share down to 0%', () => {
		expect(fmtPct(0)).toBe('0%');
		expect(fmtPct(0.002)).toBe('<1%');
		expect(fmtPct(0.42)).toBe('42%');
	});

	it('formats relative time and shrugs off a bad timestamp', () => {
		const now = Date.UTC(2026, 6, 31, 12, 0, 0);
		expect(relTime(new Date(now - 30_000).toISOString(), now)).toBe('30s ago');
		expect(relTime(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3h ago');
		expect(relTime('not-a-date', now)).toBe('');
	});
});

describe('layout', () => {
	const graph = {
		nodes: Array.from({ length: 24 }, (_, i) => node({ id: `n${i}`, in_usd: i, out_usd: 24 - i })),
		edges: Array.from({ length: 23 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, count: 1 + i, usd: i })),
	};

	it('is deterministic: the same payload and seed lay out identically', () => {
		const a = createLayout(graph, { seed: 7 });
		const b = createLayout(graph, { seed: 7 });
		a.settle(120);
		b.settle(120);
		expect([...a.positions().values()]).toEqual([...b.positions().values()]);
	});

	it('produces a different arrangement for a different seed', () => {
		const a = createLayout(graph, { seed: 7 });
		const b = createLayout(graph, { seed: 8 });
		a.settle(120);
		b.settle(120);
		expect([...a.positions().values()]).not.toEqual([...b.positions().values()]);
	});

	it('settles: motion decays and every coordinate stays finite', () => {
		const l = createLayout(graph, { seed: 3 });
		const first = l.step();
		l.settle(400);
		const last = l.step();
		expect(last).toBeLessThan(first);
		for (const n of l.nodes) {
			expect(Number.isFinite(n.x)).toBe(true);
			expect(Number.isFinite(n.y)).toBe(true);
		}
	});

	it('pushes co-located nodes apart instead of dividing by zero', () => {
		// Two nodes seeded at effectively the same point is the case that makes a
		// naive inverse-square repulsion return Infinity and poison every later frame.
		const l = createLayout({ nodes: [node({ id: 'x' }), node({ id: 'y' })], edges: [] }, { seed: 1 });
		l.nodes[0].x = 100; l.nodes[0].y = 100;
		l.nodes[1].x = 100; l.nodes[1].y = 100;
		l.step();
		expect(Number.isFinite(l.nodes[0].x)).toBe(true);
		expect(Number.isFinite(l.nodes[1].x)).toBe(true);
	});

	it('drops self-edges and edges naming a node that is not drawn', () => {
		const l = createLayout({
			nodes: [node({ id: 'a' })],
			edges: [{ from: 'a', to: 'a', count: 1 }, { from: 'a', to: 'ghost', count: 1 }],
		}, { seed: 1 });
		expect(l.links).toHaveLength(0);
	});

	it('handles an empty graph without throwing', () => {
		const l = createLayout({ nodes: [], edges: [] });
		expect(l.step()).toBe(0);
		expect(l.settle(10)).toBeGreaterThan(0);
		expect(l.bounds()).toEqual({ minX: 0, minY: 0, maxX: 900, maxY: 600 });
	});
});

describe('sizing and fitting', () => {
	it('scales node area, not radius, with value', () => {
		const min = 9;
		const max = 30;
		const quarter = nodeRadius(node({ in_usd: 25 }), 100, { min, max });
		const full = nodeRadius(node({ in_usd: 100 }), 100, { min, max });
		expect(full).toBeCloseTo(max, 6);
		// sqrt(1/4) = 1/2 of the span above the floor.
		expect(quarter).toBeCloseTo(min + (max - min) * 0.5, 6);
	});

	it('falls back to the floor radius when there is no value to scale against', () => {
		expect(nodeRadius(node(), 0)).toBe(9);
		expect(nodeRadius(node({ in_usd: 5 }), 0)).toBe(9);
	});

	it('centres the fitted graph in the viewport', () => {
		const t = fitTransform({ minX: 0, minY: 0, maxX: 400, maxY: 400 }, 500, 400, 20);
		// 400px of content into 360px of usable height.
		expect(t.scale).toBeCloseTo(0.9, 6);
		expect(0 * t.scale + t.x).toBeCloseTo(250 - 200 * t.scale, 6);
		expect(0 * t.scale + t.y).toBeCloseTo(200 - 200 * t.scale, 6);
	});

	it('clamps zoom so a two-node graph does not fill the screen with two blobs', () => {
		const t = fitTransform({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 900, 600, 48);
		expect(t.scale).toBe(2.2);
	});

	it('never returns a zero or negative scale for a degenerate bounding box', () => {
		const t = fitTransform({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 400, 300);
		expect(t.scale).toBeGreaterThan(0);
		expect(Number.isFinite(t.x)).toBe(true);
	});
});

describe('seededRandom', () => {
	it('is reproducible and stays in [0,1)', () => {
		const a = seededRandom(42);
		const b = seededRandom(42);
		for (let i = 0; i < 50; i += 1) {
			const v = a();
			expect(v).toBe(b());
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe('helpers', () => {
	it('reads throughput and net from a partial node without throwing', () => {
		expect(throughput(undefined)).toBe(0);
		expect(netUsd({ in_usd: 3 })).toBe(3);
	});
});
