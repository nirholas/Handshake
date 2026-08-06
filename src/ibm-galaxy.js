// ── ibm-galaxy.js ───────────────────────────────────────────────────────────
// The IBM Granite Agent Galaxy: an explorable 3D constellation where every
// three.ws agent is a star positioned by its IBM Granite embedding. Agents that
// mean similar things sit near each other; k-means themes (named by Granite)
// colour the clusters; natural-language search embeds the query on Granite and
// flies the camera to whatever the words actually mean.
//
// Data comes from /api/ibm/galaxy (GET = layout, POST = semantic search). There
// is no client-side mock: when watsonx is unconfigured or there are too few
// agents, the page shows a designed, honest state instead of inventing stars.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { log } from './shared/log.js';

const RADIUS = 100; // matches the server's projection half-width

// ── DOM ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const els = {
	searchWrap: $('searchWrap'), searchBox: $('searchBox'), searchInput: $('searchInput'),
	searchClear: $('searchClear'), searchHint: $('searchHint'), results: $('results'),
	legend: $('legend'), legendRows: $('legendRows'), legendFoot: $('legendFoot'),
	legendMobile: $('legendMobile'), legendMobileRows: $('legendMobileRows'),
	legendToggle: $('legendToggle'),
	stats: $('stats'), tooltip: $('tooltip'), clusterLabels: $('clusterLabels'),
	panel: $('panel'), panelHead: $('panelHead'), panelBody: $('panelBody'), panelClose: $('panelClose'),
	loading: $('loadingState'), empty: $('emptyState'), unavailable: $('unavailableState'),
	error: $('errorState'), errorMsg: $('errorMsg'), emptyTitle: $('emptyTitle'), emptyMsg: $('emptyMsg'),
	unavailableMsg: $('unavailableMsg'), loadSteps: $('loadSteps'), retryBtn: $('retryBtn'),
	resetView: $('resetView'), hudHint: $('hudHint'), tourBtn: $('tourBtn'),
	shortcutsOverlay: $('shortcutsOverlay'), shortcutsBtn: $('shortcutsBtn'), shortcutsClose: $('shortcutsClose'),
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
	data: null,            // galaxy payload
	agents: [],            // [{...agent, vec3:THREE.Vector3}]
	clusters: [],
	byId: new Map(),
	hovered: -1,
	selected: -1,
	isolatedCluster: null, // legend isolation
	searchActive: false,
	lastResults: [],
};

// ── Three.js core ─────────────────────────────────────────────────────────────
let renderer, scene, camera, controls, raycaster, points, geometry, material, starfield;
let aDim, aHi, aSize, positions, colors; // attribute backing arrays
const pointer = new THREE.Vector2(-2, -2);
let pointerDown = null; // {x,y} to distinguish click from drag
let rafPending = false; // coalesce hover raycasts to one per frame
const _pointerClient = { x: 0, y: 0 }; // latest cursor position for tooltip placement
const fly = { active: false, camFrom: new THREE.Vector3(), camTo: new THREE.Vector3(), tgtFrom: new THREE.Vector3(), tgtTo: new THREE.Vector3(), t: 0, dur: 1 };
let idleTimer = 0;
const clock = new THREE.Timer();
const EXAMPLES = [
	'a witty crypto trading assistant',
	'helpful customer support agent',
	'a creative storyteller for kids',
	'on-chain data analyst',
	'a calm meditation guide',
];

function initThree() {
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
	renderer.setClearColor(0x05070d, 1);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(window.innerWidth, window.innerHeight, false);

	scene = new THREE.Scene();
	scene.fog = new THREE.FogExp2(0x05070d, 0.0016);

	camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 4000);
	camera.position.set(0, 48, RADIUS * 2.7);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.rotateSpeed = 0.6;
	controls.minDistance = 30;
	controls.maxDistance = RADIUS * 6;
	controls.autoRotate = true;
	controls.autoRotateSpeed = 0.35;
	controls.target.set(0, 0, 0);
	controls.addEventListener('start', () => { controls.autoRotate = false; idleTimer = 0; if (tour.active) stopTour(); });

	raycaster = new THREE.Raycaster();
	raycaster.params.Points.threshold = 3.2;

	buildStarfield();
	window.addEventListener('resize', onResize, { passive: true });
	renderer.domElement.addEventListener('pointermove', onPointerMove, { passive: true });
	renderer.domElement.addEventListener('pointerdown', (e) => { pointerDown = { x: e.clientX, y: e.clientY }; });
	renderer.domElement.addEventListener('pointerup', onPointerUp);
	renderer.domElement.addEventListener('pointerleave', () => { setHover(-1); });
	renderer.setAnimationLoop(animate);
}

// Faint, slowly-drifting background stars for depth — purely decorative.
function buildStarfield() {
	const N = 1600;
	const g = new THREE.BufferGeometry();
	const pos = new Float32Array(N * 3);
	for (let i = 0; i < N; i++) {
		const r = 600 + Math.pow(Math.random(), 0.5) * 1400;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(2 * Math.random() - 1);
		pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
		pos[i * 3 + 2] = r * Math.cos(phi);
	}
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	const m = new THREE.PointsMaterial({ color: 0x66708a, size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.55, depthWrite: false });
	starfield = new THREE.Points(g, m);
	scene.add(starfield);
}

// ── Star shader (glowing, twinkling, dimmable, highlightable) ─────────────────
const VERT = `
	attribute float aSize;
	attribute float aDim;
	attribute float aHi;
	varying vec3 vColor;
	varying float vDim;
	varying float vHi;
	uniform float uPixelRatio;
	uniform float uTime;
	void main() {
		vColor = color;
		vDim = aDim;
		vHi = aHi;
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		float tw = 0.85 + 0.15 * sin(uTime * 1.6 + position.x * 0.4 + position.y * 0.7);
		float size = aSize * (1.0 + aHi * 1.6) * tw;
		gl_PointSize = size * uPixelRatio * (320.0 / -mv.z);
		gl_Position = projectionMatrix * mv;
	}
`;
const FRAG = `
	varying vec3 vColor;
	varying float vDim;
	varying float vHi;
	void main() {
		vec2 uv = gl_PointCoord - vec2(0.5);
		float d = length(uv);
		if (d > 0.5) discard;
		float core = smoothstep(0.5, 0.0, d);
		float glow = pow(core, 1.7);
		float alpha = glow * vDim;
		vec3 col = mix(vColor, vec3(1.0), vHi * 0.45 + glow * 0.18);
		gl_FragColor = vec4(col * (0.55 + 0.9 * glow), alpha);
	}
`;

function buildPoints() {
	if (points) { scene.remove(points); geometry.dispose(); material.dispose(); }
	const n = state.agents.length;
	positions = new Float32Array(n * 3);
	colors = new Float32Array(n * 3);
	aSize = new Float32Array(n);
	aDim = new Float32Array(n);
	aHi = new Float32Array(n);
	const col = new THREE.Color();
	for (let i = 0; i < n; i++) {
		const a = state.agents[i];
		positions[i * 3] = a.x; positions[i * 3 + 1] = a.y; positions[i * 3 + 2] = a.z;
		col.set(a.color);
		colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
		// Deterministic mild size variation for life (seeded by id char codes).
		const seed = (a.id.charCodeAt(0) + a.id.charCodeAt(a.id.length - 1)) % 10;
		aSize[i] = 20 + seed * 0.9;
		aDim[i] = 1; aHi[i] = 0;
	}
	geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
	geometry.setAttribute('aDim', new THREE.BufferAttribute(aDim, 1));
	geometry.setAttribute('aHi', new THREE.BufferAttribute(aHi, 1));
	material = new THREE.ShaderMaterial({
		uniforms: { uPixelRatio: { value: renderer.getPixelRatio() }, uTime: { value: 0 } },
		vertexShader: VERT, fragmentShader: FRAG,
		transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
	});
	points = new THREE.Points(geometry, material);
	scene.add(points);
}

// ── Animation loop ────────────────────────────────────────────────────────────
function animate() {
	clock.update();
	const dt = clock.getDelta();
	const t = clock.getElapsed();
	if (material) material.uniforms.uTime.value = t;
	if (starfield) starfield.rotation.y += dt * 0.006;

	// Idle → resume gentle auto-rotate after a few seconds of no interaction.
	if (!controls.autoRotate && !fly.active) {
		idleTimer += dt;
		if (idleTimer > 4) controls.autoRotate = true;
	}

	if (fly.active) {
		fly.t += dt / fly.dur;
		const k = fly.t >= 1 ? 1 : easeInOut(fly.t);
		camera.position.lerpVectors(fly.camFrom, fly.camTo, k);
		controls.target.lerpVectors(fly.tgtFrom, fly.tgtTo, k);
		if (fly.t >= 1) fly.active = false;
	}

	controls.update();
	updateClusterLabels();
	renderer.render(scene, camera);
}

function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

// ── Cluster labels projected to screen ────────────────────────────────────────
const labelEls = [];
function buildClusterLabels() {
	els.clusterLabels.innerHTML = '';
	labelEls.length = 0;
	for (const c of state.clusters) {
		if (!c.size) continue;
		const el = document.createElement('div');
		el.className = 'clabel';
		el.textContent = c.label;
		el.style.color = c.color;
		el.style.borderColor = hexA(c.color, 0.4);
		labelEls.push({ el, c, v: new THREE.Vector3(c.x, c.y, c.z) });
		els.clusterLabels.appendChild(el);
	}
}
const _proj = new THREE.Vector3();
function updateClusterLabels() {
	if (!labelEls.length) return;
	const w = window.innerWidth, h = window.innerHeight;
	for (const { el, c, v } of labelEls) {
		_proj.copy(v).project(camera);
		const visible = _proj.z < 1 && (state.isolatedCluster === null || state.isolatedCluster === c.id) && !state.searchActive;
		if (!visible) { el.style.opacity = '0'; continue; }
		const x = (_proj.x * 0.5 + 0.5) * w;
		const y = (-_proj.y * 0.5 + 0.5) * h;
		el.style.left = x + 'px';
		el.style.top = y + 'px';
		el.style.opacity = '0.92';
	}
}

// ── Hover & selection ─────────────────────────────────────────────────────────
function onPointerMove(e) {
	pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
	pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
	_pointerClient.x = e.clientX;
	_pointerClient.y = e.clientY;
	// Pointermove fires far more often than the display refreshes; coalesce the
	// raycast + tooltip work to one pass per frame via a rAF flag.
	if (!rafPending) {
		rafPending = true;
		requestAnimationFrame(updateHover);
	}
}

function updateHover() {
	rafPending = false;
	if (!points) return;
	raycaster.setFromCamera(pointer, camera);
	const hits = raycaster.intersectObject(points);
	const idx = pickVisible(hits);
	setHover(idx);
	if (idx >= 0) positionTooltip(_pointerClient.x, _pointerClient.y, idx);
}

// Nearest hit that isn't dimmed away by isolation/search.
function pickVisible(hits) {
	for (const hit of hits) {
		const i = hit.index;
		if (aDim[i] > 0.5) return i;
	}
	return -1;
}

function setHover(idx) {
	if (idx === state.hovered) return;
	if (state.hovered >= 0 && state.hovered !== state.selected) aHi[state.hovered] = 0;
	state.hovered = idx;
	if (idx >= 0) {
		aHi[idx] = Math.max(aHi[idx], 0.8);
		canvas.style.cursor = 'pointer';
		els.tooltip.classList.add('show');
	} else {
		canvas.style.cursor = 'grab';
		els.tooltip.classList.remove('show');
	}
	geometry.attributes.aHi.needsUpdate = true;
}

function positionTooltip(px, py, idx) {
	const a = state.agents[idx];
	const c = state.clusters[a.cluster];
	const match = state.searchActive && a._score != null ? `<div class="tt-match">${Math.round(a._score * 100)}% match</div>` : '';
	els.tooltip.innerHTML =
		`<div class="tt-theme" style="color:${c?.color || '#fff'}">${escapeHtml(c?.label || 'Agent')}</div>` +
		`<div class="tt-name">${escapeHtml(a.name)}</div>` +
		(a.description ? `<div class="tt-desc">${escapeHtml(a.description)}</div>` : '') + match;
	const tw = 280, gap = 16;
	let x = px + gap, y = py + gap;
	if (x + tw > window.innerWidth) x = px - tw - gap;
	if (y + 120 > window.innerHeight) y = py - 120 - gap;
	els.tooltip.style.left = Math.max(8, x) + 'px';
	els.tooltip.style.top = Math.max(8, y) + 'px';
}

function onPointerUp(e) {
	if (!pointerDown) return;
	const moved = Math.abs(e.clientX - pointerDown.x) + Math.abs(e.clientY - pointerDown.y);
	pointerDown = null;
	if (moved > 6) return; // a drag, not a click
	if (!points) return;
	raycaster.setFromCamera(pointer, camera);
	const idx = pickVisible(raycaster.intersectObject(points));
	if (idx >= 0) selectAgent(idx, true);
}

// ── Camera fly-to ─────────────────────────────────────────────────────────────
function flyTo(target, distance = 70) {
	controls.autoRotate = false;
	idleTimer = -3; // hold off auto-rotate a little longer after a fly
	const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
	fly.camFrom.copy(camera.position);
	fly.tgtFrom.copy(controls.target);
	fly.tgtTo.copy(target);
	fly.camTo.copy(target).addScaledVector(dir, distance);
	fly.t = 0; fly.dur = 1.05; fly.active = true;
}

function resetView() {
	flyTo(new THREE.Vector3(0, 0, 0), RADIUS * 2.7);
	fly.camTo.set(0, 48, RADIUS * 2.7);
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function selectAgent(idx, doFly) {
	if (state.selected >= 0) aHi[state.selected] = 0;
	state.selected = idx;
	aHi[idx] = 1;
	geometry.attributes.aHi.needsUpdate = true;
	const a = state.agents[idx];
	const c = state.clusters[a.cluster];
	if (doFly) flyTo(new THREE.Vector3(a.x, a.y, a.z), 60);

	const neighbors = semanticNeighbors(a, 5);
	drawLinks(idx, neighbors);
	setUrlParam('agent', a.id);

	const color = c?.color || '#78a9ff';
	els.panelHead.innerHTML =
		`<div class="p-avatar-row">` +
		avatarMarkup(a, 'p-avatar') +
		`<div class="p-meta">` +
		`<div class="p-theme" style="color:${color}"><span class="swatch" style="background:${color}"></span>${escapeHtml(c?.label || 'Agent')}</div>` +
		`<div class="p-name">${escapeHtml(a.name)}</div>` +
		`</div></div>`;

	const hasGraniteScores = neighbors.length && neighbors[0].score != null;
	const nbMarkup = neighbors.map((nb) => {
		const na = nb.agent;
		const pct = nb.score != null ? Math.round(nb.score * 100) : null;
		const barWidth = pct != null ? Math.round(scoreToBrightness(nb.score) * 100) : 0;
		const scoreHtml = pct != null
			? `<div class="nb-score-row"><div class="nb-bar"><i style="width:${barWidth}%"></i></div><span class="nb-pct">${pct}%</span></div>`
			: `<div class="nb-score-row"><span style="font-size:10px;color:var(--muted2)">${escapeHtml(state.clusters[na.cluster]?.label || '')}</span></div>`;
		return `<div class="nb" data-idx="${nb.idx}">${avatarMarkup(na, 'nb-av')}` +
			`<div class="nb-meta"><div class="nb-name">${escapeHtml(na.name)}</div>${scoreHtml}</div></div>`;
	}).join('');

	const graniteTag = hasGraniteScores ? '<span class="granite-tag">· Granite cosine</span>' : '';
	els.panelBody.innerHTML =
		`<div class="p-desc">${escapeHtml(a.description || 'No description provided.')}</div>` +
		(neighbors.length ? `<div class="p-section neighbors"><h4>Nearest in meaning ${graniteTag}</h4>${nbMarkup}</div>` : '') +
		`<div class="p-actions">` +
		`<a class="p-cta" href="${escapeAttr(a.url)}">Open agent</a>` +
		`<button class="p-copy-link" title="Copy shareable link">` +
		`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` +
		`Copy link</button>` +
		`</div>`;

	els.panelBody.querySelectorAll('.nb').forEach((row) => {
		row.addEventListener('click', () => selectAgent(Number(row.dataset.idx), true));
	});
	const copyBtn = els.panelBody.querySelector('.p-copy-link');
	if (copyBtn) {
		copyBtn.addEventListener('click', () => {
			const url = new URL(window.location.href);
			url.searchParams.set('agent', a.id);
			navigator.clipboard.writeText(url.toString()).then(() => {
				copyBtn.classList.add('copied');
				copyBtn.textContent = 'Copied!';
				setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Copy link`; }, 2000);
			}).catch(() => {
				// Fallback: select the URL so user can copy manually.
				const inp = document.createElement('input');
				inp.value = url.toString();
				document.body.appendChild(inp);
				inp.select();
				document.execCommand('copy');
				inp.remove();
			});
		});
	}

	els.panel.classList.add('open');
	els.panel.setAttribute('aria-hidden', 'false');
}

function closePanel() {
	els.panel.classList.remove('open');
	els.panel.setAttribute('aria-hidden', 'true');
	if (state.selected >= 0 && state.selected !== state.hovered) aHi[state.selected] = 0;
	state.selected = -1;
	geometry.attributes.aHi.needsUpdate = true;
	clearLinks();
	setUrlParam('agent', null);
}

// Semantic neighbours: prefer the server's Granite-cosine ranking (true meaning),
// falling back to 3D proximity only if the payload predates that field.
function semanticNeighbors(agent, k) {
	if (Array.isArray(agent.neighbors) && agent.neighbors.length) {
		return agent.neighbors.slice(0, k).map((nb) => {
			const na = state.byId.get(nb.id);
			return na ? { agent: na, idx: state.agents.indexOf(na), score: nb.score } : null;
		}).filter(Boolean);
	}
	return nearestNeighbors3D(state.agents.indexOf(agent), k).map((nb) => ({ agent: state.agents[nb.idx], idx: nb.idx, score: null }));
}

// Fallback nearest neighbours by 3D distance — the proximity the eye sees.
function nearestNeighbors3D(idx, k) {
	const a = state.agents[idx];
	const out = [];
	for (let i = 0; i < state.agents.length; i++) {
		if (i === idx) continue;
		const b = state.agents[i];
		const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
		out.push({ idx: i, d });
	}
	out.sort((p, q) => p.d - q.d);
	return out.slice(0, k);
}

// ── Constellation links ───────────────────────────────────────────────────────
// Faint glowing lines from the selected agent to its semantic neighbours —
// literally drawing the constellation the embedding implies.
let linkLines = null;
function clearLinks() {
	if (linkLines) { scene.remove(linkLines); linkLines.geometry.dispose(); linkLines.material.dispose(); linkLines = null; }
}
function drawLinks(idx, neighbors) {
	clearLinks();
	if (!neighbors.length) return;
	const a = state.agents[idx];
	const col = new THREE.Color(a.color);
	const pos = [];
	const colors = [];
	for (const nb of neighbors) {
		const b = nb.agent;
		pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
		// Brighter near the selected end, dimmer at the neighbour end.
		colors.push(col.r, col.g, col.b, col.r * 0.5, col.g * 0.5, col.b * 0.5);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
	g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
	const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
	linkLines = new THREE.LineSegments(g, m);
	scene.add(linkLines);
}

// ── Legend ────────────────────────────────────────────────────────────────────
function buildLegend() {
	const buildRows = (container, onclick) => {
		container.innerHTML = '';
		for (const c of state.clusters) {
			if (!c.size) continue;
			const row = document.createElement('div');
			row.className = 'row';
			row.innerHTML = `<span class="swatch" style="background:${c.color};color:${c.color}"></span>` +
				`<span class="name">${escapeHtml(c.label)}</span><span class="cnt">${c.size}</span>`;
			row.addEventListener('click', () => { onclick?.(); toggleIsolate(c.id); });
			row.dataset.cluster = c.id;
			container.appendChild(row);
		}
	};
	buildRows(els.legendRows, null);
	if (els.legendMobileRows) buildRows(els.legendMobileRows, closeMobileLegend);

	const src = state.clusters.filter((c) => c.labelSource === 'granite').length;
	if (els.legendFoot) els.legendFoot.textContent = `${state.data.meta.clusterCount} themes · ${src} named by Granite. Click to isolate.`;
	els.legend.style.display = 'block';

	// Mobile toggle button — only shown when legend is CSS-hidden (<640px).
	if (els.legendToggle) els.legendToggle.style.display = '';
	if (els.legendMobile) { els.legendMobile.style.display = 'none'; els.legendMobile.hidden = true; }
}

function closeMobileLegend() {
	if (!els.legendMobile) return;
	els.legendMobile.style.display = 'none';
	els.legendMobile.hidden = true;
}

function toggleIsolate(clusterId) {
	stopTour();
	state.isolatedCluster = state.isolatedCluster === clusterId ? null : clusterId;
	if (state.searchActive) clearSearch();
	applyVisibility();
	// When isolating a theme, fly to its centroid so the user actually sees it.
	if (state.isolatedCluster !== null) {
		const c = state.clusters[clusterId];
		if (c) flyTo(new THREE.Vector3(c.x, c.y, c.z), 95);
	}
	[els.legendRows, els.legendMobileRows].forEach((container) => {
		if (!container) return;
		container.querySelectorAll('.row').forEach((row) => {
			const isMuted = state.isolatedCluster !== null && Number(row.dataset.cluster) !== state.isolatedCluster;
			row.classList.toggle('muted', isMuted);
		});
	});
}

// Recompute per-star dimming from isolation + search state.
function applyVisibility() {
	for (let i = 0; i < state.agents.length; i++) {
		const a = state.agents[i];
		let dim = 1;
		if (state.isolatedCluster !== null && a.cluster !== state.isolatedCluster) dim = 0.12;
		if (state.searchActive) dim = a._score != null ? 0.35 + 0.65 * scoreToBrightness(a._score) : 0.08;
		aDim[i] = dim;
	}
	geometry.attributes.aDim.needsUpdate = true;
}

function scoreToBrightness(score) {
	// Stretch the typical cosine range (~0.2–0.6) to 0–1 for visual contrast.
	return Math.max(0, Math.min(1, (score - 0.18) / 0.42));
}

// ── Guided tour ───────────────────────────────────────────────────────────────
// Hands-free fly-through of every Granite-named theme — great for an unattended
// demo loop. Each step isolates a theme, flies to its centroid, and surfaces its
// label; any user interaction stops it.
const tour = { active: false, i: 0, timer: 0 };
function toggleTour() { tour.active ? stopTour() : startTour(); }
function startTour() {
	const themed = state.clusters.filter((c) => c.size);
	if (themed.length < 2) return;
	if (state.searchActive) clearSearch();
	if (els.panel.classList.contains('open')) closePanel();
	tour.active = true; tour.i = 0;
	els.tourBtn.classList.add('active');
	flashHudHint('Guided tour — touring the themes Granite named. Interact to stop.');
	tourStep(themed);
	tour.timer = setInterval(() => tourStep(themed), 4800);
}
function tourStep(themed) {
	const c = themed[tour.i % themed.length];
	tour.i++;
	state.isolatedCluster = c.id;
	applyVisibility();
	[els.legendRows, els.legendMobileRows].forEach((ct) => ct?.querySelectorAll('.row').forEach((r) => r.classList.toggle('muted', Number(r.dataset.cluster) !== c.id)));
	flyTo(new THREE.Vector3(c.x, c.y, c.z), 95);
}
function stopTour() {
	if (!tour.active) return;
	tour.active = false;
	clearInterval(tour.timer);
	els.tourBtn.classList.remove('active');
	state.isolatedCluster = null;
	applyVisibility();
	[els.legendRows, els.legendMobileRows].forEach((ct) => ct?.querySelectorAll('.row').forEach((r) => r.classList.remove('muted')));
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function buildStats() {
	const m = state.data.meta;
	const stat = (v, k, u = '') => `<div class="stat"><div class="v">${v}${u ? `<span class="u">${u}</span>` : ''}</div><div class="k">${k}</div></div>`;
	els.stats.innerHTML =
		stat(m.count, 'Agents') +
		stat(m.dims || '—', 'Granite dims') +
		stat(m.clusterCount, 'Themes') +
		stat('3D', 'Projection');
	els.stats.style.display = 'flex';
	els.stats.title = `Embedded with ${m.model} on IBM watsonx.ai`;
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer = 0;
function wireSearch() {
	els.searchInput.addEventListener('input', () => {
		els.searchClear.style.display = els.searchInput.value ? 'block' : 'none';
		clearTimeout(searchTimer);
		const q = els.searchInput.value.trim();
		if (!q) { clearSearch(); return; }
		searchTimer = setTimeout(() => runSearch(q), 420);
	});
	els.searchInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { clearTimeout(searchTimer); const q = els.searchInput.value.trim(); if (q) runSearch(q); }
		if (e.key === 'Escape') { els.searchInput.value = ''; clearSearch(); els.searchInput.blur(); }
	});
	els.searchClear.addEventListener('click', () => { els.searchInput.value = ''; els.searchClear.style.display = 'none'; clearSearch(); els.searchInput.focus(); });

	els.searchHint.innerHTML = EXAMPLES.map((e) => `<button class="chip">${escapeHtml(e)}</button>`).join('');
	els.searchHint.querySelectorAll('.chip').forEach((chip) => {
		chip.addEventListener('click', () => { els.searchInput.value = chip.textContent; els.searchClear.style.display = 'block'; runSearch(chip.textContent); });
	});
}

async function runSearch(query) {
	stopTour();
	setUrlParam('q', query);
	setUrlParam('agent', null);
	els.searchBox.classList.add('searching');
	try {
		const res = await fetch('/api/ibm/galaxy', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ query }),
		});
		if (!res.ok) throw new Error(`search ${res.status}`);
		const data = await res.json();
		applySearchResults(query, data);
	} catch (err) {
		log.error('[galaxy] search failed', err);
		els.results.innerHTML = `<div class="r-head"><span>Search unavailable right now.</span></div>`;
		els.results.classList.add('show');
	} finally {
		els.searchBox.classList.remove('searching');
	}
}

function applySearchResults(query, data) {
	state.searchActive = true;
	state.isolatedCluster = null;
	els.legendRows.querySelectorAll('.row').forEach((r) => r.classList.remove('muted'));
	const scores = new Map((data.results || []).map((r) => [r.id, r.score]));
	for (const a of state.agents) a._score = scores.has(a.id) ? scores.get(a.id) : null;
	applyVisibility();
	renderResults(query, data.results || []);

	// Clear all search highlights before applying the new best result.
	aHi.fill(0);
	state.selected = -1;
	geometry.attributes.aHi.needsUpdate = true;

	const best = data.best && state.byId.get(data.best.id);
	if (best) {
		const idx = state.agents.indexOf(best);
		flyTo(new THREE.Vector3(best.x, best.y, best.z), 64);
		if (idx >= 0) { aHi[idx] = 1; geometry.attributes.aHi.needsUpdate = true; }
	}
}

function renderResults(query, results) {
	if (!results.length) {
		els.results.innerHTML = `<div class="r-head"><span>No semantic matches for “${escapeHtml(query)}”.</span></div>`;
		els.results.classList.add('show');
		return;
	}
	const top = results.slice(0, 8);
	const rows = top.map((r, i) => {
		const a = state.byId.get(r.id);
		if (!a) return '';
		const pct = Math.round(scoreToBrightness(r.score) * 100);
		return `<div class="ritem${i === 0 ? ' active' : ''}" data-id="${escapeAttr(r.id)}">` +
			avatarMarkup(a, 'r-av') +
			`<span class="r-name">${escapeHtml(a.name)}</span>` +
			`<span class="r-bar"><i style="width:${pct}%"></i></span>` +
			`<span class="r-score">${Math.round(r.score * 100)}%</span></div>`;
	}).join('');
	els.results.innerHTML = `<div class="r-head"><span>Ranked by <b>Granite</b> semantic similarity</span><span>${results.length} matched</span></div>${rows}`;
	els.results.classList.add('show');
	els.results.querySelectorAll('.ritem').forEach((row) => {
		row.addEventListener('click', () => {
			const a = state.byId.get(row.dataset.id);
			if (a) selectAgent(state.agents.indexOf(a), true);
		});
	});
}

function clearSearch() {
	state.searchActive = false;
	for (const a of state.agents) a._score = null;
	els.results.classList.remove('show');
	applyVisibility();
	setUrlParam('q', null);
}

// ── Markup helpers ────────────────────────────────────────────────────────────
function avatarMarkup(a, cls) {
	if (a.image) return `<img class="${cls}" src="${escapeAttr(a.image)}" alt="" loading="lazy" data-fallback="element" data-fallback-class="${cls} placeholder" data-fallback-text="${escapeAttr((a.name[0] || '?').toUpperCase())}" />`;
	return `<div class="${cls} placeholder">${escapeHtml((a.name[0] || '?').toUpperCase())}</div>`;
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Reflect view state into the URL so a selected agent / active search is a
// shareable link (no history spam — replaceState).
function setUrlParam(key, val) {
	try {
		const url = new URL(window.location.href);
		if (val == null || val === '') url.searchParams.delete(key);
		else url.searchParams.set(key, val);
		window.history.replaceState(null, '', url);
	} catch { /* older browsers without URL/replaceState — non-fatal */ }
}
function escapeAttr(s) { return escapeHtml(s); }
function hexA(hex, a) {
	const h = hex.replace('#', '');
	const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── State machine for overlays ────────────────────────────────────────────────
function showOnly(el) {
	for (const o of [els.loading, els.empty, els.unavailable, els.error]) o.classList.toggle('show', o === el);
	const name = el === els.loading ? 'loading' : el === els.empty ? 'empty'
		: el === els.unavailable ? 'unavailable' : el === els.error ? 'error' : 'scene';
	document.body.dataset.galaxyState = name;
}
function setLoadStep(step) {
	els.loadSteps.querySelectorAll('.o-step').forEach((s) => {
		const n = Number(s.dataset.step);
		s.classList.toggle('done', n < step);
		s.classList.toggle('active', n === step);
	});
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function load() {
	showOnly(els.loading);
	setLoadStep(1); // request in flight → Granite is embedding + projecting server-side
	let data;
	try {
		const res = await fetch('/api/ibm/galaxy');
		if (!res.ok) throw new Error(`galaxy ${res.status}`);
		data = await res.json();
	} catch (err) {
		log.error('[galaxy] load failed', err);
		els.errorMsg.textContent = 'Something went wrong reaching the galaxy service. Check your connection and try again.';
		showOnly(els.error);
		return;
	}

	if (!data.available) {
		if (data.reason === 'watsonx_not_configured') {
			if (data.message) els.unavailableMsg.textContent = data.message;
			showOnly(els.unavailable);
		} else {
			showOnly(els.empty);
		}
		return;
	}
	if (!data.agents || data.agents.length < 2) {
		const reason = data.meta?.reason;
		els.emptyTitle.textContent = reason === 'too_few_agents' ? 'Not enough agents yet' : 'No agents to map yet';
		els.emptyMsg.textContent = reason === 'too_few_agents'
			? 'A galaxy needs at least a couple of public agents to map relationships. Create one and it joins the constellation.'
			: 'The galaxy lights up once public agents exist. Create one and it joins the constellation on the next rebuild.';
		showOnly(els.empty);
		return;
	}

	setLoadStep(3); // rendering
	state.data = data;
	state.clusters = data.clusters;
	state.agents = data.agents.map((a) => ({ ...a, color: data.clusters[a.cluster]?.color || '#78a9ff', _score: null }));
	state.byId = new Map(state.agents.map((a) => [a.id, a]));

	buildPoints();
	buildClusterLabels();
	buildLegend();
	buildStats();
	els.searchWrap.style.display = 'block';

	// Reveal the scene.
	showOnly(null);
	els.loading.classList.remove('show');
	flashHudHint(`Drag to orbit · scroll to zoom · click a star to explore · press <b>/</b> to search`);
	applyDeepLink();

	document.body.dataset.galaxyState = 'ready';
	// Read-only introspection handle for support/debugging a 3D scene that can't
	// be inspected from pixels alone (headless WebGL renders nothing screenshotable).
	window.__ibmGalaxy = {
		state,
		scene,
		camera,
		points: () => points,
		starCount: () => (points ? points.geometry.attributes.position.count : 0),
		rendererInfo: () => renderer.info.render,
		linkCount: () => (linkLines ? linkLines.geometry.attributes.position.count / 2 : 0),
		tourActive: () => tour.active,
	};
}

function flashHudHint(html) {
	els.hudHint.innerHTML = html;
	els.hudHint.classList.add('show');
	setTimeout(() => els.hudHint.classList.remove('show'), 6500);
}

// Honour a shareable URL: ?agent=<id> selects + flies to a star, ?q=<text>
// runs a semantic search. Lets a demo link open straight to the right view.
function applyDeepLink() {
	try {
		const params = new URLSearchParams(window.location.search);
		const agentId = params.get('agent');
		const q = params.get('q');
		if (agentId && state.byId.has(agentId)) {
			selectAgent(state.agents.indexOf(state.byId.get(agentId)), true);
		} else if (q) {
			els.searchInput.value = q;
			els.searchClear.style.display = 'block';
			runSearch(q);
		}
	} catch { /* malformed URL — ignore */ }
}

function onResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight, false);
	if (material) material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
}

function wireGlobalUI() {
	els.panelClose.addEventListener('click', closePanel);
	els.resetView.addEventListener('click', () => {
		stopTour(); resetView(); state.isolatedCluster = null;
		if (state.searchActive) clearSearch(); applyVisibility();
		[els.legendRows, els.legendMobileRows].forEach((c) => c?.querySelectorAll('.row').forEach((r) => r.classList.remove('muted')));
	});
	els.tourBtn.addEventListener('click', toggleTour);
	els.retryBtn.addEventListener('click', () => load());

	// Mobile legend toggle.
	if (els.legendToggle) {
		els.legendToggle.addEventListener('click', () => {
			if (!els.legendMobile) return;
			const open = !els.legendMobile.hidden;
			els.legendMobile.style.display = open ? 'none' : 'block';
			els.legendMobile.hidden = open;
		});
	}

	// Keyboard shortcuts overlay.
	const openShortcuts = () => { els.shortcutsOverlay.classList.add('show'); };
	const closeShortcuts = () => { els.shortcutsOverlay.classList.remove('show'); };
	if (els.shortcutsBtn) els.shortcutsBtn.addEventListener('click', openShortcuts);
	if (els.shortcutsClose) els.shortcutsClose.addEventListener('click', closeShortcuts);
	els.shortcutsOverlay?.addEventListener('click', (e) => { if (e.target === els.shortcutsOverlay) closeShortcuts(); });

	window.addEventListener('keydown', (e) => {
		const inInput = document.activeElement === els.searchInput;
		if (e.key === '/' && !inInput) { e.preventDefault(); els.searchInput.focus(); }
		else if (e.key === 'Escape') {
			if (els.shortcutsOverlay.classList.contains('show')) { closeShortcuts(); return; }
			if (els.legendMobile && !els.legendMobile.hidden) { closeMobileLegend(); return; }
			if (els.panel.classList.contains('open')) { closePanel(); return; }
			if (state.searchActive) { els.searchInput.value = ''; clearSearch(); return; }
		}
		else if ((e.key === 'r' || e.key === 'R') && !inInput) { els.resetView.click(); }
		else if ((e.key === 't' || e.key === 'T') && !inInput) toggleTour();
		else if (e.key === '?' && !inInput) openShortcuts();
	});
}

// WebGL capability guard — show the error state rather than a blank canvas.
function hasWebGL() {
	try {
		const c = document.createElement('canvas');
		return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
	} catch { return false; }
}

if (!hasWebGL()) {
	els.errorMsg.textContent = 'This browser or device does not support WebGL, which the Agent Galaxy needs to render.';
	showOnly(els.error);
} else {
	initThree();
	wireSearch();
	wireGlobalUI();
	load();
}
