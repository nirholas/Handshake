// /timeline — three.ws's public history as an explorable 3D scene.
//
// Every milestone (data/timeline.json) sits as a glowing marker along a
// curved path. Two ways to explore: Orbit (drag to look around 360°, click
// any marker) or Walk (step marker-to-marker with a guide beacon leading the
// way, chase camera). A synced bottom scrubber, a detail panel, category
// filters, and a real accessible fallback list for no-WebGL/reduced-motion
// visitors round it out. No server round-trip beyond the one static JSON
// fetch — everything else is client-side.

import {
	AmbientLight,
	AdditiveBlending,
	Box3,
	BufferGeometry,
	CanvasTexture,
	CatmullRomCurve3,
	Color,
	CylinderGeometry,
	DirectionalLight,
	Float32BufferAttribute,
	FogExp2,
	Group,
	HemisphereLight,
	IcosahedronGeometry,
	MeshBasicMaterial,
	Mesh,
	PerspectiveCamera,
	PlaneGeometry,
	Points,
	PointsMaterial,
	Raycaster,
	Scene,
	SRGBColorSpace,
	ACESFilmicToneMapping,
	Sprite,
	SpriteMaterial,
	Timer,
	Vector2,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { AnimationManager } from './animation-manager.js';
import { log } from './shared/log.js';

const DATA_URL = '/data/timeline.json';
const AVATAR_URL = '/avatars/default.glb';
const ANIMATIONS_MANIFEST_URL = '/animations/manifest.json';
const CLIP_IDLE = 'idle';

const SPACING = 6.4; // metres between consecutive markers along the path
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const root = document.getElementById('timeline-root');
const boot = document.getElementById('timeline-boot');

// ── Styles (injected once; keeps pages/timeline.html to a plain shell) ─────

function injectStyles() {
	if (document.getElementById('tl-styles')) return;
	const css = `
		.tl-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
		.tl-canvas:focus-visible { outline: 2px solid rgba(154, 208, 255, 0.7); outline-offset: -3px; }
		.tl-mode-btn:focus-visible, .tl-filter-chip:focus-visible, .tl-nav-btn:focus-visible, .tl-tick:focus-visible,
		.tl-panel-close:focus-visible, .tl-panel-src:focus-visible, .tl-error button:focus-visible {
			outline: 2px solid #9ad0ff; outline-offset: 2px;
		}

		.tl-topbar {
			position: absolute; top: 0.85rem; left: 50%; transform: translateX(-50%);
			display: flex; align-items: center; gap: 0.5rem; z-index: 15;
			background: rgba(8, 10, 18, 0.72); backdrop-filter: blur(10px);
			border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 999px;
			padding: 0.35rem 0.4rem; max-width: calc(100vw - 1.6rem); overflow-x: auto;
		}
		.tl-mode-btn, .tl-filter-chip {
			font: 600 0.74rem system-ui, sans-serif; color: rgba(255,255,255,0.72);
			background: transparent; border: 1px solid transparent; border-radius: 999px;
			padding: 0.34rem 0.7rem; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 0.35rem;
		}
		.tl-mode-btn:hover, .tl-filter-chip:hover { color: #fff; background: rgba(255,255,255,0.08); }
		.tl-mode-btn[aria-pressed="true"] { background: #7aa2ff; color: #06080f; }
		.tl-filter-chip[aria-pressed="false"] { opacity: 0.4; }
		.tl-chip-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
		.tl-topbar-sep { width: 1px; align-self: stretch; background: rgba(255,255,255,0.14); margin: 0 0.15rem; flex: none; }

		.tl-panel {
			position: absolute; top: 0; right: 0; height: 100%; width: min(380px, 100%);
			background: rgba(8, 10, 18, 0.88); backdrop-filter: blur(14px);
			border-left: 1px solid rgba(255,255,255,0.1); box-shadow: -20px 0 40px rgba(0,0,0,0.35);
			transform: translateX(100%); transition: transform 0.32s cubic-bezier(.2,.7,.2,1);
			z-index: 20; display: flex; flex-direction: column; padding: 1.3rem 1.25rem;
			color: #eef2fa; overflow-y: auto;
		}
		/* Open, the panel is a surface the visitor asked for, so it sits above
		   the ambient bottom-right helper stack (language pill, discovery card)
		   on the ladder public/corner-stack.js publishes; on a phone that stack
		   otherwise lands squarely on the milestone text in the sheet. */
		.tl-panel.is-open { transform: translateX(0); z-index: var(--z-overlay-modal, 2147483600); }
		/* The open panel owns the right edge, so the scrubber bar (a later
		   sibling) gives up that column: Next and Play stay clickable while a
		   milestone is being read instead of sitting under the panel. */
		.tl-panel.is-open ~ .tl-bottombar { right: min(380px, 100%); }
		.tl-panel.is-open ~ .tl-hint { display: none; }
		.tl-panel-close {
			position: absolute; top: 0.8rem; right: 0.8rem; width: 30px; height: 30px; border-radius: 50%;
			background: rgba(255,255,255,0.08); border: none; color: #fff; font-size: 1rem; cursor: pointer;
		}
		.tl-panel-close:hover { background: rgba(255,255,255,0.16); }
		.tl-panel-badge {
			display: inline-flex; align-items: center; gap: 0.4rem; font: 700 0.68rem system-ui, sans-serif;
			text-transform: uppercase; letter-spacing: 0.04em; padding: 0.28rem 0.6rem; border-radius: 999px;
			background: rgba(255,255,255,0.08); width: fit-content; margin-bottom: 0.7rem;
		}
		.tl-panel-date { font: 600 0.78rem system-ui, sans-serif; color: rgba(255,255,255,0.5); margin: 0 0 0.3rem; }
		.tl-panel-title { font: 700 1.28rem/1.3 system-ui, sans-serif; margin: 0 0 0.75rem; }
		.tl-panel-summary { font: 400 0.92rem/1.55 system-ui, sans-serif; color: rgba(255,255,255,0.78); margin: 0 0 1rem; }
		.tl-panel-src {
			display: inline-flex; align-items: center; gap: 0.4rem; color: #9ad0ff; text-decoration: none;
			font: 600 0.84rem system-ui, sans-serif; margin-top: auto; padding-top: 0.6rem;
		}
		.tl-panel-src:hover { text-decoration: underline; }
		.tl-panel-src[hidden] { display: none; }
		.tl-panel-counter { font: 600 0.72rem system-ui, sans-serif; color: rgba(255,255,255,0.4); margin-top: 0.4rem; }

		.tl-bottombar {
			position: absolute; left: 0; right: 0; bottom: 0; z-index: 15;
			background: linear-gradient(to top, rgba(4,5,10,0.92), rgba(4,5,10,0));
			padding: 2.2rem 1rem 0.9rem; display: flex; flex-direction: column; gap: 0.55rem;
		}
		.tl-scrub-row { display: flex; align-items: center; gap: 0.6rem; }
		.tl-nav-btn {
			flex: none; width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.16);
			background: rgba(255,255,255,0.06); color: #fff; font-size: 0.95rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
		}
		.tl-nav-btn:hover { background: rgba(255,255,255,0.14); }
		.tl-nav-btn[aria-pressed="true"] { background: #7aa2ff; color: #06080f; border-color: transparent; }
		.tl-scrub-track {
			flex: 1; min-width: 0; display: flex; gap: 3px; overflow-x: auto; padding: 0.3rem 0.1rem;
			scroll-behavior: smooth; scrollbar-width: thin;
		}
		.tl-tick {
			flex: none; width: 9px; height: 22px; border-radius: 4px; border: none; cursor: pointer;
			background: rgba(255,255,255,0.16); opacity: 0.55; transition: transform 0.15s, opacity 0.15s;
		}
		.tl-tick:hover { opacity: 0.9; }
		.tl-tick.is-active { height: 30px; opacity: 1; transform: translateY(-4px); }
		.tl-tick.is-dim { opacity: 0.12; cursor: default; }
		.tl-scrub-label { text-align: center; font: 600 0.7rem system-ui, sans-serif; color: rgba(255,255,255,0.5); }

		.tl-hint {
			position: absolute; bottom: 6.2rem; left: 50%; transform: translateX(-50%); z-index: 12;
			font: 500 0.72rem system-ui, sans-serif; color: rgba(255,255,255,0.4); pointer-events: none; text-align: center;
		}

		.tl-error { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.9rem; padding: 2rem; text-align: center; color: rgba(255,255,255,0.75); font: 500 0.9rem system-ui, sans-serif; }
		.tl-error button { font: 650 0.82rem system-ui, sans-serif; background: #7aa2ff; color: #06080f; border: none; border-radius: 999px; padding: 0.55rem 1.2rem; cursor: pointer; }

		@media (max-width: 640px) {
			/* Bottom sheet, parked ABOVE the scrubber bar (its measured height is
			   published as --tl-bar-h) so prev / next / play stay reachable while
			   a milestone is open, and the bar keeps its full width. */
			.tl-panel { width: 100%; height: min(56vh, 400px); top: auto; bottom: var(--tl-bar-h, 108px); right: 0;
				background: rgba(8, 10, 18, 0.97);
				transform: translateY(calc(100% + var(--tl-bar-h, 108px))); border-left: none; border-top: 1px solid rgba(255,255,255,0.1); border-radius: 16px 16px 0 0; }
			.tl-panel.is-open { transform: translateY(0); }
			.tl-panel.is-open ~ .tl-bottombar { right: 0; }
			.tl-bottombar { padding-bottom: 0.7rem; }
			.tl-hint { display: none; }
		}
	`;
	const tag = document.createElement('style');
	tag.id = 'tl-styles';
	tag.textContent = css;
	document.head.appendChild(tag);
}

// ── Small helpers ───────────────────────────────────────────────────────────

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp01(v) {
	return Math.min(1, Math.max(0, v));
}

function makeLabelSprite(text, subtext, color) {
	const canvas = document.createElement('canvas');
	const scale = 2; // crisp on hiDPI without ballooning texture memory
	canvas.width = 512 * scale;
	canvas.height = 128 * scale;
	const ctx = canvas.getContext('2d');
	ctx.scale(scale, scale);
	ctx.textAlign = 'center';
	ctx.fillStyle = 'rgba(255,255,255,0.55)';
	ctx.font = '600 15px system-ui, sans-serif';
	ctx.fillText(subtext, 256, 34);
	ctx.fillStyle = '#f4f7ff';
	ctx.font = '700 25px system-ui, sans-serif';
	const words = text.length > 42 ? text.slice(0, 40) + '…' : text;
	ctx.fillText(words, 256, 72);
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(256, 94, 4, 0, Math.PI * 2);
	ctx.fill();

	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
	const sprite = new Sprite(material);
	sprite.scale.set(3.4, 0.85, 1);
	return sprite;
}

function makeStarfield() {
	const COUNT = 1400;
	const positions = new Float32Array(COUNT * 3);
	for (let i = 0; i < COUNT; i++) {
		const r = 140 + Math.random() * 260;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(2 * Math.random() - 1);
		positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		positions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.5 + 4;
		positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
	}
	const geo = new BufferGeometry();
	geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
	const mat = new PointsMaterial({ color: 0xbfd4ff, size: 0.55, sizeAttenuation: true, transparent: true, opacity: 0.6 });
	return new Points(geo, mat);
}

// ── Boot ─────────────────────────────────────────────────────────────────

function supportsWebGL() {
	try {
		const c = document.createElement('canvas');
		return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
	} catch {
		return false;
	}
}

function escapeHtml(s) {
	const d = document.createElement('div');
	d.textContent = s;
	return d.innerHTML;
}

function renderFallback(events, reason) {
	if (boot) boot.remove();
	const wrap = document.createElement('div');
	wrap.className = 'tl-fallback';
	const intro = reason
		? `<p style="color:rgba(255,255,255,0.55);font:500 0.82rem system-ui,sans-serif;max-width:640px;margin:0 auto 1.2rem;text-align:center">${escapeHtml(reason)} Here's the same history as a plain list.</p>`
		: '';
	wrap.innerHTML = `${intro}<ol>${events
		.map(
			(e) => `<li>
				<div class="tl-date">${e.date}</div>
				<h2 class="tl-title">${escapeHtml(e.title)}</h2>
				<p class="tl-summary">${escapeHtml(e.summary)}</p>
				${e.source_url ? `<a class="tl-src" href="${e.source_url}" target="_blank" rel="noopener noreferrer">Read source ↗</a>` : ''}
			</li>`
		)
		.join('')}</ol>`;
	root.appendChild(wrap);
}

function showError(message, onRetry) {
	if (boot) boot.remove();
	const existing = root.querySelector('.tl-error');
	if (existing) existing.remove();
	const wrap = document.createElement('div');
	wrap.className = 'tl-error';
	wrap.innerHTML = `<div>${escapeHtml(message)}</div>`;
	const btn = document.createElement('button');
	btn.textContent = 'Retry';
	btn.addEventListener('click', onRetry);
	wrap.appendChild(btn);
	root.appendChild(wrap);
}

const EMPTY_MESSAGE = 'No milestones have been published yet. Check back soon.';
const OFFLINE_MESSAGE = 'Could not load the timeline. Check your connection and try again.';

async function loadData() {
	// Default HTTP caching, not force-cache: the file changes with every
	// deploy and the server already sets a bounded max-age on it.
	const res = await fetch(DATA_URL);
	if (!res.ok) throw new Error(`HTTP ${res.status} loading timeline data`);
	const json = await res.json();
	if (!json || !Array.isArray(json.events) || json.events.length === 0) {
		const err = new Error('Timeline data is empty');
		err.code = 'EMPTY';
		throw err;
	}
	return json;
}

function loadErrorMessage(err) {
	return err?.code === 'EMPTY' ? EMPTY_MESSAGE : OFFLINE_MESSAGE;
}

async function boot_() {
	injectStyles();
	if (!supportsWebGL()) {
		try {
			const data = await loadData();
			renderFallback(data.events, 'Your browser can’t run the 3D scene.');
		} catch (err) {
			showError(loadErrorMessage(err), () => location.reload());
		}
		return;
	}
	try {
		const data = await loadData();
		if (boot) boot.remove();
		mountTimeline(root, data);
	} catch (err) {
		log.warn('[timeline] load failed:', err?.message);
		showError(loadErrorMessage(err), boot_);
	}
}

boot_();

// ── Main scene ───────────────────────────────────────────────────────────

function mountTimeline(container, data) {
	const categories = data.categories || {};
	const events = data.events;
	const state = {
		mode: 'orbit', // 'orbit' | 'walk'
		focusedIndex: 0,
		visibleCategories: new Set(Object.keys(categories)),
		playing: false,
		playTimer: null,
		tween: null, // { from, to, start, duration } for walk-mode camera moves
		orbitFly: null,
		panelOpen: false,
		destroyed: false,
	};

	// ── renderer / scene / camera ──
	const canvas = document.createElement('canvas');
	canvas.className = 'tl-canvas';
	canvas.tabIndex = 0;
	container.appendChild(canvas);

	const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;

	const scene = new Scene();
	scene.background = new Color(0x03040a);
	scene.fog = new FogExp2(0x03040a, 0.016);
	scene.add(makeStarfield());

	const pathLength = (events.length - 1) * SPACING;
	const camera = new PerspectiveCamera(55, 1, 0.1, 400);
	camera.position.set(0, 5.5, Math.min(24, pathLength * 0.35 + 8));

	scene.add(new AmbientLight(0x8899cc, 0.55));
	const hemi = new HemisphereLight(0x99bbff, 0x0a0810, 0.6);
	scene.add(hemi);
	const sun = new DirectionalLight(0xffffff, 1.1);
	sun.position.set(6, 12, 6);
	scene.add(sun);

	// Ground: a dim plane so the path reads as "on the ground" without the
	// cost of real shadow mapping.
	const ground = new Mesh(
		new PlaneGeometry(pathLength + 60, 60),
		new MeshBasicMaterial({ color: 0x070912 })
	);
	ground.rotation.x = -Math.PI / 2;
	ground.position.set(pathLength / 2, -0.02, 0);
	scene.add(ground);

	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 4;
	controls.maxDistance = 60;
	controls.maxPolarAngle = Math.PI * 0.49;
	controls.autoRotate = !REDUCED_MOTION;
	controls.autoRotateSpeed = 0.4;
	controls.addEventListener('start', () => {
		controls.autoRotate = false;
		if (state.playing) togglePlay(false);
	});

	// ── path + markers ──
	// Gentle S-curve so the walk reads as a real path rather than a straight
	// line, evenly re-parametrized by arc length so marker spacing (and
	// camera travel speed in Walk mode) stays visually even through the turns.
	const rawPoints = [];
	const turns = Math.max(2, Math.round(events.length / 7));
	for (let i = 0; i < events.length; i++) {
		const t = events.length > 1 ? i / (events.length - 1) : 0;
		const x = t * pathLength;
		const z = Math.sin(t * Math.PI * turns) * 5.2;
		rawPoints.push(new Vector3(x, 0, z));
	}
	const curve = new CatmullRomCurve3(rawPoints, false, 'catmullrom', 0.5);
	curve.arcLengthDivisions = Math.max(200, events.length * 6);

	const markerGroup = new Group();
	scene.add(markerGroup);
	const markers = []; // { mesh, beam, label, position, event, index }

	events.forEach((event, index) => {
		const t = events.length > 1 ? index / (events.length - 1) : 0;
		const pos = curve.getPointAt(t);
		const color = new Color(categories[event.category]?.color || '#7aa2ff');
		const scale = 0.32 + (event.importance || 1) * 0.075;

		const mesh = new Mesh(
			new IcosahedronGeometry(scale, 1),
			new MeshBasicMaterial({ color })
		);
		mesh.position.copy(pos);
		mesh.position.y = scale;
		mesh.userData.index = index;
		markerGroup.add(mesh);

		const beamHeight = 0.6 + (event.importance || 1) * 0.7;
		const beam = new Mesh(
			new CylinderGeometry(0.02, 0.05, beamHeight, 8, 1, true),
			new MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false })
		);
		beam.position.copy(pos);
		beam.position.y = beamHeight / 2;
		markerGroup.add(beam);

		const label = makeLabelSprite(event.title, event.date, `#${new Color(color).getHexString()}`);
		label.position.copy(pos);
		label.position.y = beamHeight + 0.9;
		markerGroup.add(label);

		markers.push({ mesh, beam, label, position: pos, event, index });
	});

	// ── guide beacon (default rigged avatar, idle-animated, carried along the
	//    path) — reuses the site's shared avatar/animation pipeline. Wrapped
	//    so a manifest/network hiccup degrades to "no visible guide" instead
	//    of breaking the timeline. ──
	const guide = new Group();
	guide.visible = false;
	scene.add(guide);
	let guideAnim = null;
	loadGuideAvatar()
		.then(({ model, animationManager }) => {
			if (state.destroyed) return;
			guide.add(model);
			guide.visible = true;
			guideAnim = animationManager;
		})
		.catch((err) => log.warn('[timeline] guide avatar unavailable, continuing without it:', err?.message));

	async function loadGuideAvatar() {
		const decoder = await getMeshoptDecoder();
		const loader = new GLTFLoader();
		loader.setMeshoptDecoder(decoder);
		const gltf = await loader.loadAsync(AVATAR_URL);
		const model = cloneSkinnedScene(gltf.scene);
		const box = new Box3().setFromObject(model);
		model.position.y -= box.min.y;
		model.scale.setScalar(0.62); // small "tour guide" scale, distinct from a life-size avatar

		const animationManager = new AnimationManager();
		animationManager.attach(model);
		const manifest = await fetch(ANIMATIONS_MANIFEST_URL, { cache: 'force-cache' }).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
			return r.json();
		});
		const idleDef = manifest.filter((d) => d.name === CLIP_IDLE);
		if (idleDef.length) {
			animationManager.setAnimationDefs(idleDef);
			await animationManager.loadAll();
			await animationManager.crossfadeTo(CLIP_IDLE, 0);
		}
		return { model, animationManager };
	}

	function placeGuideAt(t, faceForwardT) {
		const p = curve.getPointAt(clamp01(t));
		guide.position.copy(p);
		const ahead = curve.getPointAt(clamp01(faceForwardT ?? t + 0.01));
		if (ahead.distanceToSquared(p) > 1e-6) {
			const dir = new Vector3().subVectors(ahead, p).normalize();
			guide.rotation.y = Math.atan2(dir.x, dir.z);
		}
	}
	placeGuideAt(0, 0.02);

	// ── UI: topbar (mode + filters) ──
	const topbar = document.createElement('div');
	topbar.className = 'tl-topbar';
	container.appendChild(topbar);

	const orbitBtn = document.createElement('button');
	orbitBtn.className = 'tl-mode-btn';
	orbitBtn.textContent = '360° Orbit';
	orbitBtn.setAttribute('aria-pressed', 'true');
	const walkBtn = document.createElement('button');
	walkBtn.className = 'tl-mode-btn';
	walkBtn.textContent = 'Walk the path';
	walkBtn.setAttribute('aria-pressed', 'false');
	orbitBtn.addEventListener('click', () => setMode('orbit'));
	walkBtn.addEventListener('click', () => setMode('walk'));
	topbar.appendChild(orbitBtn);
	topbar.appendChild(walkBtn);

	const sep = document.createElement('div');
	sep.className = 'tl-topbar-sep';
	topbar.appendChild(sep);

	const chipButtons = new Map();
	Object.entries(categories).forEach(([key, meta]) => {
		const chip = document.createElement('button');
		chip.className = 'tl-filter-chip';
		chip.setAttribute('aria-pressed', 'true');
		chip.innerHTML = `<span class="tl-chip-dot" style="background:${meta.color}"></span>${escapeHtml(meta.label)}`;
		chip.addEventListener('click', () => toggleCategory(key, chip));
		topbar.appendChild(chip);
		chipButtons.set(key, chip);
	});

	function toggleCategory(key, chip) {
		if (state.visibleCategories.has(key)) {
			state.visibleCategories.delete(key);
			chip.setAttribute('aria-pressed', 'false');
		} else {
			state.visibleCategories.add(key);
			chip.setAttribute('aria-pressed', 'true');
		}
		refreshVisibility();
	}

	function refreshVisibility() {
		markers.forEach((m) => {
			const visible = state.visibleCategories.has(m.event.category);
			const dim = !visible;
			m.mesh.material.opacity = dim ? 0.18 : 1;
			m.mesh.material.transparent = dim;
			m.beam.material.opacity = dim ? 0.06 : 0.35;
			m.label.material.opacity = dim ? 0.15 : 1;
			const tick = scrubTicks[m.index];
			if (tick) {
				tick.classList.toggle('is-dim', dim);
				tick.setAttribute('aria-disabled', String(dim));
			}
		});
	}

	function visibleIndices() {
		return markers.filter((m) => state.visibleCategories.has(m.event.category)).map((m) => m.index);
	}

	// ── UI: detail panel ──
	const panel = document.createElement('aside');
	panel.className = 'tl-panel';
	panel.setAttribute('aria-hidden', 'true');
	panel.innerHTML = `
		<button class="tl-panel-close" aria-label="Close">×</button>
		<span class="tl-panel-badge" id="tl-panel-badge"></span>
		<div class="tl-panel-date" id="tl-panel-date"></div>
		<h2 class="tl-panel-title" id="tl-panel-title"></h2>
		<p class="tl-panel-summary" id="tl-panel-summary"></p>
		<a class="tl-panel-src" id="tl-panel-src" target="_blank" rel="noopener noreferrer" hidden>Read the source ↗</a>
		<div class="tl-panel-counter" id="tl-panel-counter"></div>
	`;
	panel.inert = true;
	container.appendChild(panel);
	panel.querySelector('.tl-panel-close').addEventListener('click', () => setPanelOpen(false));

	function setPanelOpen(open) {
		state.panelOpen = open;
		panel.classList.toggle('is-open', open);
		panel.setAttribute('aria-hidden', open ? 'false' : 'true');
		// A closed panel is off-screen; keep its close button and source link
		// out of the tab order so keyboard users never focus something invisible.
		panel.inert = !open;
		if (open && state.mode === 'orbit') controls.autoRotate = false;
	}

	// ── UI: bottom scrubber ──
	const bottombar = document.createElement('div');
	bottombar.className = 'tl-bottombar';
	bottombar.innerHTML = `
		<div class="tl-scrub-label" id="tl-scrub-label"></div>
		<div class="tl-scrub-row">
			<button class="tl-nav-btn" id="tl-prev" aria-label="Previous milestone">‹</button>
			<div class="tl-scrub-track" id="tl-scrub-track"></div>
			<button class="tl-nav-btn" id="tl-next" aria-label="Next milestone">›</button>
			<button class="tl-nav-btn" id="tl-play" aria-label="Auto-play the tour" aria-pressed="false">▶</button>
		</div>
	`;
	container.appendChild(bottombar);

	const hint = document.createElement('div');
	hint.className = 'tl-hint';
	hint.textContent = 'Drag to look around · click a marker · ← → to step · space to auto-play';
	container.appendChild(hint);

	const scrubTrack = bottombar.querySelector('#tl-scrub-track');
	const scrubLabel = bottombar.querySelector('#tl-scrub-label');
	const scrubTicks = markers.map((m) => {
		const tick = document.createElement('button');
		tick.className = 'tl-tick';
		tick.style.background = categories[m.event.category]?.color || '#7aa2ff';
		tick.setAttribute('aria-label', `${m.event.date}: ${m.event.title}`);
		tick.addEventListener('click', () => {
			// Same rule as clicking a marker: a filtered-out milestone is not a
			// destination until its category is switched back on.
			if (!state.visibleCategories.has(m.event.category)) return;
			togglePlay(false);
			focusEvent(m.index, { fly: true });
		});
		scrubTrack.appendChild(tick);
		return tick;
	});

	bottombar.querySelector('#tl-prev').addEventListener('click', () => { togglePlay(false); step(-1); });
	bottombar.querySelector('#tl-next').addEventListener('click', () => { togglePlay(false); step(1); });
	const playBtn = bottombar.querySelector('#tl-play');
	playBtn.addEventListener('click', () => togglePlay());

	function step(dir) {
		const visible = visibleIndices();
		if (visible.length === 0) return;
		const pos = visible.indexOf(state.focusedIndex);
		const nextPos = pos === -1 ? 0 : (pos + dir + visible.length) % visible.length;
		focusEvent(visible[nextPos], { fly: true });
	}

	function togglePlay(force) {
		const next = typeof force === 'boolean' ? force : !state.playing;
		state.playing = next;
		playBtn.setAttribute('aria-pressed', String(next));
		playBtn.textContent = next ? '❚❚' : '▶';
		clearTimeout(state.playTimer);
		if (next) {
			if (state.mode !== 'walk') setMode('walk');
			const advance = () => {
				if (!state.playing) return;
				const visible = visibleIndices();
				const pos = visible.indexOf(state.focusedIndex);
				if (pos === visible.length - 1) { togglePlay(false); return; }
				step(1);
				state.playTimer = setTimeout(advance, REDUCED_MOTION ? 900 : 2600);
			};
			state.playTimer = setTimeout(advance, REDUCED_MOTION ? 900 : 2600);
		}
	}

	// ── focus / camera control ──
	function setMode(mode) {
		if (mode === state.mode) return;
		state.mode = mode;
		orbitBtn.setAttribute('aria-pressed', String(mode === 'orbit'));
		walkBtn.setAttribute('aria-pressed', String(mode === 'walk'));
		controls.enabled = mode === 'orbit';
		controls.autoRotate = mode === 'orbit' && !REDUCED_MOTION && !state.panelOpen;
		if (mode === 'walk') beginWalkTween(state.focusedIndex);
	}

	function beginWalkTween(index) {
		const from = state.tween ? currentWalkT() : (events.length > 1 ? state.focusedIndex / (events.length - 1) : 0);
		const to = events.length > 1 ? index / (events.length - 1) : 0;
		state.tween = { from, to, start: performance.now(), duration: REDUCED_MOTION ? 1 : 950 };
	}

	function currentWalkT() {
		if (!state.tween) return events.length > 1 ? state.focusedIndex / (events.length - 1) : 0;
		const { from, to, start, duration } = state.tween;
		const e = clamp01((performance.now() - start) / duration);
		return from + (to - from) * easeInOutCubic(e);
	}

	function focusEvent(index, { fly = false } = {}) {
		state.focusedIndex = index;
		const m = markers[index];
		scrubTicks.forEach((tick, i) => tick.classList.toggle('is-active', i === index));
		scrubTicks[index]?.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
		scrubLabel.textContent = `${index + 1} / ${events.length} · ${m.event.date}`;

		const badge = panel.querySelector('#tl-panel-badge');
		badge.textContent = categories[m.event.category]?.label || m.event.category;
		badge.style.background = `${categories[m.event.category]?.color || '#7aa2ff'}33`;
		panel.querySelector('#tl-panel-date').textContent = m.event.date;
		panel.querySelector('#tl-panel-title').textContent = m.event.title;
		panel.querySelector('#tl-panel-summary').textContent = m.event.summary;
		const srcLink = panel.querySelector('#tl-panel-src');
		if (m.event.source_url) {
			srcLink.href = m.event.source_url;
			srcLink.hidden = false;
		} else {
			srcLink.removeAttribute('href');
			srcLink.hidden = true;
		}
		panel.querySelector('#tl-panel-counter').textContent = `Milestone ${index + 1} of ${events.length}`;
		setPanelOpen(true);

		if (state.mode === 'walk') {
			beginWalkTween(index);
		} else if (fly) {
			flyOrbitTarget(m.position);
		}
	}

	// Smoothly dolly the orbit target/camera toward a clicked marker without
	// yanking the user out of a free-look — preserves the current
	// camera-to-target *offset* so 360° orbiting continues to feel natural.
	function flyOrbitTarget(target) {
		const offset = new Vector3().subVectors(camera.position, controls.target);
		const desiredDist = Math.min(Math.max(offset.length(), 6), 14);
		offset.normalize().multiplyScalar(desiredDist);
		state.orbitFly = {
			fromTarget: controls.target.clone(),
			toTarget: target.clone(),
			fromCam: camera.position.clone(),
			toCam: new Vector3().addVectors(target, offset),
			start: performance.now(),
			duration: REDUCED_MOTION ? 1 : 750,
		};
	}

	// ── input: click/tap a marker ──
	const raycaster = new Raycaster();
	const pointer = new Vector2();
	function onPointerDown(ev) {
		const rect = canvas.getBoundingClientRect();
		pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(markers.map((m) => m.mesh), false);
		if (hits.length) {
			const idx = hits[0].object.userData.index;
			if (state.visibleCategories.has(events[idx].category)) {
				togglePlay(false);
				focusEvent(idx, { fly: true });
			}
		}
	}
	canvas.addEventListener('pointerdown', onPointerDown);

	function onKeydown(ev) {
		if (ev.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(ev.target.tagName)) return;
		if (ev.key === 'ArrowRight') { togglePlay(false); step(1); }
		else if (ev.key === 'ArrowLeft') { togglePlay(false); step(-1); }
		else if (ev.key === ' ') { ev.preventDefault(); togglePlay(); }
		else if (ev.key === 'Escape') setPanelOpen(false);
	}
	window.addEventListener('keydown', onKeydown);

	// ── resize ──
	function resize() {
		const w = container.clientWidth || 1;
		const h = container.clientHeight || 1;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h, false);
	}
	const ro = new ResizeObserver(resize);
	ro.observe(container);
	resize();

	// ── keep the shared bottom-right helper stack off the scrubber ──
	// public/corner-stack.js lifts itself over a page's own bottom chrome by
	// probing for position:fixed boxes. This bar is absolute inside the scene
	// root, so it is invisible to that probe and the "Getting started" pill
	// landed on the auto-play button. Reserve the bar's live footprint the way
	// the concierge demo does, and re-measure whenever the bar changes size.
	const CORNER_KEY = 'timeline-scrubber';
	function syncCornerReserve() {
		if (state.destroyed) return;
		const r = bottombar.getBoundingClientRect();
		container.style.setProperty('--tl-bar-h', `${Math.ceil(r.height)}px`);
		const stack = window.twsCornerStack;
		if (!stack?.reserve) return;
		if (!r.height) {
			stack.release(CORNER_KEY);
			return;
		}
		stack.reserve(CORNER_KEY, { height: Math.max(0, Math.ceil(window.innerHeight - r.top)) });
	}
	const barRo = new ResizeObserver(syncCornerReserve);
	barRo.observe(bottombar);
	window.addEventListener('tws-corner-stack:ready', syncCornerReserve);
	syncCornerReserve();

	// ── render loop ──
	const timer = new Timer();
	let raf = 0;
	function tick() {
		if (state.destroyed) return;
		timer.update();
		guideAnim?.update(timer.getDelta());

		if (state.mode === 'walk') {
			const t = currentWalkT();
			const p = curve.getPointAt(clamp01(t));
			const tangent = curve.getTangentAt(clamp01(t)).normalize();
			const behind = new Vector3().copy(tangent).multiplyScalar(-3.6);
			const camPos = new Vector3().copy(p).add(behind).add(new Vector3(0, 2.1, 0));
			camera.position.lerp(camPos, REDUCED_MOTION ? 1 : 0.18);
			const lookTarget = new Vector3().copy(p).add(new Vector3().copy(tangent).multiplyScalar(3));
			controls.target.lerp(lookTarget, REDUCED_MOTION ? 1 : 0.18);
			camera.lookAt(controls.target);
			placeGuideAt(t, t + 0.02);
		} else if (state.orbitFly) {
			const { fromTarget, toTarget, fromCam, toCam, start, duration } = state.orbitFly;
			const e = clamp01((performance.now() - start) / duration);
			const k = easeInOutCubic(e);
			controls.target.lerpVectors(fromTarget, toTarget, k);
			camera.position.lerpVectors(fromCam, toCam, k);
			if (e >= 1) state.orbitFly = null;
		}

		// Gentle pulse on the focused marker's beam so it reads as "selected."
		markers.forEach((m, i) => {
			if (i !== state.focusedIndex) return;
			if (!state.visibleCategories.has(m.event.category)) { m.beam.material.opacity = 0.06; return; }
			m.beam.material.opacity = REDUCED_MOTION ? 0.4 : 0.35 + Math.sin(performance.now() / 300) * 0.15;
		});

		// OrbitControls.update() re-derives camera.position from its own
		// internal spherical state even while `enabled` is false, which would
		// fight the manual position/lookAt we just set for Walk mode. Only
		// let it drive the camera in Orbit mode; it resyncs from wherever the
		// camera actually is the next time we call it, so no explicit resync
		// is needed when switching back.
		if (state.mode === 'orbit') controls.update();
		renderer.render(scene, camera);
		raf = requestAnimationFrame(tick);
	}
	raf = requestAnimationFrame(tick);

	// initial focus (no camera fly on load — let the establishing shot hold)
	focusEvent(0, { fly: false });
	setPanelOpen(false);
	refreshVisibility();

	// ── teardown ──
	function destroy() {
		state.destroyed = true;
		cancelAnimationFrame(raf);
		clearTimeout(state.playTimer);
		ro.disconnect();
		barRo.disconnect();
		window.removeEventListener('tws-corner-stack:ready', syncCornerReserve);
		window.twsCornerStack?.release?.(CORNER_KEY);
		canvas.removeEventListener('pointerdown', onPointerDown);
		window.removeEventListener('keydown', onKeydown);
		controls.dispose();
		renderer.dispose();
		scene.traverse((obj) => {
			if (obj.geometry) obj.geometry.dispose();
			if (obj.material) {
				const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
				mats.forEach((mat) => {
					if (mat.map) mat.map.dispose();
					mat.dispose();
				});
			}
		});
	}
	window.addEventListener('pagehide', destroy, { once: true });
}
