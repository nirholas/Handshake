// /flow: the agent money-flow map.
//
// Renders the topology returned by GET /api/pulse?view=graph. All the judgement
// (roles, dispersion, filtering, layout physics) lives in flow-map-core.js and
// is unit-tested; this file is the DOM and canvas layer only.
//
// Three things the rendering has to get right, because they are what make the
// map readable rather than decorative:
//
//   · Direction. Value flows one way along every edge, so the animated
//     particles travel payer to payee. Without them a graph of undirected
//     lines cannot distinguish an agent that earns from one that pays.
//   · Honesty at every state. Loading shows the shape that is coming, empty
//     says why it is empty and what to do, and an error names the failure. A
//     blank canvas is never an acceptable outcome.
//   · Parity. The canvas is unreachable by keyboard and screen readers, so the
//     table below it is not a fallback bolted on afterwards: it is rendered
//     from the same filtered data, and selecting a row selects the node.

import {
	annotate, filterGraph, recomputeTotals, classifyRole, dispersion, rankSinks,
	createLayout, fitTransform, nodeRadius, throughput,
	fmtUsd, fmtSol, fmtPct, relTime, ROLES,
} from './flow-map-core.js';

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 60_000;
const ROLE_IDS = ['source', 'hub', 'relay', 'sink', 'quiet'];

const state = {
	raw: null,
	view: null,
	window: '30d',
	kind: 'all',
	query: '',
	roles: new Set(ROLE_IDS),
	selected: null,
	hovered: null,
	layout: null,
	transform: { x: 0, y: 0, scale: 1 },
	radii: new Map(),
	positions: new Map(),
	images: new Map(),
	raf: 0,
	timer: 0,
	paused: false,
	reduceMotion: false,
};

// ── data ─────────────────────────────────────────────────────────────────────

async function load() {
	setOverlay('loading');
	try {
		const r = await fetch(`/api/pulse?view=graph&window=${encodeURIComponent(state.window)}`, {
			headers: { accept: 'application/json' },
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const body = await r.json();
		if (!body?.data) throw new Error('malformed response');
		state.raw = annotate(body.data);
		state.error = null;
		applyFilters({ relayout: true });
		stamp();
	} catch (err) {
		state.error = err;
		setOverlay('error', err);
	}
}

/** Rebuild the view from the raw payload plus the current filters. */
function applyFilters({ relayout = false } = {}) {
	if (!state.raw) return;
	const filtered = recomputeTotals(
		filterGraph(state.raw, { kind: state.kind, query: state.query }),
	);
	// Role is judged on the FILTERED totals, so a role badge always describes
	// what is actually on screen rather than the unfiltered window behind it.
	const scored = annotate(filtered);
	const roleFiltered = state.roles.size === ROLE_IDS.length
		? scored
		: dropRoles(scored, state.roles);

	state.view = roleFiltered;
	if (state.selected && !roleFiltered.nodes.some((n) => n.id === state.selected)) {
		state.selected = null;
	}

	if (relayout || !state.layout) relayoutView();
	renderStats();
	renderServices();
	renderTable();
	renderDetail();
	setOverlay(roleFiltered.nodes.length ? null : 'empty');
	draw();
}

/** Hide whole roles, then drop any edge that lost an end. */
function dropRoles(graph, roles) {
	const kept = new Set(graph.nodes.filter((n) => roles.has(n.role)).map((n) => n.id));
	const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
	const live = new Set(edges.flatMap((e) => [e.from, e.to]));
	return { ...graph, nodes: graph.nodes.filter((n) => live.has(n.id) || kept.has(n.id)), edges };
}

function relayoutView() {
	const canvas = $('#fm-canvas');
	if (!canvas || !state.view) return;
	const w = canvas.clientWidth || 900;
	const h = canvas.clientHeight || 600;
	// Seeded on the window, so switching filters keeps the arrangement stable and
	// switching windows gives the topology room to genuinely rearrange.
	const seed = 1337 + state.window.length * 97;
	state.layout = createLayout(state.view, { width: w, height: h, seed });
	state.layout.settle(state.reduceMotion ? 600 : 320);
	state.positions = state.layout.positions();
	state.transform = fitTransform(state.layout.bounds(), w, h, 56);

	const max = Math.max(0, ...state.view.nodes.map(throughput));
	state.radii = new Map(state.view.nodes.map((n) => [n.id, nodeRadius(n, max)]));
	preloadAvatars();
}

function preloadAvatars() {
	for (const n of state.view?.nodes || []) {
		if (!n.avatar_thumbnail_url || state.images.has(n.id)) continue;
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.decoding = 'async';
		img.onload = () => { state.images.set(n.id, img); draw(); };
		// A missing thumbnail is normal, not an error: the node falls back to its
		// role-coloured disc and the map stays complete.
		img.onerror = () => state.images.set(n.id, null);
		state.images.set(n.id, undefined);
		img.src = n.avatar_thumbnail_url;
	}
}

// ── canvas ───────────────────────────────────────────────────────────────────

function sizeCanvas() {
	const canvas = $('#fm-canvas');
	if (!canvas) return;
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (!w || !h) return;
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	const ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPointerVar
	? ''
	: getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const roleColor = (role) => cssVar(`--fm-${role}`) || '#888';

function toScreen(p) {
	const { x, y, scale } = state.transform;
	return { x: p.x * scale + x, y: p.y * scale + y };
}

function draw(now = performance.now()) {
	const canvas = $('#fm-canvas');
	if (!canvas || !state.view) return;
	const ctx = canvas.getContext('2d');
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	ctx.clearRect(0, 0, w, h);

	const { scale } = state.transform;
	const nodesById = new Map(state.view.nodes.map((n) => [n.id, n]));
	const focus = state.hovered || state.selected;
	const neighbours = focus ? neighboursOf(focus) : null;

	const maxEdgeUsd = Math.max(0, ...state.view.edges.map((e) => e.usd || 0));

	for (const e of state.view.edges) {
		const a = state.positions.get(e.from);
		const b = state.positions.get(e.to);
		if (!a || !b) continue;
		const dim = focus && !(e.from === focus || e.to === focus);
		const pa = toScreen(a);
		const pb = toScreen(b);
		const weight = maxEdgeUsd > 0 ? Math.sqrt((e.usd || 0) / maxEdgeUsd) : 0.3;

		ctx.save();
		ctx.globalAlpha = dim ? 0.06 : 0.34 + weight * 0.4;
		ctx.strokeStyle = e.kinds?.includes('tip')
			? roleColor('sink')
			: roleColor('hub');
		ctx.lineWidth = Math.max(0.7, (0.8 + weight * 2.6) * Math.min(1.4, scale));
		ctx.beginPath();
		ctx.moveTo(pa.x, pa.y);
		ctx.lineTo(pb.x, pb.y);
		ctx.stroke();
		ctx.restore();

		if (dim) continue;
		drawParticles(ctx, pa, pb, e, weight, now);
	}

	const ordered = [...state.view.nodes].sort(
		(x, y) => (state.radii.get(x.id) || 0) - (state.radii.get(y.id) || 0),
	);
	for (const n of ordered) {
		const p = state.positions.get(n.id);
		if (!p) continue;
		const s = toScreen(p);
		const r = (state.radii.get(n.id) || 10) * Math.min(1.5, Math.max(0.55, scale));
		const dim = focus && n.id !== focus && !neighbours?.has(n.id);
		drawNode(ctx, n, s, r, dim, n.id === state.selected, n.id === state.hovered);
	}

	// Label only what can be read: at low zoom labels turn into noise.
	if (scale > 0.62) {
		ctx.save();
		ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		for (const n of ordered) {
			const p = state.positions.get(n.id);
			if (!p) continue;
			const r = (state.radii.get(n.id) || 10) * Math.min(1.5, Math.max(0.55, scale));
			if (r < 12 && n.id !== focus) continue;
			const s = toScreen(p);
			const dim = focus && n.id !== focus && !neighbours?.has(n.id);
			ctx.globalAlpha = dim ? 0.12 : 0.82;
			ctx.fillStyle = `rgb(${cssVar('--fm-canvas-ink') || '255,255,255'})`;
			ctx.fillText(truncate(n.name, 18), s.x, s.y + r + 5);
		}
		ctx.restore();
	}
}

function drawNode(ctx, n, s, r, dim, selected, hovered) {
	const color = roleColor(n.role || 'quiet');
	ctx.save();
	ctx.globalAlpha = dim ? 0.16 : 1;

	if (selected || hovered) {
		ctx.beginPath();
		ctx.arc(s.x, s.y, r + (selected ? 7 : 4), 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.globalAlpha = dim ? 0.08 : selected ? 0.26 : 0.16;
		ctx.fill();
		ctx.globalAlpha = dim ? 0.16 : 1;
	}

	const img = state.images.get(n.id);
	if (img) {
		ctx.save();
		ctx.beginPath();
		ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
		ctx.clip();
		ctx.drawImage(img, s.x - r, s.y - r, r * 2, r * 2);
		ctx.restore();
	} else {
		ctx.beginPath();
		ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.globalAlpha = (dim ? 0.16 : 1) * 0.24;
		ctx.fill();
		ctx.globalAlpha = dim ? 0.16 : 1;
	}

	ctx.beginPath();
	ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
	ctx.strokeStyle = color;
	ctx.lineWidth = selected ? 2.4 : 1.5;
	ctx.stroke();

	// An address-only counterparty is drawn as a dashed ring: the map should not
	// imply we know who a wallet belongs to when we do not.
	if (n.kind === 'wallet') {
		ctx.beginPath();
		ctx.setLineDash([2.5, 3]);
		ctx.arc(s.x, s.y, r + 2.5, 0, Math.PI * 2);
		ctx.globalAlpha = (dim ? 0.16 : 1) * 0.5;
		ctx.stroke();
		ctx.setLineDash([]);
	}
	ctx.restore();
}

function drawParticles(ctx, a, b, e, weight, now) {
	if (state.reduceMotion || state.paused) return;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const dist = Math.hypot(dx, dy);
	if (dist < 6) return;
	// One dot per handful of transfers, capped: the animation reads the busiest
	// routes as busier without turning them into a solid line.
	const count = Math.min(4, 1 + Math.floor(Math.log2(1 + (e.count || 1))));
	const speed = 0.00013 + weight * 0.00009;
	ctx.save();
	ctx.fillStyle = e.kinds?.includes('tip') ? roleColor('sink') : roleColor('accent');
	for (let i = 0; i < count; i += 1) {
		const t = ((now * speed) + i / count + hash01(e.from + e.to + i)) % 1;
		const x = a.x + dx * t;
		const y = a.y + dy * t;
		ctx.globalAlpha = 0.85 * Math.sin(Math.PI * t) ** 0.6;
		ctx.beginPath();
		ctx.arc(x, y, 1.6 + weight * 1.5, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

/** Stable per-edge phase offset so dots do not march in lockstep. */
function hash01(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return ((h >>> 0) % 1000) / 1000;
}

function neighboursOf(id) {
	const set = new Set([id]);
	for (const e of state.view?.edges || []) {
		if (e.from === id) set.add(e.to);
		if (e.to === id) set.add(e.from);
	}
	return set;
}

function tick(now) {
	state.raf = requestAnimationFrame(tick);
	if (document.hidden || state.paused || state.reduceMotion) return;
	draw(now);
}

// ── hit testing, pan and zoom ────────────────────────────────────────────────

function nodeAt(px, py) {
	let best = null;
	let bestD = Infinity;
	for (const n of state.view?.nodes || []) {
		const p = state.positions.get(n.id);
		if (!p) continue;
		const s = toScreen(p);
		const r = (state.radii.get(n.id) || 10) * Math.min(1.5, Math.max(0.55, state.transform.scale));
		const d = Math.hypot(s.x - px, s.y - py);
		if (d <= r + 4 && d < bestD) { best = n; bestD = d; }
	}
	return best;
}

function bindCanvas() {
	const canvas = $('#fm-canvas');
	const tip = $('#fm-tip');
	let dragging = false;
	let moved = false;
	let last = null;

	const localPoint = (ev) => {
		const rect = canvas.getBoundingClientRect();
		return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
	};

	canvas.addEventListener('pointerdown', (ev) => {
		dragging = true;
		moved = false;
		last = { x: ev.clientX, y: ev.clientY };
		canvas.setPointerCapture(ev.pointerId);
		canvas.classList.add('is-dragging');
	});

	canvas.addEventListener('pointermove', (ev) => {
		const p = localPoint(ev);
		if (dragging && last) {
			const dx = ev.clientX - last.x;
			const dy = ev.clientY - last.y;
			if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
			state.transform.x += dx;
			state.transform.y += dy;
			last = { x: ev.clientX, y: ev.clientY };
			draw();
			return;
		}
		const hit = nodeAt(p.x, p.y);
		const id = hit?.id || null;
		canvas.classList.toggle('is-hot', Boolean(hit));
		if (id !== state.hovered) {
			state.hovered = id;
			draw();
		}
		if (hit) showTip(tip, hit, p, canvas);
		else tip.classList.remove('is-on');
	});

	const endDrag = (ev) => {
		if (!dragging) return;
		dragging = false;
		canvas.classList.remove('is-dragging');
		if (ev?.pointerId != null && canvas.hasPointerCapture?.(ev.pointerId)) {
			canvas.releasePointerCapture(ev.pointerId);
		}
		if (!moved && ev) {
			const p = localPoint(ev);
			select(nodeAt(p.x, p.y)?.id || null);
		}
	};
	canvas.addEventListener('pointerup', endDrag);
	canvas.addEventListener('pointercancel', () => { dragging = false; canvas.classList.remove('is-dragging'); });

	canvas.addEventListener('pointerleave', () => {
		tip.classList.remove('is-on');
		if (state.hovered) { state.hovered = null; draw(); }
	});

	canvas.addEventListener('wheel', (ev) => {
		ev.preventDefault();
		const rect = canvas.getBoundingClientRect();
		zoomAround(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-ev.deltaY * 0.0016));
	}, { passive: false });

	$('#fm-zoom-in').addEventListener('click', () => zoomAround(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.25));
	$('#fm-zoom-out').addEventListener('click', () => zoomAround(canvas.clientWidth / 2, canvas.clientHeight / 2, 0.8));
	$('#fm-zoom-fit').addEventListener('click', () => {
		if (!state.layout) return;
		state.transform = fitTransform(state.layout.bounds(), canvas.clientWidth, canvas.clientHeight, 56);
		draw();
	});
}

function zoomAround(cx, cy, factor) {
	const t = state.transform;
	const next = Math.min(4, Math.max(0.22, t.scale * factor));
	const k = next / t.scale;
	t.x = cx - (cx - t.x) * k;
	t.y = cy - (cy - t.y) * k;
	t.scale = next;
	draw();
}

function showTip(tip, node, at, canvas) {
	const role = ROLES[node.role] || ROLES.quiet;
	tip.innerHTML = `<b></b><span></span>`;
	tip.querySelector('b').textContent = node.name;
	tip.querySelector('span').textContent =
		`${role.label} · in ${fmtUsd(node.in_usd)} · out ${fmtUsd(node.out_usd)} · ${node.in_count + node.out_count} transfers`;
	tip.classList.add('is-on');
	const w = tip.offsetWidth;
	const h = tip.offsetHeight;
	const x = Math.min(canvas.clientWidth - w - 8, Math.max(8, at.x + 14));
	const y = Math.max(8, at.y - h - 12);
	tip.style.left = `${x}px`;
	tip.style.top = `${y}px`;
}

// ── selection + detail rail ──────────────────────────────────────────────────

function select(id) {
	state.selected = id;
	renderDetail();
	renderTable();
	draw();
}

function renderDetail() {
	const host = $('#fm-detail');
	if (!host) return;
	const node = state.view?.nodes.find((n) => n.id === state.selected);

	if (!node) {
		host.innerHTML = '';
		const empty = document.createElement('div');
		empty.className = 'fm-empty-rail';
		empty.innerHTML =
			'<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
			'<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="11" cy="18" r="2.5"/>' +
			'<path d="M8.2 6.6 15.6 7.6M16.8 10.2 12.4 15.6M9.4 16.2 7 8.4"/></svg>';
		const p = document.createElement('p');
		p.textContent = 'Pick any wallet on the map, or a row in the table below, to see who it pays and who pays it.';
		empty.append(p);
		host.append(empty);
		return;
	}

	const role = ROLES[node.role] || ROLES.quiet;
	const total = node.in_usd + node.out_usd;
	const inPct = total > 0 ? (node.in_usd / total) * 100 : 0;

	host.innerHTML = '';

	const head = document.createElement('div');
	head.className = 'fm-detail-head';
	const img = state.images.get(node.id);
	if (img && node.avatar_thumbnail_url) {
		const el = document.createElement('img');
		el.className = 'fm-avatar';
		el.src = node.avatar_thumbnail_url;
		el.alt = '';
		head.append(el);
	} else {
		const el = document.createElement('div');
		el.className = 'fm-avatar fm-avatar--fallback';
		el.setAttribute('aria-hidden', 'true');
		el.textContent = (node.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '··';
		head.append(el);
	}
	const name = document.createElement('div');
	name.className = 'fm-detail-name';
	const b = document.createElement('b');
	b.textContent = node.name;
	const code = document.createElement('code');
	code.textContent = node.address_short || '';
	name.append(b, code);
	head.append(name);
	host.append(head);

	const badge = document.createElement('span');
	badge.className = 'fm-role';
	badge.dataset.role = role.id;
	badge.textContent = role.label;
	badge.title = role.hint;
	host.append(badge);

	const why = document.createElement('p');
	why.style.margin = '8px 0 12px';
	why.textContent = role.hint;
	host.append(why);

	const split = document.createElement('div');
	split.className = 'fm-split';
	split.setAttribute('role', 'img');
	split.setAttribute('aria-label', `${fmtUsd(node.in_usd)} received, ${fmtUsd(node.out_usd)} paid out`);
	split.innerHTML = '<i class="in"></i><i class="out"></i>';
	split.querySelector('.in').style.width = `${inPct}%`;
	split.querySelector('.out').style.width = `${100 - inPct}%`;
	host.append(split);

	const kv = document.createElement('dl');
	kv.className = 'fm-kv';
	const rows = [
		['Received', fmtUsd(node.in_usd), ''],
		['Paid out', fmtUsd(node.out_usd), ''],
		['Net', fmtUsd(node.net_usd), node.net_usd > 0 ? 'neg' : 'pos'],
		['Transfers', String(node.in_count + node.out_count), ''],
		['Counterparties', String(node.partners), ''],
		['SOL moved', fmtSol(node.in_sol + node.out_sol), ''],
	];
	for (const [k, v, cls] of rows) {
		const dt = document.createElement('dt');
		dt.textContent = k;
		const dd = document.createElement('dd');
		dd.textContent = v;
		if (cls) dd.className = cls;
		kv.append(dt, dd);
	}
	host.append(kv);

	const services = [...new Set(
		(state.view?.edges || [])
			.filter((e) => e.from === node.id || e.to === node.id)
			.flatMap((e) => e.services || []),
	)];
	if (services.length) {
		const chips = document.createElement('div');
		chips.className = 'fm-chips';
		for (const s of services.slice(0, 8)) {
			const chip = document.createElement('span');
			chip.className = 'fm-chip';
			chip.textContent = s;
			chips.append(chip);
		}
		host.append(chips);
	}

	const peers = (state.view?.edges || [])
		.filter((e) => e.from === node.id || e.to === node.id)
		.map((e) => {
			const outbound = e.from === node.id;
			const otherId = outbound ? e.to : e.from;
			return { outbound, otherId, other: state.view.nodes.find((n) => n.id === otherId), edge: e };
		})
		.filter((p) => p.other)
		.sort((a, b) => b.edge.usd - a.edge.usd)
		.slice(0, 8);

	if (peers.length) {
		const h2 = document.createElement('h2');
		h2.textContent = 'Routes';
		h2.style.margin = '4px 0 6px';
		const ul = document.createElement('ul');
		ul.className = 'fm-peers';
		for (const p of peers) {
			const li = document.createElement('li');
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'fm-peer';
			btn.title = `${p.edge.count} transfer(s), last ${relTime(p.edge.last_ts)}`;
			const dir = document.createElement('span');
			dir.className = `fm-peer-dir ${p.outbound ? 'out' : 'in'}`;
			dir.textContent = p.outbound ? '→' : '←';
			dir.setAttribute('aria-label', p.outbound ? 'pays' : 'paid by');
			const nm = document.createElement('span');
			nm.className = 'fm-peer-name';
			nm.textContent = p.other.name;
			const amt = document.createElement('span');
			amt.className = 'fm-peer-amt';
			amt.textContent = fmtUsd(p.edge.usd);
			btn.append(dir, nm, amt);
			btn.addEventListener('click', () => select(p.otherId));
			li.append(btn);
			ul.append(li);
		}
		host.append(h2, ul);
	}

	const links = document.createElement('div');
	links.className = 'fm-links';
	if (node.url) {
		const a = document.createElement('a');
		a.href = node.url;
		a.textContent = 'Agent profile';
		links.append(a);
	}
	if (node.explorer) {
		const a = document.createElement('a');
		a.href = node.explorer;
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		a.textContent = 'Wallet on Solscan';
		links.append(a);
	}
	if (node.agent_id) {
		const a = document.createElement('a');
		a.href = `/pulse?agent=${encodeURIComponent(node.agent_id)}`;
		a.textContent = 'Wallet story';
		links.append(a);
	}
	if (links.children.length) host.append(links);
}

// ── stats, services, table ───────────────────────────────────────────────────

function renderStats() {
	const host = $('#fm-stats');
	if (!host || !state.view) return;
	const g = state.view;
	const usd = g.edges.reduce((s, e) => s + (e.usd || 0), 0);
	const transfers = g.edges.reduce((s, e) => s + (e.count || 0), 0);
	const disp = dispersion(g);
	const sinks = rankSinks(g, 1);

	const cards = [
		{ k: 'Value moved', v: fmtUsd(usd), sub: `${fmtSol(g.edges.reduce((s, e) => s + (e.sol || 0), 0))} SOL settled` },
		{ k: 'Transfers', v: transfers.toLocaleString('en-US'), sub: `across ${g.edges.length} routes` },
		{ k: 'Wallets', v: String(g.nodes.length), sub: `${g.nodes.filter((n) => n.kind === 'agent').length} named agents` },
		{
			k: 'Stuck capital',
			v: fmtPct(disp),
			sub: sinks.length ? `most in ${truncate(sinks[0].name, 16)}` : 'nothing one-way',
			flag: disp >= 0.4,
		},
	];

	host.innerHTML = '';
	for (const c of cards) {
		const box = document.createElement('div');
		box.className = `fm-stat${c.flag ? ' fm-stat--flag' : ''}`;
		const dt = document.createElement('dt');
		dt.textContent = c.k;
		const dd = document.createElement('dd');
		dd.textContent = c.v;
		const sub = document.createElement('span');
		sub.className = 'fm-stat-sub';
		sub.textContent = c.sub;
		box.append(dt, dd, sub);
		host.append(box);
	}
	if (cards[3].flag) {
		host.lastElementChild.title =
			'Most of the value that entered these wallets has not moved again. That is capital dispersion: the loop is open.';
	}
}

function renderServices() {
	const host = $('#fm-services');
	const section = $('#fm-services-section');
	if (!host || !section) return;
	const services = state.raw?.services || [];
	section.hidden = services.length === 0;
	if (!services.length) return;
	const max = Math.max(...services.map((s) => s.usd || 0), 0);
	host.innerHTML = '';
	for (const s of services) {
		const box = document.createElement('div');
		box.className = 'fm-service';
		const b = document.createElement('b');
		b.textContent = s.name;
		const span = document.createElement('span');
		span.textContent = `${fmtUsd(s.usd)} · ${s.count} call${s.count === 1 ? '' : 's'}`;
		const bar = document.createElement('div');
		bar.className = 'fm-service-bar';
		const i = document.createElement('i');
		i.style.width = max > 0 ? `${Math.max(3, (s.usd / max) * 100)}%` : '3%';
		bar.append(i);
		box.append(b, span, bar);
		host.append(box);
	}
}

function renderTable() {
	const body = $('#fm-tbody');
	const caption = $('#fm-table-caption');
	if (!body || !state.view) return;
	const nodes = [...state.view.nodes].sort((a, b) => b.throughput_usd - a.throughput_usd);
	caption.textContent = nodes.length
		? `Every wallet on the map, ranked by value handled. Selecting a row highlights it above. ${nodes.length} shown.`
		: 'No wallets match the current filters.';

	body.innerHTML = '';
	for (const n of nodes) {
		const tr = document.createElement('tr');
		tr.tabIndex = 0;
		tr.dataset.id = n.id;
		if (n.id === state.selected) tr.setAttribute('aria-selected', 'true');

		const nameCell = document.createElement('td');
		if (n.url) {
			const a = document.createElement('a');
			a.href = n.url;
			a.textContent = n.name;
			nameCell.append(a);
		} else {
			nameCell.textContent = n.name;
		}

		const roleCell = document.createElement('td');
		const badge = document.createElement('span');
		badge.className = 'fm-role';
		badge.dataset.role = n.role;
		badge.textContent = (ROLES[n.role] || ROLES.quiet).label;
		roleCell.append(badge);

		const cells = [
			nameCell,
			roleCell,
			numCell(fmtUsd(n.in_usd)),
			numCell(fmtUsd(n.out_usd)),
			numCell(fmtUsd(n.net_usd)),
			numCell(String(n.in_count + n.out_count)),
			numCell(String(n.partners)),
		];
		tr.append(...cells);
		const activate = () => select(n.id);
		tr.addEventListener('click', activate);
		tr.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); }
		});
		body.append(tr);
	}
}

function numCell(text) {
	const td = document.createElement('td');
	td.className = 'num';
	td.textContent = text;
	return td;
}

function truncate(s, n) {
	const str = String(s || '');
	return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// ── page states ──────────────────────────────────────────────────────────────

function setOverlay(kind, err) {
	const overlay = $('#fm-overlay');
	const skeleton = $('#fm-skeleton');
	if (!overlay) return;
	overlay.innerHTML = '';
	if (!kind) {
		overlay.hidden = true;
		skeleton.hidden = true;
		$('#fm-canvas').setAttribute('aria-busy', 'false');
		return;
	}
	overlay.hidden = false;
	skeleton.hidden = kind !== 'loading';
	$('#fm-canvas').setAttribute('aria-busy', kind === 'loading' ? 'true' : 'false');

	if (kind === 'loading') {
		const spin = document.createElement('div');
		spin.className = 'fm-spinner';
		const p = document.createElement('p');
		p.textContent = 'Reading settled transfers…';
		overlay.append(spin, p);
		return;
	}

	const h2 = document.createElement('h2');
	const p = document.createElement('p');
	if (kind === 'error') {
		h2.textContent = 'The flow map could not load';
		p.textContent = `${err?.message || 'The request failed'}. The graph is read live from settled on-chain transfers, so there is nothing cached to fall back to.`;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'fm-btn';
		btn.textContent = 'Try again';
		btn.addEventListener('click', load);
		overlay.append(h2, p, btn);
		return;
	}

	const filtered = state.query || state.kind !== 'all' || state.roles.size !== ROLE_IDS.length;
	h2.textContent = filtered ? 'Nothing matches those filters' : 'No settled flow in this window';
	p.textContent = filtered
		? 'Widen the window, clear the search, or turn a role back on.'
		: 'Every edge here is a real on-chain transfer between agent wallets, so a quiet platform draws an empty map rather than a fabricated one. Try a longer window.';
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'fm-btn';
	btn.textContent = filtered ? 'Clear filters' : 'Show 90 days';
	btn.addEventListener('click', () => {
		if (filtered) resetFilters();
		else setWindow('90d');
	});
	overlay.append(h2, p, btn);
}

function stamp() {
	const el = $('#fm-stamp');
	if (!el || !state.raw) return;
	const bits = [`updated ${relTime(state.raw.generated_at)}`];
	if (state.raw.truncated) bits.push(`top ${state.raw.max_edges} routes`);
	el.textContent = bits.join(' · ');
	const note = $('#fm-truncated');
	if (note) {
		note.hidden = !state.raw.truncated;
		note.textContent = state.raw.truncated
			? `This window has more routes than the map draws. Showing the ${state.raw.max_edges} largest by value; the totals above describe what is drawn, not the whole window.`
			: '';
	}
}

// ── controls ─────────────────────────────────────────────────────────────────

function setWindow(w) {
	state.window = w;
	for (const b of document.querySelectorAll('[data-window]')) {
		b.setAttribute('aria-pressed', String(b.dataset.window === w));
	}
	load();
}

function resetFilters() {
	state.query = '';
	state.kind = 'all';
	state.roles = new Set(ROLE_IDS);
	$('#fm-q').value = '';
	for (const b of document.querySelectorAll('[data-kind]')) {
		b.setAttribute('aria-pressed', String(b.dataset.kind === 'all'));
	}
	for (const b of document.querySelectorAll('[data-role]')) b.setAttribute('aria-pressed', 'true');
	applyFilters({ relayout: true });
}

function bindControls() {
	for (const b of document.querySelectorAll('[data-window]')) {
		b.addEventListener('click', () => setWindow(b.dataset.window));
	}
	for (const b of document.querySelectorAll('[data-kind]')) {
		b.addEventListener('click', () => {
			state.kind = b.dataset.kind;
			for (const o of document.querySelectorAll('[data-kind]')) {
				o.setAttribute('aria-pressed', String(o === b));
			}
			applyFilters({ relayout: true });
		});
	}
	for (const b of document.querySelectorAll('#fm-legend [data-role]')) {
		b.addEventListener('click', () => {
			const role = b.dataset.role;
			if (state.roles.has(role)) state.roles.delete(role);
			else state.roles.add(role);
			if (!state.roles.size) state.roles = new Set(ROLE_IDS);
			for (const o of document.querySelectorAll('#fm-legend [data-role]')) {
				o.setAttribute('aria-pressed', String(state.roles.has(o.dataset.role)));
			}
			applyFilters({ relayout: true });
		});
	}

	const q = $('#fm-q');
	let debounce = 0;
	q.addEventListener('input', () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			state.query = q.value;
			$('#fm-q-clear').hidden = !q.value;
			applyFilters({ relayout: true });
		}, 180);
	});
	$('#fm-q-clear').addEventListener('click', () => {
		q.value = '';
		state.query = '';
		$('#fm-q-clear').hidden = true;
		q.focus();
		applyFilters({ relayout: true });
	});

	$('#fm-refresh').addEventListener('click', load);
	const pause = $('#fm-pause');
	pause.addEventListener('click', () => {
		state.paused = !state.paused;
		pause.setAttribute('aria-pressed', String(state.paused));
		pause.textContent = state.paused ? 'Resume' : 'Pause';
		if (!state.paused) draw();
	});

	document.addEventListener('keydown', (ev) => {
		if (ev.target.matches('input, textarea')) return;
		if (ev.key === '/') { ev.preventDefault(); q.focus(); }
		if (ev.key === 'Escape') select(null);
		if (ev.key === 'r' && !ev.metaKey && !ev.ctrlKey) load();
	});
}

// ── boot ─────────────────────────────────────────────────────────────────────

function boot() {
	state.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
	sizeCanvas();
	bindCanvas();
	bindControls();
	renderDetail();

	let resizeTimer = 0;
	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			sizeCanvas();
			relayoutView();
			draw();
		}, 160);
	});

	// Polling stops entirely in a hidden tab: this is an RPC-backed read and an
	// ops page left open all day should not keep paying for nobody.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			clearInterval(state.timer);
			state.timer = 0;
		} else if (!state.timer) {
			state.timer = setInterval(() => { if (!state.paused) load(); }, REFRESH_MS);
			load();
		}
	});
	state.timer = setInterval(() => { if (!state.paused) load(); }, REFRESH_MS);
	setInterval(stamp, 15_000);

	if (!state.reduceMotion) state.raf = requestAnimationFrame(tick);
	load();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
