// Docs World entry: /docs/world
//
// The three.ws documentation as a walkable place. Boots the scene (world.js),
// the avatar (player.js), input (controls.js) and the DOM overlays
// (reader.js), then runs a governed frame loop. The content itself never
// forks: the world reads /docs/nav.json and /docs/<slug>.md, the exact files
// the classic docs SPA renders, so both surfaces are always in sync.
//
// Device behaviour:
//   - No WebGL: a designed fallback panel routes to the classic docs.
//   - Touch: virtual joystick + drag look + tap to open pavilions.
//   - prefers-reduced-motion: ambient animation is stilled.
//   - Unfocused tab / power saver / open reader: frame cap drops to 30fps.

import { Raycaster, Vector2 } from 'three';
import { isWebGLAvailable } from '../webgl-support.js';
import {
	createFrameGovernor,
	trackWindowFocus,
	getPowerSaver,
	onPowerSaverChange,
	FPS_ACTIVE,
	FPS_IDLE,
} from '../shared/frame-governor.js';
import { createCameraModeController, CAMERA_MODE_LABELS } from '../game/camera-modes.js';
import { createDocsWorld, PAVILION_TRIGGER } from './world.js';
import { createPlayer, requestedAvatarUrl } from './player.js';
import { createControls } from './controls.js';
import { createOverlays } from './reader.js';
import { createWayfinder } from './wayfinder.js';
import { createSearch, rememberRecent } from './search.js';
import { initTooltips } from '../shared/tooltip.js';
import { startTour, isTourDone } from '../shared/tour.js';
import { log } from '../shared/log.js';

const $ = (id) => document.getElementById(id);

/**
 * Show the designed no-world state.
 *
 * @param {{ title?: string, message?: string, retry?: boolean }} [opts]
 *   `retry` marks the failure recoverable (a dropped manifest fetch, an offline
 *   moment) and reveals a reload button. A device with no WebGL gets no retry:
 *   reloading cannot grow it a GPU, and a button that reproduces the same dead
 *   end is worse than none.
 */
function showFallback({ title, message, retry = false } = {}) {
	if (title) $('dw-fallback-title').textContent = title;
	if (message) $('dw-fallback-sub').textContent = message;
	const retryBtn = $('dw-fallback-retry');
	retryBtn.hidden = !retry;
	// Reveal BEFORE focusing: a still-hidden element cannot take focus, so the
	// keyboard would have been left on <body> with the recovery action unreachable
	// without tabbing for it.
	$('dw-fallback').hidden = false;
	$('dw-loading').hidden = true;
	if (retry) {
		retryBtn.onclick = () => location.reload();
		retryBtn.focus({ preventScroll: true });
	}
}

async function boot() {
	if (!isWebGLAvailable()) {
		showFallback();
		return;
	}

	let sections;
	try {
		const res = await fetch('/docs/nav.json');
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const nav = await res.json();
		sections = Array.isArray(nav.sections) ? nav.sections : [];
		if (!sections.length) throw new Error('empty manifest');
	} catch (err) {
		log.warn('[docs-world] nav manifest failed', err?.message);
		showFallback({
			title: 'The world could not load its map',
			message:
				'The docs index (/docs/nav.json) did not arrive, so there are no pavilions to build. This is usually a dropped connection: try again, or read the same pages in the classic docs.',
			retry: true,
		});
		return;
	}

	const reducedMotion =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	const canvas = $('dw-canvas');
	let world;
	try {
		world = createDocsWorld(canvas, sections, { reducedMotion });
	} catch {
		// createRenderer already mounted its own panel; ours covers the screen and
		// routes onward. Retry is offered because the most common cause here is not
		// a GPU-less device (isWebGLAvailable already cleared that above) but an
		// exhausted per-tab context budget, which a reload genuinely clears.
		showFallback({
			title: 'The 3D view could not start',
			message:
				'The browser refused a graphics context, usually because too many 3D views are open at once. Reloading normally fixes it; the classic docs need no 3D at all.',
			retry: true,
		});
		return;
	}

	const player = createPlayer(world.scene, world.renderer, {
		avatarUrl: requestedAvatarUrl(),
	});

	const overlays = createOverlays({
		sections,
		onNavigateDoc(path) {
			// Shareable URLs: /docs/world#<slug> reopens the same doc. replaceState
			// keeps Back as "leave the world", not a crawl through every doc read.
			const url = path ? '#' + path : location.pathname + location.search;
			history.replaceState(null, '', url);
			// Every page the visitor actually opened seeds the palette's no-query
			// state, so the second visit starts from where the first one left off.
			if (path) rememberRecent(path);
		},
	});

	const cameraBtn = $('dw-camera-btn');
	const cameraCtl = createCameraModeController({
		storageKey: 'docs-world-camera',
		onChange(mode) {
			cameraBtn.textContent = CAMERA_MODE_LABELS[mode];
			player.setVisible(mode !== 'firstperson');
		},
	});
	cameraBtn.textContent = CAMERA_MODE_LABELS[cameraCtl.mode];
	player.setVisible(!cameraCtl.isFirstPerson());

	let nearest = null;

	const controls = createControls(canvas, {
		onTap(e) {
			const rect = canvas.getBoundingClientRect();
			pointerNdc.set(
				((e.clientX - rect.left) / rect.width) * 2 - 1,
				-((e.clientY - rect.top) / rect.height) * 2 + 1,
			);
			raycaster.setFromCamera(pointerNdc, world.camera);
			for (const hit of raycaster.intersectObjects(
				world.pavilions.map((p) => p.group),
				true,
			)) {
				let node = hit.object;
				while (node && !node.userData.pavilionIndex && node.userData.pavilionIndex !== 0) {
					node = node.parent;
				}
				if (node) {
					overlays.openSection(node.userData.pavilionIndex);
					return;
				}
			}
		},
		onInteract() {
			if (overlays.isOpen) return;
			if (nearest) overlays.openSection(nearest.index);
		},
		onCycleCamera() {
			cameraCtl.cycle(world.camera);
		},
	});
	cameraBtn.addEventListener('click', () => cameraCtl.cycle(world.camera));

	const raycaster = new Raycaster();
	const pointerNdc = new Vector2();
	world.pavilions.forEach((p, i) => {
		p.group.userData.pavilionIndex = i;
	});

	// ── Index overlay: every section, keyboard-reachable, teleports the player ──
	const indexEl = $('dw-index');
	const indexList = $('dw-index-list');
	sections.forEach((s, i) => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'dw-index-item';
		const pages = s.links.filter((l) => l.path).length;
		btn.innerHTML =
			'<span class="dw-index-dot" style="background:#' +
			world.pavilions[i].color.getHexString() +
			'"></span><span>' +
			s.title +
			'</span><span class="dw-index-count">' +
			pages +
			'</span>';
		btn.addEventListener('click', () => {
			indexEl.hidden = true;
			player.teleportToPavilion(world.pavilions[i]);
			controls.orbit.yaw = -world.pavilions[i].angle + Math.PI / 2;
			overlays.openSection(i);
		});
		indexList.appendChild(btn);
	});
	$('dw-index-btn').addEventListener('click', () => {
		indexEl.hidden = !indexEl.hidden;
	});
	$('dw-index-close').addEventListener('click', () => {
		indexEl.hidden = true;
	});

	$('dw-help-btn').addEventListener('click', () => {
		$('dw-help').hidden = !$('dw-help').hidden;
	});
	$('dw-help-close').addEventListener('click', () => {
		$('dw-help').hidden = true;
	});

	// ── Wayfinder: route the walker to a page, and open it on arrival ──────────
	const wayfinder = createWayfinder(world.scene, world.pavilions, { reducedMotion });
	const wayEl = $('dw-way');
	const wayDot = $('dw-way-dot');
	const wayLabel = $('dw-way-label');
	const waySub = $('dw-way-sub');

	function startRoute(page) {
		const pavilion = world.pavilions[page.sectionIndex];
		if (!pavilion) return;
		wayfinder.routeTo(pavilion, page, player.position);
		// Turn the camera toward the destination so the trail is in frame from the
		// first step. Without this the visitor is told to walk somewhere behind them.
		controls.orbit.yaw = Math.atan2(
			pavilion.group.position.x - player.position.x,
			pavilion.group.position.z - player.position.z,
		);
		wayDot.style.color = '#' + pavilion.color.getHexString();
		wayDot.style.background = '#' + pavilion.color.getHexString();
		wayLabel.textContent = page.label;
		waySub.textContent = 'Follow the trail';
		wayEl.hidden = false;
	}

	function stopRoute() {
		wayfinder.clear();
		wayEl.hidden = true;
	}

	$('dw-way-cancel').addEventListener('click', stopRoute);
	$('dw-way-read').addEventListener('click', () => {
		const page = wayfinder.target;
		stopRoute();
		if (page) overlays.openDoc(page.path);
	});

	// ── Search palette ─────────────────────────────────────────────────────────
	const search = createSearch({
		sections,
		onRead(page) {
			// Stand the avatar where the page lives before opening it, so closing the
			// reader leaves the visitor at the right pavilion rather than wherever
			// they happened to be when they searched.
			stopRoute();
			const pavilion = world.pavilions[page.sectionIndex];
			if (pavilion) {
				player.teleportToPavilion(pavilion);
				controls.orbit.yaw = -pavilion.angle + Math.PI / 2;
			}
			overlays.openDoc(page.path);
		},
		onWalk(page) {
			overlays.closeReader();
			overlays.closeSection();
			startRoute(page);
		},
	});
	$('dw-search-btn').addEventListener('click', () => search.open());

	addEventListener('keydown', (e) => {
		if (search.isOpen) return; // the palette owns its own keys while open
		const t = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
		const cmdK = e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey);
		if (!slash && !cmdK) return;
		e.preventDefault();
		search.open();
	});

	// ── First-run welcome tour ─────────────────────────────────────────────────
	const TOUR_ID = 'docs-world-welcome';
	const tourSteps = [
		{
			target: '#dw-search-btn',
			title: 'Search ' + search.size + ' pages',
			body: 'Walk with WASD or the joystick, or skip the walk entirely. Press / to search every page. Enter reads it; Shift+Enter has the world walk you there.',
		},
		{
			target: '#dw-index-btn',
			title: 'Or browse by section',
			body: 'Each of the ' + sections.length + ' pavilions on the ring is one docs section. The index jumps you straight to any of them.',
		},
		{
			target: '#dw-camera-btn',
			title: 'Pick your view',
			body: 'Cycle between follow, cinematic, first person and top down. Top down is the fastest way to see the whole ring at once.',
		},
		{
			target: '#dw-back',
			title: 'Same docs, no 3D',
			body: 'Every page here is the same file the classic docs render. Leave whenever you like; nothing is exclusive to the world.',
		},
	];
	$('dw-tour-replay').addEventListener('click', () => {
		$('dw-help').hidden = true;
		// Deliberately id-less. The engine short-circuits a tour whose id is already
		// done, and "done" also lives in the server-synced prefs cache, so clearing
		// the localStorage key would not reliably re-arm it. An explicit replay does
		// not need to be remembered either way.
		startTour(tourSteps);
	});

	// ── Deep link: /docs/world#<slug> opens that doc at its pavilion ───────────
	function openFromHash() {
		const slug = decodeURIComponent(location.hash.slice(1).replace(/^\//, ''));
		if (!slug) return;
		// An unknown slug (a stale link, a typo, a hash meant for another page)
		// used to open the reader on a doc that does not exist, so entering the
		// world greeted the visitor with a load error over the scene. Ignore it
		// instead and leave them standing in the world, which is the thing they
		// asked for either way.
		if (!overlays.hasPath(slug)) return;
		const si = overlays.sectionIndexForPath(slug);
		if (si >= 0) {
			player.teleportToPavilion(world.pavilions[si]);
			controls.orbit.yaw = -world.pavilions[si].angle + Math.PI / 2;
		}
		overlays.openDoc(slug);
	}
	openFromHash();
	addEventListener('hashchange', openFromHash);

	// ── Proximity prompt ───────────────────────────────────────────────────────
	const prompt = $('dw-prompt');
	const promptLabel = $('dw-prompt-label');
	prompt.addEventListener('click', () => {
		if (nearest) overlays.openSection(nearest.index);
	});

	function updateNearest() {
		nearest = null;
		let best = PAVILION_TRIGGER;
		for (const p of world.pavilions) {
			const d = Math.hypot(
				player.position.x - p.group.position.x,
				player.position.z - p.group.position.z,
			);
			if (d < best) {
				best = d;
				nearest = p;
			}
		}
		const show = !!nearest && !overlays.isOpen;
		prompt.hidden = !show;
		if (show) promptLabel.textContent = nearest.section.title;
	}

	// ── Touch joystick visual ──────────────────────────────────────────────────
	const joyEl = $('dw-joystick');
	const joyThumb = $('dw-joystick-thumb');
	function updateJoystickVisual() {
		const j = controls.joystick;
		joyEl.hidden = !j.active;
		if (j.active) {
			joyEl.style.left = j.baseX + 'px';
			joyEl.style.top = j.baseY + 'px';
			joyThumb.style.transform = 'translate(' + j.x * 34 + 'px,' + j.y * 34 + 'px)';
		}
	}

	// Distance is reported in whole metres, which is both honest (the world is
	// metric: the avatar is 1.7 units tall) and stable enough not to flicker.
	function updateWayfinder(dt) {
		const state = wayfinder.update(dt, player.position);
		if (!state.active) return;
		if (state.arrived) {
			const page = state.page;
			stopRoute();
			overlays.openDoc(page.path);
			return;
		}
		waySub.textContent = Math.round(state.distance) + 'm · ' + state.section;
	}

	// ── Frame loop ─────────────────────────────────────────────────────────────
	const governor = createFrameGovernor();
	const focus = trackWindowFocus();
	let saver = getPowerSaver();
	onPowerSaverChange((on) => {
		saver = on;
	});

	addEventListener('resize', world.resize);

	let last = performance.now();
	function frame(now) {
		requestAnimationFrame(frame);
		const cap = saver || !focus.focused || overlays.isOpen ? FPS_IDLE : FPS_ACTIVE;
		if (!governor.shouldRun(now, cap)) return;
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;

		player.update(dt, controls.readMove(), controls.orbit.yaw, controls.run, world.pavilions);
		world.tick(dt);
		updateWayfinder(dt);
		cameraCtl.tick(dt);
		cameraCtl.apply(world.camera, player.position, player.height, controls.orbit, 0.35);
		updateNearest();
		updateJoystickVisual();
		world.renderer.render(world.scene, world.camera);
	}

	$('dw-loading').hidden = true;
	$('dw-hud').hidden = false;
	initTooltips();
	// First visit only. Deliberately after the HUD is revealed: the tour spotlights
	// real controls, and spotlighting a hidden element would frame empty screen.
	if (!isTourDone(TOUR_ID)) startTour(tourSteps, { id: TOUR_ID });
	// Console/debug handle, same convention as window.__walkPlayground.
	window.__docsWorld = { world, player, overlays, controls, search, wayfinder };
	requestAnimationFrame((t) => {
		last = t;
		frame(t);
	});
}

boot().catch((err) => {
	log.error('[docs-world] boot failed', err);
	showFallback({
		title: 'The world stopped before it opened',
		message:
			'Something failed while building the scene. Reloading often clears it, and the classic docs carry every page this world shows.',
		retry: true,
	});
});
