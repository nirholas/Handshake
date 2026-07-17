// WebXR immersive-ar MULTI-placement session for the AR Studio.
//
// The flagship WebXRSession (./webxr.js) anchors exactly one content group and
// retires its reticle after the first tap — right for "pin my agent", wrong for
// a studio where every tap should drop ANOTHER model. This controller keeps the
// hit-test reticle armed for the whole session: each screen tap asks the host
// for the currently armed content (a fresh Group), places it at the reticle,
// and binds it to its own XRAnchor so every placed model is independently glued
// to the real world. Pinch (via the dom-overlay) resizes the most recent — or
// host-selected — placement.
//
// Deliberately shares the pure helpers with the flagship session
// (anchor-lifecycle reticle visuals + tracking state, pinch-scale math,
// depth-occlusion) so the two AR surfaces look and feel identical.

import {
	CanvasTexture, CircleGeometry, Color, Group, Matrix4, Mesh, MeshBasicMaterial,
	PlaneGeometry, RingGeometry,
} from 'three';

import {
	advancePulse, isXrVisible, nextTrackingState, reticleVisual, TRACKING_LOSS_FRAMES,
} from './anchor-lifecycle.js';
import { DepthOcclusion } from './depth-occlusion.js';
import { createPinchState, pinchEnd, pinchMove, pinchStart, touchDist } from './pinch-scale.js';

function prefersReducedMotion() {
	try {
		return typeof window !== 'undefined'
			&& !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

function makeShadowTexture() {
	try {
		const size = 128;
		const cnv = document.createElement('canvas');
		cnv.width = cnv.height = size;
		const ctx = cnv.getContext('2d');
		const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		g.addColorStop(0, 'rgba(0,0,0,0.42)');
		g.addColorStop(0.55, 'rgba(0,0,0,0.20)');
		g.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
		return new CanvasTexture(cnv);
	} catch {
		return null;
	}
}

export class MultiPlaceSession {
	/**
	 * @param {object} opts
	 * @param {import('three').WebGLRenderer} opts.renderer
	 * @param {import('three').Scene} opts.scene
	 * @param {import('three').Camera} opts.camera
	 * @param {Element} [opts.domOverlayRoot] In-session HUD (prompt bar, tray,
	 *   exit). Touches are only observable through it during immersive-ar, so it
	 *   also carries the pinch gesture. Taps that begin on an element bearing
	 *   [data-xr-ui] never place a model.
	 * @param {() => (import('three').Group|null)} opts.getArmedContent Called on
	 *   each placement tap; returns a READY group to place (the host clones its
	 *   armed template), or null when nothing is armed (tap is ignored).
	 * @param {(group: import('three').Group, pose: { position: {x,y,z}, matrix: Matrix4 }, meta: { degraded: boolean }) => void} [opts.onPlaced]
	 *   Fired after each placement is anchored.
	 * @param {() => (import('three').Group|null)} [opts.getScaleTarget] Which
	 *   group a pinch resizes; defaults to the most recent placement.
	 * @param {(scale: number, meta: { final: boolean }) => void} [opts.onScale]
	 * @param {(has: boolean) => void} [opts.onHit]
	 * @param {(ok: boolean) => void} [opts.onTracking]
	 * @param {(visible: boolean) => void} [opts.onVisibility]
	 * @param {() => void} [opts.onEnd]
	 * @param {(dt: number) => void} [opts.onFrame] Per-frame host hook (mixers).
	 */
	constructor({
		renderer, scene, camera, domOverlayRoot,
		getArmedContent, onPlaced, getScaleTarget, onScale,
		onHit, onTracking, onVisibility, onEnd, onFrame,
	}) {
		this._renderer = renderer;
		this._scene = scene;
		this._camera = camera;
		this._domOverlayRoot = domOverlayRoot ?? null;
		this._getArmedContent = getArmedContent;
		this._onPlaced = onPlaced;
		this._getScaleTarget = getScaleTarget;
		this._onScale = onScale;
		this._onHit = onHit;
		this._onTracking = onTracking;
		this._onVisibility = onVisibility;
		this._onEnd = onEnd;
		this._onFrame = onFrame;

		this._session = null;
		this._hitTestSource = null;
		this._localSpace = null;
		this._ended = false;
		this._paused = false;
		this._trackingState = { misses: 0, lost: false };
		this._depthOcclusion = null;

		/** @type {Array<{ group: Group, anchor: XRAnchor|null, shadow: Mesh }>} */
		this._placements = [];

		this._latestHit = null;
		this._latestHitMatrix = new Matrix4();
		this._hasHit = false;
		this._hadHit = false;
		this._hitAmount = 0;

		this._reticle = null;
		this._reticleRing = null;
		this._reticleDot = null;
		this._pulseRing = null;
		this._rv = { scale: 1, opacity: 0.9, dot: 0, colorMix: 0 };
		this._pulse = { t: 0, scale: 1, opacity: 0, done: false, active: false };
		this._dimColor = new Color(0x7a6cf0);
		this._lockColor = new Color(0xc4b5fd);
		this._reducedMotion = false;
		this._shadowTex = null;
		this._prevTime = 0;
		this._savedBg = null;

		this._pinch = createPinchState();
		this._pinchEndedAt = -Infinity;
		// A tap that starts on HUD chrome must not place a model when it bubbles
		// into the XR select. Tracked from the overlay's touchstart.
		this._uiTouchActive = false;

		this._handleEnd = this._handleEnd.bind(this);
		this._handleSelect = this._handleSelect.bind(this);
		this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
		this._handleTouchStart = this._handleTouchStart.bind(this);
		this._handleTouchMove = this._handleTouchMove.bind(this);
		this._handleTouchEnd = this._handleTouchEnd.bind(this);
		this._handleBeforeSelect = this._handleBeforeSelect.bind(this);
	}

	static async isSupported() {
		try {
			return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar')));
		} catch {
			return false;
		}
	}

	async start() {
		const renderer = this._renderer;
		renderer.xr.enabled = true;

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
		this._ended = false;
		this._paused = false;
		this._trackingState = { misses: 0, lost: false };
		session.addEventListener('end', this._handleEnd);
		session.addEventListener('select', this._handleSelect);
		session.addEventListener('visibilitychange', this._handleVisibilityChange);

		await renderer.xr.setSession(session);

		this._localSpace = await session.requestReferenceSpace('local');
		const viewerSpace = await session.requestReferenceSpace('viewer');
		this._hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

		this._depthOcclusion = DepthOcclusion.sessionHasDepth(session)
			? new DepthOcclusion(renderer)
			: null;

		this._reducedMotion = prefersReducedMotion();
		this._hadHit = false;
		this._hitAmount = 0;
		this._pulse.active = false;
		this._shadowTex = makeShadowTexture();
		this._buildReticle();
		this._buildPulseRing();

		this._savedBg = this._scene.background;
		this._scene.background = null;
		renderer.setClearColor(0x000000, 0);

		if (this._domOverlayRoot) {
			const root = this._domOverlayRoot;
			root.addEventListener('touchstart', this._handleTouchStart, { passive: true });
			root.addEventListener('touchmove', this._handleTouchMove, { passive: true });
			root.addEventListener('touchend', this._handleTouchEnd, { passive: true });
			root.addEventListener('touchcancel', this._handleTouchEnd, { passive: true });
			root.addEventListener('beforexrselect', this._handleBeforeSelect);
		}

		this._prevTime = 0;
		renderer.setAnimationLoop((time, frame) => this._tick(time, frame));
	}

	/** Number of models placed in this immersive session. */
	get placedCount() {
		return this._placements.length;
	}

	_tick(time, frame) {
		const renderer = this._renderer;
		const dt = this._prevTime ? Math.min(0.1, (time - this._prevTime) / 1000) : 0.016;
		this._prevTime = time;

		if (this._paused) {
			renderer.render(this._scene, this._camera);
			return;
		}

		if (frame && this._localSpace) {
			const hasPose = !!frame.getViewerPose(this._localSpace);
			const t = nextTrackingState(this._trackingState, hasPose, TRACKING_LOSS_FRAMES);
			this._trackingState = t.state;
			if (t.changed) this._setTracking(!t.lost);
		}

		this._onFrame?.(dt);

		// The reticle stays live for the WHOLE session — that is the studio's
		// entire difference from the single-shot session: always ready to place
		// one more.
		if (frame && this._hitTestSource) {
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
				this._setHit(true);
			} else {
				this._latestHit = null;
				const keep = this._hadHit && !this._trackingState.lost;
				if (this._reticle) this._reticle.visible = keep;
				this._setHit(false);
			}
		}

		// Every anchored placement re-reads its live anchor pose so each model
		// stays independently glued as tracking refines. Anchor-less placements
		// (createAnchor unsupported/rejected) stay frozen at their tap pose.
		if (frame) {
			for (const p of this._placements) {
				if (!p.anchor) continue;
				const pose = frame.getPose(p.anchor.anchorSpace, this._localSpace);
				if (pose) {
					const t = pose.transform.position;
					p.group.position.set(t.x, t.y, t.z);
					p.shadow?.position.set(t.x, t.y + 0.004, t.z);
				}
			}
		}

		this._updateReticleVisual(time, dt);
		this._updatePulse(dt);
		this._depthOcclusion?.update();

		renderer.render(this._scene, this._camera);
	}

	// ── Placement ─────────────────────────────────────────────────────────────

	async _handleSelect() {
		if (!this._latestHit) return;
		if (this._pinch.active || performance.now() - this._pinchEndedAt < 350) return;
		if (this._uiTouchActive) return;

		const group = this._getArmedContent?.();
		if (!group) return;

		const matrix = this._latestHitMatrix.clone();
		group.position.setFromMatrixPosition(matrix);
		if (!group.parent) this._scene.add(group);

		const shadow = this._buildShadow();
		shadow.position.copy(group.position);
		shadow.position.y += 0.004;
		shadow.scale.setScalar(group.scale.x || 1);

		this._fireConfirmPulse();
		try { navigator.vibrate?.(15); } catch {}

		let anchor = null;
		try {
			anchor = (await this._latestHit.createAnchor?.()) ?? null;
		} catch {
			anchor = null;
		}
		this._placements.push({ group, anchor, shadow });
		this._onPlaced?.(group, {
			position: { x: group.position.x, y: group.position.y, z: group.position.z },
			matrix,
		}, { degraded: anchor === null });
	}

	/**
	 * Detach a group placed this session (the host deleted the model). Its
	 * anchor and contact shadow are released; removing the group from the scene
	 * stays the host's call.
	 */
	release(group) {
		const i = this._placements.findIndex((p) => p.group === group);
		if (i === -1) return;
		const [p] = this._placements.splice(i, 1);
		try { p.anchor?.delete?.(); } catch {}
		if (p.shadow) {
			this._scene.remove(p.shadow);
			p.shadow.geometry?.dispose();
			p.shadow.material?.dispose();
		}
	}

	// ── Pinch (dom-overlay) ───────────────────────────────────────────────────

	_scaleTarget() {
		const fromHost = this._getScaleTarget?.();
		if (fromHost) return fromHost;
		return this._placements.length
			? this._placements[this._placements.length - 1].group
			: null;
	}

	_handleTouchStart(e) {
		if (e.touches.length === 1) {
			// Remember whether this touch began on HUD chrome — its select must not place.
			this._uiTouchActive = !!e.touches[0].target?.closest?.('[data-xr-ui]');
			return;
		}
		if (e.touches.length !== 2) return;
		const target = this._scaleTarget();
		if (!target) return;
		pinchStart(this._pinch, touchDist(e.touches), target.scale?.x ?? 1);
	}

	_handleTouchMove(e) {
		if (!this._pinch.active || e.touches.length !== 2) return;
		const s = pinchMove(this._pinch, touchDist(e.touches));
		if (s == null) return;
		const target = this._scaleTarget();
		if (!target) return;
		target.scale.setScalar(s);
		const p = this._placements.find((x) => x.group === target);
		p?.shadow?.scale.setScalar(s);
		this._onScale?.(s, { final: false });
	}

	_handleTouchEnd(e) {
		if (!e.touches || e.touches.length === 0) this._uiTouchActive = false;
		const s = pinchEnd(this._pinch);
		if (s == null) return;
		this._pinchEndedAt = performance.now();
		this._onScale?.(s, { final: true });
	}

	_handleBeforeSelect(e) {
		if (this._pinch.active || performance.now() - this._pinchEndedAt < 350) {
			e.preventDefault();
			return;
		}
		// Taps on HUD controls (tray, prompt bar, exit) are UI, never placement.
		if (e.target?.closest?.('[data-xr-ui]')) e.preventDefault();
	}

	// ── Reticle / pulse / shadow (same look as the flagship session) ─────────

	_buildReticle() {
		const group = new Group();
		group.renderOrder = 999;
		group.visible = false;
		const ring = new Mesh(
			new RingGeometry(0.08, 0.11, 40).rotateX(-Math.PI / 2),
			new MeshBasicMaterial({ color: this._dimColor.clone(), transparent: true, opacity: 0.6, depthTest: false }),
		);
		ring.renderOrder = 999;
		const dot = new Mesh(
			new CircleGeometry(0.032, 32).rotateX(-Math.PI / 2).translate(0, 0.001, 0),
			new MeshBasicMaterial({ color: this._lockColor.clone(), transparent: true, opacity: 0, depthTest: false }),
		);
		dot.renderOrder = 1000;
		group.add(ring, dot);
		this._reticle = group;
		this._reticleRing = ring;
		this._reticleDot = dot;
		this._scene.add(group);
	}

	_buildPulseRing() {
		const ring = new Mesh(
			new RingGeometry(0.10, 0.13, 40).rotateX(-Math.PI / 2),
			new MeshBasicMaterial({ color: this._lockColor.clone(), transparent: true, opacity: 0, depthTest: false }),
		);
		ring.renderOrder = 1001;
		ring.visible = false;
		this._pulseRing = ring;
		this._scene.add(ring);
	}

	_buildShadow() {
		const geo = new PlaneGeometry(0.6, 0.6).rotateX(-Math.PI / 2);
		const mat = new MeshBasicMaterial({
			map: this._shadowTex, color: this._shadowTex ? 0xffffff : 0x000000,
			transparent: true, opacity: 0.9, depthWrite: false,
		});
		const mesh = new Mesh(geo, mat);
		mesh.renderOrder = 1;
		this._scene.add(mesh);
		return mesh;
	}

	_fireConfirmPulse() {
		if (this._reducedMotion || !this._pulseRing) return;
		this._pulseRing.position.setFromMatrixPosition(this._latestHitMatrix);
		this._pulseRing.quaternion.setFromRotationMatrix(this._latestHitMatrix);
		this._pulse.t = 0;
		this._pulse.active = true;
		this._pulseRing.visible = true;
	}

	_updateReticleVisual(time, dt) {
		const group = this._reticle;
		if (!group || !group.visible) return;
		const target = this._hasHit ? 1 : 0;
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

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	_setHit(has) {
		if (has === this._hasHit) return;
		this._hasHit = has;
		this._onHit?.(has);
	}

	_setTracking(ok) {
		if (!ok && this._reticle) this._reticle.visible = false;
		this._onTracking?.(ok);
	}

	_handleVisibilityChange() {
		const visible = isXrVisible(this._session?.visibilityState);
		this._paused = !visible;
		if (!visible && this._reticle) this._reticle.visible = false;
		this._onVisibility?.(visible);
	}

	async end() {
		if (this._session) {
			try {
				await this._session.end();
			} catch {}
		}
	}

	_handleEnd() {
		if (this._ended) return;
		this._ended = true;

		const renderer = this._renderer;
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
		this._pinchEndedAt = -Infinity;
		this._uiTouchActive = false;

		renderer.setAnimationLoop(null);
		renderer.xr.enabled = false;

		if (this._hitTestSource) {
			try { this._hitTestSource.cancel(); } catch {}
			this._hitTestSource = null;
		}

		for (const child of [this._reticleRing, this._reticleDot, this._pulseRing]) {
			child?.geometry?.dispose();
			child?.material?.dispose();
		}
		if (this._reticle) this._scene.remove(this._reticle);
		if (this._pulseRing) this._scene.remove(this._pulseRing);
		this._reticle = this._reticleRing = this._reticleDot = this._pulseRing = null;
		this._pulse.active = false;

		// Placed groups stay in the scene (the host re-lays them out in fallback
		// mode); anchors and per-placement shadows are session resources — release.
		for (const p of this._placements) {
			try { p.anchor?.delete?.(); } catch {}
			if (p.shadow) {
				this._scene.remove(p.shadow);
				p.shadow.geometry?.dispose();
				p.shadow.material?.dispose();
			}
		}
		this._placements = [];
		this._shadowTex?.dispose();
		this._shadowTex = null;

		this._depthOcclusion?.dispose();
		this._depthOcclusion = null;
		this._session = null;
		this._latestHit = null;
		this._hasHit = false;
		this._hadHit = false;
		this._hitAmount = 0;
		this._paused = false;
		this._trackingState = { misses: 0, lost: false };

		this._scene.background = this._savedBg;
		renderer.setClearColor(0x000000, 0);

		this._onEnd?.();
	}
}
