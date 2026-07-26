// /walk — NPC companion avatars (Task 19)
//
// Populates the walk environment with a small cast of autonomous companions so
// the world feels alive even when you roam it alone. Each NPC is a *real*
// rigged GLB avatar from /avatars/, driven by the project's AnimationManager
// (the same idle / walk / wave / point clip library the player avatar uses),
// and steered by a tiny per-type finite-state machine:
//
//   greeter  — holds station near spawn; turns to face the player and waves +
//              speaks a greeting when they come within range, then settles.
//   wanderer — strolls a loop of waypoints, pausing to idle between legs.
//   guide    — leads toward a landmark: walks ahead, slows/waits when the
//              player lags, points + narrates on arrival, then picks a new one.
//
// Dialogue is real and per-environment, loaded from
// public/environments/<env>/dialogue.json. When a line is spoken a token-styled
// speech bubble is projected above the NPC's head and (best-effort) voiced via
// the real /api/tts/speak endpoint — failures degrade silently to text only.
//
// The host (src/walk.js) owns spawn/despawn around environment swaps. Every
// GLB, mixer, material, and DOM node an NPC creates is released on despawn so
// swapping worlds never leaks geometry or audio.

import { Box3, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationManager } from './animation-manager.js';
import { log } from './shared/log.js';

// ── Clip names (must exist in /animations/clips + the manifest) ────────────
const CLIP_IDLE = 'idle';
const CLIP_WALK = 'av-walk-feminine';
const CLIP_WAVE = 'wave';
const CLIP_POINT = 'reaction'; // the registry-sanctioned "point" clip (see walk-gestures)

// ── Tuning ─────────────────────────────────────────────────────────────────
const MAX_NPCS = 4; // hard cap regardless of config length
const NPC_WALK_SPEED = 1.25; // m/s — a relaxed stroll, slower than the player
const NPC_NATURAL_WALK_SPEED = 1.5; // matches walk.js clip cadence for foot-plant sync
const NPC_TURN_LERP = 0.14; // facing smoothing toward heading
const GREET_RANGE = 4.0; // m — player enters → greeter waves + speaks
const GREET_RELEASE = 6.0; // m — hysteresis so the greeting doesn't retrigger on the edge
const GREET_COOLDOWN = 9.0; // s — minimum gap between a greeter's greetings
const WANDER_PAUSE = [1.8, 4.5]; // s — idle dwell range between wander legs
const WANDER_RADIUS = 8.5; // m — keep wander waypoints inside the walkable disc
const ARRIVE_DIST = 0.55; // m — "reached the waypoint" threshold
const GUIDE_WAIT_DIST = 6.5; // m — guide pauses if the player falls this far behind
const GUIDE_ARRIVE = 1.4; // m — guide considers a landmark reached
const GUIDE_NARRATE_COOLDOWN = 6.0; // s — min gap between guide narration lines
const SPEAK_COOLDOWN = 5.5; // s — global per-NPC speech throttle
const BUBBLE_DURATION = 4800; // ms — speech bubble lifetime
const BUBBLE_MAX_LEN = 120; // chars
const TTS_VOICE = 'alloy'; // a neutral catalog voice (api/_lib/tts-voices)

// Default NPC cast, used when an environment supplies no explicit `npcs`. Each
// references a real rigged GLB shipped in /public/avatars/. The greeter sits at
// spawn; the wanderer and guide get sensible roaming starts.
const DEFAULT_CAST = Object.freeze([
	{ type: 'greeter', avatarUrl: '/avatars/michelle.glb', pos: [2.4, 0, 2.4] },
	{ type: 'wanderer', avatarUrl: '/avatars/xbot.glb', pos: [-4.5, 0, 3.0] },
	{ type: 'guide', avatarUrl: '/avatars/realistic-female.glb', pos: [4.0, 0, -3.5] },
]);

// Landmarks the guide can lead toward when an environment defines none. These
// are points on the walkable disc (the world is a 12 m radius ground), spread
// so the guide always has somewhere coherent to go.
const DEFAULT_LANDMARKS = Object.freeze([
	{ name: 'the north overlook', pos: [0, 0, -8] },
	{ name: 'the east path', pos: [8, 0, 0] },
	{ name: 'the south clearing', pos: [0, 0, 8] },
	{ name: 'the west edge', pos: [-8, 0, 0] },
]);

const UP = new Vector3(0, 1, 0);

// Shortest-arc angle lerp (radians) — shared by every NPC's facing update.
function lerpAngle(a, b, t) {
	let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
	if (diff < -Math.PI) diff += Math.PI * 2;
	return a + diff * t;
}

function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

function randRange([lo, hi]) {
	return lo + Math.random() * (hi - lo);
}

// Per-URL GLTF template cache shared across NPCs so two NPCs on the same model
// fetch the GLB once. SkeletonUtils.clone() gives each NPC its own bone
// hierarchy from the shared template.
const _templateCache = new Map(); // url → Promise<THREE.Object3D>
function loadTemplate(url) {
	let p = _templateCache.get(url);
	if (!p) {
		const loader = new GLTFLoader();
		p = getMeshoptDecoder()
			.then((d) => loader.setMeshoptDecoder(d))
			.then(() => loader.loadAsync(url))
			.then((gltf) => gltf.scene);
		_templateCache.set(url, p);
	}
	return p;
}

// Sanitize NPC text for innerHTML insertion into the bubble.
function escapeHtml(s) {
	return String(s).replace(
		/[<>&"']/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * A single autonomous companion: a cloned GLB body, its own animation manager,
 * a token-styled speech bubble, and an FSM driven by `update(dt, ctx)`.
 */
class NPC {
	/**
	 * @param {object} cfg            { type, avatarUrl, pos:[x,y,z], name? }
	 * @param {object} deps           { scene, camera, renderer, getGroundY, dialogue, landmarks, animationDefs, ttsEnabled }
	 */
	constructor(cfg, deps) {
		this.type = cfg.type;
		this.avatarUrl = cfg.avatarUrl;
		this.name = cfg.name || NPC.defaultName(cfg.type);
		this.deps = deps;

		this.rig = new Group();
		const [px, py, pz] = cfg.pos || [0, 0, 0];
		this.rig.position.set(px, py, pz);
		this.spawn = new Vector3(px, py, pz);
		deps.scene.add(this.rig);

		this._body = null; // cloned skinned scene
		this._anim = new AnimationManager();
		this._ready = false;
		this._disposed = false;

		this.yaw = Math.random() * Math.PI * 2;
		this.rig.quaternion.setFromAxisAngle(UP, this.yaw);
		this.motion = 'idle'; // 'idle' | 'walk'
		this._supportsClips = false;

		// FSM bookkeeping.
		this.state = 'idle';
		this._stateTimer = 0;
		this._target = null; // Vector3 destination, or null
		this._lastSpeakAt = -Infinity;
		this._lastGreetAt = -Infinity;
		this._lastNarrateAt = -Infinity;
		this._playerInRange = false;
		this._wantWave = false;
		this._currentLandmark = null;

		// Speech bubble DOM (token-styled, projected each frame).
		this._bubble = null;
		this._bubbleTimer = null;

		// Floating name label.
		this._label = this._createLabel();

		// Scratch reused per-frame to avoid GC churn.
		this._scratchDir = new Vector3();
		this._scratchHead = new Vector3();

		this._build(cfg);
	}

	static defaultName(type) {
		if (type === 'greeter') return 'Iris';
		if (type === 'guide') return 'Atlas';
		return 'Nova';
	}

	async _build(cfg) {
		let template;
		try {
			template = await loadTemplate(cfg.avatarUrl);
		} catch (err) {
			log.warn('[walk-npcs] failed to load NPC avatar', cfg.avatarUrl, err?.message || err);
			return;
		}
		if (this._disposed) return;

		const body = cloneSkinnedScene(template);
		body.traverse((n) => {
			if (n.isMesh) {
				n.castShadow = true;
				n.receiveShadow = false;
				if (n.material && 'envMapIntensity' in n.material) n.material.envMapIntensity = 0.85;
			}
		});
		// Drop the body's feet onto the rig origin so y=0 is the ground.
		const box = new Box3().setFromObject(body);
		body.position.y -= box.min.y;
		this.rig.add(body);
		this._body = body;

		this._anim.attach(body, { avatarUrl: cfg.avatarUrl });
		this._anim.setAnimationDefs(this.deps.animationDefs);
		this._supportsClips = this._anim.supportsCanonicalClips();

		try {
			await this._anim.loadAll();
			if (this._disposed) return;
			await this._anim.crossfadeTo(CLIP_IDLE, 0);
		} catch (err) {
			log.warn('[walk-npcs] NPC animation load failed', cfg.avatarUrl, err?.message || err);
		}

		// Seed the FSM per type.
		if (this.type === 'wanderer') this._enterWander();
		else if (this.type === 'guide') this._enterGuide();
		else this._enterStation();

		this._ready = true;
	}

	// ── State entries ────────────────────────────────────────────────────────
	_enterStation() {
		this.state = 'station';
		this._target = null;
		this._setMotion('idle');
	}
	_enterWander() {
		this.state = 'wander';
		this._target = this._pickWanderPoint();
		this._setMotion('walk');
	}
	_enterWanderPause() {
		this.state = 'wander-pause';
		this._target = null;
		this._stateTimer = randRange(WANDER_PAUSE);
		this._setMotion('idle');
	}
	_enterGuide() {
		this.state = 'guide-lead';
		this._currentLandmark = this._pickLandmark();
		this._target = this._currentLandmark ? new Vector3(...this._currentLandmark.pos) : null;
		this._setMotion(this._target ? 'walk' : 'idle');
	}

	_pickWanderPoint() {
		const a = Math.random() * Math.PI * 2;
		const r = 2 + Math.random() * (WANDER_RADIUS - 2);
		return new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
	}

	_pickLandmark() {
		const list = this.deps.landmarks?.length ? this.deps.landmarks : DEFAULT_LANDMARKS;
		// Avoid immediately repeating the same landmark.
		let next = list[Math.floor(Math.random() * list.length)];
		if (list.length > 1 && this._currentLandmark && next.name === this._currentLandmark.name) {
			next = list[(list.indexOf(next) + 1) % list.length];
		}
		return next;
	}

	// ── Animation helpers ──────────────────────────────────────────────────
	_setMotion(motion) {
		if (motion === this.motion) return;
		this.motion = motion;
		if (!this._supportsClips) return;
		this._anim.crossfadeTo(motion === 'walk' ? CLIP_WALK : CLIP_IDLE, 0.22);
	}

	// Wave / point as an additive upper-body overlay so the legs keep their
	// locomotion. Falls back to a full crossfade only if the rig can't overlay.
	_playOverlay(clip) {
		if (!this._supportsClips) return;
		this._anim.playOverlay(clip, { loop: false, upperBodyOnly: true, crossfade: 0.2 });
	}

	// ── Per-frame FSM + locomotion ─────────────────────────────────────────
	/**
	 * @param {number} dt seconds
	 * @param {{ playerPos: Vector3 }} ctx live player state
	 */
	update(dt, ctx) {
		if (this._disposed) return;
		this._anim.update(dt);
		if (!this._ready) {
			this._positionLabel();
			this._positionBubble();
			return;
		}

		const playerPos = ctx.playerPos;
		const distToPlayer = this.rig.position.distanceTo(playerPos);

		switch (this.type) {
			case 'greeter':
				this._tickGreeter(dt, playerPos, distToPlayer);
				break;
			case 'wanderer':
				this._tickWanderer(dt);
				break;
			case 'guide':
				this._tickGuide(dt, playerPos, distToPlayer);
				break;
		}

		this._stepToward(dt);
		this._positionLabel();
		this._positionBubble();
	}

	_tickGreeter(dt, playerPos, dist) {
		// Always face the player when they're nearby so the greeter reads as
		// attentive rather than staring into space.
		if (dist < GREET_RELEASE) this._faceToward(playerPos);

		const now = performance.now() / 1000;
		if (!this._playerInRange && dist < GREET_RANGE) {
			this._playerInRange = true;
			if (now - this._lastGreetAt > GREET_COOLDOWN) {
				this._lastGreetAt = now;
				this._playOverlay(CLIP_WAVE);
				this._speak(this._line('greeter'));
			}
		} else if (this._playerInRange && dist > GREET_RELEASE) {
			this._playerInRange = false; // hysteresis — re-arm only after leaving
		}
		// Greeter never roams; it stays parked at its station in idle.
		this._target = null;
	}

	_tickWanderer(dt) {
		if (this.state === 'wander-pause') {
			this._stateTimer -= dt;
			if (this._stateTimer <= 0) this._enterWander();
			return;
		}
		if (!this._target) {
			this._enterWander();
			return;
		}
		const d = Math.hypot(
			this._target.x - this.rig.position.x,
			this._target.z - this.rig.position.z,
		);
		if (d < ARRIVE_DIST) this._enterWanderPause();
	}

	_tickGuide(dt, playerPos, dist) {
		const now = performance.now() / 1000;
		if (this.state === 'guide-wait') {
			// Stand and face the player until they catch back up.
			this._faceToward(playerPos);
			this._target = null;
			if (dist < GUIDE_WAIT_DIST - 1.5) {
				this.state = 'guide-lead';
				this._target = this._currentLandmark
					? new Vector3(...this._currentLandmark.pos)
					: null;
				this._setMotion(this._target ? 'walk' : 'idle');
			}
			return;
		}

		// Leading: if the player drops too far back, hold position and wait.
		if (dist > GUIDE_WAIT_DIST) {
			this.state = 'guide-wait';
			this._target = null;
			this._setMotion('idle');
			if (now - this._lastNarrateAt > GUIDE_NARRATE_COOLDOWN) {
				this._lastNarrateAt = now;
				this._speak(this._line('guide-wait'));
			}
			return;
		}

		const lm = this._currentLandmark;
		if (!lm) {
			this._enterGuide();
			return;
		}
		const reached =
			Math.hypot(lm.pos[0] - this.rig.position.x, lm.pos[2] - this.rig.position.z) <
			GUIDE_ARRIVE;
		if (reached) {
			// Arrived: face the player, point at the landmark, narrate, then move on.
			this._faceToward(playerPos);
			this._setMotion('idle');
			this._target = null;
			if (now - this._lastNarrateAt > GUIDE_NARRATE_COOLDOWN) {
				this._lastNarrateAt = now;
				this._playOverlay(CLIP_POINT);
				this._speak(this._line('guide-arrive', { landmark: lm.name }));
			}
			this.state = 'guide-pause';
			this._stateTimer = 3.2;
			return;
		}
		if (this.state === 'guide-pause') {
			this._stateTimer -= dt;
			if (this._stateTimer <= 0) this._enterGuide();
			return;
		}
		// Keep leading toward the landmark; stay ahead of the player.
		this._target = new Vector3(lm.pos[0], 0, lm.pos[2]);
		this._setMotion('walk');
	}

	// Move toward `_target` on the XZ plane at NPC_WALK_SPEED, snapping Y to the
	// ground each frame, and sync clip cadence to actual speed so feet plant.
	_stepToward(dt) {
		if (!this._target) {
			this._snapGround();
			this._syncCadence(0);
			return;
		}
		const dir = this._scratchDir.set(
			this._target.x - this.rig.position.x,
			0,
			this._target.z - this.rig.position.z,
		);
		const dist = dir.length();
		if (dist < 1e-3) {
			this._snapGround();
			this._syncCadence(0);
			return;
		}
		dir.normalize();
		const step = Math.min(NPC_WALK_SPEED * dt, dist);
		this.rig.position.x += dir.x * step;
		this.rig.position.z += dir.z * step;
		// Keep inside the walkable disc.
		const r = Math.hypot(this.rig.position.x, this.rig.position.z);
		if (r > WANDER_RADIUS + 2) {
			const k = (WANDER_RADIUS + 2) / r;
			this.rig.position.x *= k;
			this.rig.position.z *= k;
		}
		this._snapGround();

		// Face the direction of travel.
		const wantYaw = Math.atan2(dir.x, dir.z);
		this.yaw = lerpAngle(this.yaw, wantYaw, NPC_TURN_LERP);
		this.rig.quaternion.setFromAxisAngle(UP, this.yaw);
		this._syncCadence(step / dt);
	}

	_faceToward(target) {
		const dx = target.x - this.rig.position.x;
		const dz = target.z - this.rig.position.z;
		if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
		const wantYaw = Math.atan2(dx, dz);
		this.yaw = lerpAngle(this.yaw, wantYaw, NPC_TURN_LERP);
		this.rig.quaternion.setFromAxisAngle(UP, this.yaw);
	}

	_snapGround() {
		const y = this.deps.getGroundY?.(this.rig.position.x, this.rig.position.z);
		if (typeof y === 'number' && Number.isFinite(y)) this.rig.position.y = y;
	}

	// Match the walk clip's timeScale to actual ground speed (mirrors walk.js so
	// the NPC doesn't appear to skate). Idle holds timeScale at 1.
	_syncCadence(speed) {
		const mixer = this._anim.mixer;
		if (!mixer) return;
		mixer.timeScale =
			this.motion === 'walk' ? clamp(speed / NPC_NATURAL_WALK_SPEED, 0.5, 1.6) : 1.0;
	}

	// ── Dialogue ───────────────────────────────────────────────────────────
	// Pull a real line from the environment's dialogue table for this slot.
	// Falls back to a coin-agnostic generic line if a slot is empty so an NPC
	// never speaks an empty bubble.
	_line(slot, vars = {}) {
		const table = this.deps.dialogue || {};
		const pool = Array.isArray(table[slot]) && table[slot].length ? table[slot] : null;
		const generic = NPC._GENERIC[slot] || NPC._GENERIC.greeter;
		const src = pool || generic;
		let line = src[Math.floor(Math.random() * src.length)];
		for (const [k, v] of Object.entries(vars)) {
			line = line.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
		}
		return line;
	}

	_speak(text) {
		if (!text) return;
		const now = performance.now() / 1000;
		if (now - this._lastSpeakAt < SPEAK_COOLDOWN) return;
		this._lastSpeakAt = now;
		this._showBubble(text);
		if (this.deps.ttsEnabled) this._voice(text);
	}

	// Best-effort TTS through the real /api/tts/speak endpoint. Any failure
	// (rate limit, no provider, offline) degrades silently to the text bubble.
	async _voice(text) {
		try {
			const res = await fetch('/api/tts/speak', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: text.slice(0, 240), voice: TTS_VOICE, format: 'mp3' }),
			});
			if (!res.ok) return;
			const buf = await res.arrayBuffer();
			if (this._disposed || !buf.byteLength) return;
			const blob = new Blob([buf], { type: res.headers.get('content-type') || 'audio/mpeg' });
			const url = URL.createObjectURL(blob);
			const audio = new Audio(url);
			audio.volume = 0.85;
			audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
			// Autoplay may be blocked until the user interacts; the catch keeps it quiet.
			audio.play().catch(() => URL.revokeObjectURL(url));
		} catch {
			/* network/provider unavailable — bubble already shows the line */
		}
	}

	// ── Speech bubble (token-styled, projected) ─────────────────────────────
	_showBubble(text) {
		const clean = escapeHtml(text).slice(0, BUBBLE_MAX_LEN);
		if (!this._bubble) this._bubble = this._createBubble();
		this._bubbleText.innerHTML = clean;
		this._bubble.style.display = '';
		// Re-trigger the enter transition.
		this._bubble.style.opacity = '0';
		this._bubble.style.transform = 'translate(-50%,-100%) scale(0.7)';
		requestAnimationFrame(() => {
			if (!this._bubble) return;
			this._bubble.style.opacity = '1';
			this._bubble.style.transform = 'translate(-50%,-100%) scale(1)';
		});
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => {
			if (!this._bubble) return;
			this._bubble.style.opacity = '0';
			this._bubble.style.transform = 'translate(-50%,-100%) scale(0.85)';
		}, BUBBLE_DURATION);
	}

	_createBubble() {
		const wrap = document.createElement('div');
		wrap.className = 'walk-npc-bubble';
		wrap.setAttribute('role', 'status');
		wrap.setAttribute('aria-live', 'polite');
		wrap.style.cssText = [
			'position:fixed',
			'z-index:4',
			'pointer-events:none',
			'max-width:220px',
			'padding:8px 13px',
			'background:var(--surface-glass, rgba(10,10,10,0.82))',
			'color:var(--text-1, #fafafa)',
			'border:1px solid var(--border-1, rgba(255,255,255,0.12))',
			'border-radius:var(--radius-lg, 14px)',
			'backdrop-filter:blur(8px)',
			'-webkit-backdrop-filter:blur(8px)',
			'font-family:inherit',
			'font-size:var(--text-sm, 12px)',
			'line-height:1.45',
			'word-break:break-word',
			'white-space:pre-wrap',
			'transform:translate(-50%,-100%) scale(0.7)',
			'opacity:0',
			'transition:opacity 0.25s ease, transform 0.25s ease',
			'will-change:transform,opacity',
		].join(';');
		this._bubbleText = document.createElement('span');
		wrap.appendChild(this._bubbleText);
		// A small speaker name caption so it's clear who is talking.
		const cap = document.createElement('span');
		cap.textContent = this.name;
		cap.style.cssText =
			'display:block;margin-top:3px;font-size:var(--text-2xs,11px);opacity:0.55;font-weight:600;letter-spacing:0.02em';
		wrap.appendChild(cap);
		// Arrow.
		const arrow = document.createElement('div');
		arrow.style.cssText = [
			'position:absolute',
			'bottom:-6px',
			'left:50%',
			'transform:translateX(-50%)',
			'width:0',
			'height:0',
			'border-left:6px solid transparent',
			'border-right:6px solid transparent',
			'border-top:6px solid var(--bg-0, rgba(10,10,10,0.82))',
		].join(';');
		wrap.appendChild(arrow);
		document.body.appendChild(wrap);
		return wrap;
	}

	_createLabel() {
		const el = document.createElement('div');
		el.className = 'walk-npc-label';
		el.textContent = this.name;
		el.style.cssText = [
			'position:fixed',
			'z-index:3',
			'left:0',
			'top:0',
			'pointer-events:none',
			'padding:2px 8px',
			'border-radius:var(--radius-pill, 999px)',
			'background:rgba(10,10,10,0.55)',
			'border:1px solid var(--border-1, rgba(255,255,255,0.12))',
			'color:var(--text-2, rgba(255,255,255,0.78))',
			'font-family:inherit',
			'font-size:var(--text-2xs, 11px)',
			'font-weight:600',
			'white-space:nowrap',
			'transform:translate(-50%,-100%)',
			'backdrop-filter:blur(6px)',
			'-webkit-backdrop-filter:blur(6px)',
		].join(';');
		document.body.appendChild(el);
		return el;
	}

	_headScreen() {
		const head = this._scratchHead.set(
			this.rig.position.x,
			this.rig.position.y + 2.05,
			this.rig.position.z,
		);
		head.project(this.deps.camera);
		const onScreen = head.z > -1 && head.z < 1;
		const w = this.deps.renderer.domElement.clientWidth;
		const h = this.deps.renderer.domElement.clientHeight;
		return {
			onScreen,
			x: (head.x * 0.5 + 0.5) * w,
			y: (-head.y * 0.5 + 0.5) * h,
		};
	}

	_positionLabel() {
		if (!this._label) return;
		const s = this._headScreen();
		if (!s.onScreen) {
			this._label.style.display = 'none';
			return;
		}
		this._label.style.display = '';
		this._label.style.transform = `translate(-50%,-100%) translate(${s.x}px, ${s.y - 6}px)`;
	}

	_positionBubble() {
		if (!this._bubble || this._bubble.style.display === 'none') return;
		const s = this._headScreen();
		if (!s.onScreen) {
			this._bubble.style.display = 'none';
			return;
		}
		this._bubble.style.left = `${s.x}px`;
		this._bubble.style.top = `${s.y - 30}px`;
	}

	dispose() {
		this._disposed = true;
		clearTimeout(this._bubbleTimer);
		try {
			this._anim.dispose();
		} catch (e) {
			log.warn('[walk-npcs] anim dispose failed:', e);
		}
		if (this._body) {
			disposeObject3D(this._body);
			this.rig.remove(this._body);
			this._body = null;
		}
		this.deps.scene.remove(this.rig);
		this._label?.remove();
		this._bubble?.remove();
		this._label = null;
		this._bubble = null;
	}
}

// Coin-agnostic fallback dialogue, used when an environment ships no line for a
// slot. No coin is referenced anywhere — these are pure ambience.
NPC._GENERIC = Object.freeze({
	greeter: [
		'Hey there — welcome in. Take a look around.',
		'Good to see you. Wander wherever you like.',
		'Welcome! The whole space is open to explore.',
	],
	'guide-wait': [
		'Take your time — I will wait here.',
		'No rush. I will hold up for you.',
		'I will pause here until you catch up.',
	],
	'guide-arrive': [
		'Here we are — {landmark}.',
		'This is {landmark}. Worth a look.',
		'And this is {landmark}.',
	],
});

/** Recursively dispose geometry + materials of a subtree (mirrors walk.js). */
function disposeObject3D(root) {
	root.traverse((n) => {
		if (n.isMesh) {
			n.geometry?.dispose?.();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			for (const mat of mats) {
				if (!mat) continue;
				for (const v of Object.values(mat)) {
					if (v && v.isTexture) v.dispose();
				}
				mat.dispose?.();
			}
		}
	});
}

/**
 * The NPC system the host (src/walk.js) owns: it spawns a capped cast for the
 * current environment, drives every NPC's FSM from the render tick, and tears
 * the cast down (GLB + mixer + DOM) on environment swap.
 *
 * @param {object} opts
 * @param {THREE.Scene}        opts.scene
 * @param {THREE.Camera}       opts.camera
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {(x:number,z:number)=>number} opts.getGroundY   terrain height sampler
 * @param {Array}              opts.animationDefs          shared clip defs (idle/walk/wave/reaction must be present)
 * @param {boolean}           [opts.ttsEnabled=true]      whether NPCs voice their lines
 */
export function createWalkNpcs(opts) {
	const { scene, camera, renderer, getGroundY, animationDefs } = opts;
	let ttsEnabled = opts.ttsEnabled !== false;

	/** @type {NPC[]} */
	let npcs = [];
	let enabled = true;
	const _playerPos = new Vector3();

	// Ensure the clips NPCs need are registered in the shared defs. The host's
	// defs already carry idle/walk; gesture defs (wave/reaction) are appended by
	// the gesture system, but NPCs may spawn before the user opens gestures — so
	// guarantee them here.
	function ensureNpcClipDefs() {
		const need = [
			{ name: CLIP_WAVE, url: `/animations/clips/${CLIP_WAVE}.json`, loop: false },
			{ name: CLIP_POINT, url: `/animations/clips/${CLIP_POINT}.json`, loop: false },
		];
		for (const def of need) {
			if (!animationDefs.some((d) => d.name === def.name)) animationDefs.push(def);
		}
	}

	/**
	 * Spawn the cast for an environment. Despawns any existing cast first.
	 * @param {object} env  { cast?:Array, landmarks?:Array, dialogue?:object }
	 */
	function spawn(env = {}) {
		despawn();
		if (!enabled) return;
		ensureNpcClipDefs();

		const cast = (Array.isArray(env.cast) && env.cast.length ? env.cast : DEFAULT_CAST).slice(
			0,
			MAX_NPCS,
		);
		const landmarks = Array.isArray(env.landmarks) && env.landmarks.length ? env.landmarks : null;
		const dialogue = env.dialogue || {};

		for (const cfg of cast) {
			if (!cfg?.avatarUrl || !cfg?.type) continue;
			npcs.push(
				new NPC(cfg, {
					scene,
					camera,
					renderer,
					getGroundY,
					dialogue,
					landmarks,
					animationDefs,
					ttsEnabled,
				}),
			);
		}
	}

	function despawn() {
		for (const npc of npcs) npc.dispose();
		npcs = [];
	}

	/**
	 * Advance every NPC. Call from the render tick.
	 * @param {number} dt
	 * @param {{x:number,y:number,z:number}} playerPos
	 */
	function update(dt, playerPos) {
		if (!enabled || npcs.length === 0) return;
		_playerPos.set(playerPos.x, playerPos.y, playerPos.z);
		for (const npc of npcs) npc.update(dt, { playerPos: _playerPos });
	}

	function setEnabled(on) {
		enabled = !!on;
		if (!enabled) despawn();
	}
	function isEnabled() {
		return enabled;
	}
	function setTtsEnabled(on) {
		ttsEnabled = !!on;
		for (const npc of npcs) npc.deps.ttsEnabled = ttsEnabled;
	}
	function count() {
		return npcs.length;
	}

	// Live world positions of the spawned cast; the host's radar draws these
	// as POI blips so companions are findable when they wander off-screen.
	function positions() {
		const out = [];
		for (const n of npcs) {
			if (n._disposed) continue;
			out.push({ x: n.rig.position.x, z: n.rig.position.z, label: n.name });
		}
		return out;
	}

	return { spawn, despawn, update, setEnabled, isEnabled, setTtsEnabled, count, positions };
}
