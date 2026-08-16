// /agora player mode — "Enter the Commons". The embodied, GTA-style layer over
// the spectator scaffold: your real avatar walks Times Square among the citizen
// NPCs (who keep living their real on-chain economy — claiming, working,
// proving, earning), other humans appear live over the shared multiplayer
// server, and walking up to any citizen offers a proximity interaction that
// opens their living passport (inspect → hire → vouch, via the existing
// me-hud/passport stack).
//
// Loaded LAZILY by agora-world.js the moment the visitor enters play mode, so
// the watchable Commons never pays for colyseus.js or nipplejs up front.
//
// Reuses, never reinvents:
//   • avatar loading + clips      → src/game/avatar-rig.js (same rig as /city, /play)
//   • multiplayer client          → src/walk-net.js (room 'agora_world', graceful solo)
//   • nameplates                  → buildLabelSprite from citizen-avatar.js
//   • movement/collision math     → player-logic.js (pure, unit-tested)
//   • interaction surface         → the existing passport/me-hud event bus
//
// The room is a dedicated 'agora_world' (multiplayer/src/rooms/AgoraRoom.js) —
// NOT a walk_world coin shard: the Commons is city-scale (±680 m) and WalkRoom's
// anti-cheat clamps assume a 60 m plaza. If the server is unreachable (or the
// room isn't deployed yet) the square stays fully playable solo — the NPCs'
// economy never depended on the presence socket.

import * as THREE from 'three';
import {
	loadManifest, resolveAvatarUrl, buildAvatar, newAnim,
	CLIP_IDLE, CLIP_WALK,
} from '../game/avatar-rig.js';
import { WalkNet } from '../walk-net.js';
import { buildLabelSprite, citizenProfessionLabel } from './citizen-avatar.js';
import { CITY_HALF } from '../city/city-map.js';
import {
	JUMP_VEL, GRAVITY,
	motionFor, stepMovement, easeYaw, resolveBuildingCollision,
	nearestInteractable, chooseAvatarSource, guestName, findOpenSpawn,
} from './player-logic.js';
import { injectPlayerCss } from './player-mode.css.js';
import { mountOnchainPresence } from './onchain-presence.js';
import { log } from '../shared/log.js';

const BOUNDS = CITY_HALF - 20; // matches the spectator PAN_BOUNDS — one world edge
const SPAWN = { x: 3.5, z: -2.5 }; // beside the job board, facing the square
const REMOTE_LERP = 0.22; // exponential-lerp factor toward 15 Hz snapshots
const PROXIMITY_HZ = 5; // interactable scan rate
const BUBBLE_MS = 5200; // how long a chat bubble hangs over a head
const CHAT_LOG_MAX = 6;

// ── Local player ─────────────────────────────────────────────────────────────

class AgoraPlayer {
	constructor(scene) {
		this._scene = scene;
		this.rig = new THREE.Group();
		scene.add(this.rig);
		this.velocity = new THREE.Vector3();
		this.onGround = true;
		this.motion = 'idle';
		this.height = 1.7;
		this._anim = null;
		this._targetYaw = 0;
		this._jumpQueued = false;
		// Analogue input the keyboard and the touch stick both write into.
		this.stick = { forward: 0, strafe: 0, running: false };
		this._keys = new Set();
	}

	async load(avatarInput, spawn = SPAWN) {
		await loadManifest();
		const url = await resolveAvatarUrl(avatarInput || '');
		this._anim = newAnim();
		// Locomotion clips only: entering the square must never wait on the full
		// emote library (dozens of clip downloads) — emotes lazy-load on use.
		const { height, fallback } = await buildAvatar(this.rig, url, this._anim, { clips: 'locomotion' });
		this.height = height;
		this.rig.position.set(spawn.x, 0, spawn.z);
		return { url, fallback };
	}

	queueJump() { this._jumpQueued = true; }

	// Merge keyboard state into the analogue stick each frame (keyboard is ±1).
	_input() {
		const k = this._keys;
		let forward = this.stick.forward;
		let strafe = this.stick.strafe;
		if (k.has('w') || k.has('arrowup')) forward = 1;
		if (k.has('s') || k.has('arrowdown')) forward = -1;
		if (k.has('a') || k.has('arrowleft')) strafe = -1;
		if (k.has('d') || k.has('arrowright')) strafe = 1;
		const running = this.stick.running || k.has('shift');
		return { forward, strafe, running };
	}

	update(dt, buildingBoxes, cameraYaw) {
		const input = this._input();
		const step = stepMovement({
			input, cameraYaw, running: input.running,
			vx: this.velocity.x, vz: this.velocity.z, yaw: this._targetYaw, dt,
		});
		this.velocity.x = step.vx;
		this.velocity.z = step.vz;
		if (step.moving) this._targetYaw = step.yaw;

		if (this._jumpQueued && this.onGround) {
			this.velocity.y = JUMP_VEL;
			this.onGround = false;
		}
		this._jumpQueued = false;
		if (!this.onGround) this.velocity.y += GRAVITY * dt;

		const p = this.rig.position;
		let nx = p.x + this.velocity.x * dt;
		let ny = p.y + this.velocity.y * dt;
		const nz0 = p.z + this.velocity.z * dt;
		const resolved = resolveBuildingCollision(nx, ny, nz0, buildingBoxes);
		nx = resolved.x;
		let nz = resolved.z;

		if (ny <= 0) { ny = 0; this.velocity.y = 0; this.onGround = true; }
		else this.onGround = false;

		nx = Math.max(-BOUNDS, Math.min(BOUNDS, nx));
		nz = Math.max(-BOUNDS, Math.min(BOUNDS, nz));
		p.set(nx, ny, nz);

		this.rig.rotation.y = easeYaw(this.rig.rotation.y, this._targetYaw, dt);

		const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
		const next = motionFor(hSpeed, input.running);
		if (next !== this.motion) {
			this.motion = next;
			// The clip set is idle + walk; running is the walk clip driven faster.
			const clip = next === 'idle' ? CLIP_IDLE : CLIP_WALK;
			this._anim?.crossfadeTo(clip, 0.2).catch(() => {});
		}
		this._anim?.update(dt);
	}

	get position() { return this.rig.position; }

	dispose() {
		this._scene.remove(this.rig);
		disposeObject(this.rig);
	}
}

// ── Remote players (the other humans in the square) ─────────────────────────

class RemotePlayers {
	constructor(scene, bubblesEl) {
		this._scene = scene;
		this._bubbles = bubblesEl;
		this._byId = new Map(); // sessionId → entry
	}

	get count() { return this._byId.size; }

	upsert(player, sessionId) {
		let entry = this._byId.get(sessionId);
		if (entry && entry.avatarUrl !== (player.avatar || '')) {
			// Live avatar swap: rebuild rather than patch a half-loaded rig.
			this.remove(sessionId);
			entry = null;
		}
		if (!entry) {
			entry = this._create(player, sessionId);
			this._byId.set(sessionId, entry);
		}
		entry.target.x = player.x;
		entry.target.y = player.y;
		entry.target.z = player.z;
		entry.target.yaw = player.yaw;
		const motion = player.motion === 'idle' ? 'idle' : 'walk';
		if (motion !== entry.motion && entry.anim) {
			entry.motion = motion;
			entry.anim.crossfadeTo(motion === 'idle' ? CLIP_IDLE : CLIP_WALK, 0.2).catch(() => {});
		} else {
			entry.motion = motion;
		}
		return entry;
	}

	_create(player, sessionId) {
		const group = new THREE.Group();
		group.position.set(player.x, player.y, player.z);
		this._scene.add(group);
		const entry = {
			sessionId,
			group,
			anim: null,
			avatarUrl: player.avatar || '',
			name: player.name || 'visitor',
			target: { x: player.x, y: player.y, z: player.z, yaw: player.yaw },
			motion: 'idle',
			height: 1.7,
			bubbleEl: null,
			bubbleUntil: 0,
			gone: false,
		};
		// Async body load; the entry is live (and lerping) before the GLB lands.
		(async () => {
			const anim = newAnim();
			const { height } = await buildAvatar(group, player.avatar || '', anim, { clips: 'locomotion' });
			if (entry.gone) { disposeObject(group); return; }
			entry.anim = anim;
			entry.height = height;
			const accent = `#${(Number(player.color) >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
			const label = buildLabelSprite(entry.name, 'visitor', accent);
			label.position.y = height + 0.42;
			group.add(label);
		})().catch((err) => log.warn('[agora-play] remote avatar failed', err?.message));
		return entry;
	}

	remove(sessionId) {
		const entry = this._byId.get(sessionId);
		if (!entry) return;
		entry.gone = true;
		this._byId.delete(sessionId);
		this._scene.remove(entry.group);
		disposeObject(entry.group);
		entry.bubbleEl?.remove();
	}

	say(sessionId, text) {
		const entry = this._byId.get(sessionId);
		if (!entry) return;
		if (!entry.bubbleEl) {
			entry.bubbleEl = document.createElement('div');
			entry.bubbleEl.className = 'agora-p-bubble';
			this._bubbles.appendChild(entry.bubbleEl);
		}
		entry.bubbleEl.textContent = String(text || '').slice(0, 200);
		entry.bubbleUntil = performance.now() + BUBBLE_MS;
	}

	tick(dt, camera, viewW, viewH) {
		const k = 1 - Math.pow(1 - REMOTE_LERP, dt * 60);
		for (const entry of this._byId.values()) {
			const p = entry.group.position;
			p.x += (entry.target.x - p.x) * k;
			p.y += (entry.target.y - p.y) * k;
			p.z += (entry.target.z - p.z) * k;
			entry.group.rotation.y = easeYaw(entry.group.rotation.y, entry.target.yaw, dt, 10);
			entry.anim?.update(dt);

			// Project the speech bubble (screen-space DOM) over the head.
			if (entry.bubbleEl) {
				if (performance.now() > entry.bubbleUntil) {
					entry.bubbleEl.remove();
					entry.bubbleEl = null;
				} else {
					_v.set(p.x, p.y + entry.height + 0.55, p.z).project(camera);
					if (_v.z > 1) {
						entry.bubbleEl.style.display = 'none';
					} else {
						entry.bubbleEl.style.display = '';
						entry.bubbleEl.style.left = `${(_v.x * 0.5 + 0.5) * viewW}px`;
						entry.bubbleEl.style.top = `${(-_v.y * 0.5 + 0.5) * viewH}px`;
					}
				}
			}
		}
	}

	// Drop every remote (freeing rigs + bubbles). Used on a reconnect: while the
	// socket was down, peers may have left without a `remove` event (walk-net's
	// _closeRoom drops all listeners), so on rejoin their entries would linger as
	// motionless ghosts. Clearing here lets onAdd repopulate only who's actually
	// present. The object stays usable — the map is simply emptied.
	clear() {
		for (const id of [...this._byId.keys()]) this.remove(id);
	}

	dispose() {
		this.clear();
	}
}

const _v = new THREE.Vector3();

function disposeObject(root) {
	root.traverse((n) => {
		if (n.isMesh || n.isSkinnedMesh) {
			n.geometry?.dispose?.();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			for (const m of mats) {
				if (!m) continue;
				for (const key of Object.keys(m)) {
					const val = m[key];
					if (val && val.isTexture) val.dispose();
				}
				m.dispose?.();
			}
		}
		if (n.isSprite) {
			n.material?.map?.dispose?.();
			n.material?.dispose?.();
		}
	});
}

// ── Mount ────────────────────────────────────────────────────────────────────

/**
 * Mount the playable layer.
 *
 * @param {object} ctx
 * @param {THREE.Scene}   ctx.scene
 * @param {THREE.Camera}  ctx.camera
 * @param {object}        ctx.population      CitizenPopulation (the NPC crowd)
 * @param {Array}         ctx.buildingBoxes   AABBs from buildCity
 * @param {() => number}  ctx.getCameraYaw    cityCamera.yaw supplier
 * @param {(id) => void}  ctx.openPassport    opens a citizen's passport panel
 * @returns {Promise<{update(dt):void, playerPosition:THREE.Vector3, playerHeight:number, dispose():void}>}
 */
export async function mountPlayerMode(ctx) {
	injectPlayerCss();
	const { scene, camera, population, buildingBoxes, getCameraYaw, openPassport } = ctx;

	// ── HUD scaffold (all states designed) ─────────────────────────────────────
	const root = el('div', 'agora-p-root');
	const bubbles = el('div', 'agora-p-bubbles');
	const prompt = el('button', 'agora-p-prompt');
	prompt.type = 'button';
	prompt.innerHTML = `<kbd>E</kbd><span class="agora-p-prompt-text"><span class="agora-p-prompt-title"></span><span class="agora-p-prompt-sub"></span></span>`;
	const presence = el('button', 'agora-p-presence');
	presence.type = 'button';
	presence.dataset.state = 'connecting';
	presence.innerHTML = `<span class="dot"></span><span class="agora-p-presence-text">connecting…</span>`;
	const chat = el('div', 'agora-p-chat');
	const chatLog = el('div', 'agora-p-chat-log');
	const chatRow = el('div', 'agora-p-chat-row');
	const chatInput = el('input', 'agora-p-chat-input');
	chatInput.placeholder = 'Say something to the square…';
	chatInput.maxLength = 200;
	chatInput.setAttribute('aria-label', 'Chat with other visitors');
	const chatSend = el('button', 'agora-p-chat-send');
	chatSend.type = 'button';
	chatSend.textContent = 'Send';
	chatRow.append(chatInput, chatSend);
	chat.append(chatLog, chatRow);
	const stickZone = el('div', 'agora-p-stick');
	const actions = el('div', 'agora-p-actions');
	const jumpBtn = el('button', 'agora-p-action-btn');
	jumpBtn.type = 'button';
	jumpBtn.textContent = 'JUMP';
	jumpBtn.setAttribute('aria-label', 'Jump');
	const interactBtn = el('button', 'agora-p-action-btn');
	interactBtn.type = 'button';
	interactBtn.textContent = 'E';
	interactBtn.setAttribute('aria-label', 'Interact with the nearest citizen');
	actions.append(interactBtn, jumpBtn);
	root.append(bubbles, prompt, presence, chat, stickZone, actions);
	document.body.appendChild(root);

	// On-chain (BNB) presence — OFF by default, opt-in toggle (prompt 16).
	// Purely additive: with it OFF, zero BNB code runs and this whole layer is
	// dormant scaffolding (a docked toggle button + an empty THREE.Group).
	const onchain = mountOnchainPresence({ scene, hudRoot: root, network: 'bscTestnet' });

	// ── Identity + avatar ──────────────────────────────────────────────────────
	const params = new URLSearchParams(location.search);
	const getStored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
	const setStored = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
	const avatarChoice = chooseAvatarSource(params, getStored);
	if (avatarChoice.source.startsWith('param')) setStored('agora:avatar', avatarChoice.value);
	const name = guestName(getStored, Math.random());
	setStored('agora:name', name);

	const player = new AgoraPlayer(scene);
	// Spawn on OPEN ground: the OSM Manhattan substrate is dense, so the nominal
	// spot beside the board can sit inside a building footprint (where the player
	// would be walled in the moment it tries to move). findOpenSpawn spirals out to
	// the nearest clear point so the visitor always starts able to walk to citizens.
	const spawn = findOpenSpawn(SPAWN, buildingBoxes);
	const { url: avatarUrl } = await player.load(avatarChoice.value, spawn);

	// ── Multiplayer presence (dedicated Commons room; graceful solo) ───────────
	const remotes = new RemotePlayers(scene, bubbles);
	const net = new WalkNet({ name, avatar: avatarUrl, room: 'agora_world' });
	const presenceText = presence.querySelector('.agora-p-presence-text');
	let wasOnline = false; // tracks online→down transitions so we clear ghosts once
	function renderPresence() {
		const state = net.status === 'online' ? 'online'
			: net.status === 'connecting' ? 'connecting'
			: net.status === 'unavailable' ? 'solo'
			: 'offline';
		// Left the live room (drop / reconnect): peers may have departed during the
		// gap with no `remove` event, so drop every remote now. onAdd repopulates
		// only who's actually present when the socket comes back — no ghost avatars.
		if (wasOnline && state !== 'online') remotes.clear();
		wasOnline = state === 'online';
		presence.dataset.state = state;
		if (state === 'online') {
			const n = remotes.count + 1;
			presenceText.textContent = `${n} ${n === 1 ? 'human' : 'humans'} in the square`;
			presence.removeAttribute('data-clickable');
			presence.title = '';
		} else if (state === 'connecting') {
			presenceText.textContent = 'connecting…';
			presence.removeAttribute('data-clickable');
		} else if (state === 'solo') {
			presenceText.textContent = 'solo square — citizens still at work';
			presence.removeAttribute('data-clickable');
			presence.title = 'No multiplayer server configured for this environment';
		} else {
			presenceText.textContent = 'solo — tap to reconnect';
			presence.setAttribute('data-clickable', '');
			presence.title = 'Reconnect to the shared square';
		}
	}
	const offStatus = net.on('status', renderPresence);
	const offAdd = net.on('add', (p, sessionId) => {
		if (sessionId === net.mySessionId) return;
		remotes.upsert(p, sessionId);
		renderPresence();
	});
	const offChange = net.on('change', (p, sessionId) => {
		if (sessionId === net.mySessionId) return;
		remotes.upsert(p, sessionId);
	});
	const offRemove = net.on('remove', (sessionId) => {
		remotes.remove(sessionId);
		renderPresence();
	});
	const offChat = net.on('chat', (msg) => {
		if (!msg || !msg.text) return;
		appendChatLine(msg.name || 'visitor', msg.text);
		if (msg.id && msg.id !== net.mySessionId) remotes.say(msg.id, msg.text);
	});
	presence.addEventListener('click', () => {
		if (presence.hasAttribute('data-clickable')) net.retry();
	});
	net.connect();

	function appendChatLine(who, text) {
		const line = el('div', 'agora-p-chat-line');
		const b = document.createElement('b');
		b.textContent = who;
		line.append(b, document.createTextNode(` ${String(text).slice(0, 200)}`));
		chatLog.appendChild(line);
		while (chatLog.children.length > CHAT_LOG_MAX) chatLog.firstChild.remove();
	}
	function sendChat() {
		const text = chatInput.value.trim();
		if (!text) return;
		if (net.status === 'online') {
			net.sendChat(text);
		} else {
			// Honest solo echo — your words still appear, marked as unheard.
			appendChatLine(`${name} (solo)`, text);
		}
		chatInput.value = '';
	}
	chatSend.addEventListener('click', sendChat);
	chatInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
		e.stopPropagation(); // typing must never move the avatar
	});

	// ── Input (keyboard) ───────────────────────────────────────────────────────
	const TRACKED = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);
	function typingSomewhere() {
		const ae = document.activeElement;
		return !!(ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable
			|| (ae.closest && ae.closest('.agora-passport, .agora-panel, .agora-h-root, [role="dialog"]'))));
	}
	const onKeyDown = (e) => {
		if (typingSomewhere()) return;
		const k = e.key.toLowerCase();
		if (k === ' ') { e.preventDefault(); player.queueJump(); return; }
		if (k === 'e') { interact(); return; }
		if (!TRACKED.has(k)) return;
		if (k.startsWith('arrow')) e.preventDefault();
		player._keys.add(k);
	};
	const onKeyUp = (e) => player._keys.delete(e.key.toLowerCase());
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	jumpBtn.addEventListener('click', () => player.queueJump());
	interactBtn.addEventListener('click', () => interact());
	prompt.addEventListener('click', () => interact());

	// ── Touch stick (lazy nipplejs — only where touch is the medium) ──────────
	let stickManager = null;
	let disposed = false; // set by dispose(); guards the async nipplejs import below
	if (window.matchMedia?.('(hover: none), (max-width: 640px)').matches) {
		import('nipplejs').then(({ default: nipplejs }) => {
			// Leaving play mode before this dynamic import resolved would otherwise
			// create a stick (with live listeners writing to a disposed player) that
			// dispose() already ran past — tear it down immediately instead.
			if (disposed) return;
			stickManager = nipplejs.create({
				zone: stickZone,
				mode: 'dynamic',
				color: '#6ea8ff',
				size: 110,
			});
			stickManager.on('move', (_e, data) => {
				const a = data.angle?.radian ?? 0;
				const f = Math.min(1, (data.distance || 0) / 55);
				player.stick.forward = Math.sin(a) * f;
				player.stick.strafe = Math.cos(a) * f;
				player.stick.running = f > 0.92; // full extension sprints
			});
			stickManager.on('end', () => {
				player.stick.forward = 0;
				player.stick.strafe = 0;
				player.stick.running = false;
			});
		}).catch((err) => log.warn('[agora-play] touch stick unavailable', err?.message));
	}

	// ── Proximity interaction (the NPC handshake) ──────────────────────────────
	let promptTarget = null;
	let proximityAccum = 0;
	function scanProximity() {
		const p = player.position;
		const candidates = [];
		for (const inst of population.instances || []) {
			const c = inst?.citizen;
			if (!c) continue;
			const pos = population.worldPosition(c.id);
			if (!pos) continue;
			candidates.push({
				id: c.id,
				kind: 'citizen',
				x: pos.x,
				z: pos.z,
				name: c.displayName || 'Citizen',
				profession: citizenProfessionLabel(c),
				busy: !!inst.busy, // live economy state — set when a real claim walks them to work
			});
		}
		const hit = nearestInteractable(p.x, p.z, candidates);
		if (hit?.id !== promptTarget?.id) {
			if (promptTarget) population.highlight(null);
			promptTarget = hit;
			if (hit) {
				population.highlight(hit.id);
				prompt.querySelector('.agora-p-prompt-title').textContent = `Meet ${hit.name}`;
				prompt.querySelector('.agora-p-prompt-sub').textContent = hit.busy
					? `${hit.profession} — busy on a job right now. See their live work.`
					: `${hit.profession} — open their living passport`;
				prompt.setAttribute('data-show', '');
				prompt.setAttribute('aria-label', `Interact with ${hit.name}, ${hit.profession}`);
			} else {
				prompt.removeAttribute('data-show');
			}
		}
	}
	function interact() {
		if (!promptTarget) return;
		openPassport(promptTarget.id);
	}

	// ── Per-frame update (driven by agora-world's single rAF) ─────────────────
	function update(dt) {
		player.update(dt, buildingBoxes, getCameraYaw());
		net.sendState({
			x: player.position.x,
			y: player.position.y,
			z: player.position.z,
			yaw: player.rig.rotation.y,
			motion: player.motion,
		});
		remotes.tick(dt, camera, window.innerWidth, window.innerHeight);
		onchain.update(dt, player.position, player.rig.rotation.y);
		proximityAccum += dt;
		if (proximityAccum >= 1 / PROXIMITY_HZ) {
			proximityAccum = 0;
			scanProximity();
		}
	}

	function dispose() {
		disposed = true; // stop a still-pending nipplejs import from creating a stick
		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);
		offStatus(); offAdd(); offChange(); offRemove(); offChat();
		try { stickManager?.destroy(); } catch { /* already gone */ }
		try { net.destroy(); } catch { /* already gone */ }
		remotes.dispose();
		onchain.dispose();
		if (promptTarget) population.highlight(null);
		player.dispose();
		root.remove();
	}

	renderPresence();
	return {
		update,
		get playerPosition() { return player.position; },
		get playerHeight() { return player.height; },
		dispose,
	};
}

function el(tag, className) {
	const node = document.createElement(tag);
	node.className = className;
	return node;
}
