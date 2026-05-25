/**
 * Hotspot Tour Widget — clickable points-of-interest layered over a 3D scene.
 *
 * Each hotspot is a `{ id, label, position: [x,y,z], body? }` from the widget
 * config. We render a numbered marker at the projected screen position of
 * every hotspot, update those positions per frame (so they track the camera),
 * and on click tween the camera toward the marker while a side panel reveals
 * the body text.
 *
 * Brand config (background, autoRotate, rotationSpeed, env) is applied by
 * app.js _applyWidgetConfig before this runs. We respect autoRotate but flip
 * it off while a hotspot is selected so the framing stays put.
 */

import { Vector3 } from 'three';

const POLL_INTERVAL_MS = 100;
const POLL_MAX_MS = 8000;
const FOCUS_DURATION_MS = 700;

/**
 * @param {import('../viewer.js').Viewer} viewer
 * @param {object} config  Hotspot-tour config (see widget-types.js).
 * @param {HTMLElement} container  Root container (usually document.body).
 * @param {{ onOpen?: (hotspot: object) => void }} [ctx]  Optional hooks; `onOpen`
 *   fires every time the visitor activates a marker (used by app.js to forward
 *   `widget:hotspot:open` to the host page).
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function mountHotspotTour(viewer, config, container, ctx) {
	const hotspots = Array.isArray(config.hotspots) ? config.hotspots : [];
	const onOpen = typeof ctx?.onOpen === 'function' ? ctx.onOpen : null;
	const state = {
		destroyed: false,
		layer: null,
		panel: null,
		markers: [],
		tickHook: null,
		resizeHandler: null,
		selectedId: null,
		autoRotateBefore: viewer?.controls?.autoRotate || false,
		_proj: new Vector3(),
	};

	await _waitForReady(viewer);
	if (state.destroyed) return _controller(state);

	_injectStyles();
	state.layer = _renderLayer(container);
	state.panel = _renderPanel(container, () => _clearSelection(viewer, state));

	for (const h of hotspots) {
		if (!h || !Array.isArray(h.position) || h.position.length !== 3) continue;
		const marker = _renderMarker(state.layer, h, state.markers.length + 1, () => {
			_select(viewer, state, h);
			onOpen?.(h);
		});
		state.markers.push({ data: h, el: marker, world: new Vector3(...h.position) });
	}

	_updatePositions(viewer, state);

	state.tickHook = () => {
		if (state.destroyed) return;
		_updatePositions(viewer, state);
	};
	if (!viewer._afterAnimateHooks) viewer._afterAnimateHooks = [];
	viewer._afterAnimateHooks.push(state.tickHook);

	state.resizeHandler = () => _updatePositions(viewer, state);
	window.addEventListener('resize', state.resizeHandler);

	return _controller(state, () => {
		state.destroyed = true;
		if (state.tickHook && viewer._afterAnimateHooks) {
			const idx = viewer._afterAnimateHooks.indexOf(state.tickHook);
			if (idx !== -1) viewer._afterAnimateHooks.splice(idx, 1);
		}
		if (state.resizeHandler) {
			window.removeEventListener('resize', state.resizeHandler);
		}
		state.layer?.remove();
		state.panel?.remove();
		if (viewer?.controls) viewer.controls.autoRotate = state.autoRotateBefore;
	});
}

// ─── helpers ──────────────────────────────────────────────────────────────

function _controller(state, destroyFn) {
	return {
		destroy:
			destroyFn ||
			(() => {
				state.destroyed = true;
			}),
	};
}

function _waitForReady(viewer) {
	return new Promise((resolve) => {
		const started = Date.now();
		const poll = () => {
			if (viewer?.content && viewer.defaultCamera && viewer.controls) return resolve();
			if (Date.now() - started > POLL_MAX_MS) return resolve();
			setTimeout(poll, POLL_INTERVAL_MS);
		};
		poll();
	});
}

function _renderLayer(container) {
	const el = document.createElement('div');
	el.className = 'hotspot-layer';
	container.appendChild(el);
	return el;
}

function _renderMarker(layer, hotspot, ordinal, onClick) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'hotspot-marker';
	btn.setAttribute('data-id', hotspot.id);
	btn.setAttribute('aria-label', hotspot.label);
	btn.title = hotspot.label;
	btn.innerHTML = `<span class="hotspot-marker-dot">${ordinal}</span><span class="hotspot-marker-label">${_escape(hotspot.label)}</span>`;
	btn.addEventListener('click', onClick);
	layer.appendChild(btn);
	return btn;
}

function _renderPanel(container, onClose) {
	const panel = document.createElement('aside');
	panel.className = 'hotspot-panel';
	panel.hidden = true;
	panel.innerHTML = `
		<button type="button" class="hotspot-panel-close" aria-label="Close">×</button>
		<h3 class="hotspot-panel-title"></h3>
		<p class="hotspot-panel-body"></p>
	`;
	panel.querySelector('.hotspot-panel-close').addEventListener('click', onClose);
	container.appendChild(panel);
	return panel;
}

function _select(viewer, state, hotspot) {
	state.selectedId = hotspot.id;

	if (viewer?.controls) viewer.controls.autoRotate = false;

	const target = new Vector3(...hotspot.position);
	const camPos = _focusPosition(viewer, target);
	if (typeof viewer._tweenCamera === 'function') {
		viewer._tweenCamera(camPos, target, FOCUS_DURATION_MS);
	} else if (viewer?.controls) {
		viewer.defaultCamera.position.copy(camPos);
		viewer.controls.target.copy(target);
		viewer.controls.update();
		viewer.invalidate?.();
	}

	state.panel.hidden = false;
	state.panel.querySelector('.hotspot-panel-title').textContent = hotspot.label;
	state.panel.querySelector('.hotspot-panel-body').textContent = hotspot.body || '';

	for (const m of state.markers) {
		m.el.classList.toggle('is-active', m.data.id === hotspot.id);
	}
}

function _clearSelection(viewer, state) {
	state.selectedId = null;
	state.panel.hidden = true;
	for (const m of state.markers) m.el.classList.remove('is-active');
	if (viewer?.controls) viewer.controls.autoRotate = state.autoRotateBefore;
}

// Pull the camera back along the line from the model centre through the
// hotspot, so the hotspot ends up roughly framed in the middle of the canvas.
function _focusPosition(viewer, hotspotPos) {
	const cam = viewer.defaultCamera;
	const center = viewer.controls?.target?.clone() || new Vector3();
	const dir = hotspotPos.clone().sub(center);
	const distFromCenter = Math.max(0.001, dir.length());
	dir.normalize();
	const camDist = cam.position.distanceTo(center);
	// Sit behind the hotspot at roughly the same orbit radius the user already had.
	return hotspotPos.clone().add(dir.multiplyScalar(Math.max(camDist - distFromCenter, 0.5)));
}

function _updatePositions(viewer, state) {
	if (!viewer?.defaultCamera || !viewer.renderer) return;
	const canvas = viewer.renderer.domElement;
	const rect = canvas.getBoundingClientRect();
	const cam = viewer.defaultCamera;

	for (const m of state.markers) {
		state._proj.copy(m.world).project(cam);
		const x = (state._proj.x * 0.5 + 0.5) * rect.width + rect.left;
		const y = (-state._proj.y * 0.5 + 0.5) * rect.height + rect.top;
		const inFront = state._proj.z < 1 && state._proj.z > -1;
		const inFrame =
			state._proj.x >= -1.05 &&
			state._proj.x <= 1.05 &&
			state._proj.y >= -1.05 &&
			state._proj.y <= 1.05;
		if (inFront && inFrame) {
			m.el.style.display = '';
			m.el.style.transform = `translate(${x}px, ${y}px)`;
		} else {
			m.el.style.display = 'none';
		}
	}
}

function _escape(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

let _stylesInjected = false;
function _injectStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.textContent = `
		.hotspot-layer {
			position: fixed;
			inset: 0;
			pointer-events: none;
			z-index: 4;
		}
		.hotspot-marker {
			position: absolute;
			top: 0;
			left: 0;
			transform: translate(-9999px, -9999px);
			margin: -22px 0 0 -22px;
			background: rgba(10, 10, 10, 0.7);
			color: #fff;
			border: 1px solid rgba(255, 255, 255, 0.18);
			border-radius: 999px;
			padding: 0 12px 0 0;
			font: 500 13px/1 Inter, system-ui, sans-serif;
			display: inline-flex;
			align-items: center;
			gap: 8px;
			cursor: pointer;
			pointer-events: auto;
			backdrop-filter: blur(8px);
			box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
			transition: background-color 120ms ease, transform 60ms linear;
			max-width: 220px;
			white-space: nowrap;
			overflow: hidden;
			min-height: 44px;
		}
		.hotspot-marker:hover,
		.hotspot-marker.is-active {
			background: rgba(139, 92, 246, 0.85);
			border-color: rgba(255, 255, 255, 0.4);
		}
		.hotspot-marker-dot {
			display: grid;
			place-items: center;
			width: 44px;
			height: 44px;
			border-radius: 999px;
			background: rgba(139, 92, 246, 0.9);
			color: #fff;
			font-weight: 600;
			font-size: 13px;
			flex: 0 0 auto;
		}
		.hotspot-marker.is-active .hotspot-marker-dot {
			background: #fff;
			color: #8b5cf6;
		}
		.hotspot-marker-label {
			text-overflow: ellipsis;
			overflow: hidden;
		}
		.hotspot-panel {
			position: fixed;
			right: 16px;
			top: 16px;
			width: 280px;
			max-height: calc(100dvh - 32px);
			background: rgba(10, 10, 10, 0.88);
			color: #e0e0e0;
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 12px;
			padding: 16px 18px 18px;
			z-index: 6;
			font: 14px/1.5 Inter, system-ui, sans-serif;
			backdrop-filter: blur(12px);
			box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
		}
		.hotspot-panel[hidden] { display: none; }
		.hotspot-panel-close {
			position: absolute;
			top: 0;
			right: 0;
			width: 44px;
			height: 44px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: transparent;
			border: 0;
			color: rgba(255, 255, 255, 0.6);
			font-size: 22px;
			line-height: 1;
			cursor: pointer;
			border-radius: 0 12px 0 8px;
		}
		.hotspot-panel-close:hover { color: #fff; background: rgba(255,255,255,0.06); }
		.hotspot-panel-title {
			margin: 0 44px 8px 0;
			font-size: 15px;
			font-weight: 600;
			color: #fff;
		}
		.hotspot-panel-body {
			margin: 0;
			color: rgba(255, 255, 255, 0.78);
			white-space: pre-wrap;
		}
		@media (max-width: 520px) {
			.hotspot-panel {
				right: 8px;
				left: 8px;
				top: auto;
				bottom: max(8px, env(safe-area-inset-bottom, 8px));
				width: auto;
				max-height: 40dvh;
				overflow-y: auto;
				padding-bottom: max(18px, env(safe-area-inset-bottom, 18px));
			}
			.hotspot-marker { max-width: 160px; }
		}
	`;
	document.head.appendChild(style);
}
