/**
 * ════════════════════════════════════════════════════════════════════════════
 * <agent-presence> — the user's live agent, rendered on every page  (P0)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * A framework-agnostic custom element that renders the caller's live 3D agent and
 * keeps it in lock-step with Agent Studio: edit a field anywhere (via the shared
 * `studio` store) and every <agent-presence> on the page updates instantly — no
 * save, no refresh. It also reacts to market/trade events with avatar emotion.
 *
 *   <agent-presence data-mode="stage"></agent-presence>      <!-- full studio stage -->
 *   <agent-presence data-mode="companion"></agent-presence>  <!-- sidebar size -->
 *   <agent-presence data-mode="mini"></agent-presence>       <!-- floating companion -->
 *   <agent-presence data-agent-id="…"></agent-presence>      <!-- pin a specific agent -->
 *   <agent-presence data-avatar-id="…"></agent-presence>     <!-- render a bare avatar -->
 *
 * It reuses the platform's renderer wholesale — `Viewer` (src/viewer.js) +
 * `AgentAvatar` (src/agent-avatar.js, emotion blend + idle loop + lip-sync) +
 * the singleton `protocol` (src/agent-protocol.js) — it does NOT fork rendering.
 *
 * Reactions (P4/P5 emit market events through `studio.emitMarket`):
 *   element.reactTo({ type: 'snipe:filled' })  →  celebration + cheer gesture
 *   element.reactTo({ type: 'position:down' })  →  concern + glance down
 * Default mappings ship below; pass any { type, ... } event.
 *
 * PERFORMANCE (this renders on every page, so it is built to disappear when idle):
 *   • Heavy Three.js modules are lazy-imported on first reveal, never at parse.
 *   • The Viewer only renders while on-screen AND the tab is visible — it owns an
 *     IntersectionObserver + visibilitychange gate internally; we also defer boot
 *     until first intersection so an off-screen companion costs nothing.
 *   • DPR is capped (1.5 for mini/companion, 2 for the stage).
 *   • mini mode is position:fixed/transform-only so it never reflows or janks scroll.
 */

import { studio } from './agent-studio-store.js';
import { log } from '../shared/log.js';

const MINI_POS_KEY = 'tws:presence:mini:pos';

// The pre-baked clip library every avatar shares (idle/walk/wave/dance/…). The
// stage Viewer's AnimationManager starts empty, so without registering these defs
// `ensureLoaded`/`playClip` find no clip and every Body-studio move is a silent
// no-op. Fetched once and memoized across every <agent-presence> on the page.
let _animDefsPromise = null;
async function loadAnimationDefs() {
	if (_animDefsPromise) return _animDefsPromise;
	_animDefsPromise = (async () => {
		const res = await fetch('/animations/manifest.json');
		if (!res.ok) throw new Error(`animation manifest ${res.status}`);
		const manifest = await res.json();
		return Array.isArray(manifest) ? manifest : manifest.clips || manifest.animations || [];
	})().catch((err) => {
		// Reset so a transient failure retries on the next avatar boot rather than
		// poisoning the library for the rest of the session.
		_animDefsPromise = null;
		throw err;
	});
	return _animDefsPromise;
}

// Market-event → reaction mapping. Each entry drives the existing emotion system
// (emote stimulus via the protocol bus) and, optionally, a one-shot gesture clip
// and a gaze direction. Tunable here; P4/P5 only need to emit the event types.
const REACTIONS = {
	'snipe:filled': { emote: ['celebration', 0.95], gesture: 'celebrate', look: null },
	'trade:filled': { emote: ['celebration', 0.8], gesture: 'celebrate', look: null },
	'trade:buy': { emote: ['curiosity', 0.5], gesture: null, look: 'token' },
	'trade:sell': { emote: ['patience', 0.4], gesture: null, look: 'token' },
	'position:up': { emote: ['celebration', 0.7], gesture: null, look: 'up' },
	'position:down': { emote: ['concern', 0.7], gesture: 'concern', look: 'down' },
	'price:up': { emote: ['celebration', 0.4], gesture: null, look: null },
	'price:down': { emote: ['concern', 0.4], gesture: null, look: null },
	'snipe:failed': { emote: ['concern', 0.7], gesture: null, look: 'down' },
	'trade:failed': { emote: ['empathy', 0.6], gesture: null, look: 'down' },
	'alert': { emote: ['curiosity', 0.6], gesture: null, look: 'token' },
};
const DEFAULT_REACTION = { emote: ['curiosity', 0.4], gesture: null, look: null };

class AgentPresenceElement extends HTMLElement {
	static get observedAttributes() {
		return ['data-mode', 'data-agent-id', 'data-avatar-id'];
	}

	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
		this._viewer = null;
		this._avatar = null;
		this._protocol = null;
		this._ACTION = null;
		this._booted = false;
		this._booting = false;
		this._disposed = false;
		this._currentAvatarId = undefined; // tracks body so we reload only on real change
		this._currentModelUrl = null;
		this._currentIdleClip = null; // resting clip, re-applied when Body studio changes it
		this._unsubStudio = null;
		this._unsubMarket = null;
		this._io = null;
		this._dragCleanup = null;
		this._reactQueue = [];
	}

	get mode() {
		return this.getAttribute('data-mode') || 'stage';
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────────

	connectedCallback() {
		this._renderShell();
		// Defer the heavy boot until the element is actually on screen. For a
		// scrolled-away companion this means zero WebGL cost until it matters.
		if (typeof IntersectionObserver !== 'undefined') {
			this._io = new IntersectionObserver(
				(entries) => {
					if (entries.some((e) => e.isIntersecting)) {
						this._io.disconnect();
						this._io = null;
						this._boot();
					}
				},
				{ rootMargin: '200px' },
			);
			this._io.observe(this);
		} else {
			this._boot();
		}
	}

	disconnectedCallback() {
		this._teardown();
	}

	attributeChangedCallback(name, oldVal, newVal) {
		if (oldVal === newVal) return;
		if (name === 'data-mode') {
			this._applyMode();
		} else if ((name === 'data-agent-id' || name === 'data-avatar-id') && this._booted) {
			this._refreshBody();
		}
	}

	// ── Boot ─────────────────────────────────────────────────────────────────

	async _boot() {
		if (this._booted || this._booting || this._disposed) return;
		this._booting = true;
		this._setStatus('loading');
		try {
			// Lazy-load the renderer + emotion layer + protocol bus together.
			const [{ Viewer }, { AgentAvatar }, protocolMod] = await Promise.all([
				import('../viewer.js'),
				import('../agent-avatar.js'),
				import('../agent-protocol.js'),
			]);
			if (this._disposed) return;
			this._protocol = protocolMod.protocol;
			this._ACTION = protocolMod.ACTION_TYPES;

			const stageEl = this.shadowRoot.getElementById('stage');
			const dprCap = this.mode === 'stage' ? 2 : 1.5;
			this._viewer = new Viewer(stageEl, {
				kiosk: true,
				maxPixelRatio: dprCap,
				framing: this.mode === 'mini' ? 'portrait' : 'full',
			});
			this._viewer.state.transparentBg = true;
			this._viewer.updateBackground();

			const resolved = await this._resolveBody();
			if (this._disposed) return;

			if (!resolved) {
				this._handleNoBody();
				this._booted = true;
				this._booting = false;
				this._subscribe();
				return;
			}

			await this._loadModel(resolved, Viewer, AgentAvatar);
			this._booted = true;
			this._booting = false;
			this._setStatus('live');
			this._subscribe();
			// Replay any reactions that arrived during boot.
			const q = this._reactQueue;
			this._reactQueue = [];
			for (const evt of q) this.reactTo(evt);
		} catch (err) {
			log.warn('[agent-presence] boot failed', err);
			this._booting = false;
			this._setStatus('error');
		}
	}

	async _loadModel(modelUrl, Viewer, AgentAvatar) {
		await this._viewer.load(modelUrl, '', new Map());
		this._currentModelUrl = modelUrl;

		// Register the shared clip library on this Viewer's AnimationManager so the
		// resting idle, market reactions, and Body-studio previews can actually load
		// and play. Without it `ensureLoaded` finds no def and every clip is a no-op.
		try {
			this._viewer.setAnimationDefs(await loadAnimationDefs());
		} catch (err) {
			log.warn('[agent-presence] animation library unavailable', err);
		}

		// Emotion + idle + lip-sync layer. AgentAvatar.attach() starts the procedural
		// idle loop and the per-frame empathy tick; we share the SINGLETON protocol so
		// reactTo() (and any other surface) can drive this avatar.
		const identity = studio.identity || { id: this.getAttribute('data-agent-id') || 'presence' };
		this._avatar = new AgentAvatar(this._viewer, this._protocol, identity);
		this._avatar.attach();

		// Best-effort baked idle so a rig with an "idle" clip loops it; the procedural
		// IdleAnimation inside AgentAvatar keeps a clip-less rig breathing regardless.
		// The Body studio can pin a different resting clip (e.g. "av-chilling") via
		// meta.studio.body.idleClip — honor it so the persisted body shows everywhere.
		try {
			const am = this._viewer.animationManager;
			const idle = this._idleClip();
			this._currentIdleClip = idle;
			if (am && (await am.ensureLoaded(idle))) am.crossfadeTo(idle, 0.4);
			else if (am && idle !== 'idle' && (await am.ensureLoaded('idle'))) am.crossfadeTo('idle', 0.4);
		} catch {
			/* procedural idle covers it */
		}
	}

	// The resting clip this avatar loops. Body studio persists a choice under
	// meta.studio.body.idleClip; absent that we use the canonical "idle".
	_idleClip() {
		const pinned = this.getAttribute('data-agent-id') || this.getAttribute('data-avatar-id');
		if (pinned) return 'idle';
		return studio.agent?.meta?.studio?.body?.idleClip || 'idle';
	}

	/**
	 * Play a clip on this live avatar — the Body studio's preview/"try it" path.
	 * A looping clip (idle/dance) crossfades and stays; a one-shot (wave/jump)
	 * plays once and settles back to the resting clip. Safe to call before boot
	 * (queued) and no-ops cleanly on a rig that can't drive canonical clips.
	 * @param {string} name  canonical clip name
	 * @param {{ loop?: boolean }} [opts]
	 */
	async playClip(name, { loop = false } = {}) {
		if (!name) return;
		if (!this._booted || !this._viewer) {
			if (this._reactQueue.length < 16) this._reactQueue.push({ type: '__clip', name, loop });
			return;
		}
		const am = this._viewer.animationManager;
		if (!am) return;
		try {
			if (am.supportsCanonicalClips && !am.supportsCanonicalClips()) {
				// Non-canonical rig — convey it through emotion instead of a dead no-op.
				this._protocol?.emit({ type: this._ACTION.EMOTE, payload: { trigger: 'curiosity', weight: 0.5 } });
				return;
			}
			if (!(await am.ensureLoaded(name))) return;
			if (loop) am.crossfadeTo(name, 0.35);
			else await am.playOnce(name, { settleTo: this._idleClip(), fade: 0.3 });
		} catch {
			/* clip unavailable on this rig — silent, the avatar keeps its idle */
		}
	}

	// Resolve the GLB URL for the agent/avatar this presence should render.
	// Order: explicit data-avatar-id → studio agent's bound avatar → data-agent-id
	//        → null (designed "no body" state). Never invents a fake body.
	async _resolveBody() {
		const { apiFetch } = await import('../api.js');

		const explicitAvatar = this.getAttribute('data-avatar-id');
		if (explicitAvatar) {
			this._currentAvatarId = explicitAvatar;
			return this._avatarUrl(explicitAvatar, apiFetch);
		}

		const explicitAgent = this.getAttribute('data-agent-id');
		if (explicitAgent) {
			return this._agentBodyUrl(explicitAgent, apiFetch);
		}

		// Default source: the Studio store's live agent. The store rejects when the
		// backend never confirmed an agent (signed out, or the API is unreachable):
		// there is no real body to render, so fall through to the designed no-body
		// state rather than inventing one from a synthesised local record.
		try {
			await studio.load();
		} catch {
			this._currentAvatarId = null;
			return null;
		}
		const agent = studio.agent;
		this._currentAvatarId = agent?.avatarId || null;
		if (agent?.avatarId) {
			const url = await this._avatarUrl(agent.avatarId, apiFetch);
			if (url) return url;
		}
		return null;
	}

	async _agentBodyUrl(agentId, apiFetch) {
		try {
			const res = await apiFetch(`/api/agents/${agentId}`, { allowAnonymous: true });
			if (!res.ok) return null;
			const { agent } = await res.json();
			this._currentAvatarId = agent?.avatar_id || null;
			if (agent?.avatar_model_url) return agent.avatar_model_url;
			if (agent?.avatar_id) return this._avatarUrl(agent.avatar_id, apiFetch);
			return null;
		} catch {
			return null;
		}
	}

	async _avatarUrl(avatarId, apiFetch) {
		try {
			const res = await apiFetch(`/api/avatars/${avatarId}`, { allowAnonymous: true });
			if (!res.ok) return null;
			const { avatar } = await res.json();
			return avatar?.url || avatar?.model_url || null;
		} catch {
			return null;
		}
	}

	// ── Reactivity: stay in sync with Studio edits ──────────────────────────────

	_subscribe() {
		// Only the default (store-backed) presence tracks the live store. An element
		// pinned to an explicit agent/avatar id renders that one statically, but still
		// listens for market events so it can react.
		if (this.getAttribute('data-agent-id') || this.getAttribute('data-avatar-id')) {
			this._unsubMarket = studio.onMarket((evt) => this.reactTo(evt));
			return;
		}
		this._unsubStudio = studio.subscribe((agent) => this._onStudioChange(agent));
		this._unsubMarket = studio.onMarket((evt) => this.reactTo(evt));
	}

	_onStudioChange(agent) {
		if (!agent) return;
		this._updateNameplate(agent.name);
		// Reload the body only when the bound avatar actually changes (covers both
		// patch({avatarId}) and preview({avatarId})). Other edits never touch the rig.
		if (agent.avatarId !== this._currentAvatarId) {
			this._currentAvatarId = agent.avatarId;
			this._refreshBody();
			return;
		}
		// Body studio changed the resting clip — restyle the loop in place (no reload).
		const idle = agent.meta?.studio?.body?.idleClip || 'idle';
		if (this._booted && idle !== this._currentIdleClip) {
			this._currentIdleClip = idle;
			this.playClip(idle, { loop: true });
		}
	}

	async _refreshBody() {
		if (!this._viewer || this._disposed) return;
		// Guard against concurrent refresh calls (rapid store patches). If already
		// refreshing, queue one follow-up so the last state wins without piling up.
		if (this._refreshing) { this._pendingRefresh = true; return; }
		this._refreshing = true;
		try {
			const resolved = await this._resolveBody();
			if (this._disposed || !this._viewer) return;
			if (!resolved) {
				this._handleNoBody();
				return;
			}
			this.hidden = false;
			if (resolved === this._currentModelUrl) return;
			this._setStatus('loading');
			try {
				const { Viewer } = await import('../viewer.js');
				const { AgentAvatar } = await import('../agent-avatar.js');
				this._avatar?.detach();
				this._avatar = null;
				await this._loadModel(resolved, Viewer, AgentAvatar);
				this._setStatus('live');
			} catch (err) {
				log.warn('[agent-presence] body refresh failed', err);
				this._setStatus('error');
			}
		} finally {
			this._refreshing = false;
			if (this._pendingRefresh && !this._disposed) {
				this._pendingRefresh = false;
				this._refreshBody();
			}
		}
	}

	// A bodiless agent: show the "give it a body" CTA only to the OWNER (the CTA
	// routes into the owner-gated Studio). For an anonymous visitor or a pinned
	// someone-else's agent there is nothing actionable, so hide rather than show a
	// dead-end CTA — a site-wide companion simply doesn't appear until there's a body.
	_handleNoBody() {
		const pinned = this.getAttribute('data-agent-id') || this.getAttribute('data-avatar-id');
		const owned = !pinned && studio.agent?.isOwner === true;
		if (owned) {
			this.hidden = false;
			this._setStatus('no-body');
		} else {
			this.hidden = true;
		}
	}

	// ── Reactions ────────────────────────────────────────────────────────────

	/**
	 * Map a market/trade event to an avatar reaction. Public API — P4/P5 emit
	 * events via studio.emitMarket and presence forwards them here; you can also
	 * call element.reactTo({ type }) directly.
	 * @param {{ type: string }} event
	 */
	reactTo(event) {
		if (!event || typeof event !== 'object') return;
		// Replayed clip-preview requests (queued before boot) route to playClip.
		if (event.type === '__clip') return void this.playClip(event.name, { loop: event.loop });
		if (!this._booted || !this._avatar || !this._protocol) {
			// Queue until the avatar is live so an early trade isn't dropped.
			if (this._reactQueue.length < 16) this._reactQueue.push(event);
			return;
		}
		const map = REACTIONS[event.type] || DEFAULT_REACTION;
		const [trigger, weight] = map.emote;
		this._protocol.emit({ type: this._ACTION.EMOTE, payload: { trigger, weight } });
		if (map.look) {
			this._protocol.emit({ type: this._ACTION.LOOK_AT, payload: { target: map.look } });
		}
		if (map.gesture) {
			try {
				this._avatar.playGesture(map.gesture);
			} catch {
				/* clip not on this rig — emotion still conveys it */
			}
		}
	}

	// ── Shell + modes + status ──────────────────────────────────────────────────

	_renderShell() {
		this.shadowRoot.innerHTML = `
			<style>
				:host { display: block; position: relative; }
				:host([hidden]) { display: none; }
				#stage { position: relative; width: 100%; height: 100%; min-height: inherit; }
				#stage canvas { display: block; width: 100% !important; height: 100% !important; }
				/* Viewer.addGUI()/addAxesHelper() append the dat.GUI debug panel, its
				   toggle, the axes gizmo, and the model-info readout straight into the
				   stage element. Everything that positions or hides them lives in
				   public/style.css (or in <agent-3d>'s own shadow CSS), and neither
				   crosses into THIS shadow root, so the markup landed unstyled and in
				   normal flow, and dat.GUI's inline-positioned colour picker painted a
				   rainbow hue strip over the avatar on every presence surface. Presence
				   is a display surface in every mode (it builds the Viewer with
				   kiosk:true), so the debug chrome is suppressed here rather than
				   depending on a host stylesheet that may not be loaded. */
				#stage .gui-wrap,
				#stage .gui-toggle,
				#stage .axes,
				#stage .model-info { display: none !important; }
				.status {
					position: absolute; inset: 0; display: none; place-items: center;
					text-align: center; padding: 16px; pointer-events: none;
					font: 500 13px/1.5 'Inter', system-ui, sans-serif; color: rgba(255,255,255,.65);
				}
				.status[data-show="1"] { display: grid; }
				.status .inner { pointer-events: auto; max-width: 240px; }
				.skeleton {
					position: absolute; inset: 0; border-radius: inherit;
					background: linear-gradient(110deg, rgba(255,255,255,.03) 30%, rgba(255,255,255,.07) 50%, rgba(255,255,255,.03) 70%);
					background-size: 220% 100%; animation: pres-shimmer 1.4s ease-in-out infinite;
				}
				@keyframes pres-shimmer { to { background-position: -220% 0; } }
				.cta {
					margin-top: 10px; display: inline-flex; appearance: none; cursor: pointer;
					padding: 7px 14px; border-radius: 999px; font: 600 12px 'Inter', system-ui, sans-serif;
					color: #fff; background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.5);
					text-decoration: none; transition: background .15s ease, transform .12s ease;
				}
				.cta:hover { background: rgba(139,92,246,.3); }
				.cta:active { transform: scale(.96); }
				.cta:focus-visible { outline: 2px solid rgba(139,92,246,.8); outline-offset: 2px; }
				.retry {
					margin-top: 10px; appearance: none; cursor: pointer; padding: 6px 12px; border-radius: 8px;
					font: 600 12px 'Inter', system-ui, sans-serif; color: #fff;
					background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18);
				}
				.retry:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
				.nameplate {
					position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
					font: 600 11px 'Inter', system-ui, sans-serif; color: rgba(255,255,255,.85);
					background: rgba(0,0,0,.45); padding: 3px 10px; border-radius: 999px;
					backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); pointer-events: none;
					max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
					opacity: 0; transition: opacity .25s ease;
				}
				.nameplate[data-show="1"] { opacity: 1; }

				/* ── modes ───────────────────────────────────────────────────── */
				:host([data-mode="stage"]) { width: 100%; height: 100%; min-height: 360px; }
				:host([data-mode="companion"]) { width: 100%; height: 100%; min-height: 280px; }
				:host([data-mode="mini"]) {
					position: fixed; z-index: 2147483000; width: 132px; height: 168px;
					right: 18px; bottom: 18px; border-radius: 16px; overflow: hidden;
					background: linear-gradient(180deg, rgba(20,21,28,.7), rgba(14,15,22,.5));
					border: 1px solid rgba(255,255,255,.1);
					box-shadow: 0 8px 32px rgba(0,0,0,.5), 0 1px 4px rgba(0,0,0,.2);
					backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
					transition: box-shadow .2s ease;
					will-change: transform;
				}
				:host([data-mode="mini"]:hover) { box-shadow: 0 12px 40px rgba(0,0,0,.6); }
				:host([data-mode="mini"]) .drag {
					position: absolute; top: 0; left: 0; right: 0; height: 22px; cursor: grab;
					display: flex; align-items: center; justify-content: center; z-index: 3;
				}
				:host([data-mode="mini"]) .drag::before {
					content: ''; width: 26px; height: 3px; border-radius: 3px; background: rgba(255,255,255,.25); margin-top: 6px;
				}
				:host([data-mode="mini"]) .drag.dragging { cursor: grabbing; }
				.drag { display: none; }
				@media (prefers-reduced-motion: reduce) {
					.skeleton { animation: none; }
					.cta, .nameplate, :host([data-mode="mini"]) { transition: none; }
				}
			</style>
			<div id="stage" role="img" aria-label="Live 3D agent avatar">
				<div class="drag" part="drag" aria-hidden="true"></div>
				<div class="skeleton" id="skel"></div>
				<div class="status" id="status"><div class="inner" id="status-inner"></div></div>
				<div class="nameplate" id="nameplate"></div>
			</div>
		`;
		this._applyMode();
	}

	_applyMode() {
		if (!this.shadowRoot) return;
		const drag = this.shadowRoot.querySelector('.drag');
		if (this.mode === 'mini') {
			this._restoreMiniPosition();
			this._enableDrag(drag);
		} else if (this._dragCleanup) {
			this._dragCleanup();
			this._dragCleanup = null;
		}
	}

	_setStatus(state) {
		const skel = this.shadowRoot?.getElementById('skel');
		const status = this.shadowRoot?.getElementById('status');
		const inner = this.shadowRoot?.getElementById('status-inner');
		if (!skel || !status || !inner) return;
		skel.style.display = state === 'loading' ? 'block' : 'none';
		if (state === 'live' || state === 'loading') {
			status.setAttribute('data-show', '0');
			return;
		}
		status.setAttribute('data-show', '1');
		if (state === 'no-body') {
			inner.innerHTML = `<div>No avatar yet</div><button class="cta" type="button">Set up in Body tab →</button>`;
			inner.querySelector('.cta')?.addEventListener('click', () => {
				document.dispatchEvent(new CustomEvent('studio:navigate', { detail: { tab: 'body' } }));
			});
		} else if (state === 'error') {
			inner.innerHTML = `<div>Couldn't load the avatar.</div><button class="retry" type="button">Try again</button>`;
			inner.querySelector('.retry')?.addEventListener('click', () => {
				this._setStatus('loading');
				this._refreshBody();
			});
		}
	}

	_updateNameplate(name) {
		const el = this.shadowRoot?.getElementById('nameplate');
		if (!el) return;
		if (this.mode === 'mini' || !name) {
			el.setAttribute('data-show', '0');
			return;
		}
		el.textContent = name;
		el.setAttribute('data-show', '1');
	}

	// ── mini drag + persisted position ──────────────────────────────────────────

	_enableDrag(handle) {
		if (!handle || this._dragCleanup) return;
		let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false;
		const onDown = (e) => {
			dragging = true;
			handle.classList.add('dragging');
			const rect = this.getBoundingClientRect();
			originX = rect.left;
			originY = rect.top;
			startX = e.clientX;
			startY = e.clientY;
			this.style.right = 'auto';
			this.style.bottom = 'auto';
			this.style.left = originX + 'px';
			this.style.top = originY + 'px';
			handle.setPointerCapture?.(e.pointerId);
			e.preventDefault();
		};
		const onMove = (e) => {
			if (!dragging) return;
			const w = this.offsetWidth, h = this.offsetHeight;
			let nx = originX + (e.clientX - startX);
			let ny = originY + (e.clientY - startY);
			nx = Math.max(6, Math.min(window.innerWidth - w - 6, nx));
			ny = Math.max(6, Math.min(window.innerHeight - h - 6, ny));
			this.style.left = nx + 'px';
			this.style.top = ny + 'px';
		};
		const onUp = () => {
			if (!dragging) return;
			dragging = false;
			handle.classList.remove('dragging');
			this._saveMiniPosition();
		};
		handle.addEventListener('pointerdown', onDown);
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		this._dragCleanup = () => {
			handle.removeEventListener('pointerdown', onDown);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
	}

	_saveMiniPosition() {
		try {
			localStorage.setItem(
				MINI_POS_KEY,
				JSON.stringify({ left: this.style.left, top: this.style.top }),
			);
		} catch {
			/* storage disabled */
		}
	}

	_restoreMiniPosition() {
		try {
			const raw = localStorage.getItem(MINI_POS_KEY);
			if (!raw) return;
			const pos = JSON.parse(raw);
			if (pos?.left && pos?.top) {
				// Clamp to the current viewport in case it shrank since last save.
				const left = Math.max(6, Math.min(window.innerWidth - 138, parseFloat(pos.left)));
				const top = Math.max(6, Math.min(window.innerHeight - 174, parseFloat(pos.top)));
				this.style.right = 'auto';
				this.style.bottom = 'auto';
				this.style.left = left + 'px';
				this.style.top = top + 'px';
			}
		} catch {
			/* ignore corrupt position */
		}
	}

	// ── Teardown ─────────────────────────────────────────────────────────────

	_teardown() {
		this._disposed = true;
		this._io?.disconnect();
		this._io = null;
		this._unsubStudio?.();
		this._unsubMarket?.();
		this._dragCleanup?.();
		try {
			this._avatar?.detach();
		} catch {}
		try {
			this._viewer?.dispose();
		} catch {}
		this._avatar = null;
		this._viewer = null;
	}
}

if (typeof window !== 'undefined' && !customElements.get('agent-presence')) {
	customElements.define('agent-presence', AgentPresenceElement);
}

export { AgentPresenceElement };
export default AgentPresenceElement;
