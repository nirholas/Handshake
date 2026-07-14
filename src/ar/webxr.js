// WebXR immersive-ar session controller.
//
// Reuses the element's existing Three.js renderer by enabling XR mode on start
// and restoring the RAF loop on end. Hit-test places the agent on tap.
//
// Half-body XR mode (collapse lower-body bones) is opt-in via the `halfBody`
// constructor option — only the demo page under /demos/halfbody passes it.
// The live AR button on the main viewer enters XR with the full body, exactly
// as it did before the half-body work was added.

import {
	CanvasTexture, CircleGeometry, Color, Group, Matrix4, Mesh, MeshBasicMaterial,
	PlaneGeometry, Quaternion, RingGeometry, Vector3,
} from 'three';

import {
	advancePulse, isXrVisible, nextTrackingState, reticleVisual, TRACKING_LOSS_FRAMES,
} from './anchor-lifecycle.js';
import { DepthOcclusion } from './depth-occlusion.js';
import { createPinchState, pinchEnd, pinchMove, pinchStart } from './pinch-scale.js';

/** prefers-reduced-motion: calm, static reticle/confirm states when set. */
function _prefersReducedMotion() {
	try {
		return typeof window !== 'undefined'
			&& !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

const LOWER_BODY_FRAGMENTS = [
	'upleg', 'leg', 'thigh', 'knee', 'shin', 'calf',
	'foot', 'toe', 'ankle',
];

function _normalizeBone(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/^mixamorig:?_?/, '')
		.replace(/^cc_base_/, '')
		.replace(/^armature[:_|]/, '')
		.replace(/^rig[:_]/, '');
}

function _isLowerBody(name) {
	const norm = _normalizeBone(name);
	return LOWER_BODY_FRAGMENTS.some((f) => norm.includes(f));
}

export class WebXRSession {
	/**
	 * @param {object} viewer  Object exposing { renderer, scene, content, controls,
	 *   activeCamera, animationManager, mixer, prevTime, _rafId, _afterAnimateHooks,
	 *   _needsRender, _updateRenderLoop } — see src/xr.js for the canonical shim.
	 * @param {object} [opts]
	 * @param {Function} [opts.onEnd]      Called after the XR session ends + restores.
	 * @param {boolean}  [opts.halfBody]   Collapse lower-body bones (demo mode).
	 * @param {Function} [opts.onAnchored] Called once on first tap with the anchored
	 *   local-space pose `{ position: Vector3, quaternion: Quaternion }` and a
	 *   `{ degraded }` flag (degraded = no real XRAnchor; placement may drift).
	 * @param {Function} [opts.onHit]      Called with `true`/`false` as the hit-test
	 *   reticle gains/loses a surface — drives the "point at the floor" searching state.
	 * @param {Function} [opts.onTracking] Called with `true`/`false` as the device
	 *   regains/loses its fix on the room — drives the "move to a brighter spot" hint.
	 * @param {Function} [opts.onVisibility] Called with `true`/`false` as the session
	 *   is foregrounded/backgrounded (lock, incoming call, app switch).
	 * @param {Element}  [opts.domOverlayRoot] Element to surface as the WebXR
	 *   `dom-overlay` root (in-session hint + exit affordance). Optional.
	 * @param {Function} [opts.onScale] Called with the new uniform scale as a
	 *   two-finger pinch resizes the agent (and once more with the settled value
	 *   when the pinch ends, flagged `{ final: true }`). Pinch-to-resize needs a
	 *   dom-overlay root (touches are only observable through it) — without one
	 *   the gesture is quietly unavailable, exactly as before.
	 */
	constructor(viewer, { onEnd, halfBody = false, onAnchored, onHit, onTracking, onVisibility, domOverlayRoot, onScale } = {}) {
		this._viewer = viewer;
		this._halfBody = halfBody;
		this._onEnd = onEnd;
		this._onAnchored = onAnchored;
		this._onHit = onHit;
		this._onTracking = onTracking;
		this._onVisibility = onVisibility;
		this._domOverlayRoot = domOverlayRoot ?? null;
		this._onScale = onScale;
		/** Pinch-to-resize state (pure math in ./pinch-scale.js). */
		this._pinch = createPinchState();
		/** Wall-clock of the last pinch end — a tap right after a pinch is the
		 * second finger lifting, not a placement intent. */
		this._pinchEndedAt = 0;
		/** Content scale captured at session start, restored on exit. */
		this._savedScale = null;
		this._handleTouchStart = this._handleTouchStart.bind(this);
		this._handleTouchMove = this._handleTouchMove.bind(this);
		this._handleTouchEnd = this._handleTouchEnd.bind(this);
		this._handleBeforeSelect = this._handleBeforeSelect.bind(this);
		this._session = null;
		this._hitTestSource = null;
		this._localSpace = null;
		this._anchored = false;
		/** Tracking-health state machine (transition-only "lost"/"recovered"). */
		this._trackingState = { misses: 0, lost: false };
		/** True while the session is backgrounded/blurred — skips non-essential work. */
		this._paused = false;
		/** Idempotency latch so an OS-initiated end and our own end() can't double-clean. */
		this._ended = false;
		/** @type {XRAnchor|null} Real world anchor created on tap (feature-detected). */
		this._anchor = null;
		/** @type {DepthOcclusion|null} Real-world occluder; null unless the session
		 * negotiated depth-sensing (feature-detected after start). */
		this._depthOcclusion = null;
		/** @type {XRHitTestResult|null} Most recent hit, used to create the anchor. */
		this._latestHit = null;
		/** Tap-moment hit pose, captured for persistence the instant the user taps. */
		this._latestHitMatrix = new Matrix4();
		this._hasHit = false;
		/** True once any surface has been found — keeps the reticle visible (dim,
		 * "searching") through brief hit dropouts instead of flickering off. */
		this._hadHit = false;
		/** @type {import('three').Group|null} Reticle group (ring + inner dot). */
		this._reticle = null;
		/** @type {import('three').Mesh|null} */
		this._reticleRing = null;
		/** @type {import('three').Mesh|null} Inner dot that fills in on lock. */
		this._reticleDot = null;
		/** @type {import('three').Mesh|null} One-shot confirm "pulse-out" ring. */
		this._pulseRing = null;
		/** @type {import('three').Mesh|null} Soft contact shadow grounding the avatar. */
		this._shadow = null;
		/** @type {import('three').CanvasTexture|null} Radial-gradient shadow map. */
		this._shadowTex = null;
		/** Eased 0→1 reticle lock amount (searching → locked); lerped each frame. */
		this._hitAmount = 0;
		/** Reused reticle-visual buffer — no per-frame allocation. */
		this._rv = { scale: 1, opacity: 0.9, dot: 0, colorMix: 0 };
		/** Reused confirm-pulse state; `active` gates the one-shot animation. */
		this._pulse = { t: 0, scale: 1, opacity: 0, done: false, active: false };
		/** Searching/locked reticle colours, lerped into the ring material in place. */
		this._dimColor = new Color(0x7a6cf0);
		this._lockColor = new Color(0xc4b5fd);
		this._reducedMotion = false;
		this._userPosition = new Vector3();
		this._savedBg = null;
		this._savedPos = null;
		this._savedRot = null;
		/** @type {Array<{ bone: import('three').Bone, scale: Vector3 }>} */
		this._halfBodyBones = [];
		this._handleEnd = this._handleEnd.bind(this);
		this._handleSelect = this._handleSelect.bind(this);
		this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
	}

	static async isSupported() {
		try {
			return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar')));
		} catch {
			return false;
		}
	}

	async start() {
		const viewer = this._viewer;
		const renderer = viewer.renderer;

		// Must be set before requestSession
		renderer.xr.enabled = true;

		// `anchors` lets us bind the agent to a real XRAnchor (no drift); it is
		// optional so devices without it still run on hit-test-follow. `dom-overlay`
		// surfaces the in-session hint + exit affordance when a root is supplied.
		// `depth-sensing` (optional) unlocks real-world occlusion — the agent hides
		// behind couches/doorways/people; we prefer the gpu-optimized luminance-alpha
		// path three.js can turn into an occluder, and degrade silently otherwise.
		const sessionInit = {
			requiredFeatures: ['hit-test'],
			optionalFeatures: ['anchors', 'local-floor', 'depth-sensing'],
			depthSensing: {
				usagePreference: ['gpu-optimized', 'cpu-optimized'],
				dataFormatPreference: ['luminance-alpha', 'float32'],
			},
		};
		if (this._domOverlayRoot) {
			sessionInit.optionalFeatures.push('dom-overlay');
			sessionInit.domOverlay = { root: this._domOverlayRoot };
		}

		const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
		this._session = session;
		// Fresh session: clear the lifecycle latches a prior run may have left set.
		this._ended = false;
		this._paused = false;
		this._trackingState = { misses: 0, lost: false };
		// An OS-initiated end (user locks the phone, takes a call, swipes the app
		// away) fires 'end' just like our exit button — both land in _handleEnd, so
		// restoration is identical and idempotent no matter who ended the session.
		session.addEventListener('end', this._handleEnd);
		// 'select' fires on controller trigger or screen tap
		session.addEventListener('select', this._handleSelect);
		// Backgrounding/blurring pauses non-essential work and surfaces a resume hint.
		session.addEventListener('visibilitychange', this._handleVisibilityChange);

		await renderer.xr.setSession(session);

		this._localSpace = await session.requestReferenceSpace('local');
		const viewerSpace = await session.requestReferenceSpace('viewer');
		this._hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

		// Real-world occlusion: only stand up the depth path when the live session
		// actually negotiated `depth-sensing`. On every other device this stays null
		// and the tick never touches depth — identical pre-occlusion behavior.
		this._depthOcclusion = DepthOcclusion.sessionHasDepth(session)
			? new DepthOcclusion(renderer)
			: null;

		// Re-read the OS motion preference per session so a mid-use settings change
		// is honoured on the next entry; gates the reticle pulse and confirm beat.
		this._reducedMotion = _prefersReducedMotion();
		this._hadHit = false;
		this._hitAmount = 0;
		this._pulse.active = false;

		// Floor reticle — a thin ring laid flat (geometry rotated into the XZ plane
		// so the hit pose's up-normal keeps it on the surface). Hidden until a hit.
		// A soft contact shadow grounds the avatar; a pulse ring fires on commit.
		this._buildReticle();
		this._buildShadow();
		this._buildPulseRing();

		// Transparent background — device camera provides the pass-through
		this._savedBg = viewer.scene.background;
		viewer.scene.background = null;
		renderer.setClearColor(0x000000, 0);

		// Save agent content transform for clean restoration on exit
		const content = viewer.content;
		this._savedPos = content?.position.clone() ?? null;
		this._savedRot = content?.rotation.clone() ?? null;
		this._savedScale = content?.scale.clone() ?? null;

		// Pinch-to-resize rides the dom-overlay: during immersive-ar, screen touches
		// are only observable as DOM events on the overlay root. Two fingers resize
		// the agent; `beforexrselect` suppresses the placement tap while (and just
		// after) a pinch so the second finger can't accidentally place/anchor.
		if (this._domOverlayRoot) {
			const root = this._domOverlayRoot;
			root.addEventListener('touchstart', this._handleTouchStart, { passive: true });
			root.addEventListener('touchmove', this._handleTouchMove, { passive: true });
			root.addEventListener('touchend', this._handleTouchEnd, { passive: true });
			root.addEventListener('touchcancel', this._handleTouchEnd, { passive: true });
			root.addEventListener('beforexrselect', this._handleBeforeSelect);
		}

		// Half-body mode is opt-in. The live AR button never sets it; only the
		// /demos/halfbody preview passes halfBody:true.
		if (this._halfBody) this._enterHalfBody();

		// Hand the render loop to the XR system (replaces RAF)
		if (viewer._rafId !== null) {
			cancelAnimationFrame(viewer._rafId);
			viewer._rafId = null;
		}
		viewer.controls.enabled = false;

		renderer.setAnimationLoop((time, frame) => this._tick(time, frame));
	}

	_tick(time, frame) {
		const viewer = this._viewer;
		const renderer = viewer.renderer;

		const dt = viewer.prevTime ? (time - viewer.prevTime) / 1000 : 0.016;
		viewer.prevTime = time;

		// Paused (app backgrounded, incoming call, screen locked): hold the agent
		// still and skip animation, hit-testing, and tracking checks so nothing
		// drifts or burns cycles. Submit a frame so the compositor stays happy, then
		// wait for visibilitychange → resume. No work, no console noise.
		if (this._paused) {
			renderer.render(viewer.scene, viewer.activeCamera);
			return;
		}

		// Tracking health: a frame with no viewer pose means the device has lost its
		// fix on the room (low light, blank wall, fast motion). Run it through the
		// transition-only state machine so the host hears "lost"/"recovered" once,
		// not every frame, and hide the reticle the moment we're lost.
		if (frame && this._localSpace) {
			const hasPose = !!frame.getViewerPose(this._localSpace);
			const t = nextTrackingState(this._trackingState, hasPose, TRACKING_LOSS_FRAMES);
			this._trackingState = t.state;
			if (t.changed) this._setTracking(!t.lost);
		}

		if (viewer.mixer) viewer.mixer.update(dt);
		viewer.animationManager.update(dt);

		// Empathy layer and any other per-frame hooks continue uninterrupted
		if (viewer._afterAnimateHooks) {
			for (const hook of viewer._afterAnimateHooks) hook(dt);
		}

		// Track user head position from the XR camera — used by lookAt('user')
		const xrCam = renderer.xr.getCamera();
		if (xrCam) this._userPosition.setFromMatrixPosition(xrCam.matrixWorld);

		// Before anchoring: the reticle (and a content preview) track the floor the
		// phone is pointed at. After a tap, a real XRAnchor takes over (below).
		if (!this._anchored && frame && this._hitTestSource) {
			const hits = frame.getHitTestResults(this._hitTestSource);
			const pose = hits.length > 0 ? hits[0].getPose(this._localSpace) : null;
			if (pose) {
				this._latestHit = hits[0];
				this._latestHitMatrix.fromArray(pose.transform.matrix);
				this._hadHit = true;
				if (this._reticle) {
					this._reticle.visible = true;
					this._reticle.position.setFromMatrixPosition(this._latestHitMatrix);
					this._reticle.quaternion.setFromRotationMatrix(this._latestHitMatrix);
				}
				this._placeShadow(this._latestHitMatrix);
				if (viewer.content) {
					viewer.content.position.setFromMatrixPosition(this._latestHitMatrix);
				}
				this._setHit(true);
			} else {
				this._latestHit = null;
				// Don't blink the reticle off on a one-frame hit dropout: once a surface
				// has been seen, hold it at the last spot in the dim "searching" look
				// (driven by _hitAmount → 0) so re-acquiring reads as calm, not broken.
				// Only the very first sweep — before any hit — shows no reticle at all.
				// But never resurrect it while tracking is lost: _setTracking hid it this
				// same tick precisely so the user can't tap a stale reticle, and the hit
				// block must not undo that. Dropout-tolerance applies only when tracked.
				const keep = this._hadHit && !this._trackingState.lost;
				if (this._reticle) this._reticle.visible = keep;
				if (this._shadow) this._shadow.visible = keep;
				this._setHit(false);
			}
		}

		// Anchored: drive content from the live anchor pose every frame so it stays
		// glued to the real world as the camera moves (position only — the agent's
		// own orientation/scale are preserved). A null anchor (createAnchor missing)
		// leaves content frozen at the tap point — degraded hit-follow, never broken.
		if (this._anchor && frame) {
			const pose = frame.getPose(this._anchor.anchorSpace, this._localSpace);
			if (pose && viewer.content) {
				const p = pose.transform.position;
				viewer.content.position.set(p.x, p.y, p.z);
				if (this._shadow) this._shadow.position.set(p.x, p.y, p.z);
			}
		}

		// Reticle look (searching ↔ locked) + the one-shot confirm pulse-out ring.
		// Both read existing state into reused buffers, so no per-frame allocation.
		this._updateReticleVisual(time, dt);
		this._updatePulse(dt);

		// Configure the real-world occluder the first frame depth data is ready; a
		// no-op (single boolean check) on every frame after, and never present at
		// all when the session has no depth-sensing. Must run before the render so
		// three's depth quad writes real-world depth before the agent is rasterized.
		this._depthOcclusion?.update();

		renderer.render(viewer.scene, viewer.activeCamera);
	}

	// ── Pinch-to-resize ────────────────────────────────────────────────────────
	// Raw touch geometry → the pure pinch state machine → a uniform scale on the
	// content group (and its contact shadow, so the grounding grows with it).

	static _touchDist(touches) {
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.hypot(dx, dy);
	}

	_handleTouchStart(e) {
		if (e.touches.length !== 2) return;
		const base = this._viewer.content?.scale?.x ?? 1;
		pinchStart(this._pinch, WebXRSession._touchDist(e.touches), base);
	}

	_handleTouchMove(e) {
		if (!this._pinch.active || e.touches.length !== 2) return;
		const s = pinchMove(this._pinch, WebXRSession._touchDist(e.touches));
		if (s == null) return;
		this._applyContentScale(s);
		this._onScale?.(s, { final: false });
	}

	_handleTouchEnd() {
		const s = pinchEnd(this._pinch);
		if (s == null) return;
		this._pinchEndedAt = performance.now();
		this._onScale?.(s, { final: true });
	}

	// While a pinch is live (or a beat after it ends), the tap must not place —
	// the "tap" is just the second finger. Cancels the upcoming XR select event.
	_handleBeforeSelect(e) {
		if (this._pinch.active || performance.now() - this._pinchEndedAt < 350) {
			e.preventDefault();
		}
	}

	_applyContentScale(s) {
		const content = this._viewer.content;
		if (!content) return;
		content.scale.setScalar(s);
		// The contact shadow grounds the agent — grow it with the body so a
		// statue-sized avatar doesn't stand on a coin-sized shadow.
		if (this._shadow) this._shadow.scale.setScalar(s);
	}

	// First tap anchors the agent at the current hit-test position. Creates a real
	// XRAnchor when the device supports it (survives the small tracking corrections
	// a raw hit pose does not); falls back to frozen hit-follow otherwise.
	async _handleSelect() {
		if (this._anchored || !this._latestHit) return;
		// Belt-and-braces with _handleBeforeSelect: some browsers deliver the select
		// anyway — a pinch (or its trailing finger-lift) is never a placement.
		if (this._pinch.active || performance.now() - this._pinchEndedAt < 350) return;
		this._anchored = true;
		// Capture the tap-moment pose now — before the anchor's own drift correction
		// nudges it — so the persisted GPS pin matches where the user actually tapped.
		const anchorPose = this._readAnchorPose();
		// The commit beat: a one-shot pulse-out ring from the tap point + a short
		// haptic tick. The reticle retires (the spot is taken); the contact shadow
		// stays to keep the agent grounded. Reduced motion drops the visual pulse but
		// keeps the haptic — the confirmation still lands, just calmly.
		this._fireConfirmPulse();
		try { navigator.vibrate?.(15); } catch {}
		if (this._reticle) this._reticle.visible = false;
		if (this._shadow) this._shadow.visible = true;
		this._setHit(false);
		try {
			this._anchor = (await this._latestHit.createAnchor?.()) ?? null;
		} catch {
			// Anchor creation can reject on devices that advertise but can't honour
			// the feature — fall back to the frozen tap pose rather than failing.
			this._anchor = null;
		}
		// Disclose a degraded placement: with no real XRAnchor the agent is frozen
		// at the tap pose and may drift. We still persist the pin; we just stop
		// pretending it's rock-solid so the host can say so honestly.
		this._onAnchored?.(anchorPose, { degraded: this._anchor === null });
	}

	// Build the floor reticle: a flat ring + an inner dot, both pre-rotated into the
	// XZ plane so the hit pose (Y = surface normal) lays them on the surface. The
	// group is oriented to the hit each frame; _updateReticleVisual animates the
	// searching↔locked look (dim/breathing → bright/filled) off the eased lock
	// amount, so this only establishes geometry — no per-frame branching here.
	_buildReticle() {
		const group = new Group();
		group.renderOrder = 999; // draw over the passthrough + agent
		group.visible = false;

		const ringGeo = new RingGeometry(0.08, 0.11, 40).rotateX(-Math.PI / 2);
		const ringMat = new MeshBasicMaterial({
			color: this._dimColor.clone(), transparent: true, opacity: 0.6, depthTest: false,
		});
		const ring = new Mesh(ringGeo, ringMat);
		ring.renderOrder = 999;

		// Inner dot: invisible while searching, fades in as the surface locks so
		// "ready to place" reads at a glance. Lifted a hair so it never z-fights the
		// ring on the exact same plane.
		const dotGeo = new CircleGeometry(0.032, 32).rotateX(-Math.PI / 2).translate(0, 0.001, 0);
		const dotMat = new MeshBasicMaterial({
			color: this._lockColor.clone(), transparent: true, opacity: 0, depthTest: false,
		});
		const dot = new Mesh(dotGeo, dotMat);
		dot.renderOrder = 1000;

		group.add(ring, dot);
		this._reticle = group;
		this._reticleRing = ring;
		this._reticleDot = dot;
		this._viewer.scene.add(group);
	}

	// Soft contact shadow — a single transparent plane with a radial-gradient map
	// (no real shadow map). Grounds the avatar so it sits *on* the floor instead of
	// floating; follows the reticle pre-tap and the anchor after. Lifted a few mm
	// along the surface normal so it never z-fights the real floor that the depth
	// occluder stamps — which also makes it correctly hidden by closer real geometry.
	_buildShadow() {
		const size = 128;
		let tex = null;
		try {
			const cnv = document.createElement('canvas');
			cnv.width = cnv.height = size;
			const ctx = cnv.getContext('2d');
			const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
			g.addColorStop(0, 'rgba(0,0,0,0.42)');
			g.addColorStop(0.55, 'rgba(0,0,0,0.20)');
			g.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, size, size);
			tex = new CanvasTexture(cnv);
		} catch {
			tex = null; // no DOM canvas (shouldn't happen in-session) → tinted disc fallback
		}
		const geo = new PlaneGeometry(0.6, 0.6).rotateX(-Math.PI / 2).translate(0, 0.004, 0);
		const mat = new MeshBasicMaterial({
			map: tex, color: tex ? 0xffffff : 0x000000, transparent: true,
			opacity: 0.9, depthWrite: false,
		});
		const mesh = new Mesh(geo, mat);
		mesh.renderOrder = 1; // beneath the reticle, above the passthrough
		mesh.visible = false;
		this._shadow = mesh;
		this._shadowTex = tex;
		this._viewer.scene.add(mesh);
	}

	// One-shot "pulse-out" ring fired on a successful anchor (the visible half of
	// the confirm beat). Separate from the reticle so it can keep animating after
	// the reticle retires. Hidden until _fireConfirmPulse arms it.
	_buildPulseRing() {
		const geo = new RingGeometry(0.10, 0.13, 40).rotateX(-Math.PI / 2);
		const mat = new MeshBasicMaterial({
			color: this._lockColor.clone(), transparent: true, opacity: 0, depthTest: false,
		});
		const ring = new Mesh(geo, mat);
		ring.renderOrder = 1001; // above the reticle
		ring.visible = false;
		this._pulseRing = ring;
		this._viewer.scene.add(ring);
	}

	// Lay the contact shadow flat on a hit (or anchor) pose and reveal it.
	_placeShadow(matrix) {
		if (!this._shadow) return;
		this._shadow.position.setFromMatrixPosition(matrix);
		this._shadow.quaternion.setFromRotationMatrix(matrix);
		this._shadow.visible = true;
	}

	// Arm the confirm pulse at the tap point. Reduced motion skips the visual beat
	// (the haptic + ✓ copy still confirm); otherwise the ring expands and fades via
	// _updatePulse. No allocation — the pulse state object is reused.
	_fireConfirmPulse() {
		if (this._reducedMotion || !this._pulseRing) return;
		this._pulseRing.position.setFromMatrixPosition(this._latestHitMatrix);
		this._pulseRing.quaternion.setFromRotationMatrix(this._latestHitMatrix);
		this._pulse.t = 0;
		this._pulse.active = true;
		this._pulseRing.visible = true;
	}

	// Per-frame reticle look. Eases the lock amount toward the live hit state and
	// maps it (+ a slow breathing phase) to scale/opacity/dot/colour via the pure,
	// unit-tested reticleVisual(). Writes straight onto materials with a reused
	// buffer and in-place colour lerp — zero per-frame allocation.
	_updateReticleVisual(time, dt) {
		const group = this._reticle;
		if (!group || !group.visible) return;
		const target = this._hasHit ? 1 : 0;
		// Snap toward lock a touch faster than it relaxes toward searching, so the
		// "locked" beat feels crisp while losing the surface feels gentle.
		const rate = Math.min(1, dt * (target > this._hitAmount ? 16 : 9));
		this._hitAmount += (target - this._hitAmount) * rate;
		const breathe = this._reducedMotion ? 0 : Math.sin(time * 0.0019) * 0.5 + 0.5;
		reticleVisual(this._rv, this._hitAmount, breathe, this._reducedMotion);
		group.scale.setScalar(this._rv.scale);
		const ringMat = this._reticleRing.material;
		ringMat.opacity = this._rv.opacity;
		ringMat.color.lerpColors(this._dimColor, this._lockColor, this._rv.colorMix);
		this._reticleDot.material.opacity = this._rv.dot * 0.95;
	}

	// Advance the one-shot confirm pulse, if armed. Expands + fades the ring via the
	// pure advancePulse(), then retires it. No-op (and no allocation) once done.
	_updatePulse(dt) {
		if (!this._pulse.active || !this._pulseRing) return;
		advancePulse(this._pulse, dt);
		this._pulseRing.scale.setScalar(this._pulse.scale);
		this._pulseRing.material.opacity = this._pulse.opacity;
		if (this._pulse.done) {
			this._pulse.active = false;
			this._pulseRing.visible = false;
		}
	}

	_disposeReticle() {
		if (!this._reticle) return;
		this._viewer.scene.remove(this._reticle);
		for (const child of [this._reticleRing, this._reticleDot]) {
			child?.geometry?.dispose();
			child?.material?.dispose();
		}
		this._reticle = null;
		this._reticleRing = null;
		this._reticleDot = null;
	}

	_disposeShadow() {
		if (this._shadow) {
			this._viewer.scene.remove(this._shadow);
			this._shadow.geometry?.dispose();
			this._shadow.material?.dispose();
			this._shadow = null;
		}
		this._shadowTex?.dispose();
		this._shadowTex = null;
	}

	_disposePulseRing() {
		if (!this._pulseRing) return;
		this._viewer.scene.remove(this._pulseRing);
		this._pulseRing.geometry?.dispose();
		this._pulseRing.material?.dispose();
		this._pulseRing = null;
		this._pulse.active = false;
	}

	// Notify the host only on transitions (searching ↔ surface found), not per frame.
	_setHit(has) {
		if (has === this._hasHit) return;
		this._hasHit = has;
		this._onHit?.(has);
	}

	// Tracking lost/recovered. On loss, hide the reticle (and its contact shadow)
	// so the user never taps a stale one; the host surfaces a recoverable "move to a
	// brighter spot" hint. A returning surface re-shows both on the next hit frame.
	_setTracking(ok) {
		if (!ok) {
			if (this._reticle) this._reticle.visible = false;
			if (!this._anchored && this._shadow) this._shadow.visible = false;
		}
		this._onTracking?.(ok);
	}

	// Foreground/background transition. Pause non-essential work while hidden and
	// hand the host a hint; resume cleanly when foregrounded. An OS that ends the
	// session instead of merely hiding it lands in _handleEnd, not here.
	_handleVisibilityChange() {
		const visible = isXrVisible(this._session?.visibilityState);
		this._paused = !visible;
		if (!visible) {
			if (this._reticle) this._reticle.visible = false;
			if (!this._anchored && this._shadow) this._shadow.visible = false;
		}
		this._onVisibility?.(visible);
	}

	// Decompose the captured tap-moment hit matrix into a local-space pose the host
	// converts to a GPS pin (metres from the session origin → lat/lng + floor height).
	_readAnchorPose() {
		const position = new Vector3();
		const quaternion = new Quaternion();
		const scale = new Vector3();
		this._latestHitMatrix.decompose(position, quaternion, scale);
		return { position, quaternion };
	}

	// Returns the current XR camera (user head) position for lookAt('user')
	getUserPosition() {
		return this._userPosition.clone();
	}

	async end() {
		if (this._session) {
			try {
				await this._session.end();
			} catch {}
			// _handleEnd fires from the 'end' event
		}
	}

	_handleEnd() {
		// Idempotent: the 'end' event and a direct end() can both reach here, and an
		// OS-initiated end must restore exactly once — same path as the exit button.
		if (this._ended) return;
		this._ended = true;

		const viewer = this._viewer;
		const renderer = viewer.renderer;

		// Stop listening before tearing down so a late visibilitychange during
		// teardown can't re-pause a session that's already gone.
		this._session?.removeEventListener('visibilitychange', this._handleVisibilityChange);
		if (this._domOverlayRoot) {
			const root = this._domOverlayRoot;
			root.removeEventListener('touchstart', this._handleTouchStart);
			root.removeEventListener('touchmove', this._handleTouchMove);
			root.removeEventListener('touchend', this._handleTouchEnd);
			root.removeEventListener('touchcancel', this._handleTouchEnd);
			root.removeEventListener('beforexrselect', this._handleBeforeSelect);
		}
		this._pinch = createPinchState();
		this._pinchEndedAt = 0;

		renderer.setAnimationLoop(null);
		renderer.xr.enabled = false;

		if (this._hitTestSource) {
			try {
				this._hitTestSource.cancel();
			} catch {}
			this._hitTestSource = null;
		}
		this._disposeReticle();
		this._disposeShadow();
		this._disposePulseRing();
		// Detach + free the depth occluder (no-op when it was never attached).
		this._depthOcclusion?.dispose();
		this._depthOcclusion = null;
		this._session = null;
		this._anchored = false;
		this._anchor = null;
		this._latestHit = null;
		this._hasHit = false;
		this._hadHit = false;
		this._hitAmount = 0;
		this._paused = false;
		this._trackingState = { misses: 0, lost: false };

		// Restore background
		viewer.scene.background = this._savedBg;
		renderer.setClearColor(0x000000, 1);

		// Restore agent content to its pre-AR transform (a pinch-resized scale is
		// persisted on the pin, not carried back into the non-AR view).
		if (viewer.content && this._savedPos) viewer.content.position.copy(this._savedPos);
		if (viewer.content && this._savedRot) viewer.content.rotation.copy(this._savedRot);
		if (viewer.content && this._savedScale) viewer.content.scale.copy(this._savedScale);

		// Restore full-body bone scales captured at XR start (no-op when halfBody
		// mode was never entered — _halfBodyBones is empty).
		this._exitHalfBody();

		viewer.controls.enabled = true;
		viewer._needsRender = true;
		viewer._updateRenderLoop();

		this._onEnd?.();
	}

	// ── Half-body mode ────────────────────────────────────────────────────────

	_enterHalfBody() {
		const content = this._viewer.content;
		if (!content) return;
		this._halfBodyBones = [];

		content.traverse((obj) => {
			if (!obj.isSkinnedMesh || !obj.skeleton) return;
			for (const bone of obj.skeleton.bones || []) {
				if (!_isLowerBody(bone.name)) continue;
				// Each bone may appear in multiple meshes; only record it once.
				if (this._halfBodyBones.some((b) => b.bone === bone)) continue;
				this._halfBodyBones.push({ bone, scale: bone.scale.clone() });
				bone.scale.set(0.0001, 0.0001, 0.0001);
			}
		});
		// Skeleton matrices need a fresh update so the zero-scale propagates
		// to every dependent vertex on the next render.
		content.traverse((obj) => {
			if (obj.isSkinnedMesh && obj.skeleton) obj.skeleton.update();
		});
	}

	_exitHalfBody() {
		for (const { bone, scale } of this._halfBodyBones) {
			bone.scale.copy(scale);
		}
		this._halfBodyBones = [];
		const content = this._viewer.content;
		if (content) {
			content.traverse((obj) => {
				if (obj.isSkinnedMesh && obj.skeleton) obj.skeleton.update();
			});
		}
	}
}
