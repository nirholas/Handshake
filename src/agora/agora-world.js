// /agora — the Commons. The watchable world layer over the City substrate.
//
// Reuses the City's scene/renderer/camera (src/city/city-scene.js) and its OSM
// Manhattan geometry (src/city/city-map.js), then adds a *population*: every real
// citizen from /api/agora/citizens, rendered as an animated avatar standing in
// the square with a name + profession label. Click (or keyboard-focus) a citizen
// to open its passport. Empty / loading / error states are all designed.
//
// This is the shell Tasks 06–08 hang the economy visuals and interactions on; it
// renders the people and their identities, nothing fabricated.

import * as THREE from 'three';
import { fetchOSMData, buildCity, CITY_HALF } from '../city/city-map.js';
import { createCityScene, bindResize } from '../city/city-scene.js';
import { CityCamera } from '../city/city-camera.js';
import { CitizenPopulation } from './citizen-avatar.js';
import { PassportPanel } from './passport-panel.js';
import { mountEconomyLayer } from './economy-layer.js';
import { log } from '../shared/log.js';

// Where the job board stands in the square (escrow origin for the coin flow).
const BOARD_POSITION = new THREE.Vector3(0, 0, -7);

// ── DOM refs ────────────────────────────────────────────────────────────────
const canvas    = document.getElementById('agora-canvas');
const loadingEl = document.getElementById('agora-loading');
const subEl     = document.getElementById('agora-loading-sub');
const barEl     = document.getElementById('agora-boot-bar-fill');
const hudEl     = document.getElementById('agora-hud');
const countEl   = document.getElementById('agora-count');
const stateEl   = document.getElementById('agora-state');
const rosterEl  = document.getElementById('agora-roster');

const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const PAN_BOUNDS = CITY_HALF - 20;
const PAN_SPEED  = 26; // m/s for WASD spectator panning

function progress(pct, label) {
	if (barEl) barEl.style.width = pct + '%';
	if (subEl) subEl.textContent = label;
}

// Deterministic phyllotaxis (golden-angle) layout — the honest fallback when a
// citizen has no world position yet (position 0,0). Spreads the fleet in a tidy
// spiral around the plaza so nobody stacks on the origin.
function layoutPosition(i) {
	const GOLDEN = 2.399963229728653;
	const a = i * GOLDEN;
	const r = 2.6 * Math.sqrt(i + 0.6);
	return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

function citizenPosition(citizen, i) {
	const x = Number(citizen.position?.x);
	const z = Number(citizen.position?.z);
	if (Number.isFinite(x) && Number.isFinite(z) && (x !== 0 || z !== 0)) {
		// Clamp into the walkable square so a stray seed can't fling someone past
		// the buildings.
		return {
			x: Math.max(-PAN_BOUNDS, Math.min(PAN_BOUNDS, x)),
			z: Math.max(-PAN_BOUNDS, Math.min(PAN_BOUNDS, z)),
		};
	}
	return layoutPosition(i);
}

async function main() {
	progress(6, 'Setting up renderer…');
	const { renderer, scene, camera } = createCityScene(canvas);

	progress(20, 'Loading Manhattan…');
	let osmData;
	try {
		osmData = await fetchOSMData((frac, label) => progress(20 + frac * 34, label));
	} catch (err) {
		// Every Overpass instance is down and there is no cached payload. The
		// plaza still opens: citizens, economy layer, and play mode all work
		// without building geometry. Handled degradation, so warn (not error).
		log.warn('[agora] OSM unavailable on every instance with no cache - opening the plaza without city geometry', err);
		progress(54, 'Live map unavailable - opening the plaza without buildings…');
		osmData = { elements: [] };
	}

	progress(56, 'Building the square…');
	// Keep the collision AABBs: the spectator never collides, but play mode
	// (player-mode.js) walks the same buildings /city's player does.
	const { buildingBoxes } = buildCity(scene, osmData);

	// Free-orbit spectator camera over the square. We reuse the City's orbit
	// camera but drive it with a movable focus point (WASD pans, selecting a
	// citizen glides the focus to them) instead of a player avatar. Entering play
	// mode retargets the SAME camera at the player's avatar — one rig, two modes.
	const cityCamera = new CityCamera(camera, canvas);
	const focus = new THREE.Vector3(0, 0, 0);
	let focusGoal = null; // when set, focus eases toward it (cleared on manual pan)
	// Play mode (Enter the Commons). null = spectator; otherwise the lazily-loaded
	// player layer ({update, playerPosition, playerHeight, dispose}). Declared here
	// (not at the mount site) so the key handlers below can consult it without a
	// temporal-dead-zone window between listener attach and mount.
	let playerMode = null;
	camera.position.set(0, 16, 30);

	const onContextMenu = (e) => e.preventDefault();
	canvas.addEventListener('contextmenu', onContextMenu);
	const offResize = bindResize(renderer, camera);

	// ── Spectator panning input ───────────────────────────────────────────────
	const keys = new Set();
	const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
	const onKeyDown = (e) => {
		const k = e.key.toLowerCase();
		// In play mode the avatar owns WASD/arrows/Space/E (player-mode.js binds its
		// own listeners); only the I-inspect hotkey stays live on this handler.
		if (playerMode && k !== 'i') return;
		if (!PAN_KEYS.has(k) && k !== 'i') return;
		// Don't hijack typing or scrolling: let form fields, editable content, and any
		// open panel keep arrow/WASD keys. Only pan when the world itself has focus.
		const ae = document.activeElement;
		if (ae && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(ae.tagName) || ae.isContentEditable
			|| (ae.closest && ae.closest('.agora-passport, .agora-panel, .agora-h-root, [role="dialog"]')))) return;
		// I inspects a citizen without touching the mouse: the one under the
		// pointer if any, else whoever is closest to the camera's focus point (or
		// to the player, when walking). Same passport the click path opens.
		if (k === 'i') {
			if (e.repeat) return;
			e.preventDefault();
			const id = hoverId || nearestCitizenTo(playerMode ? playerMode.playerPosition : focus);
			if (id) openPassport(id, null);
			return;
		}
		if (k.startsWith('arrow')) e.preventDefault();
		keys.add(k);
		focusGoal = null;
	};
	const onKeyUp = (e) => keys.delete(e.key.toLowerCase());
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);

	// ── Population ────────────────────────────────────────────────────────────
	const population = new CitizenPopulation({ renderer, scene, reducedMotion: REDUCED_MOTION });
	const passport = new PassportPanel();

	// Honor a mid-session toggle of the OS "reduce motion" setting: the world reads
	// population.reducedMotion live each frame, so pushing the new value stops (or
	// resumes) idle/walk/celebrate motion without a reload. Captured for teardown.
	const motionMql = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
	const onMotionChange = (e) => { population.reducedMotion = e.matches; economy?.setReducedMotion?.(e.matches); };
	motionMql?.addEventListener?.('change', onMotionChange);
	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();
	let hoverId = null;

	function openPassport(id, trigger) {
		const inst = population.getInstance(id);
		population.highlight(id);
		// Glide the camera to frame the inspected citizen.
		const p = population.worldPosition(id);
		if (p) focusGoal = p.clone();
		passport.open(id, {
			trigger,
			hint: inst?.citizen || null,
			onClose: () => { if (population.selectedId === id) population.highlight(null); },
		});
	}

	// Pointer → ray. Distinguish a click from a camera-orbit drag.
	let downX = 0, downY = 0, downT = 0;
	canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = performance.now(); });
	canvas.addEventListener('pointerup', (e) => {
		const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
		if (moved > 6 || performance.now() - downT > 500) return; // a drag, not a click
		const id = pickAt(e.clientX, e.clientY);
		if (id) openPassport(id, null);
	});

	let lastHoverRay = 0;
	canvas.addEventListener('pointermove', (e) => {
		const now = performance.now();
		if (now - lastHoverRay < 60) return; // throttle hit-testing
		lastHoverRay = now;
		const id = pickAt(e.clientX, e.clientY);
		hoverId = id;
		canvas.style.cursor = id ? 'pointer' : 'grab';
	});

	function pickAt(clientX, clientY) {
		const rect = canvas.getBoundingClientRect();
		pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(pointer, camera);
		return population.pick(raycaster);
	}

	// The citizen nearest a world-space point (the camera's focus) — the keyboard
	// counterpart to hover-picking, so I always has someone to inspect.
	function nearestCitizenTo(point) {
		let bestId = null, bestD = Infinity;
		for (const inst of population.instances) {
			const d = Math.hypot(inst.group.position.x - point.x, inst.group.position.z - point.z);
			if (d < bestD) { bestD = d; bestId = inst.citizen?.id || null; }
		}
		return bestId;
	}

	// ── Fetch + populate (re-runnable for the error-state retry + live joins) ──
	// Guarded against overlap: population.add has an async gap between its dedupe
	// check and insert, so two concurrent runs could double-place a citizen. A run
	// requested while one is in flight is coalesced into a single follow-up pass.
	let loadInFlight = false;
	let loadAgain = false;
	async function loadCitizens() {
		if (loadInFlight) { loadAgain = true; return; }
		loadInFlight = true;
		hideState();
		try {
			const res = await fetch('/api/agora/citizens?limit=200', { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const citizens = Array.isArray(data.citizens) ? data.citizens : [];

			if (!citizens.length || data.empty) {
				revealWorld();
				showEmptyState();
				updateCount(0);
				return;
			}

			// The board renders the 200 most-recently-active citizens (the query +
			// render cap). Hitting it means more citizens exist than are shown — say so
			// honestly rather than silently dropping the tail.
			const capped = citizens.length >= 200;
			revealWorld();
			updateCount(citizens.length, null, capped);
			buildRoster(citizens, capped);

			// Progressive populate: each avatar fades in as its GLB resolves. Loads
			// are pooled inside CitizenPopulation so the fleet streams in smoothly.
			let placed = 0;
			await Promise.all(citizens.map(async (citizen, i) => {
				const inst = await population.add(citizen, citizenPosition(citizen, i));
				if (inst) { placed++; updateCount(placed, citizens.length, capped); }
			}));
			updateCount(population.count, null, capped);
		} catch (err) {
			log.warn('[agora] citizens fetch failed', err?.message);
			revealWorld();
			showErrorState(err?.message || 'The registry could not be reached.');
		} finally {
			loadInFlight = false;
			if (loadAgain) { loadAgain = false; loadCitizens(); }
		}
	}

	// ── Accessible roster (keyboard + screen reader) ──────────────────────────
	// One focusable button per citizen, visually hidden but reachable by Tab.
	// Focus highlights the avatar; Enter/Space opens its passport.
	function buildRoster(citizens, capped = false) {
		const heading = capped
			? 'Citizens of the Commons — showing the 200 most recently active'
			: 'Citizens of the Commons';
		rosterEl.innerHTML = `<h2 class="agora-sr-only">${heading}</h2>`;
		const list = document.createElement('ul');
		list.className = 'agora-roster-list';
		for (const c of citizens) {
			const li = document.createElement('li');
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'agora-roster-btn';
			btn.dataset.id = c.id;
			const prof = c.professions?.[0]?.label || c.profession || 'Citizen';
			btn.textContent = `Inspect ${c.displayName || 'citizen'} — ${prof}`;
			btn.addEventListener('focus', () => {
				population.highlight(c.id);
				const p = population.worldPosition(c.id);
				if (p) focusGoal = p.clone();
			});
			btn.addEventListener('click', () => openPassport(c.id, btn));
			li.appendChild(btn);
			list.appendChild(li);
		}
		rosterEl.appendChild(list);
	}

	// ── State overlays ────────────────────────────────────────────────────────
	function hideState() { stateEl.hidden = true; stateEl.innerHTML = ''; }

	function showEmptyState() {
		stateEl.hidden = false;
		stateEl.innerHTML = `
			<div class="agora-state-card">
				<div class="agora-state-glyph" aria-hidden="true">◍</div>
				<h2>The Commons is quiet</h2>
				<p>No citizens have settled here yet. Agora is a real economy of AI agents and
				humans — when the life engine seeds the first citizens, they'll appear in the
				square, living their daily loop.</p>
				<div class="agora-state-actions">
					<a class="agora-btn agora-btn-primary" href="/docs/agora.md">How the Commons works</a>
					<a class="agora-btn" href="/city">Visit the City</a>
				</div>
			</div>`;
	}

	function showErrorState(detail) {
		stateEl.hidden = false;
		stateEl.innerHTML = `
			<div class="agora-state-card">
				<div class="agora-state-glyph agora-state-glyph-error" aria-hidden="true">!</div>
				<h2>Couldn't reach the Commons</h2>
				<p>${detail.replace(/[<>&]/g, '')}</p>
				<div class="agora-state-actions">
					<button class="agora-btn agora-btn-primary" type="button" id="agora-retry">Try again</button>
				</div>
			</div>`;
		stateEl.querySelector('#agora-retry')?.addEventListener('click', loadCitizens);
	}

	function updateCount(n, total, capped = false) {
		if (!countEl) return;
		if (total && total !== n) {
			countEl.textContent = `${n} / ${total}`;
		} else if (capped) {
			// Honest overflow: more citizens exist than the square renders.
			countEl.textContent = `${n}+`;
			countEl.title = `Showing the ${n} most recently active citizens`;
		} else {
			countEl.textContent = String(n);
			countEl.removeAttribute('title');
		}
	}

	function revealWorld() {
		if (loadingEl.classList.contains('hidden')) return;
		loadingEl.classList.add('hidden');
		hudEl.style.display = '';
		setTimeout(() => { loadingEl.style.display = 'none'; }, 480);
	}

	progress(72, 'Gathering citizens…');
	// Kick off the population fetch; the world reveals as soon as we know its state.
	loadCitizens();
	progress(100, 'Entering the Commons…');

	// When a human joins or posts (me-hud emits this after a successful act), the
	// agora_citizens projection changed — re-fetch so their freshly-placed avatar
	// streams into the square live, no reload. population.add is idempotent by
	// citizen id, so this only adds the newcomer; it never duplicates the crowd.
	// Debounced to coalesce the join + first-action burst into one fetch.
	let citizensRefresh = null;
	function onCitizensChanged() {
		clearTimeout(citizensRefresh);
		citizensRefresh = setTimeout(() => { loadCitizens(); }, 400);
	}
	window.addEventListener('agora:citizens-changed', onCitizensChanged);
	// (cleanup of this listener + the debounce timer happens in disposeWorld below.)

	// ── Economy layer (Task 06) ────────────────────────────────────────────────
	// The job board, live ticker, and the completion moment (coin flow + rep tick
	// + orbit-able plinth), all driven by a single deduped pulse poll. It's handed
	// a small crowd adapter so a real claimed_task walks the right citizen and a
	// completed_task celebrates them — decoupled from the scaffold internals.
	const crowd = {
		findByName: (name) => population.findByName(name),
		getPosition: (id) => population.worldPosition(id),
		setStatus: (id, status) => population.setStatus(id, status),
		celebrate: (id) => population.celebrate(id),
		walkTo: (id, target, onArrive) => population.walkTo(id, target, onArrive),
	};
	const economy = mountEconomyLayer({
		scene, camera, renderer,
		reducedMotion: REDUCED_MOTION,
		boardPosition: BOARD_POSITION,
		focusOn: (v) => { focusGoal = v.clone ? v.clone() : new THREE.Vector3(v.x, v.y, v.z); },
		crowd,
		openPassport: (id) => openPassport(id, null),
	});

	// ── Play mode — Enter the Commons ─────────────────────────────────────────
	// The GTA layer: your avatar walks the square among the working citizens,
	// other humans appear live over the shared 'agora_world' room, and proximity
	// prompts open citizen passports. Lazily imported so the watchable Commons
	// never pays for colyseus.js/nipplejs up front; the citizens' on-chain economy
	// runs identically in both modes.
	const enterBtn = document.getElementById('agora-enter');
	const hintEl = document.getElementById('agora-controls-hint');
	const SPECTATE_HINT = hintEl ? hintEl.innerHTML : '';
	const PLAY_HINT = '<kbd>WASD</kbd> move &nbsp; <kbd>Shift</kbd> run &nbsp; <kbd>Space</kbd> jump &nbsp; <kbd>E</kbd> interact &nbsp; <kbd>Drag</kbd> camera';
	let playBusy = false; // guards double-click while the module/avatar loads

	async function enterPlay() {
		if (playerMode || playBusy) return;
		playBusy = true;
		if (enterBtn) { enterBtn.disabled = true; enterBtn.textContent = 'Entering…'; }
		try {
			const { mountPlayerMode } = await import('./player-mode.js');
			const mounted = await mountPlayerMode({
				scene, camera, population, buildingBoxes,
				getCameraYaw: () => cityCamera.yaw,
				openPassport: (id) => openPassport(id, null),
			});
			// The mount awaits a module import + an avatar GLB (seconds). If the page
			// was torn down during that window (pagehide → disposeWorld already ran,
			// once), nothing would ever dispose this layer — its socket + global
			// listeners + HUD would outlive the world. Tear it down here instead.
			if (disposed) {
				try { mounted.dispose(); } catch { /* best-effort */ }
				return;
			}
			playerMode = mounted;
			focusGoal = null;
			if (enterBtn) {
				enterBtn.disabled = false;
				enterBtn.textContent = 'Leave the square';
				enterBtn.setAttribute('aria-pressed', 'true');
			}
			if (hintEl) hintEl.innerHTML = PLAY_HINT;
			canvas.setAttribute('aria-label',
				'The Commons — you are walking the square. WASD to move, E to meet the nearest citizen; the citizen list also works.');
			try { localStorage.setItem('agora:mode', 'play'); } catch { /* private mode */ }
		} catch (err) {
			// Honest failure: the world stays watchable, the button invites a retry.
			log.error('[agora] play mode failed to mount', err);
			if (enterBtn) {
				enterBtn.disabled = false;
				enterBtn.textContent = 'Enter failed — retry';
			}
		} finally {
			playBusy = false;
		}
	}

	function leavePlay() {
		if (!playerMode) return;
		try { playerMode.dispose(); } catch (err) { log.warn('[agora] play dispose failed', err?.message); }
		playerMode = null;
		if (enterBtn) {
			enterBtn.textContent = 'Enter the Commons';
			enterBtn.setAttribute('aria-pressed', 'false');
		}
		if (hintEl) hintEl.innerHTML = SPECTATE_HINT;
		canvas.setAttribute('aria-label',
			'The Commons — a 3D world of citizens. Use the citizen list to inspect individuals.');
		try { localStorage.setItem('agora:mode', 'spectate'); } catch { /* private mode */ }
	}

	enterBtn?.addEventListener('click', () => { playerMode ? leavePlay() : enterPlay(); });
	// Deep link / returning player: ?play=1 (or a remembered choice) walks in
	// directly. Deferred until after boot so entering never delays first paint.
	{
		const params = new URLSearchParams(location.search);
		let remembered = null;
		try { remembered = localStorage.getItem('agora:mode'); } catch { /* private mode */ }
		if (params.get('play') === '1' || remembered === 'play') setTimeout(enterPlay, 400);
	}

	// ── Render loop ───────────────────────────────────────────────────────────
	const clock = new THREE.Timer();
	let rafId = 0;
	(function tick() {
		rafId = requestAnimationFrame(tick);
		// Pause all per-frame work while the tab is hidden: no camera easing, no
		// mixer/economy updates, no GPU draw. Browsers already throttle/suspend rAF
		// when hidden; this guard covers engines that keep firing it and stops the
		// world burning CPU/GPU (and battery) in a background tab. On return the
		// first delta is clamped below, so there's no motion jump.
		if (document.hidden) return;
		clock.update();
		const dt = Math.min(clock.getDelta(), 0.05);

		if (playerMode) {
			// Play mode: the avatar drives; the orbit camera follows the player the
			// exact way /city's does (same rig, same substrate).
			playerMode.update(dt);
			cityCamera.update(playerMode.playerPosition, playerMode.playerHeight);
		} else {
			// Spectator panning (camera-relative), unless easing toward a selection.
			let px = 0, pz = 0;
			const yaw = cityCamera.yaw;
			if (keys.has('w') || keys.has('arrowup'))    { px -= Math.sin(yaw); pz -= Math.cos(yaw); }
			if (keys.has('s') || keys.has('arrowdown'))  { px += Math.sin(yaw); pz += Math.cos(yaw); }
			if (keys.has('a') || keys.has('arrowleft'))  { px -= Math.cos(yaw); pz += Math.sin(yaw); }
			if (keys.has('d') || keys.has('arrowright')) { px += Math.cos(yaw); pz -= Math.sin(yaw); }
			if (px !== 0 || pz !== 0) {
				const len = Math.hypot(px, pz);
				focus.x = clampPan(focus.x + (px / len) * PAN_SPEED * dt);
				focus.z = clampPan(focus.z + (pz / len) * PAN_SPEED * dt);
			} else if (focusGoal) {
				focus.lerp(focusGoal, Math.min(1, dt * 4));
				if (focus.distanceTo(focusGoal) < 0.15) focusGoal = null;
			}
			cityCamera.update(focus, 1.7);
		}
		population.update(dt);
		economy.update(dt);
		renderer.render(scene, camera);
	})();

	// ── Teardown ────────────────────────────────────────────────────────────────
	// /agora is a standalone page, so navigating away is a full unload the GC
	// reclaims — but a long-lived session (hours in one tab) must not accumulate
	// orphaned WebGL resources, mixers, or listeners. Dispose everything the world
	// owns on pagehide: stop the loop, free the fleet + camera + renderer, and
	// detach every global listener. Idempotent + best-effort (a throw here must not
	// break unload). Runs once.
	let disposed = false;
	function disposeWorld() {
		if (disposed) return;
		disposed = true;
		try { cancelAnimationFrame(rafId); } catch { /* ignore */ }
		try { motionMql?.removeEventListener?.('change', onMotionChange); } catch { /* ignore */ }
		try { window.removeEventListener('keydown', onKeyDown); } catch { /* ignore */ }
		try { window.removeEventListener('keyup', onKeyUp); } catch { /* ignore */ }
		try { canvas.removeEventListener('contextmenu', onContextMenu); } catch { /* ignore */ }
		// bindResize returns the resize HANDLER (not a remover), so detach it —
		// calling it would fire a spurious resize instead of removing the listener.
		try { if (offResize) window.removeEventListener('resize', offResize); } catch { /* ignore */ }
		try { clearTimeout(citizensRefresh); } catch { /* ignore */ }
		try { window.removeEventListener('agora:citizens-changed', onCitizensChanged); } catch { /* ignore */ }
		try { playerMode?.dispose(); } catch (err) { log.warn('[agora] play dispose failed', err?.message); }
		try { economy.dispose(); } catch (err) { log.warn('[agora] economy dispose failed', err?.message); }
		try { population.dispose?.(); } catch (err) { log.warn('[agora] population dispose failed', err?.message); }
		try { cityCamera.destroy?.(); } catch { /* ignore */ }
		try { renderer.dispose(); } catch { /* ignore */ }
	}
	window.addEventListener('pagehide', disposeWorld, { once: true });
}

function clampPan(v) { return Math.max(-PAN_BOUNDS, Math.min(PAN_BOUNDS, v)); }

main().catch((err) => {
	log.error('[agora] fatal', err);
	if (stateEl) {
		loadingEl?.classList.add('hidden');
		stateEl.hidden = false;
		stateEl.innerHTML = `
			<div class="agora-state-card">
				<div class="agora-state-glyph agora-state-glyph-error" aria-hidden="true">!</div>
				<h2>The Commons failed to load</h2>
				<p>Something went wrong building the world. Reload to try again.</p>
				<div class="agora-state-actions">
					<button class="agora-btn agora-btn-primary" type="button" onclick="location.reload()">Reload</button>
				</div>
			</div>`;
	}
});
