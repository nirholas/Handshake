/**
 * Idle Animation Loop
 * -------------------
 * Four additive ambient motion channels for a static avatar:
 *   1. Breathing   — spine bone X micro-rotation (~4s period); morph fallback if no bones.
 *   2. Saccades    — small eye/head yaw+pitch offsets, critically damped spring.
 *   3. Blink       — eyelid morph close/hold/open on a random [2.5–6s] interval.
 *   4. Weight shift — hip bone yaw drift (~8s period), per-avatar seeded phase.
 *
 * All channels are additive — empathy layer wins. Pure dt-driven; no setTimeout/setInterval.
 * No allocations in update() — all scratch buffers are pre-allocated instance fields.
 */

import { ACTION_TYPES } from './agent-protocol.js';

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** mulberry32 PRNG — deterministic, seeded. Returns a function yielding [0, 1). */
function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
	};
}

/** djb2-style string → uint32, used for PRNG seeding. */
function hashStr(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

export class IdleAnimation {
	/**
	 * @param {object} opts
	 * @param {() => import('three').Object3D | null} opts.getRoot
	 *   Getter for the live avatar root — called each frame, handles late-loaded content.
	 * @param {import('./agent-protocol.js').AgentProtocol} [opts.protocol]
	 *   Optional — when present, idle pauses blink during SPEAK and saccade during LOOK_AT.
	 *   Static previews (avatar customizer, /create-review) can omit this safely.
	 * @param {string} [opts.seed]   Stable per-avatar seed (agent id); prevents multi-avatar sync.
	 * @param {() => Record<string,number>} [opts.getMorphCurrent]
	 *   Returns the empathy layer's live morph weight map (avatar._morphCurrent).
	 * @param {Partial<{breathing:boolean,saccade:boolean,blink:boolean,weightShift:boolean}>} [opts.channels]
	 */
	constructor(opts) {
		this._getRoot = opts.getRoot;
		// Static previews don't have an AgentProtocol — synthesize a no-op stub
		// so SPEAK / LOOK_AT subscriptions are inert rather than a hard error.
		this._protocol = opts.protocol || { on() {}, off() {} };
		this._getMorphCurrent = opts.getMorphCurrent ?? null;

		this._channels = {
			breathing: true,
			saccade: true,
			blink: true,
			weightShift: true,
			...opts.channels,
		};

		const seed = opts.seed ?? 'default';
		this._rand = mulberry32(hashStr(seed));

		// Per-avatar phase offsets — desync multiple instances on the same page.
		this._breathPhase = this._rand() * TWO_PI;
		this._weightPhase = this._rand() * TWO_PI;
		this._uncertaintyBias = 0; // 0..1, increases hip drift amplitude

		// ── Lazy bone / morph discovery ───────────────────────────────────────────
		this._scannedRoot = null;
		this._headBone = null;
		this._spineBone = null;
		this._hipBone = null;
		this._spineRestX = 0;
		this._hipRestY = 0;

		/**
		 * Pre-built morph index cache per mesh — eliminates dict lookup in hot path.
		 * @type {Array<{mesh:import('three').Mesh,blinkL:number,blinkR:number,browInner:number,mouthOpen:number}>}
		 */
		this._morphMeshes = [];

		// ── Spring scratch buffer — Float32Array avoids GC pressure ─────────────
		this._springBuf = new Float32Array(2);

		// ── Micro-saccade state ───────────────────────────────────────────────────
		this._saccYaw = 0;
		this._saccYawVel = 0;
		this._saccPitch = 0;
		this._saccPitchVel = 0;
		this._saccTargetYaw = 0;
		this._saccTargetPitch = 0;
		this._saccDwell = this._randRange(0.8, 2.4);
		this._saccTimer = 0;
		this._saccPauseTimer = 0; // counts down after look-at; saccade pauses while > 0

		// ── Blink state ───────────────────────────────────────────────────────────
		this._blinkCountdown = this._randRange(2.5, 6.0);
		this._blinkPhase = 'idle'; // 'idle' | 'close' | 'hold' | 'open'
		this._blinkPhaseT = 0;
		this._blinkWeight = 0;
		this._blinkPauseTimer = 0; // counts down after speak; blink start paused while > 0

		// ── Protocol listeners ────────────────────────────────────────────────────
		this._onSpeak = () => {
			this._blinkPauseTimer = 1.0;
		};
		this._onLookAt = () => {
			this._saccPauseTimer = 0.5;
		};
		this._protocol.on(ACTION_TYPES.SPEAK, this._onSpeak);
		this._protocol.on(ACTION_TYPES.LOOK_AT, this._onLookAt);
	}

	// ── Public API ───────────────────────────────────────────────────────────────

	/**
	 * Call every frame with elapsed seconds since the last tick.
	 * @param {number} dt
	 */
	update(dt) {
		this._ensureInit();
		if (this._channels.breathing) this._tickBreathing(dt);
		if (this._channels.saccade) this._tickSaccade(dt);
		if (this._channels.blink) this._tickBlink(dt);
		if (this._channels.weightShift) this._tickWeightShift(dt);
	}

	/**
	 * Toggle channels at runtime. Partial — unmentioned channels unchanged.
	 * @param {Partial<{breathing:boolean,saccade:boolean,blink:boolean,weightShift:boolean}>} partial
	 */
	setChannels(partial) {
		Object.assign(this._channels, partial);
	}

	/**
	 * Pause or resume saccade micro-movements externally (e.g. while user is speaking).
	 * @param {boolean} active — true = pause indefinitely, false = release immediately
	 */
	setPauseSaccade(active) {
		this._saccPauseTimer = active ? 999 : 0;
	}

	/**
	 * Set uncertainty bias that modulates hip drift amplitude.
	 * Called each frame by AgentAvatar._applyEmotionToAvatar().
	 * @param {number} value — 0..1
	 */
	setUncertainty(value) {
		this._uncertaintyBias = Math.max(0, Math.min(1, value));
	}

	/** Remove protocol listeners. */
	dispose() {
		this._protocol.off(ACTION_TYPES.SPEAK, this._onSpeak);
		this._protocol.off(ACTION_TYPES.LOOK_AT, this._onLookAt);
	}

	// ── Lazy init ────────────────────────────────────────────────────────────────

	_ensureInit() {
		const root = this._getRoot?.();
		if (!root || root === this._scannedRoot) return;
		this._scannedRoot = root;
		this._headBone = null;
		this._spineBone = null;
		this._hipBone = null;
		this._morphMeshes = [];

		let headCandidate = null, neckCandidate = null;
		root.traverse((node) => {
			if (node.isBone) {
				// Strip mixamorig prefix and any leading namespace so 'mixamorig:Head' → 'head'
				const canon = node.name
					.replace(/^mixamorig:?/i, '')
					.replace(/^[A-Za-z0-9]+[_:]/, '')
					.toLowerCase();

				if (!headCandidate && canon === 'head') headCandidate = node;
				else if (!neckCandidate && canon === 'neck') neckCandidate = node;

				if (
					!this._spineBone &&
					(canon === 'spine' ||
						canon === 'spine1' ||
						canon === 'spine2' ||
						canon === 'chest' ||
						canon === 'upperchest')
				) {
					this._spineBone = node;
					this._spineRestX = node.rotation.x;
				}

				if (
					!this._hipBone &&
					(canon === 'hips' || canon === 'hip' || canon === 'pelvis' || canon === 'root')
				) {
					this._hipBone = node;
					this._hipRestY = node.rotation.y;
				}
			}

			if (node.isMesh && node.morphTargetDictionary && node.morphTargetInfluences) {
				const d = node.morphTargetDictionary;
				this._morphMeshes.push({
					mesh: node,
					blinkL: d.eyeBlinkLeft ?? -1,
					blinkR: d.eyeBlinkRight ?? -1,
					browInner: d.browInnerUp ?? -1,
					mouthOpen: d.mouthOpen ?? -1,
				});
			}
		});

		// Prefer head over neck — neck is visited first in DFS but adding rotation
		// at neck level cascades into head, fighting the empathy layer's head-only control.
		this._headBone = headCandidate || neckCandidate;

		if (
			!this._headBone &&
			!this._spineBone &&
			!this._hipBone &&
			this._morphMeshes.length === 0
		) {
			console.warn(
				'[IdleAnimation] No bones or morph targets found on avatar root — channels will be no-ops.',
			);
		}
	}

	// ── Channel 1: Breathing ─────────────────────────────────────────────────────

	_tickBreathing(dt) {
		this._breathPhase = (this._breathPhase + (dt * TWO_PI) / 4.0) % TWO_PI;
		const signal = Math.sin(this._breathPhase);

		if (this._spineBone) {
			// Preferred path: subtle chest expansion via spine X rotation (±0.3°).
			this._spineBone.rotation.x = this._spineRestX + signal * 0.3 * DEG2RAD;
			return;
		}

		// Morph fallback when no spine bone — micro-modulate brow + mouthOpen.
		const mc = this._getMorphCurrent?.();
		const empMouthOpen = mc?.mouthOpen ?? 0;
		const amp = 0.005; // 0.5% amplitude — imperceptible except as "aliveness"

		for (let i = 0; i < this._morphMeshes.length; i++) {
			const m = this._morphMeshes[i];
			if (m.browInner >= 0) {
				m.mesh.morphTargetInfluences[m.browInner] = Math.max(
					0,
					Math.min(1, m.mesh.morphTargetInfluences[m.browInner] + signal * amp),
				);
			}
			// Defer to empathy layer when it is actively using mouthOpen.
			if (m.mouthOpen >= 0 && empMouthOpen <= 0.2) {
				m.mesh.morphTargetInfluences[m.mouthOpen] = Math.max(
					0,
					Math.min(1, m.mesh.morphTargetInfluences[m.mouthOpen] + signal * amp),
				);
			}
		}
	}

	// ── Channel 2: Micro-saccades ────────────────────────────────────────────────

	_tickSaccade(dt) {
		if (!this._headBone) return;

		if (this._saccPauseTimer > 0) {
			this._saccPauseTimer -= dt;
			return;
		}

		// Dwell timer — pick a new random target when the dwell expires.
		this._saccTimer += dt;
		if (this._saccTimer >= this._saccDwell) {
			this._saccTimer = 0;
			this._saccDwell = this._randRange(0.8, 2.4);
			this._saccTargetYaw = (this._rand() * 2 - 1) * 1.5 * DEG2RAD;
			this._saccTargetPitch = (this._rand() * 2 - 1) * 1.5 * DEG2RAD;
		}

		// Critically damped spring (omega=5) — smooth approach, no overshoot.
		this._springStep(this._saccYaw, this._saccYawVel, this._saccTargetYaw, 5, dt);
		this._saccYaw = this._springBuf[0];
		this._saccYawVel = this._springBuf[1];

		this._springStep(this._saccPitch, this._saccPitchVel, this._saccTargetPitch, 5, dt);
		this._saccPitch = this._springBuf[0];
		this._saccPitchVel = this._springBuf[1];

		// Additive — applied after the empathy layer sets head rotation this frame.
		this._headBone.rotation.y += this._saccYaw;
		this._headBone.rotation.x += this._saccPitch;
	}

	// ── Channel 3: Blink ─────────────────────────────────────────────────────────

	_tickBlink(dt) {
		if (this._blinkPauseTimer > 0) this._blinkPauseTimer -= dt;
		const paused = this._blinkPauseTimer > 0;

		switch (this._blinkPhase) {
			case 'idle':
				if (!paused) {
					this._blinkCountdown -= dt;
					if (this._blinkCountdown <= 0) {
						this._blinkPhase = 'close';
						this._blinkPhaseT = 0;
						this._blinkCountdown = this._randRange(2.5, 6.0);
					}
				}
				return; // nothing to write while idle

			case 'close':
				this._blinkPhaseT += dt;
				this._blinkWeight = Math.min(1, this._blinkPhaseT / 0.08); // 80ms close
				if (this._blinkPhaseT >= 0.08) {
					this._blinkPhase = 'hold';
					this._blinkPhaseT = 0;
					this._blinkWeight = 1;
				}
				break;

			case 'hold':
				this._blinkPhaseT += dt;
				if (this._blinkPhaseT >= 0.04) {
					// 40ms hold
					this._blinkPhase = 'open';
					this._blinkPhaseT = 0;
				}
				break;

			case 'open':
				this._blinkPhaseT += dt;
				this._blinkWeight = Math.max(0, 1 - this._blinkPhaseT / 0.12); // 120ms open
				if (this._blinkPhaseT >= 0.12) {
					this._blinkPhase = 'idle';
					this._blinkWeight = 0;
				}
				break;
		}

		for (let i = 0; i < this._morphMeshes.length; i++) {
			const m = this._morphMeshes[i];
			if (m.blinkL >= 0) m.mesh.morphTargetInfluences[m.blinkL] = this._blinkWeight;
			if (m.blinkR >= 0) m.mesh.morphTargetInfluences[m.blinkR] = this._blinkWeight;
		}
	}

	// ── Channel 4: Weight shift ──────────────────────────────────────────────────

	_tickWeightShift(dt) {
		if (!this._hipBone) return;
		this._weightPhase = (this._weightPhase + (dt * TWO_PI) / 8.0) % TWO_PI;
		const amplitude = 0.018 + this._uncertaintyBias * 0.025;
		this._hipBone.rotation.y = this._hipRestY + Math.sin(this._weightPhase) * amplitude;
	}

	// ── Utility ──────────────────────────────────────────────────────────────────

	/**
	 * Critically damped spring step — closed-form, no Euler drift.
	 * Writes [newPos, newVel] into this._springBuf (zero allocation).
	 * @param {number} pos     Current position
	 * @param {number} vel     Current velocity
	 * @param {number} target  Rest position
	 * @param {number} omega   Natural frequency (stiffness^0.5)
	 * @param {number} dt
	 */
	_springStep(pos, vel, target, omega, dt) {
		const x0 = pos - target;
		const b = vel + omega * x0;
		const decay = Math.exp(-omega * dt);
		this._springBuf[0] = target + (x0 + b * dt) * decay;
		this._springBuf[1] = (b - omega * (x0 + b * dt)) * decay;
	}

	_randRange(min, max) {
		return min + this._rand() * (max - min);
	}
}
