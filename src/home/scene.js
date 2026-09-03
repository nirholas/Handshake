/**
 * /home/:id, the live 3D home.
 *
 * The page owns state, not geometry. It holds one SSE subscription to the
 * house, turns every event into a scene model, hands that to whichever renderer
 * this device can run, and renders the ten states a real house actually reaches
 * (loading, empty, unfiled, live, stale, disconnected, acting, awaiting a human
 * yes, no WebGL, broken) as designed screens rather than as a spinner and a
 * stack trace.
 *
 * The one rule that outranks everything else here: the house never empties. A
 * dropped socket greys the scene and shows its age. It does not clear it.
 */

import { HomeApiError, callService, getHome, getLayout, grantEntity, openStream } from './api.js';
import { buildSceneModel } from './scene-model.js';
import { createHomeFallback, webglAvailable } from './scene-fallback.js';

const VIEW_KEY = 'three:home:view';
/** A device that cannot hold this for a few seconds is sent to the 2D house. */
const MIN_FPS = 18;
const FPS_GRACE_MS = 6000;

const el = {
	shell: document.getElementById('hs-shell'),
	title: document.getElementById('hs-title'),
	status: document.getElementById('hs-status'),
	rooms: document.getElementById('hs-rooms'),
	stage: document.getElementById('hs-stage'),
	panel: document.getElementById('hs-panel'),
	panelEmpty: document.getElementById('hs-panel-empty'),
	inspector: document.getElementById('hs-inspector'),
	live: document.getElementById('hs-live'),
	view3d: document.getElementById('hs-view-3d'),
	view2d: document.getElementById('hs-view-2d'),
	viewPlan: document.getElementById('hs-view-plan'),
	plan: document.getElementById('hs-plan'),
	reconnect: document.getElementById('hs-reconnect'),
};

const state = {
	homeId: homeIdFromPath(),
	home: null,
	graph: null,
	model: null,
	/**
	 * The authored floorplan's room map, or null when nobody drew one. Null is
	 * the ordinary state: the scene packs rooms into a default grid without it.
	 */
	layout: null,
	layoutVersion: 0,
	/** The mounted floorplan editor, when the plan view is showing. */
	plan: null,
	view: preferredView(),
	renderer: null,
	stream: null,
	status: 'connecting',
	stale: false,
	lastGraphAt: 0,
	selected: null,
	pending: null,
	busy: new Set(),
	log: [],
	// Latency instrumentation: the wall time from an SSE frame landing to the
	// first painted frame that carries it. Reported on window for the
	// measurement pass and for the e2e spec.
	latency: { last: null, samples: [] },
	overlay: null,
	fpsSince: 0,
	// True once a person picked a view, by clicking the toggle or by asking for
	// one in the URL. An explicit choice is never overridden by the frame-rate
	// watchdog: measuring a slow device is a reason to offer the flat house, not
	// a reason to overrule someone who asked for the 3D one.
	viewChosen: new URLSearchParams(location.search).has('view'),
};

window.__homeScene = {
	get model() {
		return state.model;
	},
	get latency() {
		return state.latency;
	},
	get status() {
		return { status: state.status, stale: state.stale, view: state.view };
	},
	stats() {
		return state.renderer?.stats?.() || null;
	},
};

boot();

async function boot() {
	if (!state.homeId) {
		showOverlay({
			title: 'No home in that link',
			body: 'A home scene needs a home id, as in /home/<id>. Open one from your list of connected homes.',
			actions: [{ label: 'Your homes', href: '/home', primary: true }],
		});
		return;
	}
	el.view3d.addEventListener('click', () => {
		state.viewChosen = true;
		setView('3d', { remember: true });
	});
	el.view2d.addEventListener('click', () => {
		state.viewChosen = true;
		setView('2d', { remember: true });
	});
	el.viewPlan?.addEventListener('click', () => {
		state.viewChosen = true;
		setView('plan', { remember: true });
	});
	el.reconnect.addEventListener('click', () => reconnect());
	document.addEventListener('keydown', onKeydown);
	holdScreenAwake();

	await load();
}

/**
 * The decision, and why it is this one.
 *
 * The live house is the only surface in the lane a screen is meant to sit on:
 * a kitchen tablet on a shelf showing which lights are on. A wall display that
 * blanks every thirty seconds is not a display, and the user cannot fix it
 * without turning off the device's screen timeout for everything else it does.
 * So this page, and only this page, asks for a screen wake lock.
 *
 * The other half matters more. A phone must never be held awake by a tab it is
 * not looking at, so the lock is dropped the moment the document is hidden and
 * only re-taken when it comes back visible. That is also what the platform
 * requires: a wake lock is released automatically on hide, and re-acquiring is
 * the only way back, so the visibility handler is the feature, not a guard
 * around it.
 *
 * Everything here is best-effort. Screen Wake Lock is absent on some browsers
 * and the request is refused outright on a low battery, both of which are the
 * device making a correct decision. The scene is unaffected either way, so a
 * failure is never surfaced to the user.
 */
function holdScreenAwake() {
	if (!('wakeLock' in navigator)) return;
	let sentinel = null;

	const acquire = async () => {
		if (sentinel || document.visibilityState !== 'visible') return;
		try {
			sentinel = await navigator.wakeLock.request('screen');
			sentinel.addEventListener('release', () => {
				sentinel = null;
			});
		} catch {
			sentinel = null;
		}
	};

	const release = () => {
		sentinel?.release?.().catch(() => {});
		sentinel = null;
	};

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') acquire();
		else release();
	});
	window.addEventListener('pagehide', release);
	acquire();
}

async function load() {
	setStatus('connecting', 'Connecting');
	try {
		const payload = await getHome(state.homeId);
		state.home = payload.home || null;
		el.title.textContent = state.home?.label || 'Your home';
		document.title = `${state.home?.label || 'Your home'} · three.ws`;
		mountRenderer();
		// The authored floorplan, if anyone drew one. Best effort on purpose: a
		// layout that cannot be read must never stop the house from rendering,
		// because the default grid is a complete experience on its own.
		loadLayout();
		if (payload.graph) {
			applyGraph(payload.graph, { stale: Boolean(payload.stale) });
			setStatusFromServer({ status: payload.live_status, stale: payload.stale, detail: payload.error?.message });
		} else if (payload.error) {
			// A 200 carrying a coded failure: the connection record exists, the house
			// did not answer. That is a designed screen, not an exception.
			renderFailure(new HomeApiError(payload.error.code, payload.error.message));
			return;
		}
		subscribe();
	} catch (err) {
		renderFailure(err);
	}
}

// ── the stream ───────────────────────────────────────────────────────────────

function subscribe() {
	state.stream?.close();
	state.stream = openStream(state.homeId, {
		onOpen() {
			setStatus('live', 'Live');
		},
		onGraph(payload) {
			const receivedAt = performance.now();
			applyGraph(payload.graph, { stale: Boolean(payload.stale), receivedAt });
			if (payload.stale) setStatusFromServer(payload);
		},
		onStatus(payload) {
			setStatusFromServer(payload);
		},
		onSilence() {
			// A stream that stopped delivering without closing. Treat it as a
			// disconnect rather than as a very quiet house.
			setStatusFromServer({ status: 'disconnected', stale: true, detail: 'The live stream went quiet.' });
		},
	});
}

function reconnect() {
	el.reconnect.disabled = true;
	setStatus('connecting', 'Connecting');
	load().finally(() => {
		el.reconnect.disabled = false;
	});
}

/**
 * Turn what the server said into one of the four things the top bar can say.
 *
 * The distinction that matters: a house that dropped while the platform is
 * still retrying is STALE, not disconnected. The data is old and the system is
 * working on it, and there is nothing for the person to do but read the age.
 * Disconnected is reserved for the cases where nobody is retrying: the token
 * stopped working, or this browser's own stream is gone. That is the state that
 * offers a button, because that is the state where pressing one helps.
 */
function setStatusFromServer(payload) {
	const status = payload.status || 'live';
	state.stale = Boolean(payload.stale);
	const detail = payload.detail || payload.statusDetail;
	if (status === 'auth_failed' || status === 'revoked' || status === 'disconnected') {
		setStatus('disconnected', status === 'auth_failed' ? 'Sign in again' : 'Disconnected', detail);
	} else if (status === 'unreachable' || state.stale || status === 'reconnecting' || status === 'pending' || status === 'connecting') {
		setStatus('stale', status === 'reconnecting' ? 'Reconnecting' : 'Stale', detail);
	} else {
		setStatus('live', 'Live');
	}
}

function setStatus(kind, label, detail) {
	state.status = kind;
	el.status.dataset.status = kind;
	el.status.textContent = label;
	el.status.title = detail || '';
	// Offered whenever the house is not live: on a terminal disconnect it is the
	// only way back, and on a long stale it is a person deciding not to wait.
	el.reconnect.hidden = kind === 'live' || kind === 'connecting';
	const stale = kind === 'stale' || kind === 'disconnected';
	state.stale = stale;
	state.renderer?.setStale?.(stale);
	el.stage.classList.toggle('is-stale', stale);
	renderAge();
	if (kind === 'disconnected') {
		announce(detail || 'The connection to your home dropped. The house below is the last state we saw.');
	}
}

/**
 * Read the authored floorplan and re-lay the scene with it.
 *
 * Deliberately not awaited by load(): the house paints on the default grid
 * immediately and slides into the authored plan when it arrives, which is a
 * better first frame than a blank canvas waiting on a second request. A failure
 * leaves state.layout null, which is exactly the no-layout case the model
 * already handles.
 */
async function loadLayout() {
	try {
		const res = await getLayout(state.homeId);
		state.layout = res?.layout?.rooms || null;
		state.layoutVersion = res?.version || 0;
		if (state.graph) applyGraph(state.graph, { stale: state.stale });
	} catch {
		state.layout = null;
	}
}

// ── the model ────────────────────────────────────────────────────────────────

function applyGraph(graph, { stale = false, receivedAt = 0 } = {}) {
	if (!graph) return;
	state.graph = graph;
	state.lastGraphAt = Date.now();
	state.stale = stale;
	const model = buildSceneModel(graph, { focusRoomId: state.model?.focusRoomId, layout: state.layout });
	state.model = model;
	renderRooms(model);
	renderInspector();
	// The designed nothings are the page's, not the renderer's. Gating them on a
	// mounted renderer meant an empty house painted nothing at all while the 3D
	// module was still being imported, which is the exact case the empty state
	// exists for.
	renderEmptyStates(model);
	renderAge();
	if (receivedAt) measureLatency(receivedAt);
	if (!state.renderer) return;
	state.renderer.setModel(model);
	state.renderer.setStale?.(stale);
	repositionConfirm();
}

/**
 * How long a real device change takes to reach the screen: the SSE frame lands,
 * the next painted frame carries it, and the difference is the number this
 * order has to report. Measured, not estimated.
 */
function measureLatency(receivedAt) {
	requestAnimationFrame(() => {
		const ms = Math.round(performance.now() - receivedAt);
		state.latency.last = ms;
		state.latency.samples.push(ms);
		// A ten-minute wall display must not grow an array forever.
		if (state.latency.samples.length > 200) state.latency.samples.splice(0, 100);
	});
}

// ── renderers ────────────────────────────────────────────────────────────────

function mountRenderer() {
	const want = state.view === '2d' || !webglAvailable() ? '2d' : '3d';
	if (want === '2d' && state.view !== '2d') {
		// Not a preference: this device genuinely cannot run WebGL, and it is
		// told so rather than being shown a blank canvas.
		announce('This browser cannot run WebGL, so your home is shown as a floor list you can still read and control.');
		state.view = '2d';
	}
	setView(state.view, { remember: false, force: true });
}

function setView(view, { remember = true, force = false } = {}) {
	if (view === '3d' && !webglAvailable()) {
		announce('WebGL is unavailable in this browser, so the 2D house stays on.');
		view = '2d';
	}
	if (!force && view === state.view && state.renderer) return;
	state.view = view;
	if (remember) {
		try {
			localStorage.setItem(VIEW_KEY, view);
		} catch {
			// A private window keeps the choice for this visit only.
		}
	}
	el.view3d.setAttribute('aria-pressed', String(view === '3d'));
	el.view2d.setAttribute('aria-pressed', String(view === '2d'));
	el.viewPlan?.setAttribute('aria-pressed', String(view === 'plan'));
	el.view3d.disabled = !webglAvailable();
	if (el.view3d.disabled) el.view3d.title = 'This browser cannot run WebGL.';

	state.renderer?.dispose();
	state.renderer = null;
	clearStage();
	el.stage.classList.toggle('is-flat', view === '2d');

	// The plan is a workspace, not a renderer: it replaces the stage rather than
	// drawing into it, and it keeps no live subscription of its own.
	state.plan?.destroy();
	state.plan = null;
	if (el.plan) el.plan.hidden = view !== 'plan';
	el.stage.hidden = view === 'plan';
	if (view === 'plan') {
		mountPlan();
		renderAge();
		return;
	}

	if (view === '2d') {
		state.renderer = createHomeFallback(el.stage, { onAct: act, onFocusRoom: focusRoom });
		state.fpsSince = 0;
	} else {
		mount3d();
	}
	if (state.model) {
		state.renderer.setModel(state.model);
		state.renderer.setStale?.(state.stale);
		renderEmptyStates(state.model);
	}
	renderAge();
}

/**
 * The floorplan workspace.
 *
 * Loaded on demand: nobody who only wants to see their house should pay for the
 * editor. Its saves feed straight back into the model, so the 3D view is already
 * arranged when they switch back to it.
 */
async function mountPlan() {
	if (!el.plan) return;
	el.plan.textContent = '';
	const { mountFloorplan } = await import('./floorplan.js');
	if (state.view !== 'plan') return;
	state.plan = mountFloorplan({
		mount: el.plan,
		homeId: state.homeId,
		graph: state.graph,
		// The layout capability. A guest sees the plan and cannot redraw somebody
		// else's home; the server enforces it either way, this only hides controls
		// that would fail.
		canEdit: state.home?.capabilities?.layout !== false,
		onChange(doc, opts) {
			state.layout = doc?.rooms || null;
			if (state.graph) applyGraph(state.graph, { stale: state.stale });
			// Filing a device changed Home Assistant's own registry, so the room
			// graph is stale in a way no state event will correct.
			if (opts?.refreshGraph) refreshGraph();
		},
	});
	el.plan.focus?.();
}

/** Re-read the house after we changed its registry rather than its state. */
async function refreshGraph() {
	try {
		const payload = await getHome(state.homeId);
		if (payload?.graph) applyGraph(payload.graph, { stale: Boolean(payload.stale) });
	} catch {
		// The plan is still correct locally; the graph refreshes on the next event.
	}
}

async function mount3d() {
	// The renderer pulls Three.js, the avatar loader and the clip library. A
	// device that will never show it (or a visitor who prefers the flat house)
	// must not pay for the bytes, so it is imported here and not at module load.
	try {
		const { createHomeScene } = await import('./scene-render.js');
		if (state.view !== '3d') return;
		state.renderer = createHomeScene(el.stage, {
			onSelect: (entityId, object) => {
				state.selected = entityId ? { entityId, object } : null;
				renderInspector();
			},
			onFocusRoom: focusRoom,
			onFirstFrame: () => {
				state.fpsSince = performance.now();
				startFpsWatch();
			},
		});
		if (state.model) {
			state.renderer.setModel(state.model);
			state.renderer.setStale?.(state.stale);
			renderEmptyStates(state.model);
		}
	} catch (err) {
		announce('The 3D house could not start, so the 2D house is on instead.');
		console.warn('[home] 3D renderer failed to start', err);
		setView('2d', { remember: false, force: true });
	}
}

/**
 * If this device measurably cannot hold a usable frame rate, move it to the 2D
 * house and say so. Measure, then route: never assume a class of device is too
 * slow, and never leave someone watching a slideshow of their own kitchen.
 */
function startFpsWatch() {
	const started = performance.now();
	const timer = setInterval(() => {
		if (state.view !== '3d' || !state.renderer) return clearInterval(timer);
		const stats = state.renderer.stats?.();
		if (!stats || !stats.fps) return;
		if (performance.now() - started < FPS_GRACE_MS) return;
		clearInterval(timer);
		if (stats.fps >= MIN_FPS) return;
		if (state.viewChosen) {
			// They asked for this view. Say what the device is doing and leave it on.
			announce(`This device is holding ${stats.fps} frames a second in the 3D house. The 2D button is faster if it feels heavy.`);
			return;
		}
		announce(`This device held only ${stats.fps} frames a second, so your home switched to the 2D view. The 3D button turns it back on.`);
		setView('2d', { remember: false, force: true });
	}, 1000);
}

function clearStage() {
	for (const node of [...el.stage.children]) {
		if (node.classList?.contains('hs-overlay') || node.classList?.contains('hs-confirm') || node.classList?.contains('hs-age')) continue;
		node.remove();
	}
}

// ── the room rail ────────────────────────────────────────────────────────────

function renderRooms(model) {
	el.rooms.classList.remove('hs-skeleton');
	el.rooms.removeAttribute('aria-busy');
	el.rooms.innerHTML = '';
	if (!model.rooms.length) {
		const note = document.createElement('p');
		note.className = 'hs-panel-empty';
		note.textContent = 'No rooms yet.';
		el.rooms.appendChild(note);
		return;
	}
	for (const floor of model.floors) {
		const section = document.createElement('section');
		section.className = 'hs-floor';
		if (model.floors.length > 1) {
			const name = document.createElement('p');
			name.className = 'hs-floor-name';
			name.textContent = floor.name;
			section.appendChild(name);
		}
		const list = document.createElement('ul');
		list.className = 'hs-room-list';
		for (const roomId of floor.roomIds) {
			const room = model.rooms.find((r) => r.id === roomId);
			if (!room) continue;
			const item = document.createElement('li');
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'hs-room';
			button.setAttribute('aria-current', String(room.id === model.focusRoomId));
			button.dataset.roomId = room.id;

			const dot = document.createElement('span');
			dot.className = 'hs-room-dot';
			dot.style.setProperty('--room-dot', room.light.on ? room.light.hex : 'rgba(255,255,255,0.14)');
			dot.style.setProperty('--room-halo', room.light.on ? `${Math.round(3 + room.light.brightness * 7)}px` : '0px');
			button.appendChild(dot);

			const name = document.createElement('span');
			name.className = 'hs-room-name';
			name.textContent = room.name;
			button.appendChild(name);

			const meta = document.createElement('span');
			meta.className = 'hs-room-meta';
			if (room.security && !room.security.secure) {
				meta.classList.add('hs-room-alert');
				meta.textContent = 'open';
			} else if (room.climate) {
				meta.textContent = room.climate.label;
			} else {
				meta.textContent = `${room.entityCount}`;
			}
			button.appendChild(meta);

			button.addEventListener('click', () => focusRoom(room.id));
			item.appendChild(button);
			list.appendChild(item);
		}
		section.appendChild(list);
		el.rooms.appendChild(section);
	}
}

function focusRoom(roomId) {
	if (!state.model) return;
	state.model = { ...state.model, focusRoomId: roomId };
	state.renderer?.focusRoom?.(roomId);
	for (const button of el.rooms.querySelectorAll('.hs-room')) {
		button.setAttribute('aria-current', String(button.dataset.roomId === roomId));
	}
}

// ── inspector ────────────────────────────────────────────────────────────────

function renderInspector() {
	const selection = state.selected;
	if (!selection) {
		el.inspector.hidden = true;
		el.panelEmpty.hidden = false;
		renderLog();
		return;
	}
	const object = findObject(selection.entityId) || selection.object;
	if (!object) {
		el.inspector.hidden = true;
		el.panelEmpty.hidden = false;
		return;
	}
	el.panelEmpty.hidden = true;
	el.inspector.hidden = false;
	el.inspector.innerHTML = '';

	const name = document.createElement('h2');
	name.className = 'hs-entity-name';
	name.textContent = object.name;
	el.inspector.appendChild(name);

	const id = document.createElement('p');
	id.className = 'hs-entity-id';
	id.textContent = object.entityId;
	el.inspector.appendChild(id);

	const stateLine = document.createElement('p');
	stateLine.className = 'hs-entity-state';
	stateLine.textContent = object.available ? `Currently ${object.state}.` : 'Home Assistant cannot reach this device right now.';
	el.inspector.appendChild(stateLine);

	const attrs = describeAttributes(object);
	if (attrs.length) {
		const dl = document.createElement('dl');
		dl.className = 'hs-entity-attrs';
		for (const [key, value] of attrs) {
			const dt = document.createElement('dt');
			dt.textContent = key;
			const dd = document.createElement('dd');
			dd.textContent = value;
			dl.append(dt, dd);
		}
		el.inspector.appendChild(dl);
	}

	const actions = actionsFor(object);
	if (actions.length && object.available) {
		const row = document.createElement('div');
		row.className = 'hs-actions';
		for (const action of actions) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = action.risky ? 'hs-btn hs-btn--danger' : 'hs-btn';
			button.textContent = state.busy.has(object.entityId) ? 'Working' : action.label;
			button.disabled = state.busy.has(object.entityId);
			button.addEventListener('click', () =>
				act({ entityId: object.entityId, domain: action.domain, service: action.service, name: object.name, roomId: roomOf(object.entityId)?.id }),
			);
			row.appendChild(button);
		}
		el.inspector.appendChild(row);
	}
	renderLog();
}

function describeAttributes(object) {
	const out = [];
	const a = object.attributes || {};
	if (Number.isFinite(Number(a.brightness))) out.push(['Brightness', `${Math.round((Number(a.brightness) / 255) * 100)}%`]);
	if (Array.isArray(a.rgb_color)) out.push(['Colour', `rgb(${a.rgb_color.join(', ')})`]);
	if (Number.isFinite(Number(a.current_position))) out.push(['Open', `${Number(a.current_position)}%`]);
	if (Number.isFinite(Number(a.current_temperature))) out.push(['Now', `${a.current_temperature}°`]);
	if (Number.isFinite(Number(a.temperature))) out.push(['Set to', `${a.temperature}°`]);
	if (a.device_class) out.push(['Class', String(a.device_class)]);
	if (a.media_title) out.push(['Playing', String(a.media_title)]);
	return out.slice(0, 6);
}

function actionsFor(object) {
	const on = object.activity > 0.02;
	switch (object.domain) {
		case 'light':
		case 'switch':
		case 'fan':
			return [on
				? { domain: object.domain, service: 'turn_off', label: 'Turn off' }
				: { domain: object.domain, service: 'turn_on', label: 'Turn on' }];
		case 'lock':
			return on
				? [{ domain: 'lock', service: 'lock', label: 'Lock' }]
				: [{ domain: 'lock', service: 'unlock', label: 'Unlock', risky: true }];
		case 'cover':
			return on
				? [{ domain: 'cover', service: 'close_cover', label: 'Close' }]
				: [{ domain: 'cover', service: 'open_cover', label: 'Open', risky: true }];
		case 'media_player':
			return [on ? { domain: 'media_player', service: 'media_pause', label: 'Pause' } : { domain: 'media_player', service: 'media_play', label: 'Play' }];
		case 'vacuum':
			return [on ? { domain: 'vacuum', service: 'return_to_base', label: 'Send home' } : { domain: 'vacuum', service: 'start', label: 'Start' }];
		case 'alarm_control_panel':
			return on
				? [{ domain: 'alarm_control_panel', service: 'alarm_disarm', label: 'Disarm', risky: true }]
				: [{ domain: 'alarm_control_panel', service: 'alarm_arm_away', label: 'Arm' }];
		default:
			return [];
	}
}

// ── acting ───────────────────────────────────────────────────────────────────

async function act(request, { confirmed = false, remember = false } = {}) {
	const room = request.roomId ? state.model?.rooms.find((r) => r.id === request.roomId) : roomOf(request.entityId);
	state.busy.add(request.entityId);
	state.renderer?.setBusy?.([...state.busy]);
	state.renderer?.setActing?.({ roomId: room?.id || null, entityId: request.entityId });
	renderInspector();

	try {
		if (confirmed && remember) {
			await grantEntity(state.homeId, { entityId: request.entityId, expiresAt: null });
		}
		await callService(state.homeId, {
			domain: request.domain,
			service: request.service,
			data: { entity_id: request.entityId },
			confirmed,
		});
		dismissConfirm();
		pushLog({ text: `${request.service.replace(/_/g, ' ')} ${request.name}`, outcome: 'ok' });
		announce(`${request.name}: ${request.service.replace(/_/g, ' ')}.`);
	} catch (err) {
		if (err instanceof HomeApiError && err.code === 'needs_confirmation') {
			// The gate fired. Ask, next to the thing it would move.
			state.pending = { request, message: err.message, risk: err.pending?.risk || 'physical', entityId: err.pending?.entityId || request.entityId };
			pushLog({ text: `${request.service.replace(/_/g, ' ')} ${request.name}`, outcome: 'refused' });
			renderConfirm();
			announce(err.message);
		} else {
			pushLog({ text: `${request.service.replace(/_/g, ' ')} ${request.name}`, outcome: 'failed' });
			announce(err.message || 'That did not work.');
			showToastError(err);
		}
	} finally {
		state.busy.delete(request.entityId);
		state.renderer?.setBusy?.([...state.busy]);
		renderInspector();
	}
}

/**
 * The confirmation lives on top of the thing it would move, not in a toast in
 * the corner. A person being asked "unlock the front door?" has to be able to
 * see WHICH door without reading an entity id.
 */
function renderConfirm() {
	dismissConfirm();
	const pending = state.pending;
	if (!pending) return;

	const card = document.createElement('div');
	card.className = 'hs-confirm';
	card.setAttribute('role', 'alertdialog');
	card.setAttribute('aria-modal', 'false');
	card.setAttribute('aria-label', 'Confirm this action');

	const risk = document.createElement('p');
	risk.className = 'hs-confirm-risk';
	risk.textContent = pending.risk === 'security' ? 'Opens your home' : 'Moves something physical';
	card.appendChild(risk);

	const text = document.createElement('p');
	text.className = 'hs-confirm-text';
	const object = findObject(pending.entityId);
	text.textContent = `${pending.request.service.replace(/_/g, ' ')} ${object?.name || pending.request.name}?`;
	card.appendChild(text);

	const why = document.createElement('p');
	why.className = 'hs-confirm-text';
	why.style.color = 'var(--ink-dim)';
	why.textContent = pending.message;
	card.appendChild(why);

	const row = document.createElement('div');
	row.className = 'hs-confirm-row';
	const yes = document.createElement('button');
	yes.type = 'button';
	yes.className = 'hs-btn hs-btn--primary';
	yes.textContent = 'Yes, do it';
	yes.addEventListener('click', () => {
		const remember = card.querySelector('input')?.checked;
		const request = pending.request;
		state.pending = null;
		act(request, { confirmed: true, remember });
	});
	const no = document.createElement('button');
	no.type = 'button';
	no.className = 'hs-btn';
	no.textContent = 'Cancel';
	no.addEventListener('click', () => {
		state.pending = null;
		dismissConfirm();
	});
	row.append(yes, no);
	card.appendChild(row);

	const rememberLabel = document.createElement('label');
	rememberLabel.className = 'hs-confirm-remember';
	const checkbox = document.createElement('input');
	checkbox.type = 'checkbox';
	rememberLabel.append(checkbox, document.createTextNode(`Do not ask again for ${object?.name || 'this device'}`));
	card.appendChild(rememberLabel);

	el.stage.appendChild(card);
	state.confirmCard = card;
	// Measured after insertion: the clamp needs the card's real height.
	repositionConfirm();
	requestAnimationFrame(repositionConfirm);
	yes.focus();
}

/**
 * Pin the confirmation to the thing it would move.
 *
 * The card grows upward from its anchor, so both axes are clamped to what is
 * actually on screen: an anchor near the top of the stage would otherwise put
 * the question, and the word "unlock" in it, above the visible area.
 */
function repositionConfirm() {
	const card = state.confirmCard;
	if (!card || !state.pending) return;
	const rect = el.stage.getBoundingClientRect();
	const scroll = el.stage.scrollTop;
	const height = card.offsetHeight || 190;
	const halfWidth = card.offsetWidth ? card.offsetWidth / 2 : 160;
	const minTop = scroll + height + 12;
	const maxTop = scroll + rect.height - 12;

	const point = state.renderer?.project?.(state.pending.entityId);
	let left = rect.width / 2;
	let top = scroll + rect.height / 2;
	if (point && point.visible) {
		left = point.x;
		top = point.y - 18;
	} else {
		// The 2D house and an off-screen object both anchor to the row instead.
		const row = el.stage.querySelector(`[data-entity-id="${cssEscape(state.pending.entityId)}"]`);
		if (row) {
			const r = row.getBoundingClientRect();
			left = r.left - rect.left + r.width / 2;
			top = r.top - rect.top + scroll - 6;
		}
	}
	card.style.left = `${clamp(left, halfWidth + 8, rect.width - halfWidth - 8)}px`;
	card.style.top = `${clamp(top, minTop, Math.max(minTop, maxTop))}px`;
}

function dismissConfirm() {
	state.confirmCard?.remove();
	state.confirmCard = null;
}

function onKeydown(event) {
	if (event.key === 'Escape' && state.pending) {
		state.pending = null;
		dismissConfirm();
	}
}

// ── the designed nothings ────────────────────────────────────────────────────

function renderEmptyStates(model) {
	if (model.empty) {
		showOverlay({
			title: 'Your home is connected, and empty',
			body: 'Home Assistant answered, but it is not exposing any devices yet. Add an integration in Home Assistant (Settings, Devices and services), and this scene fills in as soon as the first device appears. Nothing else to do here.',
			actions: [{ label: 'Add a device in Home Assistant', href: integrationsUrl(), external: true, primary: true }],
		});
		return;
	}
	if (model.needsLayout) {
		showOverlay({
			title: 'Nothing is in a room yet',
			body: 'Every device in this house is unfiled, so they are all in one room below. Assign them to areas in Home Assistant (Settings, Areas and zones) or lay the house out here, and the scene splits into real rooms.',
			actions: [
				{ label: 'Assign rooms in Home Assistant', href: areasUrl(), external: true, primary: true },
			],
			dismissable: true,
		});
		return;
	}
	hideOverlay();
}

function showOverlay({ title, body, actions = [], dismissable = false }) {
	hideOverlay();
	const overlay = document.createElement('div');
	overlay.className = 'hs-overlay';
	const h = document.createElement('h2');
	h.textContent = title;
	const p = document.createElement('p');
	p.textContent = body;
	overlay.append(h, p);
	const row = document.createElement('div');
	row.className = 'hs-actions';
	for (const action of actions) {
		if (!action.href && !action.onClick) continue;
		const node = action.href ? document.createElement('a') : document.createElement('button');
		node.className = action.primary ? 'hs-btn hs-btn--primary' : 'hs-btn';
		node.textContent = action.label;
		if (action.href) {
			node.href = action.href;
			if (action.external) {
				node.target = '_blank';
				node.rel = 'noopener noreferrer';
			}
		} else {
			node.type = 'button';
			node.addEventListener('click', action.onClick);
		}
		row.appendChild(node);
	}
	if (dismissable) {
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'hs-btn';
		close.textContent = 'Show me the house anyway';
		close.addEventListener('click', hideOverlay);
		row.appendChild(close);
	}
	if (row.children.length) overlay.appendChild(row);
	el.stage.appendChild(overlay);
	state.overlay = overlay;
}

function hideOverlay() {
	state.overlay?.remove();
	state.overlay = null;
}

function renderFailure(err) {
	const code = err instanceof HomeApiError ? err.code : 'call_failed';
	const copy = {
		unauthorized: {
			title: 'Sign in to see this home',
			body: 'A home belongs to the account that connected it. Sign in and this page opens straight onto your house.',
			actions: [{ label: 'Sign in', href: `/login?next=${encodeURIComponent(location.pathname)}`, primary: true }],
		},
		not_found: {
			title: 'That home is not here',
			body: 'Either this home was removed, or it belongs to another account. Your connected homes are one click away.',
			actions: [{ label: 'Your homes', href: '/home', primary: true }],
		},
		auth: {
			title: 'Home Assistant rejected the token',
			body: 'The long-lived access token this home was connected with no longer works. Create a new one in Home Assistant (your profile, Security) and reconnect.',
			actions: [{ label: 'Reconnect this home', href: '/home', primary: true }],
		},
		unreachable: {
			title: 'Your home did not answer',
			body: 'three.ws could not reach this Home Assistant. If it only exists on your home network, a public server cannot route to it: use your remote https URL, or run the three.ws add-on inside the network.',
			actions: [{ label: 'Try again', onClick: () => reconnect(), primary: true }, { label: 'Connection settings', href: '/home' }],
		},
		not_connected: {
			title: 'Still opening the connection',
			body: 'The link to your house is coming up, or was paused after repeated failures. Give it a moment and try again.',
			actions: [{ label: 'Try again', onClick: () => reconnect(), primary: true }],
		},
	}[code] || {
		title: 'Something went wrong loading your home',
		body: err?.message || 'The request failed. Trying again usually works; if it keeps failing, the connection settings will say why.',
		actions: [{ label: 'Try again', onClick: () => reconnect(), primary: true }, { label: 'Connection settings', href: '/home' }],
	};
	setStatus('disconnected', 'Disconnected', err?.message);
	showOverlay(copy);
	announce(copy.body);
}

function showToastError(err) {
	// A failed action is reported in the log and the live region rather than as
	// a modal: the house is still on screen and still usable.
	pushLog({ text: err?.message || 'Action failed', outcome: 'failed' });
}

function renderAge() {
	const existing = el.stage.querySelector('.hs-age');
	if (!state.stale || !state.lastGraphAt) {
		existing?.remove();
		if (state.ageTimer) {
			clearInterval(state.ageTimer);
			state.ageTimer = 0;
		}
		return;
	}
	const node = existing || document.createElement('div');
	node.className = 'hs-age';
	const write = () => {
		node.textContent = `Last seen ${relativeAge(Date.now() - state.lastGraphAt)}. Showing the house as it was.`;
	};
	write();
	if (!existing) {
		el.stage.appendChild(node);
		state.ageTimer = setInterval(write, 1000);
	}
}

function relativeAge(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} second${s === 1 ? '' : 's'} ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
	const h = Math.round(m / 60);
	return `${h} hour${h === 1 ? '' : 's'} ago`;
}

function pushLog(entry) {
	state.log.unshift({ ...entry, at: new Date() });
	// Bounded on purpose: a wall display left open overnight must not grow one
	// DOM node per action forever.
	state.log = state.log.slice(0, 20);
	renderLog();
}

function renderLog() {
	const existing = el.panel.querySelector('.hs-log');
	existing?.remove();
	if (!state.log.length) return;
	const list = document.createElement('ul');
	list.className = 'hs-log';
	for (const entry of state.log) {
		const li = document.createElement('li');
		if (entry.outcome !== 'ok') li.className = entry.outcome === 'refused' ? 'is-refused' : 'is-failed';
		const time = document.createElement('time');
		time.dateTime = entry.at.toISOString();
		time.textContent = entry.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		const text = document.createElement('span');
		text.textContent = entry.outcome === 'refused' ? `${entry.text} (needs your yes)` : entry.text;
		li.append(time, text);
		list.appendChild(li);
	}
	el.panel.appendChild(list);
}

function announce(message) {
	el.live.textContent = message;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function homeIdFromPath() {
	// Both routes serve this page: /smart-home/:id is where the connect flow's
	// "Open" lands, and /home/:id is the campaign's own address for the scene.
	const match = location.pathname.match(/^\/(?:smart-)?home\/([0-9a-fA-F-]{36})/);
	if (match) return match[1];
	const query = new URLSearchParams(location.search).get('home');
	return query && /^[0-9a-fA-F-]{36}$/.test(query) ? query : null;
}

function preferredView() {
	try {
		const stored = localStorage.getItem(VIEW_KEY);
		if (stored === '2d' || stored === '3d') return stored;
	} catch {
		// Storage disabled: default to 3D and let the WebGL probe decide.
	}
	return new URLSearchParams(location.search).get('view') === '2d' ? '2d' : '3d';
}

function findObject(entityId) {
	if (!state.model) return null;
	for (const room of state.model.rooms) {
		const found = room.objects.find((o) => o.entityId === entityId);
		if (found) return found;
	}
	return null;
}

function roomOf(entityId) {
	if (!state.model) return null;
	return state.model.rooms.find((room) => room.objects.some((o) => o.entityId === entityId)) || null;
}

/** Home Assistant's own areas screen, on this user's own instance. */
function areasUrl() {
	return state.home?.base_url ? `${state.home.base_url}/config/areas/dashboard` : null;
}

/** ...and the screen where a device gets added in the first place. */
function integrationsUrl() {
	return state.home?.base_url ? `${state.home.base_url}/config/integrations` : null;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function cssEscape(value) {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}
