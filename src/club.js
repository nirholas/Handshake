// /club — three.ws Pole Club
//
// A dark 3D venue with four pole stages arranged in a half-arc. Each pole has
// a "Tip $0.001 to dance" button bound to /api/x402/dance-tip via the x402
// drop-in modal (window.X402.pay). Once the buyer's USDC settles, the dancer
// for that slot teleports onto their pole and performs the selected routine
// for ~12s, then drifts back to backstage. No tip, no dance.

import {
	AdditiveBlending,
	AmbientLight,
	Box3,
	BufferAttribute,
	BufferGeometry,
	Clock,
	Color,
	EquirectangularReflectionMapping,
	Fog,
	Group,
	HemisphereLight,
	PerspectiveCamera,
	PMREMGenerator,
	PointLight,
	Points,
	PointsMaterial,
	Scene,
	SpotLight,
	SRGBColorSpace,
	Vector3,
	WebGLRenderer,
} from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';

import { gltfLoader } from './loaders/gltf.js';
import { REQUIRED_VENUE_EMPTIES, collectVenueEmpties, resolveVenueAnchors } from './club-venue.js';
import { AnimationManager } from './animation-manager.js';
import { ClubCamera } from './club-camera.js';
import { ClubAudio, styleAudioFor, TRACK_LABELS } from './club-audio.js';
import { playSequence, ticketSteps } from './club-sequence.js';
import { detectProfile, PROFILES, createFrameWatchdog, isMobileLayout } from './club-perf.js';

const AVATAR_URL = '/avatars/default.glb';
const MANIFEST_URL = '/animations/manifest.json';
const POLE_GLB_URL = '/club/props/pole.glb';
const STAGE_GLB_URL = '/club/props/stage.glb';
// Authored nightclub interior + equirectangular HDRI for PBR reflections.
// Both are required — a 404 surfaces an error in the UI; the page does NOT
// fall back to a procedural scene. See public/club/assets/LICENSES.md for
// the named-empty contract these files must satisfy (the contract itself
// lives in src/club-venue.js so it can be unit-tested in isolation).
const VENUE_GLB_URL = '/club/venue/club-venue.glb';
const VENUE_HDRI_URL = '/club/venue/club-hdri.hdr';

// Clips we actually use — keeps the manifest pre-fetch small. Pole-specific
// clips (pole-spin, pole-climb, etc.) are added here once their source FBX
// files land in /public/animations/ and re-run of `npm run build:animations`
// registers them in /animations/manifest.json.
const REQUIRED_CLIPS = new Set([
	'idle', 'dance', 'rumba', 'silly', 'thriller', 'capoeira', 'walk',
	'pole-walk-on', 'pole-spin', 'pole-climb', 'pole-invert', 'pole-floorwork', 'pole-bow',
]);
const WALK_CLIP = 'walk';

const TIP_ENDPOINT = '/api/x402/dance-tip';
const TIPS_HISTORY_URL = '/api/club/tips?limit=20';
const TIPS_STREAM_URL = '/api/club/tips/stream';

// ── Stage layout ─────────────────────────────────────────────────────────
// Four poles in a half-arc facing the camera. Backstage is behind the bar at
// negative Z so dancers visibly walk out before mounting the pole.
const STAGE_RADIUS = 4.2;
const POLE_COUNT = 4;
const POLE_HEIGHT = 3.6;
const PERFORMANCE_FADE = 0.45; // seconds for clip crossfade
// Top of the stage GLB. Authored in scripts/build-club-props.mjs at y=0.18.
// Mirrored here so the dancer rig + pole base sit on the disc face.
const STAGE_TOP_Y = 0.18;

const POLES = Array.from({ length: POLE_COUNT }, (_, i) => {
	// Spread across an arc from -55° to +55° at the front of the room.
	const t = POLE_COUNT === 1 ? 0.5 : i / (POLE_COUNT - 1);
	const angle = -Math.PI * 0.31 + t * Math.PI * 0.62;
	return {
		id: String(i + 1),
		x: Math.sin(angle) * STAGE_RADIUS,
		z: -Math.cos(angle) * STAGE_RADIUS + 1.4, // shift forward of camera focus
		// Backstage spawn point — same X as pole, deeper into the room.
		backstageX: Math.sin(angle) * (STAGE_RADIUS + 0.6),
		backstageZ: -Math.cos(angle) * (STAGE_RADIUS + 0.6) - 2.4,
		yaw: angle + Math.PI, // face the camera (poles look outward)
	};
});

// ── DOM ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('club-canvas');
const polesPanel = document.getElementById('club-poles');
const statusEl = document.getElementById('club-status');
const tipFeedEl = document.getElementById('club-tip-feed');
const feedStatusEl = document.getElementById('club-feed-status');
const lbRowsEl = document.getElementById('club-lb-rows');
const lbTabsEls = document.querySelectorAll('.club-lb-tab');

function setStatus(text, { kind = 'info' } = {}) {
	if (!statusEl) return;
	statusEl.textContent = text;
	statusEl.dataset.kind = kind;
	statusEl.hidden = false;
	clearTimeout(setStatus._t);
	setStatus._t = setTimeout(() => { statusEl.hidden = true; }, 3500);
}

function fmtUsd(atomics, decimals = 6) {
	if (atomics == null) return '';
	const n = Number(atomics) / 10 ** decimals;
	if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
	return `$${n.toFixed(2)}`;
}

// Dedupe ring: the local x402 echo and the SSE channel both deliver the same
// settled tip. Whichever wins the race renders the row; the loser is dropped
// by ticket_id. Capped so it doesn't grow without bound on a long session.
const DEDUPE_MAX = 50;
const renderedTicketIds = new Set();
const renderedOrder = [];

function rememberTicketId(id) {
	if (!id || renderedTicketIds.has(id)) return false;
	renderedTicketIds.add(id);
	renderedOrder.push(id);
	while (renderedOrder.length > DEDUPE_MAX) {
		renderedTicketIds.delete(renderedOrder.shift());
	}
	return true;
}

// Render one tip into the feed. Accepts both the server row shape
// (snake_case from /api/club/tips and SSE `tip` events) and the local
// x402 ticket shape (camelCase from window.X402.pay).
function renderTipRow(rowLike, { live = false, prepend = true } = {}) {
	if (!tipFeedEl || !rowLike) return;
	const ticketId = rowLike.ticket_id ?? rowLike.ticketId ?? null;
	if (ticketId && !rememberTicketId(ticketId)) return;

	const dancer = rowLike.dancer ?? '?';
	const label = rowLike.label ?? rowLike.dance ?? 'dance';
	const payer = rowLike.payer ?? null;
	const amountAtomics = rowLike.amount_atomics ?? rowLike.amountAtomics ?? null;
	const network = rowLike.network ?? '';

	tipFeedEl.querySelector('.club-feed-empty')?.remove();
	const row = document.createElement('div');
	row.className = 'club-tip-row';
	if (live) row.classList.add('is-live');
	const who = payer ? `${payer.slice(0, 4)}…${payer.slice(-4)}` : 'someone';
	const safeLabel = String(label).replace(/[<>&]/g, '');
	row.innerHTML = `
		<span class="club-tip-who">${who}</span>
		<span class="club-tip-mid">tipped dancer ${dancer} → ${safeLabel}</span>
		<span class="club-tip-amt">${fmtUsd(amountAtomics)} · ${network || ''}</span>
	`;
	if (prepend) {
		tipFeedEl.prepend(row);
	} else {
		tipFeedEl.appendChild(row);
	}
	while (tipFeedEl.children.length > 20) tipFeedEl.lastChild.remove();
}

function setFeedStatus(text, kind) {
	if (!feedStatusEl) return;
	if (!text) {
		feedStatusEl.hidden = true;
		feedStatusEl.textContent = '';
		delete feedStatusEl.dataset.kind;
		return;
	}
	feedStatusEl.textContent = text;
	feedStatusEl.dataset.kind = kind || 'info';
	feedStatusEl.hidden = false;
}

// Load the most-recent tips for a fresh page load. Tries twice (one retry
// after 4 s) so a transient network blip doesn't leave the feed empty.
async function loadInitialTips({ attempt = 0 } = {}) {
	try {
		const r = await fetch(TIPS_HISTORY_URL, { cache: 'no-store' });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		const tips = Array.isArray(data?.tips) ? data.tips : [];
		// Server returns newest-first; reverse so the newest ends up at the
		// top after sequential prepend.
		for (const t of tips.slice().reverse()) {
			renderTipRow(t, { live: false });
		}
		setFeedStatus(null);
	} catch (err) {
		console.warn('[club] tip history failed', err);
		if (attempt === 0) {
			setFeedStatus("Couldn't load tip history — retrying", 'error');
			setTimeout(() => loadInitialTips({ attempt: 1 }), 4000);
		} else {
			setFeedStatus("Couldn't load tip history", 'error');
		}
	}
}

// Subscribe to the SSE channel. Reconnects with linear backoff after an
// error; after 3 consecutive failures shows a "live updates paused" badge.
// The badge clears as soon as the next connection succeeds.
function subscribeTipStream() {
	if (typeof window.EventSource !== 'function') {
		setFeedStatus('Live updates paused', 'paused');
		return null;
	}
	let es = null;
	let consecutiveFailures = 0;
	let reconnectTimer = 0;
	let closedByUser = false;

	const open = () => {
		if (closedByUser) return;
		try {
			es = new EventSource(TIPS_STREAM_URL);
		} catch (err) {
			console.warn('[club] EventSource init failed', err);
			scheduleReconnect();
			return;
		}
		es.addEventListener('hello', () => {
			consecutiveFailures = 0;
			setFeedStatus(null);
		});
		es.addEventListener('tip', (e) => {
			try {
				const row = JSON.parse(e.data);
				renderTipRow(row, { live: true });
			} catch (err) {
				console.warn('[club] tip event parse failed', err);
			}
		});
		es.onerror = () => {
			// EventSource auto-reconnects in some browsers but keeps the
			// closed socket in CONNECTING state and re-fires onerror in a
			// spin. Explicitly close + schedule so the failure counter
			// advances predictably and the badge timing is honest.
			try { es?.close(); } catch {}
			es = null;
			consecutiveFailures += 1;
			if (consecutiveFailures >= 3) {
				setFeedStatus('Live updates paused', 'paused');
			}
			scheduleReconnect();
		};
	};

	const scheduleReconnect = () => {
		if (closedByUser) return;
		clearTimeout(reconnectTimer);
		// 1.5 s, 3 s, 6 s, capped — fast enough to recover from a momentary
		// blip without hammering the endpoint during a longer outage.
		const delay = Math.min(1500 * Math.max(1, consecutiveFailures), 6000);
		reconnectTimer = setTimeout(open, delay);
	};

	open();
	window.addEventListener('beforeunload', () => {
		closedByUser = true;
		clearTimeout(reconnectTimer);
		try { es?.close(); } catch {}
	});
	return {
		close() {
			closedByUser = true;
			clearTimeout(reconnectTimer);
			try { es?.close(); } catch {}
		},
	};
}

// ── Perf profile (boot-time pick from real capability signals) ───────────
// One profile picked once, then applied to the renderer, lights, and any
// future scene additions (mirror ball, volumetric cones, crowd, postFX).
// Mid-session, the animate-loop watchdog can swap us down one tier if a
// phone starts throttling; profile is exposed on window so prompts 01–04
// can read it without an explicit import cycle.
let activeProfile = PROFILES[detectProfile()];
if (typeof window !== 'undefined') window.__clubProfile = activeProfile;

// ── Renderer / scene ──────────────────────────────────────────────────────
const renderer = new WebGLRenderer({ canvas, antialias: activeProfile.tier !== 'low', alpha: false });
renderer.setPixelRatio(activeProfile.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = SRGBColorSpace;
renderer.shadowMap.enabled = activeProfile.shadows;

const scene = new Scene();
scene.background = new Color(0x07050b);
scene.fog = new Fog(0x07050b, 9, 28);
// scene.environment is set inside bootstrap() once the equirectangular HDRI
// (public/club/venue/club-hdri.hdr) has been pre-filtered through
// PMREMGenerator.fromEquirectangular. We intentionally do NOT seed the env
// with a RoomEnvironment lightprobe — PBR materials read straight from the
// loaded HDRI so reflections match the authored interior, not a generic
// neutral sphere.

// Soft room light so the avatars aren't pitch black — but kept low so the
// spotlights do the talking.
scene.add(new AmbientLight(0x150b1a, 0.55));
const hemi = new HemisphereLight(0xff6abf, 0x110820, 0.35);
hemi.position.set(0, 6, 0);
scene.add(hemi);

const camera = new PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.05, 80);
camera.position.set(0, 1.8, 6.0);
camera.lookAt(0, 1.4, -1.5);

const clubCam = new ClubCamera(camera, {
	onModeChange: (mode) => {
		updateFreeCamChip(mode);
		document.querySelector('#club-stage')?.setAttribute('data-cam-mode', mode);
	},
});
document.querySelector('#club-stage')?.setAttribute('data-cam-mode', clubCam.getMode());

// ── Authored venue ───────────────────────────────────────────────────────
// The floor, walls, ceiling, bar, neon strips, and crowd silhouettes all
// live inside public/club/venue/club-venue.glb. They're added to the scene
// in bootstrap() once GLTFLoader resolves; the named empties inside that
// GLB (stage.NN, backstage.door.NN, truss.spot.NN, truss.mirrorball,
// bar.backsplash.neon) are what drive pole + spotlight placement below.

// ── Poles + spotlights ───────────────────────────────────────────────────
const POLE_COLORS = [0xff3bd6, 0x4ad6ff, 0xff8a3b, 0x9b5dff];

// Dancer registry — display names, bios, accent palette.
const DANCER_META = [
	{ name: 'Aria', bio: 'Neon pink fire. Classical meets street.', palette: 'pink' },
	{ name: 'Nova', bio: 'Cyan ice. Fluid and hypnotic.', palette: 'cyan' },
	{ name: 'Blaze', bio: 'Amber heat. Power and precision.', palette: 'amber' },
	{ name: 'Luna', bio: 'Violet dream. Gravity-defying flow.', palette: 'violet' },
];

class PoleStation {
	constructor(idx, layout) {
		this.idx = idx;
		this.layout = layout;
		this.id = layout.id;
		this.stageTopY = STAGE_TOP_Y;

		// Stage + pole GLBs are attached later in attachProps(); construct only
		// the lights, the rig holder, and lifecycle state here so the station
		// exists before async assets finish loading.

		// Spotlight — colored, focused on the pole base.
		const spot = new SpotLight(POLE_COLORS[idx % POLE_COLORS.length], 0, 12, Math.PI / 7, 0.4, 1.6);
		spot.position.set(layout.x, 6.0, layout.z + 0.5);
		spot.target.position.set(layout.x, 0.0, layout.z);
		spot.castShadow = activeProfile.shadows;
		if (activeProfile.shadowMapSize > 0) {
			spot.shadow.mapSize.set(activeProfile.shadowMapSize, activeProfile.shadowMapSize);
		}
		spot.shadow.bias = -0.0008;
		scene.add(spot);
		scene.add(spot.target);
		this.spot = spot;
		this.spotIdleIntensity = 0.6;
		this.spotActiveIntensity = 12.0;
		spot.intensity = this.spotIdleIntensity;

		// Floor accent point light — sits at the base of the pole.
		const accent = new PointLight(POLE_COLORS[idx % POLE_COLORS.length], 0.4, 4.5, 1.6);
		accent.position.set(layout.x, 0.6, layout.z);
		scene.add(accent);
		this.accent = accent;

		// Dancer rig — placed in backstage. We populate skinned mesh later.
		this.rig = new Group();
		this.rig.position.set(layout.backstageX, 0, layout.backstageZ);
		this.rig.rotation.y = layout.yaw;
		scene.add(this.rig);

		this.anim = null;
		this.skinned = null;
		this.stage = null;          // root group from stage.glb
		this.pole = null;           // root group from pole.glb

		// Current performance lifecycle.
		this.activeTicket = null;     // backend ticket id
		this.activeUntil = 0;         // ms epoch — informational; sequence loop drives end
		this.performing = false;
		this.walkPhase = 'idle';      // 'idle' | 'to-pole' | 'dancing' | 'returning'
		this._phaseTarget = this.rig.position.clone();

		// Render-loop coupled sleepers (sleep() resolves them in tick()).
		// Wall-clock setTimeout would drift if the tab is throttled or paused;
		// driving sleep off the render clock keeps choreography frame-aligned.
		this._clockSec = 0;
		this._sleepers = [];
	}

	/**
	 * Snap this station's stage / backstage / spotlight positions onto the
	 * world-space anchors harvested from the venue GLB. Called from
	 * bootstrap() AFTER the venue loads but BEFORE attachProps so the cloned
	 * stage disc / pole geo land on the authored stage.NN empties rather
	 * than the analytical fallback baked into the POLES array.
	 *
	 * Mutates `this.layout` in place — downstream code (attachProps,
	 * startPerformance, tick) reads layout each frame, so a single override
	 * pass at boot is enough.
	 *
	 * @param {object} anchors
	 * @param {import('three').Vector3} [anchors.stagePos]
	 * @param {import('three').Vector3} [anchors.backstagePos]
	 * @param {import('three').Vector3} [anchors.spotPos]
	 */
	applyVenueOverrides({ stagePos, backstagePos, spotPos } = {}) {
		if (stagePos) {
			this.layout.x = stagePos.x;
			this.layout.z = stagePos.z;
			this.accent.position.set(stagePos.x, 0.6, stagePos.z);
		}
		if (backstagePos) {
			this.layout.backstageX = backstagePos.x;
			this.layout.backstageZ = backstagePos.z;
			this.rig.position.set(backstagePos.x, 0, backstagePos.z);
			this._phaseTarget = this.rig.position.clone();
		}
		if (spotPos) {
			this.spot.position.set(spotPos.x, spotPos.y, spotPos.z);
		}
		// Spotlight always re-aims at the (possibly new) stage center.
		this.spot.target.position.set(this.layout.x, 0.0, this.layout.z);
	}

	/**
	 * Clone the pole + stage GLB templates into this station. Called from
	 * bootstrap() once both .glb files have finished loading. Each station gets
	 * its own clone so material tints (per-pole accent emissive) don't leak.
	 */
	attachProps({ poleTemplate, stageTemplate }) {
		const accent = new Color(POLE_COLORS[this.idx % POLE_COLORS.length]);

		const stage = stageTemplate.clone(true);
		stage.position.set(this.layout.x, 0, this.layout.z);
		stage.traverse((n) => {
			if (!n.isMesh) return;
			n.receiveShadow = true;
			if (n.material) {
				n.material = n.material.clone();
				if (n.material.emissive) {
					if (n.name === 'stage.led.ring') {
						n.material.emissive = accent.clone();
						n.material.emissiveIntensity = 1.2;
					} else {
						n.material.emissive.lerp(accent, 0.4);
					}
				}
			}
		});
		scene.add(stage);
		this.stage = stage;

		const pole = poleTemplate.clone(true);
		pole.position.set(this.layout.x, this.stageTopY, this.layout.z);
		pole.traverse((n) => {
			if (!n.isMesh) return;
			n.castShadow = true;
			n.receiveShadow = false;
			if (n.material && n.material.metalness >= 0.9) {
				// Subtle per-pole tint on the chrome only (skip dark brackets / bolts).
				n.material = n.material.clone();
				if (!n.material.emissive) n.material.emissive = new Color(0x000000);
				n.material.emissive = accent.clone().multiplyScalar(0.04);
			}
		});
		scene.add(pole);
		this.pole = pole;
	}

	attachAvatar(template, animationDefs) {
		const root = cloneSkinnedScene(template);
		root.traverse((n) => {
			if (!n.isMesh) return;
			n.castShadow = true;
			n.receiveShadow = false;
			if (n.material && 'envMapIntensity' in n.material) {
				n.material = n.material.clone();
				n.material.envMapIntensity = 0.6;
				// Tint each dancer subtly with the pole's accent color so the
				// four are visually distinct even before the spotlight kicks in.
				if (n.material.emissive) {
					n.material.emissive = new Color(POLE_COLORS[this.idx % POLE_COLORS.length]);
					n.material.emissiveIntensity = 0.05;
				}
			}
		});

		// Re-zero the avatar so feet sit at rig y=0.
		const box = new Box3().setFromObject(root);
		root.position.y -= box.min.y;

		this.rig.add(root);
		this.skinned = root;

		this.anim = new AnimationManager();
		this.anim.attach(root);
		this.anim.setAnimationDefs(animationDefs);
		// Lazy-load — first clip request fetches its JSON on demand.
		this.anim.play('idle');
	}

	get backstagePos() {
		return new Vector3(this.layout.backstageX, 0, this.layout.backstageZ);
	}
	get poleBasePos() {
		return new Vector3(this.layout.x, 0, this.layout.z + 0.02);
	}

	async startPerformance(ticket) {
		this.activeTicket = ticket;
		this.performing = true;
		this.activeUntil = Date.now() + (ticket.durationSec || 12) * 1000;
		this.walkPhase = 'to-pole';
		this._phaseTarget = this.poleBasePos;

		// Spotlight ramps up while the dancer walks on stage.
		this._spotTarget = this.spotActiveIntensity;
		this._accentTarget = 2.4;

		// Auto-cam: if the user opted in and no manual VIP/house shot is active,
		// switch to an orbiting auto-cam for the duration. We remember that the
		// auto-cam started this transition so we can release it on end.
		if (autoFollow && clubCam.getMode() === 'free') {
			this._autoCammed = true;
			clubCam.setAuto(this.layout);
		} else {
			this._autoCammed = false;
		}

		// Update pole card status.
		updatePoleCardStatus(this.id, 'performing');

		// Crossfade idle → walking → dance once the dancer reaches the pole.
		await this.anim?.crossfadeTo(WALK_CLIP, PERFORMANCE_FADE);
	}

	/**
	 * Render-loop coupled sleep. Resolves when `_clockSec` has advanced past
	 * the requested duration. Used by playSequence between crossfades so
	 * choreography stays aligned with the mixer's frame clock even when the
	 * tab is throttled (where setTimeout would still fire on its own schedule
	 * and desync from the visible animation).
	 *
	 * @param {number} ms
	 * @returns {Promise<void>}
	 */
	sleep(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
		return new Promise((resolve) => {
			this._sleepers.push({ wakeAt: this._clockSec + ms / 1000, resolve });
		});
	}

	async _arriveAtPole() {
		this.walkPhase = 'dancing';
		const steps = ticketSteps(this.activeTicket).length
			? ticketSteps(this.activeTicket)
			: [{ clip: this.activeTicket?.clip || 'dance', durationSec: this.activeTicket?.durationSec || 12 }];

		await playSequence({
			anim: this.anim,
			steps,
			fadeSec: PERFORMANCE_FADE,
			isCancelled: () => !this.performing,
			sleep: (ms) => this.sleep(ms),
		});

		// Sequence finished (or was cancelled) — return the dancer to backstage.
		// Cancellation is a fast-path: performing is already false, so _endPerformance
		// won't toggle it back, but the walking + audio cleanup still runs.
		if (this.walkPhase === 'dancing') await this._endPerformance();
	}

	async _endPerformance() {
		this.performing = false;
		this.walkPhase = 'returning';
		this._phaseTarget = this.backstagePos;
		this._spotTarget = this.spotIdleIntensity;
		this._accentTarget = 0.4;
		// Release auto-cam back to free if we were the ones who took it.
		if (this._autoCammed && (clubCam.getMode() === 'auto' || clubCam.getMode() === 'vip')) {
			clubCam.setFree();
		}
		this._autoCammed = false;

		// Update pole card status back to idle.
		updatePoleCardStatus(this.id, 'idle');
		// Signal the audio mixer (and anyone else listening) to fade the
		// style loop back to ambience. Dispatched on window so the page-
		// level audio binding can stay decoupled from this class.
		try {
			window.dispatchEvent(new CustomEvent('club:performance-end', {
				detail: { dancer: this.id, ticket: this.activeTicket },
			}));
		} catch {}
		await this.anim?.crossfadeTo(WALK_CLIP, PERFORMANCE_FADE);
	}

	async _arriveBackstage() {
		this.walkPhase = 'idle';
		this.activeTicket = null;
		this._phaseTarget = this.backstagePos;
		await this.anim?.crossfadeTo('idle', PERFORMANCE_FADE);
	}

	tick(dt) {
		// Advance the station clock and wake any sleepers due this frame.
		// Driving sleep off the render clock (not setTimeout) keeps choreography
		// aligned with the mixer when the tab is backgrounded or paused.
		this._clockSec += dt;
		if (this._sleepers.length) {
			let i = 0;
			while (i < this._sleepers.length) {
				if (this._sleepers[i].wakeAt <= this._clockSec) {
					const { resolve } = this._sleepers.splice(i, 1)[0];
					resolve();
				} else {
					i += 1;
				}
			}
		}

		// Lerp spotlight intensity.
		if (this._spotTarget != null) {
			this.spot.intensity += (this._spotTarget - this.spot.intensity) * Math.min(1, dt * 4);
		}
		if (this._accentTarget != null) {
			this.accent.intensity += (this._accentTarget - this.accent.intensity) * Math.min(1, dt * 4);
		}

		// Drive avatar walk between waypoints.
		if (this.walkPhase === 'to-pole' || this.walkPhase === 'returning') {
			const target = this._phaseTarget;
			const dir = new Vector3().subVectors(target, this.rig.position);
			dir.y = 0;
			const dist = dir.length();
			if (dist < 0.04) {
				this.rig.position.copy(target);
				if (this.walkPhase === 'to-pole') this._arriveAtPole();
				else this._arriveBackstage();
			} else {
				dir.normalize();
				const step = Math.min(dist, 1.4 * dt);
				this.rig.position.addScaledVector(dir, step);
				// Face direction of travel.
				const targetYaw = Math.atan2(dir.x, dir.z);
				this.rig.rotation.y += angleDelta(this.rig.rotation.y, targetYaw) * Math.min(1, dt * 6);
			}
		} else if (this.walkPhase === 'dancing') {
			// Keep dancer facing the camera (yaw lerp to original pole yaw).
			// End-of-dance is driven by the playSequence loop in _arriveAtPole,
			// not a wall-clock deadline — that way each sequence step lasts
			// exactly its declared duration in render-loop time.
			const targetYaw = this.layout.yaw;
			this.rig.rotation.y += angleDelta(this.rig.rotation.y, targetYaw) * Math.min(1, dt * 3);
		} else {
			// idle backstage — face into the room.
			const targetYaw = this.layout.yaw;
			this.rig.rotation.y += angleDelta(this.rig.rotation.y, targetYaw) * Math.min(1, dt * 1.5);
		}

		this.anim?.update(dt);
	}
}

function angleDelta(from, to) {
	let d = (to - from) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return d;
}

const stations = POLES.map((layout, i) => new PoleStation(i, layout));

// ── Disco / strobe light cycling ─────────────────────────────────────────
// A slowly rotating set of fill lights to keep the room feeling alive even
// when no dancers are out. Kept low-intensity so spotlights still dominate.
const disco = new Group();
scene.add(disco);
const discoColors = [0xff2bd6, 0x4ad6ff, 0xff8a3b, 0x6c4dff];
const discoCount = Math.max(1, Math.min(activeProfile.discoLights, discoColors.length));
for (let i = 0; i < discoCount; i++) {
	const p = new PointLight(discoColors[i % discoColors.length], 0.6, 12, 1.4);
	const angle = (i / discoCount) * Math.PI * 2;
	p.position.set(Math.sin(angle) * 5.5, 4.6, Math.cos(angle) * 5.5 - 1);
	disco.add(p);
}

// ── Avatar template + manifest load ──────────────────────────────────────
let animationDefs = null;

/**
 * Wrap a three.js loader's callback-form `.load()` in a promise that
 * forwards every progress event into `setStatus`. `loadAsync` would be
 * shorter but it swallows the progress callback, leaving the user staring
 * at "Loading club…" for the full duration of a multi-megabyte venue.
 *
 * @template T
 * @param {{ load: (url: string, onLoad: (asset: T) => void, onProgress: (e: ProgressEvent) => void, onError: (err: unknown) => void) => void }} loader
 * @param {string} url
 * @param {string} label
 * @returns {Promise<T>}
 */
function loadWithProgress(loader, url, label) {
	return new Promise((resolve, reject) => {
		loader.load(
			url,
			resolve,
			(e) => {
				if (e && e.total > 0) {
					const pct = Math.round((e.loaded / e.total) * 100);
					setStatus(`${label} ${pct}%`);
				}
			},
			(err) => {
				const message = err?.message || err?.statusText || String(err);
				reject(new Error(`Failed to load ${url}: ${message}`));
			},
		);
	});
}

async function bootstrap() {
	setStatus('Loading club…');

	const loader = gltfLoader(renderer);
	const rgbe = new RGBELoader();

	// Load everything in parallel — the venue + HDRI are the heaviest
	// payloads but the avatar + animation manifest + pole/stage props can
	// fetch in the same window. Any rejection bubbles up to the .catch in
	// the call site below, which paints an error status and stops; no
	// primitive fallback ever gets attached.
	const [venueGltf, hdrTexture, gltf, manifest, poleGltf, stageGltf] = await Promise.all([
		loadWithProgress(loader, VENUE_GLB_URL, 'Loading club…'),
		loadWithProgress(rgbe, VENUE_HDRI_URL, 'Loading lighting…'),
		loader.loadAsync(AVATAR_URL),
		fetch(MANIFEST_URL, { cache: 'force-cache' }).then((r) => {
			if (!r.ok) throw new Error(`HTTP ${r.status} loading animation manifest`);
			return r.json();
		}),
		loader.loadAsync(POLE_GLB_URL),
		loader.loadAsync(STAGE_GLB_URL),
	]);

	// HDRI → pre-filtered cubemap for PBR reflections. Background stays
	// the dark fog color so the HDRI only affects materials, not the
	// visible sky.
	hdrTexture.mapping = EquirectangularReflectionMapping;
	const pmrem = new PMREMGenerator(renderer);
	pmrem.compileEquirectangularShader();
	const envRT = pmrem.fromEquirectangular(hdrTexture);
	scene.environment = envRT.texture;
	hdrTexture.dispose();
	pmrem.dispose();

	// Venue geometry — receiveShadow on everything, castShadow only on
	// meshes the artist explicitly opted in via userData (set in Blender's
	// custom-property panel). Keeping the cast set small protects the
	// shadow-budget for the per-pole spotlights.
	venueGltf.scene.traverse((n) => {
		if (n.isMesh) {
			n.receiveShadow = true;
			n.castShadow = n.userData?.castShadow === true;
		}
	});
	scene.add(venueGltf.scene);

	// Resolve every required named empty. Throws if any are missing so the
	// outer catch surfaces a precise error to the user instead of
	// silently placing dancers at the origin.
	const empties = collectVenueEmpties(venueGltf.scene, REQUIRED_VENUE_EMPTIES);
	const anchors = resolveVenueAnchors(empties, stations.length);
	for (let i = 0; i < stations.length; i += 1) {
		stations[i].applyVenueOverrides({
			stagePos: anchors.stages[i],
			backstagePos: anchors.backstages[i],
			spotPos: anchors.spots[i],
		});
	}

	// Expose the mirrorball + bar-neon anchors for prompt 04 (lighting).
	// Both are Object3D nodes — the consumer reads world position / parent
	// frame as needed; we don't pre-resolve to a Vector3 here so prompt 04
	// can also attach children directly to the empty.
	if (typeof window !== 'undefined') {
		window.__clubVenueAnchors = {
			mirrorball: anchors.mirrorball,
			barBacksplashNeon: anchors.barBacksplashNeon,
		};
	}

	const template = gltf.scene;
	// Mark all materials as cloneable up front so per-dancer tinting works.
	template.traverse((n) => {
		if (n.isMesh) n.castShadow = true;
	});

	const poleTemplate = poleGltf.scene;
	const stageTemplate = stageGltf.scene;

	animationDefs = manifest.filter((d) => REQUIRED_CLIPS.has(d.name));

	for (const station of stations) {
		station.attachProps({ poleTemplate, stageTemplate });
		station.attachAvatar(template, animationDefs);
	}

	// Backfill history + open the SSE channel so this tab sees other tabs'
	// tips. Both run side-effect-only and don't block the stage being ready.
	loadInitialTips();
	subscribeTipStream();

	setStatus('Tip a pole to make her dance.', { kind: 'ok' });
}

// ── Audio mixer (Web Audio API, lazy-created on first user gesture) ──────
const audio = new ClubAudio();
// Other modules (rim-light pulse from prompt 04) read getPeak() each frame
// via this handle. They handle the no-context case themselves.
if (typeof window !== 'undefined') window.__clubAudio = audio;

// When a performance ends (PoleStation._endPerformance), fade the style
// loop back to ambience. Decoupled via custom event so the station class
// stays focused on motion.
window.addEventListener('club:performance-end', () => {
	audio.fadeOutStyle().catch((err) => console.warn('[club] fadeOutStyle', err));
});

// ── Tip flow (x402 drop-in) ──────────────────────────────────────────────
async function tipDancer({ dancer, dance, button }) {
	if (!window.X402?.pay) {
		setStatus('Payment widget still loading — try again in a second.', { kind: 'error' });
		return;
	}

	const station = stations.find((s) => s.id === String(dancer));
	if (!station) {
		setStatus(`No dancer ${dancer} on stage.`, { kind: 'error' });
		return;
	}
	if (station.performing) {
		setStatus(`Dancer ${dancer} is already performing — tip another pole.`, { kind: 'warn' });
		return;
	}

	// First click on a Tip button is the user gesture browsers require to
	// unlock AudioContext. Do this BEFORE opening the wallet modal so the
	// gesture isn't lost by the time we settle. Failures here are
	// non-fatal — the rest of the tip flow still works without audio.
	try {
		await audio.ensureContext();
		audio.startAmbience().catch((err) => console.warn('[club] startAmbience', err));
	} catch (err) {
		console.warn('[club] audio unavailable', err);
	}

	const url = `${TIP_ENDPOINT}?dancer=${encodeURIComponent(dancer)}&dance=${encodeURIComponent(dance)}`;

	button?.classList.add('is-pending');
	const originalLabel = button?.textContent;
	if (button) button.textContent = 'Open wallet…';

	try {
		const out = await window.X402.pay({
			endpoint: url,
			method: 'GET',
			merchant: 'three.ws Pole Club',
			action: `Tip Dancer ${dancer} — ${dance}`,
		});
		const ticket = out?.result;
		if (!ticket?.ok) {
			throw new Error(ticket?.error || 'tip did not settle');
		}
		station.startPerformance(ticket);

		// Crossfade ambience → style loop in sync with the dancer walking
		// out. Prefer the explicit `track` from the ticket; fall back to a
		// dance-key lookup for older tickets/agents that don't send it yet.
		const trackName = ticket.track || styleAudioFor(ticket.dance);
		if (trackName) {
			audio.fadeToStyle(trackName).then(() => {
				const label = TRACK_LABELS[trackName] || trackName;
				setStatus(`Now playing: ${label}`, { kind: 'ok' });
			}).catch((err) => console.warn('[club] fadeToStyle', err));
		}

		// Local echo — renderTipRow's dedupe ring (keyed on ticket_id) drops
		// the SSE copy if it arrives later; if the SSE copy wins the race the
		// local echo here is the one that gets dropped instead.
		renderTipRow({
			ticket_id: ticket.ticketId,
			dancer: ticket.dancer,
			label: ticket.label || ticket.dance,
			payer: ticket.payer,
			amount_atomics: ticket.amountAtomics,
			network: ticket.network,
		}, { live: true });
		setStatus(`Dancer ${ticket.dancer} → ${ticket.label}`, { kind: 'ok' });
		// Fire-and-forget refresh — keep the leaderboard in sync with the tip.
		if (typeof fetchLeaderboard === 'function') fetchLeaderboard();
	} catch (err) {
		if (err?.code !== 'cancelled') {
			setStatus(err?.message || 'tip failed', { kind: 'error' });
		}
	} finally {
		button?.classList.remove('is-pending');
		if (button && originalLabel) button.textContent = originalLabel;
	}
}

// ── Mobile bottom-sheet handle + leaderboard auto-collapse ───────────────
// The right panel becomes a bottom sheet on mobile. The drag handle at the
// top of the sheet toggles `.is-expanded` (CSS transform handles the
// slide). The leaderboard <details> is force-open on desktop and starts
// collapsed on mobile to keep the viewport canvas-first.
{
	const handle = document.getElementById('club-sheet-handle');
	const sheet = document.getElementById('club-right');
	if (handle && sheet) {
		handle.addEventListener('click', () => {
			const expanded = sheet.classList.toggle('is-expanded');
			handle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
		});
	}

	const lbDetails = document.getElementById('club-lb-details');
	if (lbDetails && typeof window.matchMedia === 'function') {
		const mq = window.matchMedia('(max-width: 800px)');
		const apply = () => {
			if (mq.matches) lbDetails.removeAttribute('open');
			else lbDetails.setAttribute('open', '');
		};
		apply();
		if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
		else if (typeof mq.addListener === 'function') mq.addListener(apply);
	}
}

// ── Mute pill in top bar ─────────────────────────────────────────────────
function bindMutePill() {
	const btn = document.getElementById('club-audio-toggle');
	if (!btn) return;
	const render = () => {
		btn.textContent = audio.muted ? '🔇 Audio off' : '🔊 Audio on';
		btn.setAttribute('aria-pressed', audio.muted ? 'true' : 'false');
	};
	render();
	btn.addEventListener('click', async () => {
		try { await audio.ensureContext(); } catch {}
		audio.setMuted(!audio.muted);
		render();
	});
}
bindMutePill();

// ── Free cam chip (shown while in VIP / house) ───────────────────────────
let freeCamChip = null;
function ensureFreeCamChip() {
	if (freeCamChip) return freeCamChip;
	const chip = document.createElement('button');
	chip.type = 'button';
	chip.id = 'club-free-cam';
	chip.textContent = '↩ Free cam';
	chip.hidden = true;
	chip.addEventListener('click', () => clubCam.setFree());
	const stage = document.getElementById('club-stage');
	(stage || document.body).appendChild(chip);
	freeCamChip = chip;
	return chip;
}
function updateFreeCamChip(mode) {
	const chip = ensureFreeCamChip();
	chip.hidden = (mode === 'free');
}

// ── Auto-follow tips toggle (persisted) ──────────────────────────────────
const AUTO_FOLLOW_KEY = 'club:autoFollowTips';
let autoFollow = (() => {
	try { return localStorage.getItem(AUTO_FOLLOW_KEY) === '1'; } catch { return false; }
})();
function setAutoFollow(on) {
	autoFollow = !!on;
	try { localStorage.setItem(AUTO_FOLLOW_KEY, autoFollow ? '1' : '0'); } catch {}
}

// ── Side panel — render pole controls ────────────────────────────────────
const DANCES = [
	{ key: 'rumba',    label: 'Rumba' },
	{ key: 'silly',    label: 'Silly' },
	{ key: 'thriller', label: 'Thriller' },
	{ key: 'capoeira', label: 'Capoeira' },
	{ key: 'hiphop',   label: 'Hip Hop' },
	{ key: 'spin',     label: 'Pole Spin' },
	{ key: 'climb',    label: 'Climb + Invert' },
	{ key: 'combo',    label: 'Combo' },
];

// Track per-pole card elements for status updates.
const poleCardEls = new Map();

function updatePoleCardStatus(poleId, status) {
	const cardEl = poleCardEls.get(poleId);
	if (!cardEl) return;
	const dotEl = cardEl.querySelector('.club-status-dot');
	const labelEl = cardEl.querySelector('.club-pole-status-label');
	const btnEl = cardEl.querySelector('.club-tip-btn');
	const progressEl = cardEl.querySelector('.club-pole-progress');

	if (dotEl) {
		dotEl.classList.remove('is-idle', 'is-performing', 'is-backstage');
		dotEl.classList.add(status === 'performing' ? 'is-performing' : status === 'backstage' ? 'is-backstage' : 'is-idle');
	}
	if (labelEl) {
		labelEl.textContent = status === 'performing' ? 'Performing' : status === 'backstage' ? 'Backstage' : 'Idle';
	}
	if (btnEl) {
		if (status === 'performing') {
			btnEl.disabled = true;
			btnEl.textContent = 'Performing...';
		} else {
			btnEl.disabled = false;
			const meta = DANCER_META[parseInt(poleId, 10) - 1] || DANCER_META[0];
			btnEl.textContent = `Tip $0.001`;
		}
	}
	if (progressEl) {
		progressEl.style.display = status === 'performing' ? '' : 'none';
	}
}

function flashPoleCard(poleId) {
	const cardEl = poleCardEls.get(poleId);
	if (!cardEl) return;
	cardEl.classList.remove('is-flash');
	void cardEl.offsetWidth; // force reflow for re-triggering animation
	cardEl.classList.add('is-flash');
	cardEl.addEventListener('animationend', () => cardEl.classList.remove('is-flash'), { once: true });
}

function renderPoles() {
	if (!polesPanel) return;
	polesPanel.innerHTML = '';
	for (const pole of POLES) {
		const idx = parseInt(pole.id, 10) - 1;
		const meta = DANCER_META[idx] || DANCER_META[0];
		const card = document.createElement('div');
		card.className = 'club-pole-card';
		card.setAttribute('role', 'listitem');
		card.setAttribute('aria-label', `Pole ${pole.id} - ${meta.name}`);
		card.dataset.poleId = pole.id;

		card.innerHTML = `
			<div class="club-pole-head">
				<div>
					<span class="club-dancer-name">${meta.name}</span>
					<span class="club-dancer-bio" title="${meta.bio}">${meta.bio}</span>
				</div>
				<span class="club-pole-row-right">
					<button type="button" class="club-cam-btn" data-pole="${pole.id}" title="VIP camera for ${meta.name}" aria-label="VIP camera for pole ${pole.id}">VIP</button>
				</span>
			</div>
			<div class="club-pole-status" aria-label="Status: Idle">
				<span class="club-status-dot is-idle" aria-hidden="true"></span>
				<span class="club-pole-status-label">Idle</span>
				<span class="club-pole-stats" id="club-pole-stats-${pole.id}" aria-label="Tips today: 0">0 tips today</span>
			</div>
			<div class="club-pole-progress" style="display:none" role="progressbar" aria-label="Performance progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
				<div class="club-pole-progress-bar" style="width:0%"></div>
			</div>
			<label class="club-pole-style">
				<span class="sr-only">Dance style for ${meta.name}</span>
				Style
				<select data-dancer="${pole.id}" class="club-pole-select" aria-label="Dance style for pole ${pole.id}">
					${DANCES.map((d) => `<option value="${d.key}">${d.label}</option>`).join('')}
				</select>
			</label>
			<button type="button" class="club-tip-btn" data-dancer="${pole.id}" aria-label="Tip ${meta.name} $0.001 USDC">
				Tip $0.001
			</button>
		`;
		polesPanel.appendChild(card);
		poleCardEls.set(pole.id, card);
	}

	// Tap card on mobile to VIP.
	polesPanel.addEventListener('click', (e) => {
		const camBtn = e.target.closest('.club-cam-btn');
		if (camBtn) {
			const layout = POLES.find((p) => p.id === camBtn.dataset.pole);
			if (layout) clubCam.setVip(layout);
			return;
		}
		const btn = e.target.closest('.club-tip-btn');
		if (btn) {
			const dancer = btn.dataset.dancer;
			const select = polesPanel.querySelector(`.club-pole-select[data-dancer="${dancer}"]`);
			const dance = select?.value || 'rumba';
			tipDancer({ dancer, dance, button: btn });
			return;
		}
		// Tap the card itself (not a button/select) on mobile → VIP cam.
		const card = e.target.closest('.club-pole-card');
		if (card && isMobileLayout()) {
			const poleId = card.dataset.poleId;
			const layout = POLES.find((p) => p.id === poleId);
			if (layout) clubCam.setVip(layout);
		}
	});
}

// ── Pointer + pinch handling ─────────────────────────────────────────────
// One pointer → orbit (ClubCamera.applyDrag, free mode only). Two pointers →
// pinch zoom (ClubCamera.applyZoom). Wheel also zooms. The camera state
// machine owns yaw/pitch — this block is just input plumbing.
{
	const pointers = new Map(); // pointerId → {x, y}
	let pinchPrevDist = 0;

	const pinchDistance = () => {
		const [a, b] = [...pointers.values()];
		return Math.hypot(a.x - b.x, a.y - b.y);
	};

	canvas.addEventListener('pointerdown', (e) => {
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		canvas.setPointerCapture?.(e.pointerId);
		if (pointers.size === 2) pinchPrevDist = pinchDistance();
	});
	canvas.addEventListener('pointermove', (e) => {
		const prev = pointers.get(e.pointerId);
		if (!prev) return;
		const dx = e.clientX - prev.x;
		const dy = e.clientY - prev.y;
		prev.x = e.clientX; prev.y = e.clientY;

		if (pointers.size === 1) {
			clubCam.applyDrag(dx, dy);
		} else if (pointers.size === 2) {
			const next = pinchDistance();
			// Pinch-in (fingers closer) → zoom in (negative deltaY); pinch-out → zoom out.
			const delta = (pinchPrevDist - next) * 4; // scale to wheel-ish units
			clubCam.applyZoom(delta);
			pinchPrevDist = next;
		}
	});
	const onUp = (e) => {
		if (!pointers.has(e.pointerId)) return;
		pointers.delete(e.pointerId);
		try { canvas.releasePointerCapture?.(e.pointerId); } catch {}
		if (pointers.size < 2) pinchPrevDist = 0;
	};
	canvas.addEventListener('pointerup', onUp);
	canvas.addEventListener('pointercancel', onUp);

	canvas.addEventListener('wheel', (e) => {
		e.preventDefault();
		clubCam.applyZoom(e.deltaY);
	}, { passive: false });
}

// ── Resize ────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
	renderer.setSize(window.innerWidth, window.innerHeight, false);
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────
// 0     → overhead house cam
// 1-4   → per-pole VIP cam
// Esc   → back to free orbit
// Inputs / selects in the side panel are excluded so typing doesn't move
// the camera.
window.addEventListener('keydown', (e) => {
	const tag = e.target?.tagName;
	if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
	if (e.key === '0') return clubCam.setHouse();
	if (e.key === 'Escape') return clubCam.setFree();
	if (['1', '2', '3', '4'].includes(e.key)) {
		const layout = POLES.find((p) => p.id === e.key);
		if (layout) clubCam.setVip(layout);
	}
});

// ── Frame-budget watchdog ────────────────────────────────────────────────
// Even with the boot-time profile, a phone can throttle mid-session (thermal,
// background sync, etc.). The watchdog drops us one tier on sustained slow
// frames and we never auto-upgrade. Downgrade re-applies cheap render-state
// flags (pixelRatio, shadowMap, antialias-already-baked); features built
// once (mirror ball, volumetric cones) stay as constructed — turning them
// off mid-flight would mean destroying GPU resources which itself spikes
// frame time. Halting their per-frame work is enough.
const watchdog = createFrameWatchdog({
	initialTier: activeProfile.tier,
	onDowngrade: (nextTier) => {
		const next = PROFILES[nextTier];
		if (!next) return;
		activeProfile = next;
		if (typeof window !== 'undefined') window.__clubProfile = next;
		renderer.setPixelRatio(next.pixelRatio);
		renderer.shadowMap.enabled = next.shadows;
		for (const station of stations) {
			if (station.spot) station.spot.castShadow = next.shadows;
		}
		// Trim disco lights to the new cap so we render fewer point lights.
		while (disco.children.length > next.discoLights) {
			const dropped = disco.children[disco.children.length - 1];
			disco.remove(dropped);
		}
		console.info('[club] downgrading profile to', nextTier);
	},
});

// ── Render loop ──────────────────────────────────────────────────────────
const clock = new Clock();
let rafId = null;
function animate() {
	const dt = Math.min(clock.getDelta(), 0.066);
	const t = clock.getElapsedTime();

	watchdog.tick(dt);

	for (const station of stations) station.tick(dt);

	// Disco light slow swirl.
	disco.rotation.y = t * 0.25;

	// Camera state machine — orbit / VIP / house.
	clubCam.tick(dt);

	renderer.render(scene, camera);
	rafId = requestAnimationFrame(animate);
}

renderPoles();

// Bind the auto-follow checkbox to persisted state.
{
	const cb = document.getElementById('club-auto-follow');
	if (cb) {
		cb.checked = autoFollow;
		cb.addEventListener('change', () => setAutoFollow(cb.checked));
	}
}

// ── Leaderboard — fetch + tabs + 30s refresh ─────────────────────────────
// Rank dancers by USDC tipped over the selected window. We also surface
// unpaid_atomics so the user can watch the value drain as the payout cron
// sweeps. Polling pauses when the tab is hidden to spare RPC budget.
const LB_REFRESH_MS = 30_000;
let lbWindow = 'day';
let lbTimer = null;
let lbInflight = false;

async function fetchLeaderboard() {
	if (!lbRowsEl || lbInflight) return;
	lbInflight = true;
	try {
		const res = await fetch(`/api/club/leaderboard?window=${encodeURIComponent(lbWindow)}`, {
			headers: { accept: 'application/json' },
			cache: 'no-store',
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		renderLeaderboard(body.rows || []);
	} catch (err) {
		console.error('[club] leaderboard fetch failed', err);
		// Don't blow away an already-rendered table on a transient hiccup.
		if (!lbRowsEl.querySelector('.club-lb-row')) {
			lbRowsEl.innerHTML = '<div class="club-lb-empty">Leaderboard unavailable.</div>';
		}
	} finally {
		lbInflight = false;
	}
}

function renderLeaderboard(rows) {
	if (!lbRowsEl) return;
	if (!rows.length) {
		lbRowsEl.innerHTML = '<div class="club-lb-empty">No dancers registered yet.</div>';
		return;
	}
	const frag = document.createDocumentFragment();
	rows.forEach((row, i) => {
		const total = Number(row.total_atomics || 0);
		const unpaid = Number(row.unpaid_atomics || 0);
		const div = document.createElement('div');
		div.className = 'club-lb-row' + (unpaid > 0 ? ' has-unpaid' : '');
		const dancer = String(row.dancer || '').replace(/[<>&]/g, '');
		const name = String(row.display_name || `Dancer ${dancer}`).replace(/[<>&]/g, '');
		const unpaidLabel = unpaid > 0
			? `<small>${fmtUsd(unpaid)} unpaid</small>`
			: '';
		div.innerHTML = `
			<span class="club-lb-rank">${i + 1}</span>
			<span class="club-lb-name">${name}${unpaidLabel}</span>
			<span class="club-lb-amt">${total > 0 ? fmtUsd(total) : '—'}</span>
			<span class="club-lb-tips">${row.tip_count || 0}×</span>
		`;
		frag.appendChild(div);
	});
	lbRowsEl.innerHTML = '';
	lbRowsEl.appendChild(frag);
}

function setLeaderboardWindow(next) {
	if (next === lbWindow) return;
	lbWindow = next;
	for (const tab of lbTabsEls) {
		tab.classList.toggle('is-active', tab.dataset.window === next);
	}
	fetchLeaderboard();
}

for (const tab of lbTabsEls) {
	tab.addEventListener('click', () => {
		const w = tab.dataset.window;
		if (w) setLeaderboardWindow(w);
	});
}

function startLeaderboardPolling() {
	stopLeaderboardPolling();
	lbTimer = setInterval(fetchLeaderboard, LB_REFRESH_MS);
}
function stopLeaderboardPolling() {
	if (lbTimer) {
		clearInterval(lbTimer);
		lbTimer = null;
	}
}
document.addEventListener('visibilitychange', () => {
	if (document.hidden) {
		stopLeaderboardPolling();
		// Stop the rAF loop entirely on hidden tabs — on mobile, leaving it
		// running heats the phone and drains battery for a tab the user
		// isn't even looking at.
		if (rafId != null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	} else {
		fetchLeaderboard();
		startLeaderboardPolling();
		// Discard the gap delta so the watchdog doesn't see one huge frame
		// (which would immediately count as "slow") on resume.
		clock.getDelta();
		if (rafId == null) animate();
	}
});

fetchLeaderboard();
startLeaderboardPolling();

bootstrap()
	.catch((err) => {
		console.error('[club] bootstrap failed', err);
		setStatus(`Club failed to load: ${err.message}`, { kind: 'error' });
	})
	.finally(() => animate());
