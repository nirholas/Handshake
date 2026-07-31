// flow-map-core: the math behind /flow, with no DOM, no fetch and no globals.
//
// Two jobs, deliberately kept apart from rendering so both are testable:
//
//  1. READING the graph. A leaderboard cannot tell you the shape of a flow, and
//     the shape is the diagnosis. An agent that earns steadily and never spends
//     again is indistinguishable from a healthy one on any "top earners" list,
//     yet it is the exact signature of capital dispersion: money entering the
//     fleet and never circulating back out. classifyRole() names that, and
//     dispersion() puts a number on how much of the economy is stuck in it.
//
//  2. PLACING the graph. A deterministic force simulation, seeded so the same
//     payload always lays out the same way. That matters more than it sounds:
//     an operator comparing two windows should see the topology move, not the
//     layout reshuffle underneath them.

// ── roles ────────────────────────────────────────────────────────────────────
// A node's role is decided by how lopsided its flow is, not by how big it is.
// The thresholds are intentionally wide: 85/15 keeps a node out of the extreme
// buckets unless it is genuinely one-directional, so "sink" stays a real signal
// rather than a label half the graph wears.
export const SOURCE_RATIO = 0.85;
export const SINK_RATIO = 0.15;
// A hub is defined by how many DISTINCT partners it trades with, not by volume:
// one agent paying another a hundred times is a strong edge, not a hub.
export const HUB_PARTNERS = 4;

export const ROLES = {
	source: { id: 'source', label: 'Source', hint: 'Pays out far more than it earns. Where money enters the loop.' },
	sink: { id: 'sink', label: 'Sink', hint: 'Earns and does not spend again. Capital stops circulating here.' },
	hub: { id: 'hub', label: 'Hub', hint: 'Trades both ways with many partners. The load-bearing middle of the economy.' },
	relay: { id: 'relay', label: 'Relay', hint: 'Earns and spends, on a small number of routes.' },
	quiet: { id: 'quiet', label: 'Quiet', hint: 'No settled value moved in this window.' },
};

/** Total value a node handled in the window, in USD. */
export const throughput = (n) => Number(n?.in_usd || 0) + Number(n?.out_usd || 0);

/** Earned minus spent. Positive means the node accumulated. */
export const netUsd = (n) => Number(n?.in_usd || 0) - Number(n?.out_usd || 0);

/** How many distinct counterparties a node touched, in either direction. */
export const partners = (n) => Number(n?.partners_in || 0) + Number(n?.partners_out || 0);

/**
 * Name what a node does in the economy. Order matters: `quiet` must win first,
 * because a node with zero flow has an undefined ratio and would otherwise be
 * reported as a sink (0/0 reads as "earns and never spends", which is wrong: it
 * did nothing at all).
 */
export function classifyRole(node) {
	const total = throughput(node);
	if (total <= 0) return ROLES.quiet;
	const outShare = Number(node.out_usd || 0) / total;
	if (outShare >= SOURCE_RATIO) return ROLES.source;
	if (outShare <= SINK_RATIO) return ROLES.sink;
	return partners(node) >= HUB_PARTNERS ? ROLES.hub : ROLES.relay;
}

/**
 * Share of all settled value that ended up in sinks. This is the single number
 * that says whether the loop is closed: a healthy circular economy trends
 * toward zero, and a fleet quietly draining its treasury into agent wallets
 * trends toward one.
 */
export function dispersion(graph) {
	const nodes = graph?.nodes || [];
	const totalIn = nodes.reduce((s, n) => s + Number(n.in_usd || 0), 0);
	if (totalIn <= 0) return 0;
	const stuck = nodes
		.filter((n) => classifyRole(n).id === 'sink')
		.reduce((s, n) => s + netUsd(n), 0);
	return Math.max(0, Math.min(1, stuck / totalIn));
}

/**
 * Decorate every node with its derived reading once, so renderers and the
 * accessible table agree by construction instead of by convention.
 */
export function annotate(graph) {
	const nodes = (graph?.nodes || []).map((n) => ({
		...n,
		role: classifyRole(n).id,
		net_usd: netUsd(n),
		throughput_usd: throughput(n),
		partners: partners(n),
	}));
	return { ...graph, nodes };
}

/** The nodes holding the most stuck capital, worst first. */
export function rankSinks(graph, limit = 5) {
	return (graph?.nodes || [])
		.filter((n) => classifyRole(n).id === 'sink')
		.map((n) => ({ ...n, net_usd: netUsd(n) }))
		.sort((a, b) => b.net_usd - a.net_usd)
		.slice(0, limit);
}

/** The busiest two-way nodes, by distinct partners then value. */
export function rankHubs(graph, limit = 5) {
	return (graph?.nodes || [])
		.filter((n) => classifyRole(n).id === 'hub')
		.map((n) => ({ ...n, throughput_usd: throughput(n), partners: partners(n) }))
		.sort((a, b) => b.partners - a.partners || b.throughput_usd - a.throughput_usd)
		.slice(0, limit);
}

/**
 * Narrow the graph without ever leaving a dangling edge. Edges are filtered
 * first and the node set is then rebuilt from the survivors, so a filtered view
 * can never reference a node that is no longer drawn.
 */
export function filterGraph(graph, { kind = 'all', query = '' } = {}) {
	const nodes = graph?.nodes || [];
	const edges = graph?.edges || [];
	const q = String(query || '').trim().toLowerCase();

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const matches = (node) =>
		!q ||
		String(node?.name || '').toLowerCase().includes(q) ||
		String(node?.address || '').toLowerCase().includes(q);

	const keptEdges = edges.filter((e) => {
		if (kind !== 'all' && !(e.kinds || []).includes(kind)) return false;
		if (!q) return true;
		// A search keeps the matched node's whole neighbourhood, because an edge
		// with one end hidden would be a line into nowhere.
		return matches(byId.get(e.from)) || matches(byId.get(e.to));
	});

	const live = new Set(keptEdges.flatMap((e) => [e.from, e.to]));
	return { ...graph, nodes: nodes.filter((n) => live.has(n.id)), edges: keptEdges };
}

/** Per-node totals recomputed from a filtered edge set, so panels stay truthful. */
export function recomputeTotals(graph) {
	const blank = () => ({ in_usd: 0, out_usd: 0, in_sol: 0, out_sol: 0, in_count: 0, out_count: 0, partners_in: 0, partners_out: 0 });
	const acc = new Map((graph?.nodes || []).map((n) => [n.id, blank()]));
	for (const e of graph?.edges || []) {
		const from = acc.get(e.from);
		const to = acc.get(e.to);
		if (from) { from.out_usd += e.usd || 0; from.out_sol += e.sol || 0; from.out_count += e.count || 0; from.partners_out += 1; }
		if (to) { to.in_usd += e.usd || 0; to.in_sol += e.sol || 0; to.in_count += e.count || 0; to.partners_in += 1; }
	}
	return { ...graph, nodes: (graph?.nodes || []).map((n) => ({ ...n, ...acc.get(n.id) })) };
}

// ── formatting ───────────────────────────────────────────────────────────────
// Dust is real money at this scale, so it is never rounded away to a bare "$0".
export function fmtUsd(n) {
	const v = Number(n || 0);
	if (v === 0) return '$0';
	if (Math.abs(v) < 0.01) return v < 0 ? '>-$0.01' : '<$0.01';
	if (Math.abs(v) >= 1000) return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
	return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}

export function fmtSol(n) {
	const v = Number(n || 0);
	if (v === 0) return '0';
	if (Math.abs(v) < 0.001) return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
	return v.toFixed(Math.abs(v) < 1 ? 4 : 3).replace(/0+$/, '').replace(/\.$/, '');
}

export function fmtPct(n) {
	const v = Number(n || 0) * 100;
	if (v > 0 && v < 1) return '<1%';
	return `${Math.round(v)}%`;
}

export function relTime(iso, now = Date.now()) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

// ── layout ───────────────────────────────────────────────────────────────────

/** mulberry32: a small, fast, fully deterministic PRNG. Same seed, same graph. */
export function seededRandom(seed) {
	let a = seed >>> 0;
	return function next() {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A node's drawn radius, from its share of value. Area, not radius, tracks
 *  volume, so a node ten times richer does not become a hundred times the ink. */
export function nodeRadius(node, maxThroughput, { min = 9, max = 30 } = {}) {
	const t = throughput(node);
	if (!(maxThroughput > 0) || t <= 0) return min;
	return min + (max - min) * Math.sqrt(t / maxThroughput);
}

/**
 * A force-directed layout that is a pure function of (nodes, edges, seed).
 *
 * Deliberately O(n²) on repulsion: the edge cap upstream keeps this to a couple
 * of hundred nodes, where the exact all-pairs pass is both faster than building
 * a quadtree and free of its approximation artefacts.
 */
export function createLayout(graph, opts = {}) {
	const {
		width = 900, height = 600, seed = 1337,
		repulsion = 5200, spring = 0.0016, springLength = 130,
		gravity = 0.012, damping = 0.86, maxVelocity = 24,
	} = opts;

	const rand = seededRandom(seed);
	const cx = width / 2;
	const cy = height / 2;

	// Seed on a golden-angle spiral rather than at random: it starts the system
	// already spread out, so it settles in far fewer steps and never begins with
	// every node stacked on one pixel (which makes repulsion explode).
	const nodes = (graph?.nodes || []).map((n, i) => {
		const angle = i * 2.399963229728653;
		const radius = Math.sqrt(i + 1) * Math.min(width, height) * 0.045;
		return {
			id: n.id,
			x: cx + Math.cos(angle) * radius + (rand() - 0.5) * 8,
			y: cy + Math.sin(angle) * radius + (rand() - 0.5) * 8,
			vx: 0, vy: 0,
			mass: 1 + Math.log10(1 + throughput(n)),
		};
	});
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const links = (graph?.edges || [])
		.map((e) => ({ a: index.get(e.from), b: index.get(e.to), w: Math.max(1, Number(e.count) || 1) }))
		.filter((l) => l.a != null && l.b != null && l.a !== l.b);

	function step() {
		for (let i = 0; i < nodes.length; i += 1) {
			const a = nodes[i];
			for (let j = i + 1; j < nodes.length; j += 1) {
				const b = nodes[j];
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 0.01) { dx = (rand() - 0.5) * 0.2; dy = (rand() - 0.5) * 0.2; d2 = 0.01; }
				const force = repulsion / d2;
				const d = Math.sqrt(d2);
				const fx = (dx / d) * force;
				const fy = (dy / d) * force;
				a.vx += fx / a.mass; a.vy += fy / a.mass;
				b.vx -= fx / b.mass; b.vy -= fy / b.mass;
			}
		}
		for (const l of links) {
			const a = nodes[l.a];
			const b = nodes[l.b];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const d = Math.max(1, Math.hypot(dx, dy));
			// Heavier routes pull harder, but only logarithmically, so a single
			// very chatty pair cannot collapse the rest of the graph onto itself.
			const k = spring * Math.log2(1 + l.w);
			const f = (d - springLength) * k;
			const fx = (dx / d) * f;
			const fy = (dy / d) * f;
			a.vx += fx; a.vy += fy;
			b.vx -= fx; b.vy -= fy;
		}
		let motion = 0;
		for (const n of nodes) {
			n.vx = (n.vx + (cx - n.x) * gravity) * damping;
			n.vy = (n.vy + (cy - n.y) * gravity) * damping;
			const v = Math.hypot(n.vx, n.vy);
			if (v > maxVelocity) { n.vx = (n.vx / v) * maxVelocity; n.vy = (n.vy / v) * maxVelocity; }
			n.x += n.vx; n.y += n.vy;
			motion += Math.abs(n.vx) + Math.abs(n.vy);
		}
		return nodes.length ? motion / nodes.length : 0;
	}

	/** Run until the average per-node motion falls below `epsilon`, or `max` steps. */
	function settle(max = 300, epsilon = 0.05) {
		let steps = 0;
		for (; steps < max; steps += 1) if (step() < epsilon) { steps += 1; break; }
		return steps;
	}

	const positions = () => new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
	const bounds = () => {
		if (!nodes.length) return { minX: 0, minY: 0, maxX: width, maxY: height };
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x > maxX) maxX = n.x;
			if (n.y > maxY) maxY = n.y;
		}
		return { minX, minY, maxX, maxY };
	};

	return { nodes, links, step, settle, positions, bounds };
}

/**
 * Fit a settled layout into a viewport with padding. Returned separately from
 * the simulation so panning and zooming never have to re-run the physics.
 */
export function fitTransform(bounds, width, height, padding = 48) {
	const w = Math.max(1, bounds.maxX - bounds.minX);
	const h = Math.max(1, bounds.maxY - bounds.minY);
	const scale = Math.min((width - padding * 2) / w, (height - padding * 2) / h, 2.2);
	const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
	return {
		scale: s,
		x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * s,
		y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * s,
	};
}
