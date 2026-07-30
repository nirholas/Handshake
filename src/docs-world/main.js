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
import { log } from '../shared/log.js';

const $ = (id) => document.getElementById(id);

function showFallback(message) {
	const el = $('dw-fallback');
	if (message) $('dw-fallback-sub').textContent = message;
	el.hidden = false;
	$('dw-loading').hidden = true;
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
		showFallback('The docs manifest could not be loaded. The classic docs below always work.');
		return;
	}

	const reducedMotion =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	const canvas = $('dw-canvas');
	let world;
	try {
		world = createDocsWorld(canvas, sections, { reducedMotion });
	} catch {
		// createRenderer already mounted its own panel; ours routes to the docs.
		showFallback();
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
		cameraCtl.tick(dt);
		cameraCtl.apply(world.camera, player.position, player.height, controls.orbit, 0.35);
		updateNearest();
		updateJoystickVisual();
		world.renderer.render(world.scene, world.camera);
	}

	$('dw-loading').hidden = true;
	$('dw-hud').hidden = false;
	// Console/debug handle, same convention as window.__walkPlayground.
	window.__docsWorld = { world, player, overlays, controls };
	requestAnimationFrame((t) => {
		last = t;
		frame(t);
	});
}

boot().catch((err) => {
	log.error('[docs-world] boot failed', err);
	showFallback();
});
