// World Line AR ceremony — the in-AR (and first-class non-AR) completion experience.
//
// On approach, the agent appears at the anchored spot, SPEAKS the quest prompt (TTS),
// runs the interaction, and on success plays a reward beat. WebXR gives the immersive
// version: the avatar is anchored to the real floor via hit-test. Where WebXR is
// unavailable (most desktops, many iOS browsers), the SAME ceremony runs as a designed,
// fully-playable panel — never a dead end. Every state is rendered: speaking, awaiting
// the interaction, submitting, granted, already-completed, capacity-reached, expired,
// and error.
//
// The module owns NO secrets and trusts NO client state for the proof: it only drives UI
// + the agent's voice, and calls the server (challenge → complete) which does all the
// co-location, nonce, signature, cap, and idempotency enforcement.

import {
	Scene, PerspectiveCamera, WebGLRenderer, AmbientLight, DirectionalLight,
	RingGeometry, Mesh, MeshBasicMaterial, Group,
} from 'three';
import { getMeshoptDecoder } from '../viewer/internal.js';
import { mountPinIdle } from './pin-idle.js';

// ── Agent voice (TTS) ────────────────────────────────────────────────────────
let _voiceAudio = null;
// Speak `text` in the agent's voice. Best-effort: a missing/failed TTS upstream must
// never block the ceremony (the prompt is also shown on screen). Returns when playback
// finishes (or immediately on failure). Cancels any prior utterance.
export async function speakAsAgent(text, { voice = 'alloy', signal } = {}) {
	const clean = String(text || '').trim();
	if (!clean) return;
	stopAgentVoice();
	try {
		const r = await fetch('/api/tts/speak', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: clean.slice(0, 400), voice, format: 'mp3' }),
			signal,
		});
		if (!r.ok) return;
		const blob = await r.blob();
		const url = URL.createObjectURL(blob);
		await new Promise((resolve) => {
			const audio = new Audio(url);
			_voiceAudio = audio;
			audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
			audio.play().catch(() => { URL.revokeObjectURL(url); resolve(); });
		});
	} catch {
		/* speech is decoration — the prompt text is always visible */
	}
}
export function stopAgentVoice() {
	if (_voiceAudio) {
		try { _voiceAudio.pause(); } catch { /* ignore */ }
		_voiceAudio = null;
	}
}

// ── The ceremony state machine ───────────────────────────────────────────────
// Drives a container element through the completion flow. Pure DOM + the client; the
// optional AR layer is added by enterAR().
export class WorldLineCeremony {
	/**
	 * @param {object} opts
	 * @param {object} opts.worldLine  the quest (from getQuest/nearby): id, title, prompt, challenge, reward_*
	 * @param {object} opts.client     worldLinesClient
	 * @param {() => {lat:number,lng:number,accuracy?:number}} opts.getFix  current device fix
	 * @param {string} [opts.avatarUrl]  the agent avatar GLB (for the AR layer)
	 * @param {(proof:object, collectible:object)=>void} [opts.onGranted]
	 * @param {boolean} [opts.muted]    skip TTS (reduced-motion / user preference)
	 */
	constructor({ worldLine, client, getFix, avatarUrl, onGranted, muted = false }) {
		this.wl = worldLine;
		this.client = client;
		this.getFix = getFix;
		this.avatarUrl = avatarUrl || null;
		this.onGranted = onGranted || (() => {});
		this.muted = muted;
		this.nonce = null;
		this.container = null;
		this._ar = null;
	}

	mount(container) {
		this.container = container;
		container.classList.add('wl-ceremony');
		this._renderIntro();
		return this;
	}

	destroy() {
		stopAgentVoice();
		if (this._ar) { this._ar.end().catch(() => {}); this._ar = null; }
	}

	_set(html) { if (this.container) this.container.innerHTML = html; }

	async _speak(text) {
		if (this.muted) return;
		await speakAsAgent(text, { voice: this.wl?.voice || 'alloy' });
	}

	_renderIntro() {
		const w = this.wl;
		const arBtn = '';
		this._set(`
			<div class="wl-cer-card">
				<div class="wl-cer-agent">${this.avatarUrl
					? `<canvas class="wl-cer-canvas" aria-hidden="true"></canvas>`
					: `<div class="wl-cer-orb" aria-hidden="true"></div>`}</div>
				<h3 class="wl-cer-title">${esc(w.title)}</h3>
				<p class="wl-cer-prompt">${esc(w.prompt || 'Complete the agent’s challenge to earn your proof of presence.')}</p>
				<div class="wl-cer-actions">
					<button class="wl-btn wl-btn-primary" data-act="begin">Begin the encounter</button>
					${arBtn}
				</div>
				<p class="wl-cer-foot">You’re here — your device is co-located with the quest.</p>
			</div>`);
		this._wireIntro();
		if (this.avatarUrl) this._mountAvatarPreview();
	}

	_wireIntro() {
		const begin = this.container.querySelector('[data-act="begin"]');
		if (begin) begin.addEventListener('click', () => this._begin());
		const ar = this.container.querySelector('[data-act="ar"]');
		if (ar) ar.addEventListener('click', () => this.enterAR().catch(() => this._begin()));
	}

	async _begin() {
		// Acquire the single-use nonce (server re-checks co-location here).
		this._set(loadingCard('The agent is greeting you…'));
		const fix = this.getFix();
		if (!fix || !Number.isFinite(fix.lat)) return this._renderError('We need your location to complete the quest. Enable location and try again.', true);
		let ch;
		try {
			ch = await this.client.challenge(this.wl.id, fix.lat, fix.lng, fix.accuracy);
		} catch (err) {
			return this._handleApiError(err);
		}
		if (ch.already_completed) return this._renderAlready(ch.proof_id);
		this.nonce = ch.nonce;
		this.wl.challenge = ch.challenge || this.wl.challenge;
		// The agent speaks the prompt, then the interaction appears.
		this._renderInteraction();
		this._speak(this.wl.prompt || this.wl.title);
	}

	_renderInteraction() {
		const spec = this.wl.challenge || { kind: 'tap' };
		let body = '';
		if (spec.kind === 'quiz') {
			body = `
				<p class="wl-cer-q">${esc(spec.question || 'Answer the agent’s question:')}</p>
				<div class="wl-cer-choices" role="radiogroup" aria-label="Quiz choices">
					${(spec.choices || []).map((c, i) => `
						<button class="wl-choice" role="radio" aria-checked="false" data-i="${i}">${esc(c)}</button>`).join('')}
				</div>`;
		} else if (spec.kind === 'phrase') {
			body = `
				<p class="wl-cer-q">${esc(spec.prompt || 'Say the passphrase the agent asked for:')}</p>
				<input class="wl-input" type="text" inputmode="text" autocomplete="off"
					aria-label="Passphrase" placeholder="Type what the agent asked for" />
				<button class="wl-btn wl-btn-primary" data-act="submit">Tell the agent</button>`;
		} else {
			body = `
				<p class="wl-cer-q">${esc(spec.prompt || 'Reach out and meet the agent.')}</p>
				<button class="wl-btn wl-btn-primary wl-tap" data-act="submit">Tap to meet the agent</button>`;
		}
		this._set(`<div class="wl-cer-card"><div class="wl-cer-interaction">${body}</div>
			<p class="wl-cer-err" data-err hidden></p></div>`);
		this._wireInteraction(spec);
	}

	_wireInteraction(spec) {
		if (spec.kind === 'quiz') {
			this.container.querySelectorAll('.wl-choice').forEach((btn) => {
				btn.addEventListener('click', () => {
					this.container.querySelectorAll('.wl-choice').forEach((b) => b.setAttribute('aria-checked', 'false'));
					btn.setAttribute('aria-checked', 'true');
					this._submit({ answer: Number(btn.dataset.i) });
				});
			});
		} else if (spec.kind === 'phrase') {
			const input = this.container.querySelector('.wl-input');
			const submit = this.container.querySelector('[data-act="submit"]');
			const go = () => this._submit({ phrase: input?.value || '' });
			submit?.addEventListener('click', go);
			input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
			input?.focus();
		} else {
			this.container.querySelector('[data-act="submit"]')?.addEventListener('click', () => this._submit({}));
		}
	}

	async _submit(interaction) {
		const errEl = this.container.querySelector('[data-err]');
		const fix = this.getFix();
		if (!fix || !Number.isFinite(fix.lat)) return this._renderError('Lost your location. Move back to the spot and try again.', true);
		this._set(loadingCard('The agent is signing your proof of presence…'));
		let res;
		try {
			res = await this.client.complete(this.wl.id, this.nonce, fix.lat, fix.lng, fix.accuracy, interaction);
		} catch (err) {
			// A failed challenge (wrong answer) is recoverable — re-show the interaction.
			if (err.code === 'challenge_failed') {
				this._renderInteraction();
				const e = this.container.querySelector('[data-err]');
				if (e) { e.textContent = err.message; e.hidden = false; }
				return;
			}
			if (err.code === 'invalid_nonce') {
				// Expired/used challenge — restart cleanly.
				return this._renderError(err.message || 'Your challenge expired. Tap to try again.', true);
			}
			return this._handleApiError(err);
		}
		this._renderGranted(res.proof, res.collectible, res.already_completed);
	}

	_renderGranted(proof, collectible, already) {
		const verifyUrl = (proof && proof.verify_url) || (collectible && `/api/irl/world-lines/verify/${collectible.proof_id}`);
		stopAgentVoice();
		this._set(`
			<div class="wl-cer-card wl-granted">
				<div class="wl-reward-burst" aria-hidden="true"></div>
				<div class="wl-reward-badge">✦</div>
				<h3 class="wl-cer-title">${already ? 'You already hold this proof' : 'Proof of presence minted'}</h3>
				<p class="wl-cer-prompt">${esc(collectible?.name || 'Proof of presence')}</p>
				<dl class="wl-proof-meta">
					<div><dt>Signed by agent</dt><dd class="wl-mono">${esc(short(collectible?.signer_pubkey || proof?.signer_pubkey))}</dd></div>
					<div><dt>Collectible</dt><dd class="wl-mono">${esc(collectible?.mint || `presence:${proof?.id}`)}</dd></div>
				</dl>
				<div class="wl-cer-actions">
					<a class="wl-btn wl-btn-secondary" href="${verifyUrl}" target="_blank" rel="noopener">Verify the signature ↗</a>
					<button class="wl-btn wl-btn-primary" data-act="done">Done</button>
				</div>
				<p class="wl-cer-foot">Anyone can re-check this signature — it’s cryptographically real, bound only to a ~1&nbsp;km area.</p>
			</div>`);
		this.container.querySelector('[data-act="done"]')?.addEventListener('click', () => {
			this.onGranted(proof, collectible);
		});
		if (!already) this._speak('Proof minted. You were here.');
	}

	_renderAlready(proofId) {
		this._set(`
			<div class="wl-cer-card">
				<div class="wl-reward-badge wl-dim">✓</div>
				<h3 class="wl-cer-title">You’ve already completed this World Line</h3>
				<p class="wl-cer-prompt">Your proof of presence is already in your collection.</p>
				<div class="wl-cer-actions">
					<a class="wl-btn wl-btn-secondary" href="/api/irl/world-lines/verify/${proofId}" target="_blank" rel="noopener">Verify your proof ↗</a>
					<button class="wl-btn wl-btn-primary" data-act="done">Done</button>
				</div>
			</div>`);
		this.container.querySelector('[data-act="done"]')?.addEventListener('click', () => this.onGranted(null, null));
	}

	_handleApiError(err) {
		const code = err.code;
		if (code === 'capacity_reached') return this._renderError('This quest just reached its completion limit. The reward pool is full.', false);
		if (code === 'not_colocated') return this._renderError('Move closer to the quest’s spot to complete it.', true);
		if (code === 'fix_required') return this._renderError('We couldn’t confirm your location. Enable precise location and try again.', true);
		if (err.status === 404 || code === 'anchor_gone') return this._renderError('This World Line is no longer active.', false);
		return this._renderError(err.message || 'Something went wrong. Try again.', true);
	}

	_renderError(message, retry) {
		this._set(`
			<div class="wl-cer-card wl-cer-error">
				<div class="wl-reward-badge wl-err">!</div>
				<p class="wl-cer-prompt">${esc(message)}</p>
				<div class="wl-cer-actions">
					${retry ? '<button class="wl-btn wl-btn-primary" data-act="retry">Try again</button>' : ''}
					<button class="wl-btn wl-btn-secondary" data-act="done">Close</button>
				</div>
			</div>`);
		this.container.querySelector('[data-act="retry"]')?.addEventListener('click', () => this._renderIntro());
		this.container.querySelector('[data-act="done"]')?.addEventListener('click', () => this.onGranted(null, null));
	}

	// ── Optional 3D agent preview (non-AR) ─────────────────────────────────────
	async _mountAvatarPreview() {
		const canvas = this.container.querySelector('.wl-cer-canvas');
		if (!canvas || !this.avatarUrl) return;
		try {
			const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
			const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
			renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
			const size = 160;
			renderer.setSize(size, size, false);
			const scene = new Scene();
			scene.add(new AmbientLight(0xffffff, 1.1));
			const key = new DirectionalLight(0xffffff, 1.2); key.position.set(1, 2, 2); scene.add(key);
			const cam = new PerspectiveCamera(35, 1, 0.1, 100);
			cam.position.set(0, 1.4, 2.6);
			const root = new Group(); scene.add(root);
			const loader = new GLTFLoader();
			loader.setMeshoptDecoder(await getMeshoptDecoder());
			const gltf = await loader.loadAsync(this.avatarUrl);
			root.add(gltf.scene);
			gltf.scene.position.y = -1.2;
			// Breathe: play the retargeted idle clip so the quest agent greets you
			// mid-motion, not frozen in a bind-pose T. Null for unriggable models.
			const idleMgr = await mountPinIdle(gltf.scene, { avatarUrl: this.avatarUrl });
			let raf;
			let prevMs = performance.now();
			const tick = () => {
				const nowMs = performance.now();
				idleMgr?.update(Math.min((nowMs - prevMs) / 1000, 0.05));
				prevMs = nowMs;
				root.rotation.y += 0.01;
				renderer.render(scene, cam);
				raf = requestAnimationFrame(tick);
			};
			tick();
			this._previewStop = () => { cancelAnimationFrame(raf); idleMgr?.detach(); renderer.dispose(); };
		} catch {
			/* preview is decoration; the orb fallback already rendered */
		}
	}

	// ── Optional immersive AR layer (self-contained, decoupled from xr.js) ──────
	static async arSupported() {
		try { return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); }
		catch { return false; }
	}

	// Start a minimal immersive-AR session that anchors the agent to the real floor via
	// hit-test, then surfaces the same interaction. Any failure falls back to the panel
	// ceremony — AR is an enhancement, never the only path.
	async enterAR() {
		if (!(await WorldLineCeremony.arSupported())) return this._begin();
		try {
			const renderer = new WebGLRenderer({ alpha: true, antialias: true });
			renderer.xr.enabled = true;
			renderer.setSize(window.innerWidth, window.innerHeight);
			document.body.appendChild(renderer.domElement);
			const scene = new Scene();
			scene.add(new AmbientLight(0xffffff, 1.2));
			const cam = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 40);
			const reticle = new Mesh(
				new RingGeometry(0.09, 0.11, 32).rotateX(-Math.PI / 2),
				new MeshBasicMaterial({ color: 0xc4b5fd }),
			);
			reticle.visible = false; reticle.matrixAutoUpdate = false; scene.add(reticle);

			const root = new Group(); root.visible = false; scene.add(root);
			let arIdleMgr = null;
			import('three/addons/loaders/GLTFLoader.js').then(async ({ GLTFLoader }) => {
				if (!this.avatarUrl) return;
				const loader = new GLTFLoader();
				loader.setMeshoptDecoder(await getMeshoptDecoder());
				loader.loadAsync(this.avatarUrl).then(async (g) => {
					root.add(g.scene);
					// Idle in place on the real floor — same living treatment as /irl pins.
					arIdleMgr = await mountPinIdle(g.scene, { avatarUrl: this.avatarUrl });
				}).catch(() => {});
			});

			const overlay = document.createElement('div');
			overlay.className = 'wl-ar-overlay';
			overlay.innerHTML = `<div class="wl-ar-hint">Point at the floor and tap to meet the agent</div>
				<button class="wl-ar-exit" aria-label="Exit AR">Exit</button>`;
			document.body.appendChild(overlay);

			const session = await navigator.xr.requestSession('immersive-ar', {
				requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'local-floor'],
				domOverlay: { root: overlay },
			});
			renderer.xr.setReferenceSpaceType('local');
			await renderer.xr.setSession(session);

			const viewerSpace = await session.requestReferenceSpace('viewer');
			const refSpace = renderer.xr.getReferenceSpace();
			const hitSource = await session.requestHitTestSource({ space: viewerSpace });
			let placed = false;

			const end = async () => {
				try { await session.end(); } catch { /* already ending */ }
			};
			this._ar = { end };
			overlay.querySelector('.wl-ar-exit')?.addEventListener('click', end);
			session.addEventListener('select', () => {
				if (placed || !reticle.visible) return;
				placed = true;
				root.position.setFromMatrixPosition(reticle.matrix);
				root.visible = true;
				const hint = overlay.querySelector('.wl-ar-hint');
				if (hint) hint.textContent = 'The agent is here. Listen…';
				this._speak(this.wl.prompt || this.wl.title);
				// Hand off to the panel interaction (rendered into the dom-overlay) once placed.
				setTimeout(() => { end(); this._begin(); }, 600);
			});
			let prevLoopMs = null;
			renderer.setAnimationLoop((timeMs, frame) => {
				if (arIdleMgr) {
					arIdleMgr.update(prevLoopMs == null ? 0 : Math.min((timeMs - prevLoopMs) / 1000, 0.05));
				}
				prevLoopMs = timeMs;
				if (frame && !placed) {
					const hits = frame.getHitTestResults(hitSource);
					if (hits.length) {
						const pose = hits[0].getPose(refSpace);
						reticle.visible = true;
						reticle.matrix.fromArray(pose.transform.matrix);
					} else reticle.visible = false;
				}
				renderer.render(scene, cam);
			});
			session.addEventListener('end', () => {
				renderer.setAnimationLoop(null);
				arIdleMgr?.detach();
				renderer.domElement.remove();
				overlay.remove();
				renderer.dispose();
				this._ar = null;
			});
		} catch {
			// AR couldn't start — the panel ceremony is the first-class fallback.
			this._begin();
		}
	}
}

function loadingCard(text) {
	return `<div class="wl-cer-card"><div class="wl-spinner" aria-hidden="true"></div>
		<p class="wl-cer-prompt">${esc(text)}</p></div>`;
}
function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function short(k) {
	const s = String(k || '');
	return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
