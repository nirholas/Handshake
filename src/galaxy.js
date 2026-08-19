// Agent Galaxy — the interactive 3D star-map.
//
// Fetches the constellation snapshot from /api/galaxy (agents positioned by IBM
// Granite embeddings on watsonx.ai), renders it as a glowing point cloud with
// Three.js, and wires the exploration UI: hover tooltips, click-to-inspect, a
// Granite-powered semantic search that lights up matching stars, and a legend that
// flies the camera to each named constellation.
//
// All data is real (no mock path). When the backend can't build the galaxy — most
// often because watsonx isn't configured — the viewer explains rather than faking a
// universe.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { track, ANALYTICS_EVENTS } from './analytics.js';
import { walletChipHTML, wireWalletChips } from './shared/agent-wallet-chip.js';

const REDUCED_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);

// ── DOM ──────────────────────────────────────────────────────────────────────
const els = {};
function cacheEls() {
	for (const id of [
		'gxStage', 'gxCanvas', 'gxHud', 'gxStats', 'gxStatAgents', 'gxStatClusters',
		'gxSearch', 'gxSearchInput', 'gxSearchClear', 'gxSearchGo',
		'gxLegend', 'gxLegendList', 'gxLegendToggle',
		'gxTip', 'gxCard', 'gxCardClose', 'gxCardThumb', 'gxCardName', 'gxCardConstellation',
		'gxCardDesc', 'gxCardMeta', 'gxCardView', 'gxCardChat',
		'gxResults', 'gxResultsList', 'gxResultsClose', 'gxResultsLabel',
		'gxLoading', 'gxEmpty', 'gxEmptySub', 'gxError', 'gxErrorSub', 'gxRetry', 'gxHint',
		// Money-Cam
		'gxMoneyToggle', 'gxMoneyCam', 'gxMcLiveDot', 'gxMcClose',
		'gxMcModeLive', 'gxMcModeReplay', 'gxMcStats', 'gxMcReplay', 'gxMcPlay',
		'gxMcScrub', 'gxMcSpeed', 'gxMcTime', 'gxMcFilters', 'gxMcTicker', 'gxMcNote',
		'gxFlow', 'gxFlowClose', 'gxFlowBody',
	]) {
		els[id] = $(id);
	}
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
	data: null, // galaxy payload
	clusterById: new Map(),
	idToIndex: new Map(), // agent id → point index
	networthById: new Map(), // agent id → { usd, tier, level, wealth } from real wallets
	selected: -1,
	focusMode: null, // 'search' | 'cluster' | null
	focusCluster: -1,
};

// Three.js handles
let renderer, scene, camera, controls, points, geom, mat, labelLayer;
let raycaster, clock;
const pointer = new THREE.Vector2();
let hoverIndex = -1;
let rafPending = false;

// Camera fly-to tween
const fly = { active: false, t: 0, dur: 0.9, fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(), fromTgt: new THREE.Vector3(), toTgt: new THREE.Vector3() };

// ── Money-Cam ────────────────────────────────────────────────────────────────
// The galaxy as the platform's live economy: every real, on-chain transfer that
// touches a star is rendered as light moving between them. Data is /api/galaxy/flows
// (agent↔agent edges + one-sided flares), all real — when it's quiet, it's calm.
let flowLayer = null;
let pollTimer = null;
const FLOW_COLORS = {
	tip: '#4ade80', // inbound value — success green
	trade: '#4589ff', // a trade — brand blue
	snipe: '#fbbf24', // a snipe — warn amber
	payment: '#c4b5fd', // agent→agent payment — wallet violet
	launch: '#ffd27a', // a coin launch — gold
};
const LIVE_POLL_MS = 6000; // cheap delta poll cadence while live + visible
const REPLAY_DURATION_S = 30; // wall-clock to replay the whole loaded window at 1×
const money = {
	active: false,
	mode: 'live', // 'live' | 'replay'
	type: 'all', // all | tips | trades | payments | launches
	history: [], // loaded flows, ascending by ts (the honest data window)
	seen: new Set(), // flow ids already enqueued/animated (dedupe across polls)
	queue: [], // flows waiting to animate (paced, never a frame-dropping burst)
	releaseAcc: 0,
	headCursor: null, // newest cursor — handed back as ?since= to poll the delta
	loading: false,
	pollFails: 0,
	lastServerTime: null,
	// replay
	replayT: 1, // 0..1 playhead across the window
	replaySpeed: 1,
	replayPlaying: false,
	replayPtr: 0, // index in history spawned up to
	nodeVec: new Map(), // agentId → THREE.Vector3 (cached node world position)
};

// Public debug/verification surface.
const dbg = (window.__galaxy = {
	ready: false,
	status: 'loading',
	error: null,
	agentCount: 0,
	clusterCount: 0,
	pointCount: 0,
	search: (q) => runSearch(q),
	refresh: () => loadGalaxy(true),
});

// ── Boot ───────────────────────────────────────────────────────────────────
function boot() {
	// Engagement: the galaxy visualizer surface opened.
	track(ANALYTICS_EVENTS.SURFACE_OPENED, { surface: 'visualizer:galaxy' });
	cacheEls();
	setupThree();
	bindUI();
	loadGalaxy(false);
}

// ── Data ───────────────────────────────────────────────────────────────────
async function loadGalaxy(refresh) {
	showOverlay('loading');
	dbg.status = 'loading';
	try {
		const res = await fetch(`/api/galaxy${refresh ? '?refresh=1' : ''}`, {
			headers: { accept: 'application/json' },
		});
		const body = await res.json().catch(() => ({}));

		if (!res.ok) {
			if (res.status === 503 && body.error === 'watsonx_unavailable') {
				return showError(
					'IBM Granite isn’t connected',
					'The galaxy is positioned by IBM Granite embeddings on watsonx.ai. ' +
						'Once watsonx credentials are configured, the universe lights up here.',
					false,
				);
			}
			return showError('Couldn’t reach the stars', body.error_description || `Request failed (${res.status}).`);
		}

		if (!body.agents || body.agents.length === 0) {
			dbg.status = 'empty';
			return showOverlay('empty');
		}

		renderGalaxy(body);
		hideOverlays();
		dbg.status = 'ready';
		dbg.ready = true;
	} catch (err) {
		showError('Couldn’t reach the stars', err?.message || 'Network error.');
	}
}

// ── Render the constellation ─────────────────────────────────────────────────
function renderGalaxy(data) {
	state.data = data;
	state.clusterById = new Map(data.clusters.map((c) => [c.id, c]));

	disposePoints();

	const n = data.agents.length;
	const positions = new Float32Array(n * 3);
	const colors = new Float32Array(n * 3);
	const sizes = new Float32Array(n);
	const seeds = new Float32Array(n);
	const states = new Float32Array(n); // 0 normal, 1 highlit, -1 dimmed
	const wealth = new Float32Array(n); // 0 dormant … 1 luminous (real net worth)

	const color = new THREE.Color();
	const maxChats = Math.max(1, ...data.agents.map((a) => a.chat_count || 0));

	state.idToIndex.clear();
	state.networthById = new Map();
	data.agents.forEach((a, i) => {
		state.idToIndex.set(a.id, i);
		const [x, y, z] = a.coords;
		positions[i * 3] = x;
		positions[i * 3 + 1] = y;
		positions[i * 3 + 2] = z;
		const cluster = state.clusterById.get(a.cluster);
		color.set((cluster && cluster.color) || '#78a9ff');
		colors[i * 3] = color.r;
		colors[i * 3 + 1] = color.g;
		colors[i * 3 + 2] = color.b;
		// Base size grows with engagement (chat volume), gently (log scale).
		sizes[i] = 7 + 9 * (Math.log1p(a.chat_count || 0) / Math.log1p(maxChats));
		seeds[i] = Math.random();
		states[i] = 0;
		wealth[i] = 0; // lit up asynchronously from real wallet net worth
	});

	geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
	geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
	geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
	geom.setAttribute('aState', new THREE.BufferAttribute(states, 1));
	geom.setAttribute('aWealth', new THREE.BufferAttribute(wealth, 1));

	mat = new THREE.ShaderMaterial({
		uniforms: {
			uTime: { value: 0 },
			uPixelRatio: { value: Math.min(devicePixelRatio || 1, 2) },
			uHighlight: { value: 0 },
			uDim: { value: 0.14 },
			uTwinkle: { value: REDUCED_MOTION ? 0 : 1 },
			uWealthPulse: { value: REDUCED_MOTION ? 0 : 1 },
			// Wallet-violet — funded stars bias toward the wallet accent so a glance
			// across the galaxy reads who is wealthy. Kept in the wallet palette.
			uWealthColor: { value: new THREE.Color('#c4b5fd') },
		},
		vertexShader: POINT_VERT,
		fragmentShader: POINT_FRAG,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});

	points = new THREE.Points(geom, mat);
	points.frustumCulled = false;
	scene.add(points);

	buildClusterLabels(data.clusters);
	buildLegend(data.clusters);
	loadNetWorth(data.agents);
	loadLineageEdges();

	// Stats
	els.gxStatAgents.innerHTML = `<strong>${n.toLocaleString()}</strong> agents`;
	els.gxStatClusters.innerHTML = `<strong>${data.clusters.length}</strong> constellations`;
	els.gxStats.hidden = false;
	els.gxLegend.hidden = false;

	dbg.agentCount = n;
	dbg.clusterCount = data.clusters.length;
	dbg.pointCount = n;

	// Frame the whole cloud.
	flyTo(new THREE.Vector3(0, 36, 322), new THREE.Vector3(0, 0, 0), 0.001);

	// Money-Cam: node positions changed with this snapshot — drop the cache and
	// (re)enable the entry. If the cam is already open, re-seed against the new map.
	money.nodeVec = new Map();
	if (els.gxMoneyToggle) els.gxMoneyToggle.disabled = false;
	if (money.active) {
		flowLayer?.reset();
		money.queue = [];
		loadWindow();
	}
}

// ── Net-worth glow (real wallet value lights the stars) ──────────────────────
// Every star is an agent with a real custodial wallet. We batch-read their net
// worth (api/agents/networth → the same priced-balance path the avatars use) and
// drive each point's `aWealth`, so the galaxy shows at a glance who is funded —
// from real chain data, never decoration. Failures degrade silently to the
// baseline (no glow), so a galaxy still renders if the read is unavailable.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function loadNetWorth(agents) {
	const ids = agents.map((a) => a.id).filter((id) => UUID_RE.test(String(id)));
	if (!ids.length || !geom) return;
	const wealthAttr = geom.getAttribute('aWealth');
	for (let i = 0; i < ids.length; i += 120) {
		const chunk = ids.slice(i, i + 120);
		let items;
		try {
			const res = await fetch(`/api/agents/networth?ids=${encodeURIComponent(chunk.join(','))}`, {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) return; // endpoint unavailable → keep the clean baseline
			const body = await res.json().catch(() => ({}));
			items = body?.data?.items || [];
		} catch {
			return;
		}
		if (!geom) return; // galaxy was disposed while we awaited
		for (const it of items) {
			const idx = state.idToIndex.get(it.id);
			if (idx == null) continue;
			state.networthById.set(it.id, it);
			wealthAttr.setX(idx, Math.max(0, Math.min(1, Number(it.wealth) || 0)));
		}
		wealthAttr.needsUpdate = true;
	}
	dbg.networthLit = state.networthById.size;
}

// ── Cluster labels (DOM, projected each frame) ───────────────────────────────
let clusterLabels = [];
function buildClusterLabels(clusters) {
	if (!labelLayer) {
		labelLayer = document.createElement('div');
		labelLayer.className = 'gx-clabels';
		els.gxStage.appendChild(labelLayer);
	}
	labelLayer.innerHTML = '';
	clusterLabels = clusters.map((c) => {
		const el = document.createElement('button');
		el.className = 'gx-clabel';
		el.type = 'button';
		el.style.setProperty('--c', c.color);
		el.innerHTML = `<span class="gx-clabel-dot"></span><span class="gx-clabel-text">${escapeHtml(c.label)}</span>`;
		el.title = c.theme || c.label;
		el.addEventListener('click', () => toggleClusterFocus(c.id));
		labelLayer.appendChild(el);
		return { el, pos: new THREE.Vector3(...c.centroid), id: c.id };
	});
}

function updateClusterLabels() {
	if (!clusterLabels.length) return;
	const w = renderer.domElement.clientWidth;
	const h = renderer.domElement.clientHeight;
	const v = new THREE.Vector3();
	for (const lbl of clusterLabels) {
		v.copy(lbl.pos).project(camera);
		const behind = v.z > 1;
		const dimmed = state.focusMode === 'cluster' && state.focusCluster !== lbl.id;
		if (behind) {
			lbl.el.style.opacity = '0';
			lbl.el.style.pointerEvents = 'none';
			continue;
		}
		const x = (v.x * 0.5 + 0.5) * w;
		const y = (-v.y * 0.5 + 0.5) * h;
		lbl.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
		lbl.el.style.opacity = dimmed ? '0.25' : '1';
		lbl.el.style.pointerEvents = 'auto';
	}
}

// ── Legend ───────────────────────────────────────────────────────────────────
function buildLegend(clusters) {
	els.gxLegendList.innerHTML = '';
	for (const c of clusters) {
		const li = document.createElement('li');
		const btn = document.createElement('button');
		btn.className = 'gx-legend-item';
		btn.type = 'button';
		btn.dataset.cluster = String(c.id);
		btn.innerHTML =
			`<span class="gx-legend-swatch" style="color:${escapeHtml(c.color)};background:${escapeHtml(c.color)}"></span>` +
			`<span class="gx-legend-name">${escapeHtml(c.label)}</span>` +
			`<span class="gx-legend-count">${c.size}</span>`;
		btn.title = c.theme || c.label;
		btn.addEventListener('click', () => toggleClusterFocus(c.id));
		li.appendChild(btn);
		els.gxLegendList.appendChild(li);
	}
}

function syncLegendActive() {
	for (const btn of els.gxLegendList.querySelectorAll('.gx-legend-item')) {
		const on = state.focusMode === 'cluster' && Number(btn.dataset.cluster) === state.focusCluster;
		btn.classList.toggle('gx-active', on);
	}
}

// ── Highlight machinery (shared by search + cluster focus) ──────────────────
function applyHighlight(indexSet) {
	const arr = geom.getAttribute('aState');
	for (let i = 0; i < arr.count; i++) arr.setX(i, indexSet.has(i) ? 1 : -1);
	arr.needsUpdate = true;
	mat.uniforms.uHighlight.value = 1;
}
function clearHighlight() {
	if (!geom) return;
	const arr = geom.getAttribute('aState');
	for (let i = 0; i < arr.count; i++) arr.setX(i, 0);
	arr.needsUpdate = true;
	mat.uniforms.uHighlight.value = 0;
	state.focusMode = null;
	state.focusCluster = -1;
	syncLegendActive();
}

function toggleClusterFocus(clusterId) {
	if (state.focusMode === 'cluster' && state.focusCluster === clusterId) {
		clearHighlight();
		return;
	}
	const members = new Set();
	state.data.agents.forEach((a, i) => {
		if (a.cluster === clusterId) members.add(i);
	});
	if (!members.size) return;
	applyHighlight(members);
	state.focusMode = 'cluster';
	state.focusCluster = clusterId;
	syncLegendActive();
	clearSearchUI();
	const c = state.clusterById.get(clusterId);
	if (c) flyToTarget(new THREE.Vector3(...c.centroid), 220);
}

// ── Semantic search (Granite) ───────────────────────────────────────────────
let searchSeq = 0;
async function runSearch(query) {
	const q = String(query || '').trim();
	if (!q) {
		clearSearch();
		return;
	}
	const seq = ++searchSeq;
	els.gxSearchGo.disabled = true;
	els.gxSearchGo.textContent = '…';
	try {
		const res = await fetch('/api/galaxy', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ query: q }),
		});
		const body = await res.json().catch(() => ({}));
		if (seq !== searchSeq) return; // a newer search superseded this one
		if (!res.ok) {
			renderResults([], q, body.error_description || 'Search failed.');
			return;
		}
		const results = (body.results || []).filter((r) => state.idToIndex.has(r.id));
		const idxSet = new Set(results.map((r) => state.idToIndex.get(r.id)));
		if (idxSet.size) {
			applyHighlight(idxSet);
			state.focusMode = 'search';
			state.focusCluster = -1;
			syncLegendActive();
			// Fly to the best match.
			const top = results[0];
			const ti = state.idToIndex.get(top.id);
			const a = state.data.agents[ti];
			flyToTarget(new THREE.Vector3(...a.coords), 150);
		} else {
			clearHighlight();
		}
		renderResults(results, q);
	} catch (err) {
		if (seq === searchSeq) renderResults([], q, err?.message || 'Network error.');
	} finally {
		if (seq === searchSeq) {
			els.gxSearchGo.disabled = false;
			els.gxSearchGo.textContent = 'Search';
		}
	}
}

function renderResults(results, query, errMsg) {
	els.gxResultsLabel.textContent = errMsg
		? 'Search'
		: results.length
			? `Closest to “${truncate(query, 40)}”`
			: `Nothing close to “${truncate(query, 40)}”`;
	els.gxResultsList.innerHTML = '';
	if (errMsg) {
		els.gxResultsList.innerHTML = `<div class="gx-results-empty">${escapeHtml(errMsg)}</div>`;
	} else if (!results.length) {
		els.gxResultsList.innerHTML =
			'<div class="gx-results-empty">No agents matched. Try a broader phrase.</div>';
	} else {
		results.forEach((r, i) => {
			const item = document.createElement('button');
			item.className = 'gx-result';
			item.type = 'button';
			item.innerHTML =
				`<span class="gx-result-rank">${i + 1}</span>` +
				`<span class="gx-result-body"><span class="gx-result-name">${escapeHtml(r.name)}</span>` +
				`<span class="gx-result-score">${Math.round(r.score * 100)}% match</span></span>`;
			item.addEventListener('click', () => {
				const idx = state.idToIndex.get(r.id);
				if (idx != null) selectAgent(idx, true);
			});
			els.gxResultsList.appendChild(item);
		});
	}
	els.gxResults.hidden = false;
	els.gxSearchClear.hidden = false;
}

function clearSearch() {
	els.gxSearchInput.value = '';
	clearSearchUI();
	clearHighlight();
}
function clearSearchUI() {
	els.gxResults.hidden = true;
	els.gxSearchClear.hidden = !els.gxSearchInput.value;
}

// ── Selection card ───────────────────────────────────────────────────────────
function selectAgent(index, fly = false) {
	const a = state.data.agents[index];
	if (!a) return;
	state.selected = index;
	const cluster = state.clusterById.get(a.cluster);

	if (a.thumbnail) {
		els.gxCardThumb.style.backgroundImage = `url("${a.thumbnail}")`;
		els.gxCardThumb.textContent = '';
	} else {
		els.gxCardThumb.style.backgroundImage = 'none';
		els.gxCardThumb.textContent = (a.name || '?').trim().charAt(0).toUpperCase();
	}
	els.gxCardName.textContent = a.name;
	els.gxCardConstellation.innerHTML = cluster
		? `<span class="gx-tip-dot" style="background:${escapeHtml(cluster.color)}"></span>${escapeHtml(cluster.label)}`
		: '';
	els.gxCardDesc.textContent = a.description || 'No description.';

	// Meta chips: net worth (real wallet value), engagement, on-chain identity, token.
	const chips = [];
	const nw = state.networthById?.get(a.id);
	if (nw && nw.level > 0) {
		chips.push(
			`<span class="gx-chip gx-chip-wealth" title="Net worth ${gxFmtUsd(nw.usd)} · ${escapeHtml(nw.tier)} tier — from real wallet balances">◈ ${gxFmtUsd(nw.usd)}</span>`,
		);
	}
	if (a.chat_count) chips.push(chip(`✦ ${formatCount(a.chat_count)} chats`));
	if (a.token && a.token.symbol) chips.push(chip(`$${escapeHtml(a.token.symbol)}`));
	// The agent's custodial wallet identity — the SAME shared chip every other
	// surface renders (copy, Solscan, vanity tier, tip), so the galaxy inspect card
	// shows the wallet exactly as the profile/marketplace/dashboard do. The galaxy
	// is a public read-only map, so the viewer is always a non-owner here.
	const walletChip = walletChipHTML(a, { isOwner: false, showPending: false, link: true, tip: true });
	if (walletChip) chips.push(walletChip);
	// Money-Cam cross-link: how many real flows in the current window touch this
	// agent — turns the inspect card into a jump-off into the live economy.
	if (money.active && money.history.length) {
		const involved = money.history.filter(
			(f) => f.actor?.id === a.id || f.from?.id === a.id || f.to?.id === a.id,
		).length;
		if (involved) {
			chips.push(
				`<span class="gx-chip gx-chip-flow" title="Public flows touching this agent in the current Money-Cam window">◉ ${involved} flow${involved > 1 ? 's' : ''} in view</span>`,
			);
		}
	}
	els.gxCardMeta.innerHTML = chips.join('');
	wireWalletChips(els.gxCardMeta);

	els.gxCardView.href = `/agents/${a.id}`;
	els.gxCardChat.href = `/agents/${a.id}`;
	els.gxCard.hidden = false;

	if (fly) flyToTarget(new THREE.Vector3(...a.coords), 120);
}
function deselect() {
	state.selected = -1;
	els.gxCard.hidden = true;
}

// ── Three.js scene ───────────────────────────────────────────────────────────
function setupThree() {
	renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
	renderer.setClearColor(0x000000, 0);
	els.gxCanvas.appendChild(renderer.domElement);

	scene = new THREE.Scene();
	scene.fog = new THREE.FogExp2(0x05060a, 0.0016);

	camera = new THREE.PerspectiveCamera(58, 1, 0.1, 4000);
	camera.position.set(0, 36, 322);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.enablePan = false;
	controls.minDistance = 60;
	controls.maxDistance = 760;
	controls.rotateSpeed = 0.6;
	controls.zoomSpeed = 0.8;
	controls.autoRotate = !REDUCED_MOTION;
	controls.autoRotateSpeed = 0.32;
	controls.addEventListener('start', () => {
		controls.autoRotate = false;
		clearTimeout(idleTimer);
	});
	controls.addEventListener('end', scheduleIdle);

	addBackgroundStars();
	flowLayer = createFlowLayer(scene);

	raycaster = new THREE.Raycaster();
	raycaster.params.Points.threshold = 4.2;
	clock = new THREE.Timer();

	const ro = new ResizeObserver(resize);
	ro.observe(els.gxStage);
	resize();

	renderer.domElement.addEventListener('pointermove', onPointerMove);
	renderer.domElement.addEventListener('pointerdown', onPointerDown);
	renderer.domElement.addEventListener('pointerleave', () => {
		hoverIndex = -1;
		els.gxTip.hidden = true;
		els.gxCanvas.classList.remove('gx-pointing');
	});

	renderer.setAnimationLoop(tick);
}

// A faint, deep background starfield for depth/parallax — purely decorative.
function addBackgroundStars() {
	const N = 1400;
	const pos = new Float32Array(N * 3);
	for (let i = 0; i < N; i++) {
		// Shell well outside the agent cloud so it reads as distant sky.
		const r = 700 + Math.random() * 1700;
		const th = Math.random() * Math.PI * 2;
		const ph = Math.acos(2 * Math.random() - 1);
		pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
		pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
		pos[i * 3 + 2] = r * Math.cos(ph);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	const m = new THREE.PointsMaterial({
		color: 0x9fb4d6,
		size: 1.4,
		sizeAttenuation: false,
		transparent: true,
		opacity: 0.5,
		depthWrite: false,
	});
	scene.add(new THREE.Points(g, m));
}

let idleTimer;
function scheduleIdle() {
	clearTimeout(idleTimer);
	if (REDUCED_MOTION) return;
	idleTimer = setTimeout(() => {
		controls.autoRotate = true;
	}, 3500);
}

function resize() {
	const w = els.gxStage.clientWidth || window.innerWidth;
	const h = els.gxStage.clientHeight || window.innerHeight;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}

function tick() {
	clock.update();
	const dt = clock.getDelta();
	const t = clock.getElapsed();
	if (mat) mat.uniforms.uTime.value = t;

	if (fly.active) {
		fly.t = Math.min(1, fly.t + dt / fly.dur);
		const e = easeInOut(fly.t);
		camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
		controls.target.lerpVectors(fly.fromTgt, fly.toTgt, e);
		if (fly.t >= 1) {
			fly.active = false;
			scheduleIdle();
		}
	}

	controls.update();
	updateClusterLabels();
	if (flowLayer) flowLayer.update(dt);
	if (money.active) {
		paceQueue(dt);
		if (money.mode === 'replay') replayTick(dt);
	}
	renderer.render(scene, camera);
}

// ── Camera moves ─────────────────────────────────────────────────────────────
function flyTo(toPos, toTgt, dur = 0.9) {
	fly.fromPos.copy(camera.position);
	fly.fromTgt.copy(controls.target);
	fly.toPos.copy(toPos);
	fly.toTgt.copy(toTgt);
	fly.dur = Math.max(0.001, dur);
	fly.t = 0;
	fly.active = true;
	controls.autoRotate = false;
}

// Fly so the camera looks at `target` from a comfortable standoff `dist`, keeping
// the current viewing direction so the move feels like gliding closer, not cutting.
function flyToTarget(target, dist) {
	const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
	if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
	dir.normalize().multiplyScalar(dist);
	flyTo(new THREE.Vector3().addVectors(target, dir), target.clone(), 0.9);
}

// ── Pointer interaction ──────────────────────────────────────────────────────
function onPointerMove(e) {
	const rect = renderer.domElement.getBoundingClientRect();
	pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
	pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
	els.gxTip.dataset.x = e.clientX - rect.left;
	els.gxTip.dataset.y = e.clientY - rect.top;
	if (!rafPending) {
		rafPending = true;
		requestAnimationFrame(updateHover);
	}
}

function updateHover() {
	rafPending = false;
	if (!points) return;
	raycaster.setFromCamera(pointer, camera);
	const hits = raycaster.intersectObject(points, false);
	const idx = hits.length ? hits[0].index : -1;
	if (idx === hoverIndex) {
		positionTip();
		return;
	}
	hoverIndex = idx;
	if (idx < 0) {
		els.gxTip.hidden = true;
		els.gxCanvas.classList.remove('gx-pointing');
		return;
	}
	const a = state.data.agents[idx];
	const c = state.clusterById.get(a.cluster);
	els.gxTip.innerHTML =
		`<div class="gx-tip-name">${escapeHtml(a.name)}</div>` +
		(c ? `<div class="gx-tip-cluster"><span class="gx-tip-dot" style="background:${escapeHtml(c.color)}"></span>${escapeHtml(c.label)}</div>` : '');
	els.gxTip.hidden = false;
	els.gxCanvas.classList.add('gx-pointing');
	positionTip();
}
function positionTip() {
	if (els.gxTip.hidden) return;
	els.gxTip.style.left = `${els.gxTip.dataset.x}px`;
	els.gxTip.style.top = `${els.gxTip.dataset.y}px`;
}

let downAt = null;
function onPointerDown(e) {
	downAt = { x: e.clientX, y: e.clientY, idx: hoverIndex };
	const onUp = (ev) => {
		renderer.domElement.removeEventListener('pointerup', onUp);
		if (!downAt) return;
		const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
		// A click (not a drag) on a star selects it; on empty space, deselect — but
		// in Money-Cam a click near a flowing edge opens that real transfer instead.
		if (moved < 5) {
			if (downAt.idx >= 0) selectAgent(downAt.idx, true);
			else {
				let picked = null;
				if (money.active && flowLayer) {
					raycaster.setFromCamera(pointer, camera);
					picked = flowLayer.pick(raycaster);
				}
				if (picked) openFlow(picked, false);
				else deselect();
			}
		}
		downAt = null;
	};
	renderer.domElement.addEventListener('pointerup', onUp);
}

// ── UI wiring ────────────────────────────────────────────────────────────────
function bindUI() {
	els.gxSearch.addEventListener('submit', (e) => {
		e.preventDefault();
		runSearch(els.gxSearchInput.value);
	});
	els.gxSearchInput.addEventListener('input', () => {
		els.gxSearchClear.hidden = !els.gxSearchInput.value;
	});
	els.gxSearchClear.addEventListener('click', () => {
		clearSearch();
		els.gxSearchInput.focus();
	});
	els.gxResultsClose.addEventListener('click', clearSearch);
	els.gxCardClose.addEventListener('click', deselect);
	els.gxRetry.addEventListener('click', () => loadGalaxy(false));
	els.gxLegendToggle.addEventListener('click', () => {
		const collapsed = els.gxLegend.classList.toggle('gx-collapsed');
		els.gxLegendToggle.setAttribute('aria-expanded', String(!collapsed));
		els.gxLegendToggle.textContent = collapsed ? '+' : '−';
	});
	// ── Money-Cam controls ──────────────────────────────────────────────────
	els.gxMoneyToggle.addEventListener('click', toggleMoneyCam);
	els.gxMcClose.addEventListener('click', closeMoneyCam);
	els.gxMcModeLive.addEventListener('click', () => setMcMode('live'));
	els.gxMcModeReplay.addEventListener('click', () => setMcMode('replay'));
	els.gxMcFilters.addEventListener('click', (e) => {
		const b = e.target.closest('.gx-mc-filter');
		if (b) setMcType(b.dataset.type);
	});
	els.gxMcTicker.addEventListener('click', (e) => {
		const row = e.target.closest('.gx-mc-row');
		if (!row) return;
		const f = flowById(row.dataset.flow);
		if (f) openFlow(f, true);
	});
	els.gxMcPlay.addEventListener('click', () => {
		if (money.replayT >= 1) enterReplayWindow();
		money.replayPlaying = !money.replayPlaying;
		syncPlayBtn();
	});
	els.gxMcScrub.addEventListener('input', () => {
		money.replayPlaying = false;
		syncPlayBtn();
		money.replayT = Number(els.gxMcScrub.value) / 1000;
		// Move the playhead without retro-animating: advance the spawn pointer to
		// the first flow past the new position.
		const [t0, t1] = windowSpan();
		const span = Math.max(1, t1 - t0);
		const ptr = money.history.findIndex((f) => (new Date(f.ts).getTime() - t0) / span > money.replayT);
		money.replayPtr = ptr < 0 ? money.history.length : ptr;
		updateReplayTime();
	});
	els.gxMcSpeed.addEventListener('click', () => {
		const order = [1, 2, 4];
		money.replaySpeed = order[(order.indexOf(money.replaySpeed) + 1) % order.length];
		els.gxMcSpeed.textContent = `${money.replaySpeed}×`;
	});
	els.gxFlowClose.addEventListener('click', closeFlow);
	document.addEventListener('visibilitychange', () => {
		if (!money.active) return;
		if (document.hidden) stopPolling();
		else if (money.mode === 'live') { startPolling(); pollDelta(); }
		updateLiveDot();
	});

	window.addEventListener('keydown', (e) => {
		const t = e.target;
		const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
		if (!typing && (e.key === 'm' || e.key === 'M')) {
			toggleMoneyCam();
			return;
		}
		if (e.key === 'Escape') {
			if (!els.gxFlow.hidden) closeFlow();
			else if (money.active) closeMoneyCam();
			else if (!els.gxCard.hidden) deselect();
			else if (state.focusMode) clearSearch();
		}
	});
	window.addEventListener('pagehide', dispose, { once: true });
}

// ── Overlays ─────────────────────────────────────────────────────────────────
function showOverlay(which) {
	els.gxLoading.hidden = which !== 'loading';
	els.gxEmpty.hidden = which !== 'empty';
	els.gxError.hidden = which !== 'error';
}
function hideOverlays() {
	els.gxLoading.hidden = true;
	els.gxEmpty.hidden = true;
	els.gxError.hidden = true;
}
function showError(title, sub, retryable = true) {
	dbg.status = 'error';
	dbg.error = sub;
	$('gxErrorTitle').textContent = title;
	els.gxErrorSub.textContent = sub;
	els.gxRetry.hidden = !retryable;
	showOverlay('error');
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
function disposePoints() {
	if (points) {
		scene.remove(points);
		geom?.dispose();
		mat?.dispose();
		points = geom = mat = null;
	}
	if (lineageLines) {
		scene.remove(lineageLines);
		lineageLines.geometry?.dispose();
		lineageLines.material?.dispose();
		lineageLines = null;
	}
}

// ── Lineage lines — descent edges between bred agents (Agent Genome) ──────────
// Draws a faint violet segment from each parent to its child using the live node
// positions, so a deep pedigree reads as a visible family thread in the star-map.
// Additive + best-effort: any failure (no edges, missing nodes) leaves the galaxy
// untouched. Edges to off-map agents (private/unmapped) are skipped.
let lineageLines = null;
async function loadLineageEdges() {
	try {
		const res = await fetch('/api/genome/edges?limit=3000');
		if (!res.ok) return;
		const { edges } = await res.json();
		if (!Array.isArray(edges) || !edges.length || !geom) return;
		const pos = geom.getAttribute('position');
		if (!pos) return;

		const verts = [];
		const at = (id) => {
			const idx = state.idToIndex.get(id);
			if (idx == null) return null;
			return [pos.getX(idx), pos.getY(idx), pos.getZ(idx)];
		};
		for (const e of edges) {
			const c = at(e.child);
			if (!c) continue;
			for (const pid of [e.a, e.b]) {
				const p = at(pid);
				if (!p) continue;
				verts.push(p[0], p[1], p[2], c[0], c[1], c[2]);
			}
		}
		if (!verts.length) return;

		const lg = new THREE.BufferGeometry();
		lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
		const lm = new THREE.LineBasicMaterial({
			color: 0xa78bfa,
			transparent: true,
			opacity: 0.28,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		lineageLines = new THREE.LineSegments(lg, lm);
		lineageLines.frustumCulled = false;
		scene.add(lineageLines);
		dbg.lineageEdges = verts.length / 6;
	} catch {
		/* lineage overlay is supplementary — never break the galaxy */
	}
}
function dispose() {
	try {
		stopPolling();
		renderer?.setAnimationLoop(null);
		flowLayer?.dispose();
		flowLayer = null;
		disposePoints();
		renderer?.dispose();
	} catch {
		/* page is unloading; best-effort */
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}
function truncate(s, n) {
	s = String(s || '');
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function chip(inner) {
	return `<span class="gx-chip">${inner}</span>`;
}
function formatCount(n) {
	if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
	return String(n);
}
function gxFmtUsd(v) {
	const n = Number(v) || 0;
	if (n < 1000) return `$${n.toFixed(n < 1 ? 2 : 0)}`;
	if (n < 1_000_000) return `$${Math.round(n).toLocaleString()}`;
	return `$${(n / 1_000_000).toFixed(2)}M`;
}
function easeInOut(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ══════════════════════════════════════════════════════════════════════════════
// Money-Cam — the live economy layer
// ══════════════════════════════════════════════════════════════════════════════

// GPU-friendly flow renderer: pooled arcs + a single Points cloud of travelling
// "photons" + a single Points cloud of impact/flare "rings". Everything is fixed
// capacity, so a burst of flows can never grow unbounded or drop frames — excess
// flows queue and animate as slots free. Every photon traces a real transfer.
function createFlowLayer(scene) {
	const PR = Math.min(devicePixelRatio || 1, 2);
	const ARC_MAX = 56;
	const ARC_SEG = 22;
	const PHOTON_MAX = ARC_MAX;
	const RING_MAX = 96;
	const ARC_BASE = 0.34;

	// Arc pool — faint bezier trails the photon rides along.
	const arcPool = [];
	for (let i = 0; i < ARC_MAX; i++) {
		const geom = new THREE.BufferGeometry();
		geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_SEG * 3), 3));
		const mat = new THREE.LineBasicMaterial({
			transparent: true,
			opacity: 0,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const line = new THREE.Line(geom, mat);
		line.frustumCulled = false;
		line.visible = false;
		line.renderOrder = 2;
		scene.add(line);
		arcPool.push({ line, geom, mat, free: true });
	}
	const acquireArc = () => {
		for (const a of arcPool) if (a.free) { a.free = false; return a; }
		return null;
	};

	// Photons — one travelling point per active edge.
	const photonPos = new Float32Array(PHOTON_MAX * 3);
	const photonCol = new Float32Array(PHOTON_MAX * 3);
	const photonSize = new Float32Array(PHOTON_MAX);
	const photonAlpha = new Float32Array(PHOTON_MAX);
	const photonGeom = new THREE.BufferGeometry();
	photonGeom.setAttribute('position', new THREE.BufferAttribute(photonPos, 3));
	photonGeom.setAttribute('aColor', new THREE.BufferAttribute(photonCol, 3));
	photonGeom.setAttribute('aSize', new THREE.BufferAttribute(photonSize, 1));
	photonGeom.setAttribute('aAlpha', new THREE.BufferAttribute(photonAlpha, 1));
	const photonMat = new THREE.ShaderMaterial({
		uniforms: { uPixelRatio: { value: PR } },
		vertexShader: FLOW_PHOTON_VERT,
		fragmentShader: FLOW_PHOTON_FRAG,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});
	const photons = new THREE.Points(photonGeom, photonMat);
	photons.frustumCulled = false;
	photons.renderOrder = 3;
	scene.add(photons);
	const photonFree = [];
	for (let i = PHOTON_MAX - 1; i >= 0; i--) photonFree.push(i);

	// Rings — expanding halos for an edge's arrival and for one-sided flares.
	const ringPos = new Float32Array(RING_MAX * 3);
	const ringCol = new Float32Array(RING_MAX * 3);
	const ringT = new Float32Array(RING_MAX).fill(1);
	const ringSize = new Float32Array(RING_MAX);
	const ringAge = new Float32Array(RING_MAX);
	const ringDur = new Float32Array(RING_MAX).fill(1);
	const ringActive = new Uint8Array(RING_MAX);
	const ringGeom = new THREE.BufferGeometry();
	ringGeom.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
	ringGeom.setAttribute('aColor', new THREE.BufferAttribute(ringCol, 3));
	ringGeom.setAttribute('aT', new THREE.BufferAttribute(ringT, 1));
	ringGeom.setAttribute('aSize', new THREE.BufferAttribute(ringSize, 1));
	const ringMat = new THREE.ShaderMaterial({
		uniforms: { uPixelRatio: { value: PR }, uGrow: { value: REDUCED_MOTION ? 0.6 : 3.0 } },
		vertexShader: FLOW_RING_VERT,
		fragmentShader: FLOW_RING_FRAG,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});
	const rings = new THREE.Points(ringGeom, ringMat);
	rings.frustumCulled = false;
	rings.renderOrder = 3;
	scene.add(rings);
	let ringCursor = 0;

	// Invisible pick points at active-edge midpoints → click an edge to inspect it.
	const pickPos = new Float32Array(ARC_MAX * 3).fill(1e7);
	const pickGeom = new THREE.BufferGeometry();
	pickGeom.setAttribute('position', new THREE.BufferAttribute(pickPos, 3));
	const pickPoints = new THREE.Points(
		pickGeom,
		new THREE.PointsMaterial({ size: 0.01, transparent: true, opacity: 0, depthWrite: false }),
	);
	pickPoints.frustumCulled = false;
	pickPoints.renderOrder = 4;
	scene.add(pickPoints);

	const edges = [];
	const tmpV = new THREE.Vector3();
	const tmpMid = new THREE.Vector3();
	const tmpPerp = new THREE.Vector3();
	const UP = new THREE.Vector3(0, 1, 0);
	const colorCache = new Map();
	const col = (hex) => {
		let c = colorCache.get(hex);
		if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
		return c;
	};
	const usdSize = (usd, base) =>
		base + (22 - base) * Math.min(1, Math.log1p(Number(usd) || 0) / Math.log1p(5000));
	const usdDur = (usd) => 1.5 + 1.0 * Math.min(1, Math.log1p(Number(usd) || 0) / Math.log1p(2000));
	const ringSizeFor = (flow) => (flow.kind === 'launch' ? 16 : usdSize(flow.usd, 9));

	function spawnRing(pos, color, size, kind) {
		const s = ringCursor;
		ringCursor = (ringCursor + 1) % RING_MAX;
		ringPos[s * 3] = pos.x; ringPos[s * 3 + 1] = pos.y; ringPos[s * 3 + 2] = pos.z;
		ringCol[s * 3] = color.r; ringCol[s * 3 + 1] = color.g; ringCol[s * 3 + 2] = color.b;
		ringSize[s] = size;
		ringAge[s] = 0;
		ringDur[s] = kind === 'launch' ? 1.7 : 1.15;
		ringActive[s] = 1;
		ringT[s] = 0;
		ringGeom.getAttribute('position').needsUpdate = true;
		ringGeom.getAttribute('aColor').needsUpdate = true;
		ringGeom.getAttribute('aSize').needsUpdate = true;
	}

	function freeEdge(e, i) {
		if (e.slot >= 0) { photonAlpha[e.slot] = 0; photonSize[e.slot] = 0; photonFree.push(e.slot); e.slot = -1; }
		e.arc.free = true;
		e.arc.line.visible = false;
		e.arc.mat.opacity = 0;
		edges.splice(i, 1);
	}

	function spawnEdge(flow, a, b) {
		const slot = photonFree.pop();
		if (slot == null) return false;
		const arc = acquireArc();
		if (!arc) { photonFree.push(slot); return false; }

		const dist = a.distanceTo(b);
		tmpMid.copy(a).add(b).multiplyScalar(0.5);
		tmpPerp.subVectors(b, a).normalize().cross(UP);
		if (tmpPerp.lengthSq() < 1e-4) tmpPerp.set(1, 0, 0);
		tmpPerp.normalize().multiplyScalar(dist * 0.18);
		tmpMid.add(tmpPerp).addScaledVector(UP, dist * 0.1);
		const curve = new THREE.QuadraticBezierCurve3(a.clone(), tmpMid.clone(), b.clone());

		const pos = arc.geom.getAttribute('position');
		for (let i = 0; i < ARC_SEG; i++) {
			curve.getPoint(i / (ARC_SEG - 1), tmpV);
			pos.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
		}
		pos.needsUpdate = true;

		const cc = col(FLOW_COLORS[flow.kind] || '#9fb4d6');
		arc.mat.color.copy(cc);
		arc.mat.opacity = REDUCED_MOTION ? ARC_BASE * 1.4 : 0;
		arc.line.visible = true;

		photonCol[slot * 3] = cc.r; photonCol[slot * 3 + 1] = cc.g; photonCol[slot * 3 + 2] = cc.b;
		photonSize[slot] = REDUCED_MOTION ? 0 : usdSize(flow.usd, 7);
		photonAlpha[slot] = 0;
		photonGeom.getAttribute('aColor').needsUpdate = true;

		edges.push({ flow, curve, arc, slot, age: 0, dur: usdDur(flow.usd), phase: 'travel', fadeAge: 0, b: b.clone(), color: cc });
		return true;
	}

	function spawnFlare(flow, pos) {
		spawnRing(pos, col(FLOW_COLORS[flow.kind] || '#9fb4d6'), ringSizeFor(flow), flow.kind);
		return true;
	}

	function update(dt) {
		// Edges.
		for (let i = edges.length - 1; i >= 0; i--) {
			const e = edges[i];
			e.age += dt;
			if (REDUCED_MOTION) {
				const k = Math.min(1, e.age / e.dur);
				e.arc.mat.opacity = ARC_BASE * 1.4 * (1 - k);
				if (k >= 1) { spawnRing(e.b, e.color, ringSizeFor(e.flow), e.flow.kind); freeEdge(e, i); }
				continue;
			}
			if (e.phase === 'travel') {
				const p = Math.min(1, e.age / e.dur);
				e.curve.getPoint(p, tmpV);
				photonPos[e.slot * 3] = tmpV.x; photonPos[e.slot * 3 + 1] = tmpV.y; photonPos[e.slot * 3 + 2] = tmpV.z;
				let alpha = Math.min(1, p / 0.12);
				if (p > 0.85) alpha *= Math.max(0, (1 - p) / 0.15);
				photonAlpha[e.slot] = alpha;
				e.arc.mat.opacity = ARC_BASE * Math.min(1, e.age / 0.22);
				if (p >= 1) {
					photonAlpha[e.slot] = 0; photonSize[e.slot] = 0; photonFree.push(e.slot); e.slot = -1;
					e.phase = 'fade';
					spawnRing(e.b, e.color, ringSizeFor(e.flow), e.flow.kind);
				}
			} else {
				e.fadeAge += dt;
				e.arc.mat.opacity = ARC_BASE * Math.max(0, 1 - e.fadeAge / 0.45);
				if (e.fadeAge >= 0.45) freeEdge(e, i);
			}
		}
		if (!REDUCED_MOTION && edges.length) {
			photonGeom.getAttribute('position').needsUpdate = true;
			photonGeom.getAttribute('aSize').needsUpdate = true;
			photonGeom.getAttribute('aAlpha').needsUpdate = true;
		}

		// Rings.
		let ringDirty = false;
		for (let s = 0; s < RING_MAX; s++) {
			if (!ringActive[s]) continue;
			ringAge[s] += dt;
			const t = ringAge[s] / ringDur[s];
			if (t >= 1) { ringActive[s] = 0; ringT[s] = 1; } else ringT[s] = t;
			ringDirty = true;
		}
		if (ringDirty) ringGeom.getAttribute('aT').needsUpdate = true;

		// Pick midpoints (only the active prefix is real; the rest sit far away).
		for (let i = 0; i < ARC_MAX; i++) {
			if (i < edges.length) {
				edges[i].curve.getPoint(0.5, tmpV);
				pickPos[i * 3] = tmpV.x; pickPos[i * 3 + 1] = tmpV.y; pickPos[i * 3 + 2] = tmpV.z;
			} else if (pickPos[i * 3] !== 1e7) {
				pickPos[i * 3] = 1e7; pickPos[i * 3 + 1] = 1e7; pickPos[i * 3 + 2] = 1e7;
			}
		}
		pickGeom.getAttribute('position').needsUpdate = true;
	}

	function pick(rc) {
		if (!edges.length) return null;
		const hits = rc.intersectObject(pickPoints, false);
		if (!hits.length) return null;
		const idx = hits[0].index;
		return idx != null && idx < edges.length ? edges[idx].flow : null;
	}

	function reset() {
		for (let i = edges.length - 1; i >= 0; i--) freeEdge(edges[i], i);
		for (let s = 0; s < RING_MAX; s++) { ringActive[s] = 0; ringT[s] = 1; }
		ringGeom.getAttribute('aT').needsUpdate = true;
	}

	function dispose() {
		reset();
		for (const a of arcPool) { scene.remove(a.line); a.geom.dispose(); a.mat.dispose(); }
		scene.remove(photons); photonGeom.dispose(); photonMat.dispose();
		scene.remove(rings); ringGeom.dispose(); ringMat.dispose();
		scene.remove(pickPoints); pickGeom.dispose(); pickPoints.material.dispose();
	}

	return { spawnEdge, spawnFlare, update, pick, reset, dispose, get activeEdges() { return edges.length; } };
}

// ── Money-Cam controller ─────────────────────────────────────────────────────
function nodeVec(agentId) {
	if (!agentId) return null;
	if (money.nodeVec.has(agentId)) return money.nodeVec.get(agentId);
	const idx = state.idToIndex.get(agentId);
	if (idx == null) return null;
	const a = state.data?.agents[idx];
	if (!a) return null;
	const v = new THREE.Vector3(...a.coords);
	money.nodeVec.set(agentId, v);
	return v;
}

// Animate one real flow: an agent↔agent transfer becomes a travelling edge; a
// one-sided flow (counterparty isn't a star we have) flares the single node. A
// flow whose agent isn't in the current snapshot is honestly skipped — we never
// invent a star to anchor it.
function animateFlow(flow) {
	if (!flowLayer) return false;
	const fromV = flow.from?.id ? nodeVec(flow.from.id) : null;
	const toV = flow.to?.id ? nodeVec(flow.to.id) : null;
	if (fromV && toV && flow.from.id !== flow.to.id) return flowLayer.spawnEdge(flow, fromV, toV);
	const v = (flow.actor?.id ? nodeVec(flow.actor.id) : null) || fromV || toV;
	if (v) return flowLayer.spawnFlare(flow, v);
	return false;
}

function isEdgeFlow(flow) {
	return Boolean(flow.from?.id && flow.to?.id && flow.from.id !== flow.to.id);
}

async function fetchFlows({ since } = {}) {
	const params = new URLSearchParams({ network: 'mainnet', type: money.type, limit: '140' });
	if (since) params.set('since', since);
	const res = await fetch(`/api/galaxy/flows?${params.toString()}`, {
		headers: { accept: 'application/json' },
	});
	if (!res.ok) throw new Error(`flows ${res.status}`);
	const body = await res.json().catch(() => ({}));
	return body?.data || null;
}

function ingest(flowsNewestFirst) {
	// Store ascending by ts; dedupe by id across overlapping polls.
	const fresh = [];
	for (const f of flowsNewestFirst) {
		if (money.seen.has(f.id)) continue;
		money.seen.add(f.id);
		fresh.push(f);
	}
	if (!fresh.length) return [];
	fresh.reverse(); // → ascending
	money.history.push(...fresh);
	money.history.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
	if (money.history.length > 500) {
		money.history.splice(0, money.history.length - 500);
		money.seen = new Set(money.history.map((f) => f.id));
	}
	return fresh;
}

async function loadWindow() {
	money.loading = true;
	setMcNote('');
	try {
		const data = await fetchFlows();
		if (!data) throw new Error('no data');
		money.history = [];
		money.seen = new Set();
		money.queue = [];
		ingest(data.flows || []);
		money.headCursor = data.head_cursor || null;
		money.lastServerTime = data.server_time || null;
		money.pollFails = 0;
		renderStats();
		renderTicker();
		if (!money.history.length) {
			setMcNote('Quiet right now — no public flows in the last 24h. The galaxy is calm.');
		} else if (money.mode === 'live') {
			// A gentle welcoming ripple of the most recent real flows (not all at once).
			const seed = money.history.slice(-12);
			money.queue.push(...seed);
		}
		if (money.mode === 'replay') enterReplayWindow();
	} catch {
		setMcNote('Money-Cam feed isn’t reachable right now — retrying. No flows are invented to fill the gap.');
		money.pollFails++;
	} finally {
		money.loading = false;
		updateLiveDot();
	}
}

async function pollDelta() {
	if (!money.active || money.mode !== 'live' || document.hidden) return;
	if (!money.headCursor) { await loadWindow(); return; }
	try {
		const data = await fetchFlows({ since: money.headCursor });
		if (!data) throw new Error('no data');
		money.lastServerTime = data.server_time || money.lastServerTime;
		const fresh = ingest(data.flows || []);
		if (data.head_cursor) money.headCursor = data.head_cursor;
		money.pollFails = 0;
		setMcNote('');
		if (fresh.length) {
			money.queue.push(...fresh); // fresh is ascending → oldest animates first
			renderStats();
			renderTicker();
		}
	} catch {
		money.pollFails++;
		if (money.pollFails >= 2) setMcNote('Reconnecting to the live economy…');
	}
	updateLiveDot();
}

// Release queued flows at a steady cadence so a burst ripples rather than dropping
// frames. The fixed-capacity flow layer naturally back-pressures; anything that
// can't get a slot waits its turn.
function paceQueue(dt) {
	if (money.mode !== 'live' || !money.queue.length) return;
	money.releaseAcc += dt;
	const interval = 0.1;
	let guard = 8;
	while (money.queue.length && money.releaseAcc >= interval && guard-- > 0) {
		money.releaseAcc -= interval;
		animateFlow(money.queue.shift());
	}
	if (money.queue.length > 240) money.queue.splice(0, money.queue.length - 240);
}

// ── Replay ───────────────────────────────────────────────────────────────────
function windowSpan() {
	const h = money.history;
	if (!h.length) return [0, 0];
	return [new Date(h[0].ts).getTime(), new Date(h[h.length - 1].ts).getTime()];
}
function enterReplayWindow() {
	money.replayPtr = 0;
	money.replayT = 0;
	money.replayPlaying = false;
	if (els.gxMcScrub) els.gxMcScrub.value = '0';
	updateReplayTime();
}
function replayTick(dt) {
	if (money.mode !== 'replay' || !money.replayPlaying) return;
	const [t0, t1] = windowSpan();
	if (t1 <= t0) { money.replayPlaying = false; syncPlayBtn(); return; }
	const prev = money.replayT;
	money.replayT = Math.min(1, prev + (dt / REPLAY_DURATION_S) * money.replaySpeed);
	spawnReplayBetween(prev, money.replayT, t0, t1);
	if (els.gxMcScrub) els.gxMcScrub.value = String(Math.round(money.replayT * 1000));
	updateReplayTime();
	if (money.replayT >= 1) { money.replayPlaying = false; syncPlayBtn(); }
}
function spawnReplayBetween(fromT, toT, t0, t1) {
	const span = Math.max(1, t1 - t0);
	let guard = 60;
	while (money.replayPtr < money.history.length && guard-- > 0) {
		const f = money.history[money.replayPtr];
		const norm = (new Date(f.ts).getTime() - t0) / span;
		if (norm > toT) break;
		if (norm > fromT - 1e-6) animateFlow(f);
		money.replayPtr++;
	}
}
function updateReplayTime() {
	if (!els.gxMcTime) return;
	const [t0, t1] = windowSpan();
	if (t1 <= t0) { els.gxMcTime.textContent = money.history.length ? '1 flow' : ''; return; }
	const at = t0 + (t1 - t0) * money.replayT;
	els.gxMcTime.textContent = `${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${money.history.length} real flows`;
}
function syncPlayBtn() {
	if (els.gxMcPlay) els.gxMcPlay.textContent = money.replayPlaying ? '❙❙' : '▶';
}

// ── Panel rendering ──────────────────────────────────────────────────────────
function computeWindow() {
	let usd = 0, edges = 0;
	for (const f of money.history) {
		if (f.usd) usd += f.usd;
		if (isEdgeFlow(f)) edges++;
	}
	return { count: money.history.length, usd, edges };
}
function renderStats() {
	if (!els.gxMcStats) return;
	const w = computeWindow();
	const [t0, t1] = windowSpan();
	const spanMin = t1 > t0 ? Math.max(1, Math.round((t1 - t0) / 60000)) : 0;
	els.gxMcStats.innerHTML =
		`<span class="gx-mc-stat"><strong>${w.count.toLocaleString()}</strong> flows</span>` +
		`<span class="gx-mc-stat"><strong>${gxFmtUsd(w.usd)}</strong> moved</span>` +
		`<span class="gx-mc-stat"><strong>${w.edges.toLocaleString()}</strong> agent↔agent</span>` +
		(spanMin ? `<span class="gx-mc-stat gx-mc-span">last ${spanMin >= 60 ? `${Math.round(spanMin / 60)}h` : `${spanMin}m`}</span>` : '');
}
function renderTicker() {
	if (!els.gxMcTicker) return;
	const recent = money.history.slice(-7).reverse();
	if (!recent.length) {
		els.gxMcTicker.innerHTML = '<div class="gx-mc-empty">No flows in view yet.</div>';
		return;
	}
	els.gxMcTicker.innerHTML = recent
		.map((f) => {
			const c = FLOW_COLORS[f.kind] || '#9fb4d6';
			const amount = f.usd ? gxFmtUsd(f.usd) : f.kind === 'launch' ? `$${escapeHtml(f.symbol || 'coin')}` : f.sol != null ? `${(+f.sol).toFixed(3)} SOL` : '';
			return (
				`<button class="gx-mc-row" type="button" data-flow="${escapeHtml(f.id)}">` +
				`<span class="gx-mc-row-dot" style="background:${c};box-shadow:0 0 8px ${c}"></span>` +
				`<span class="gx-mc-row-main">${flowHeadline(f)}</span>` +
				`<span class="gx-mc-row-amt">${escapeHtml(amount)}</span>` +
				`<span class="gx-mc-row-ago">${relTime(f.ts)}</span>` +
				`</button>`
			);
		})
		.join('');
}
function flowHeadline(f) {
	const a = escapeHtml(f.actor?.name || 'Agent');
	if (f.kind === 'launch') return `${a} launched $${escapeHtml(f.symbol || 'a coin')}`;
	if (f.kind === 'tip') return `${escapeHtml(f.from?.name || shortAddr(f.from?.wallet) || 'someone')} → ${a}`;
	const to = f.to?.name ? escapeHtml(f.to.name) : shortAddr(f.to?.wallet) || 'market';
	const verb = f.kind === 'payment' ? 'paid' : f.kind === 'snipe' ? 'sniped' : 'traded →';
	return f.kind === 'payment' ? `${a} ${verb} ${to}` : `${a} ${verb} ${to}`;
}

// ── Flow inspector ───────────────────────────────────────────────────────────
function partyHtml(p, fallback) {
	if (!p) return `<span class="gx-flow-party">${escapeHtml(fallback || '—')}</span>`;
	if (p.id) return `<a class="gx-flow-party gx-flow-link" href="/agents/${escapeHtml(p.id)}">${escapeHtml(p.name || 'Agent')}</a>`;
	return `<span class="gx-flow-party"><code>${escapeHtml(shortAddr(p.wallet) || '—')}</code></span>`;
}
function openFlow(flow, fly = true) {
	const c = FLOW_COLORS[flow.kind] || '#9fb4d6';
	const label = { tip: 'Tip', trade: 'Trade', snipe: 'Snipe', payment: 'Payment', launch: 'Launch' }[flow.kind] || 'Flow';
	const amount = flow.usd ? gxFmtUsd(flow.usd) : null;
	const sub = flow.kind === 'launch'
		? `$${escapeHtml(flow.symbol || flow.coin_name || 'coin')}`
		: flow.sol != null
			? `${(+flow.sol).toFixed(4)} SOL`
			: flow.asset
				? `${flow.amount_raw ? '' : ''}${escapeHtml(flow.asset === 'SOL' ? 'SOL' : shortAddr(flow.asset) || flow.asset)}`
				: '';
	const explorerLink = flow.kind === 'launch' ? flow.mint_explorer : flow.explorer;
	const explorerLabel = flow.kind === 'launch' ? 'View mint on Solscan' : 'View signature on Solscan';
	const route = flow.kind === 'launch'
		? partyHtml(flow.actor)
		: `${partyHtml(flow.from, 'market')} <span class="gx-flow-arrow" aria-hidden="true">→</span> ${partyHtml(flow.to, 'market')}`;

	els.gxFlowBody.innerHTML =
		`<div class="gx-flow-head"><span class="gx-flow-dot" style="background:${c};box-shadow:0 0 12px ${c}"></span>` +
		`<span class="gx-flow-kind">${label}</span>` +
		`<span class="gx-flow-time">${escapeHtml(absTime(flow.ts))}</span></div>` +
		`<div class="gx-flow-amount">${amount ? `<strong>${escapeHtml(amount)}</strong>` : ''}${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</div>` +
		`<div class="gx-flow-route">${route}</div>` +
		(explorerLink
			? `<a class="gx-flow-explorer" href="${escapeHtml(explorerLink)}" target="_blank" rel="noopener">${explorerLabel} ↗</a>`
			: '<div class="gx-flow-explorer gx-flow-pending">Confirming on-chain…</div>');
	els.gxFlow.hidden = false;

	if (fly) {
		const fv = flow.from?.id ? nodeVec(flow.from.id) : null;
		const tv = flow.to?.id ? nodeVec(flow.to.id) : null;
		const av = flow.actor?.id ? nodeVec(flow.actor.id) : null;
		let target = null;
		if (fv && tv) target = new THREE.Vector3().addVectors(fv, tv).multiplyScalar(0.5);
		else target = av || fv || tv;
		if (target) flyToTarget(target.clone(), 150);
	}
}
function closeFlow() {
	if (els.gxFlow) els.gxFlow.hidden = true;
}

// ── Mode + lifecycle ─────────────────────────────────────────────────────────
function setMcNote(msg) {
	if (!els.gxMcNote) return;
	els.gxMcNote.textContent = msg || '';
	els.gxMcNote.hidden = !msg;
}
function updateLiveDot() {
	if (!els.gxMcLiveDot) return;
	const live = money.active && money.mode === 'live' && !document.hidden;
	els.gxMcLiveDot.classList.toggle('gx-mc-on', live && money.pollFails === 0);
	els.gxMcLiveDot.classList.toggle('gx-mc-stale', money.pollFails > 0);
}
function startPolling() {
	stopPolling();
	pollTimer = setInterval(pollDelta, LIVE_POLL_MS);
}
function stopPolling() {
	if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function setMcMode(mode) {
	money.mode = mode;
	const live = mode === 'live';
	els.gxMcModeLive.classList.toggle('gx-active', live);
	els.gxMcModeReplay.classList.toggle('gx-active', !live);
	els.gxMcModeLive.setAttribute('aria-selected', String(live));
	els.gxMcModeReplay.setAttribute('aria-selected', String(!live));
	els.gxMcReplay.hidden = live;
	if (live) {
		money.replayPlaying = false;
		startPolling();
		pollDelta();
	} else {
		stopPolling();
		flowLayer?.reset();
		enterReplayWindow();
	}
	updateLiveDot();
}
function setMcType(type) {
	if (money.type === type) return;
	money.type = type;
	for (const b of els.gxMcFilters.querySelectorAll('.gx-mc-filter')) {
		b.classList.toggle('gx-active', b.dataset.type === type);
	}
	flowLayer?.reset();
	loadWindow().then(() => { if (money.mode === 'live') pollDelta(); });
}
function openMoneyCam() {
	if (money.active) return;
	if (!state.data || !flowLayer) return;
	money.active = true;
	els.gxMoneyCam.hidden = false;
	els.gxMoneyToggle.setAttribute('aria-pressed', 'true');
	els.gxMoneyToggle.classList.add('gx-active');
	clearSearch();
	if (!els.gxResults.hidden) els.gxResults.hidden = true;
	controls.autoRotate = false;
	track(ANALYTICS_EVENTS.SURFACE_OPENED, { surface: 'visualizer:money-cam' });
	loadWindow();
	startPolling();
}
function closeMoneyCam() {
	if (!money.active) return;
	money.active = false;
	stopPolling();
	flowLayer?.reset();
	money.queue = [];
	els.gxMoneyCam.hidden = true;
	closeFlow();
	els.gxMoneyToggle.setAttribute('aria-pressed', 'false');
	els.gxMoneyToggle.classList.remove('gx-active');
	if (!REDUCED_MOTION) scheduleIdle();
}
function toggleMoneyCam() {
	if (money.active) closeMoneyCam();
	else openMoneyCam();
}

// ── Money-Cam helpers ────────────────────────────────────────────────────────
function shortAddr(w) {
	if (!w || typeof w !== 'string') return '';
	return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}
function relTime(iso) {
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return '';
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}
function absTime(iso) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function flowById(id) {
	return money.history.find((f) => f.id === id) || null;
}

// ── Money-Cam flow shaders ───────────────────────────────────────────────────
const FLOW_PHOTON_VERT = /* glsl */ `
	attribute vec3 aColor;
	attribute float aSize;
	attribute float aAlpha;
	uniform float uPixelRatio;
	varying vec3 vColor;
	varying float vAlpha;
	void main() {
		vColor = aColor;
		vAlpha = aAlpha;
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		float dist = max(-mv.z, 1.0);
		gl_PointSize = clamp(aSize * (300.0 / dist), 1.0, 64.0) * uPixelRatio;
		gl_Position = projectionMatrix * mv;
	}
`;
const FLOW_PHOTON_FRAG = /* glsl */ `
	precision mediump float;
	varying vec3 vColor;
	varying float vAlpha;
	void main() {
		float d = length(gl_PointCoord - 0.5);
		if (d > 0.5) discard;
		float core = smoothstep(0.5, 0.0, d);
		gl_FragColor = vec4(vColor * (0.6 + 0.9 * core), core * core * vAlpha);
	}
`;
const FLOW_RING_VERT = /* glsl */ `
	attribute vec3 aColor;
	attribute float aT;
	attribute float aSize;
	uniform float uPixelRatio;
	uniform float uGrow;
	varying vec3 vColor;
	varying float vT;
	void main() {
		vColor = aColor;
		vT = aT;
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		float dist = max(-mv.z, 1.0);
		float grow = aSize * (1.0 + aT * uGrow);
		gl_PointSize = clamp(grow * (300.0 / dist), 2.0, 96.0) * uPixelRatio;
		gl_Position = projectionMatrix * mv;
	}
`;
const FLOW_RING_FRAG = /* glsl */ `
	precision mediump float;
	varying vec3 vColor;
	varying float vT;
	void main() {
		float d = length(gl_PointCoord - 0.5) * 2.0;
		if (d > 1.0) discard;
		// Annulus near the outer edge; fades as the ring expands.
		float ring = smoothstep(0.62, 0.9, d) * smoothstep(1.0, 0.9, d);
		float alpha = ring * (1.0 - vT) * 0.9;
		gl_FragColor = vec4(vColor, alpha);
	}
`;

// ── Shaders ──────────────────────────────────────────────────────────────────
const POINT_VERT = /* glsl */ `
	attribute vec3 aColor;
	attribute float aSize;
	attribute float aSeed;
	attribute float aState;
	attribute float aWealth;
	uniform float uTime;
	uniform float uPixelRatio;
	uniform float uTwinkle;
	uniform float uWealthPulse;
	varying vec3 vColor;
	varying float vState;
	varying float vWealth;
	void main() {
		vColor = aColor;
		vState = aState;
		vWealth = aWealth;
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		float size = aSize;
		// gentle twinkle
		size *= 1.0 + uTwinkle * 0.16 * sin(uTime * 1.6 + aSeed * 6.2831);
		// Net worth swells the star (a funded agent is visibly bigger) and adds a
		// slow, dignified breathing pulse that scales with wealth.
		size *= 1.0 + aWealth * 0.9;
		size *= 1.0 + uWealthPulse * aWealth * 0.12 * sin(uTime * 1.1 + aSeed * 6.2831);
		// highlight pulse for matched/focused stars
		float hi = step(0.5, aState);
		size *= mix(1.0, 1.85 + 0.55 * sin(uTime * 5.0), hi);
		float dist = max(-mv.z, 1.0);
		gl_PointSize = clamp(size * (300.0 / dist), 1.0, 90.0) * uPixelRatio;
		gl_Position = projectionMatrix * mv;
	}
`;
const POINT_FRAG = /* glsl */ `
	precision mediump float;
	uniform float uHighlight;
	uniform float uDim;
	uniform vec3 uWealthColor;
	varying vec3 vColor;
	varying float vState;
	varying float vWealth;
	void main() {
		float d = length(gl_PointCoord - 0.5);
		if (d > 0.5) discard;
		float core = smoothstep(0.5, 0.0, d);
		float alpha = core * core;
		// When a search/focus is active, fade the non-matching stars way back.
		float dimmed = (uHighlight > 0.5 && vState < 0.5) ? uDim : 1.0;
		// Funded stars bias toward the wallet-violet accent and burn brighter, with
		// a wealth-scaled halo in the outer falloff so wealth reads at a glance.
		vec3 base = mix(vColor, uWealthColor, vWealth * 0.6);
		float halo = smoothstep(0.5, 0.18, d) * vWealth * 0.5;
		vec3 col = base * (0.55 + 0.75 * core) + uWealthColor * halo;
		float a = (alpha + halo * 0.6) * dimmed;
		gl_FragColor = vec4(col, a);
	}
`;

// ── Start ────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
	boot();
}
