// <three-ws-agent> — embeddable custom element that renders a three.ws
// 3D avatar bound to the on-chain state of an AgenC task.
//
//   <script type="module" src="https://three.ws/agenc/embed.js"></script>
//   <three-ws-agent
//     src="/avatars/default.glb"
//     agenc-task="<TASK_PDA>"
//     agenc-cluster="devnet"
//     agenc-poll-ms="4000"
//     agenc-bridge="https://three.ws/api/agenc"
//   ></three-ws-agent>
//
// Attributes:
//   src              — GLB url for the avatar body (passed straight to model-viewer)
//   agenc-task       — base58 task PDA on AgenC (required to poll state)
//   agenc-cluster    — "devnet" | "mainnet" (default "devnet")
//   agenc-poll-ms    — polling interval; clamped [1500, 120000] (default 4000)
//   agenc-bridge     — base URL of the three.ws AgenC API (default "/api/agenc")
//   agenc-clips      — JSON map of {state: clipName} for state-driven animation,
//                       e.g. `{"Claimed":"working","Completed":"cheer"}`. Clips
//                       must exist in the GLB; missing clips are a no-op.
//   show-overlay     — when present, render a small state badge in the corner
//
// Events (CustomEvent, bubble=true):
//   agenc:state      — { taskPda, state, task, lifecycle } on every poll where
//                       the task is found. The page can hook this to drive
//                       additional UI without reaching into the element.
//   agenc:error      — { message } on transport / parse failure.
//
// The element is dependency-free apart from <model-viewer>, which is loaded
// lazily from the npm CDN on first connect (the same source three.ws uses).

const MODEL_VIEWER_CDN = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js';

let modelViewerPromise = null;
function ensureModelViewer() {
	if (typeof window === 'undefined') return Promise.resolve();
	if (customElements.get('model-viewer')) return Promise.resolve();
	if (modelViewerPromise) return modelViewerPromise;
	modelViewerPromise = new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.type = 'module';
		script.src = MODEL_VIEWER_CDN;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('failed to load model-viewer from ' + MODEL_VIEWER_CDN));
		document.head.appendChild(script);
	});
	return modelViewerPromise;
}

const STATE_COLORS = {
	Open: '#7af0c4',
	Claimed: '#f0c47a',
	Completed: '#7af0c4',
	Cancelled: '#f07a7a',
	Expired: '#f07a7a',
	Disputed: '#f07a7a',
	loading: '#8a8499',
	error: '#f07a7a',
	idle: '#8a8499',
};

class ThreewsAgentElement extends HTMLElement {
	static get observedAttributes() {
		return ['src', 'agenc-task', 'agenc-cluster', 'agenc-poll-ms', 'agenc-bridge', 'agenc-clips', 'show-overlay'];
	}

	constructor() {
		super();
		this._shadow = this.attachShadow({ mode: 'open' });
		this._pollTimer = null;
		this._requestId = 0;
		this._lastState = null;
	}

	connectedCallback() {
		this._render();
		ensureModelViewer().catch((err) => this._emit('agenc:error', { message: err.message }));
		this._restart();
	}

	disconnectedCallback() {
		clearTimeout(this._pollTimer);
		this._requestId += 1;
	}

	attributeChangedCallback(name, oldValue, newValue) {
		if (oldValue === newValue) return;
		if (name === 'src' && this._viewer) {
			this._viewer.setAttribute('src', newValue || '');
		}
		if (['agenc-task', 'agenc-cluster', 'agenc-poll-ms', 'agenc-bridge'].includes(name)) {
			this._restart();
		}
		if (name === 'show-overlay') {
			this._toggleOverlay();
		}
	}

	_emit(type, detail) {
		this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
	}

	_pollMs() {
		const raw = parseInt(this.getAttribute('agenc-poll-ms') || '4000', 10);
		if (!Number.isFinite(raw)) return 4000;
		return Math.max(1500, Math.min(raw, 120000));
	}

	_cluster() {
		const c = (this.getAttribute('agenc-cluster') || 'devnet').toLowerCase();
		return c === 'mainnet' ? 'mainnet' : 'devnet';
	}

	_bridge() {
		return (this.getAttribute('agenc-bridge') || '/api/agenc').replace(/\/+$/, '');
	}

	_clipsMap() {
		const raw = this.getAttribute('agenc-clips');
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch {
			return null;
		}
	}

	_render() {
		this._shadow.innerHTML = `
			<style>
				:host { display: block; position: relative; width: 100%; height: 100%; min-height: 240px; background: transparent; }
				.viewer { position: relative; width: 100%; height: 100%; border-radius: inherit; overflow: hidden; }
				model-viewer { width: 100%; height: 100%; --poster-color: transparent; background: transparent; }
				.pulse {
					position: absolute; inset: 0; pointer-events: none;
					mix-blend-mode: screen;
					opacity: 0;
					transition: opacity 0.3s, background 0.3s;
				}
				:host([data-state="Claimed"]) .pulse {
					background: radial-gradient(circle at 50% 70%, #f0c47a 0%, transparent 55%);
					opacity: 0.28;
					animation: pulse 2.4s ease-in-out infinite;
				}
				:host([data-state="Completed"]) .pulse {
					background: radial-gradient(circle at 50% 70%, #7af0c4 0%, transparent 55%);
					opacity: 0.36;
				}
				:host([data-state="Cancelled"]) .pulse,
				:host([data-state="Expired"]) .pulse,
				:host([data-state="Disputed"]) .pulse {
					background: radial-gradient(circle at 50% 70%, #f07a7a 0%, transparent 55%);
					opacity: 0.24;
				}
				@keyframes pulse {
					0%, 100% { opacity: 0.16; }
					50% { opacity: 0.36; }
				}
				.overlay {
					position: absolute;
					left: 12px;
					bottom: 12px;
					font: 600 11px/1 -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
					letter-spacing: 0.06em;
					text-transform: uppercase;
					color: #ececec;
					background: rgba(0, 0, 0, 0.6);
					border: 1px solid rgba(255, 255, 255, 0.12);
					padding: 5px 10px;
					border-radius: 999px;
					transition: color 0.2s, border-color 0.2s;
					display: none;
				}
				.overlay.show { display: inline-block; }
			</style>
			<div class="viewer">
				<model-viewer auto-rotate camera-controls environment-image="neutral"
					interaction-prompt="none"
					exposure="1" shadow-intensity="0.6"
					reveal="auto"></model-viewer>
				<div class="pulse"></div>
				<div class="overlay">idle</div>
			</div>
		`;
		this._viewer = this._shadow.querySelector('model-viewer');
		this._overlay = this._shadow.querySelector('.overlay');
		if (this.hasAttribute('src')) this._viewer.setAttribute('src', this.getAttribute('src'));
		this._toggleOverlay();
		this._setState(this.getAttribute('agenc-task') ? 'loading' : 'idle');
	}

	_toggleOverlay() {
		if (!this._overlay) return;
		const show = this.hasAttribute('show-overlay');
		this._overlay.classList.toggle('show', show);
	}

	_setState(state) {
		if (this._lastState === state) return;
		this._lastState = state;
		this.setAttribute('data-state', state);
		if (this._overlay) {
			this._overlay.textContent = state;
			this._overlay.style.color = STATE_COLORS[state] || '#ececec';
			this._overlay.style.borderColor = (STATE_COLORS[state] || '#ffffff20') + '88';
		}
		// State-driven animation: if the user supplied an agenc-clips map and the
		// clip exists in the loaded GLB, switch the active animation; otherwise
		// silently fall back to whatever clip is already playing.
		const clipMap = this._clipsMap();
		if (this._viewer && clipMap && clipMap[state]) {
			const desired = String(clipMap[state]);
			const available = this._viewer.availableAnimations || [];
			if (!available.length || available.includes(desired)) {
				this._viewer.setAttribute('animation-name', desired);
				try {
					this._viewer.play({ repetitions: state === 'Completed' ? 1 : Infinity });
				} catch {
					// model-viewer.play may not be ready yet — non-fatal
				}
			}
		}
	}

	_restart() {
		clearTimeout(this._pollTimer);
		this._requestId += 1;
		const taskPda = this.getAttribute('agenc-task');
		if (!taskPda) {
			this._setState('idle');
			return;
		}
		this._setState('loading');
		const myReq = this._requestId;
		this._poll(taskPda, myReq);
	}

	async _poll(taskPda, requestId) {
		const cluster = this._cluster();
		const bridge = this._bridge();
		const url = `${bridge}/get-task?taskPda=${encodeURIComponent(taskPda)}&cluster=${cluster}&lifecycle=1`;
		try {
			const r = await fetch(url, { headers: { accept: 'application/json' } });
			if (requestId !== this._requestId) return;
			if (!r.ok && r.status !== 404) {
				this._setState('error');
				this._emit('agenc:error', { message: `bridge ${r.status}` });
				return;
			}
			const payload = await r.json();
			if (!payload.ok || !payload.task) {
				this._setState('error');
				this._emit('agenc:error', { message: payload.error || 'not_found' });
				return;
			}
			this._setState(payload.task.state);
			this._emit('agenc:state', {
				taskPda,
				cluster,
				state: payload.task.state,
				task: payload.task,
				lifecycle: payload.lifecycle,
			});
		} catch (err) {
			if (requestId !== this._requestId) return;
			this._setState('error');
			this._emit('agenc:error', { message: err.message || String(err) });
		} finally {
			if (requestId === this._requestId) {
				this._pollTimer = setTimeout(() => this._poll(taskPda, requestId), this._pollMs());
			}
		}
	}
}

if (typeof customElements !== 'undefined' && !customElements.get('three-ws-agent')) {
	customElements.define('three-ws-agent', ThreewsAgentElement);
}

export { ThreewsAgentElement };
