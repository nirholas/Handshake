import { track, trackError, ANALYTICS_EVENTS } from './analytics.js';

/**
 * Embed modal for the agent hub page.
 *
 * Offers four embed kinds, all generating real, copy-pasteable snippets:
 *   • iframe         : chat-style embed (/agents/:id/embed)
 *   • <agent-3d>     : web component wrapper
 *   • SDK            : iframe + Agent3D bridge for programmatic control
 *   • walking        : a live, walking 3D avatar of THIS agent
 *                      (/walk-embed?agent=:id) with joystick/keyboard controls,
 *                      a selectable environment, autoplay, and a background.
 *
 * The walking kind renders a LIVE preview iframe that re-loads as the developer
 * tweaks options, so they see exactly what their visitors will get before they
 * copy. Size controls drive width × height for every kind.
 */

// Scene presets surfaced to the developer. These ids are the real keys the
// /walk-embed runtime understands (src/walk-embed.js → ENVIRONMENTS); the
// labels are just friendlier copy. Keep this list in sync with that map.
const WALK_ENVIRONMENTS = [
	{ id: 'studio', label: 'Studio' },
	{ id: 'void', label: 'Void' },
	{ id: 'beach', label: 'Beach' },
	{ id: 'sunset', label: 'Sunset' },
	{ id: 'night', label: 'Night' },
	{ id: 'grid', label: 'Grid' },
];

// Control schemes the /walk-embed page accepts via ?controls=.
const WALK_CONTROLS = [
	{ id: 'joystick', label: 'Joystick' },
	{ id: 'keyboard', label: 'Keyboard' },
	{ id: 'none', label: 'View only' },
];

const WALK_DEFAULTS = {
	controls: 'joystick',
	env: 'studio',
	autoplay: true,
	bg: 'transparent',
};

const STYLE_ID = 'aem-walking-styles';

// Walking-mode styling is injected here (idempotent) rather than the shared
// page stylesheet so the modal is fully self-contained. It reuses the same
// design tokens (golden-ratio sizes, low-alpha whites) as the existing aem-*
// rules so the two surfaces read as one.
const WALKING_STYLES = `
.aem-walk-options {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 0.618rem;
}
.aem-field {
	display: flex;
	flex-direction: column;
	gap: 0.236rem;
}
.aem-field-label {
	font-size: 0.618rem;
	color: rgba(255, 255, 255, 0.4);
	letter-spacing: 0.02em;
}
.aem-select {
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 6px;
	color: rgba(255, 255, 255, 0.85);
	font-size: 0.764rem;
	font-family: inherit;
	padding: 0.3rem 0.45rem;
	cursor: pointer;
	transition: border-color 0.12s;
}
.aem-select:hover {
	border-color: rgba(255, 255, 255, 0.2);
}
.aem-select:focus-visible {
	outline: none;
	border-color: rgba(255, 255, 255, 0.45);
	box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.12);
}
.aem-swatch-row {
	display: flex;
	align-items: center;
	gap: 0.382rem;
}
.aem-swatch {
	-webkit-appearance: none;
	appearance: none;
	width: 28px;
	height: 28px;
	padding: 0;
	border: 1px solid rgba(255, 255, 255, 0.18);
	border-radius: 6px;
	background: none;
	cursor: pointer;
}
.aem-swatch::-webkit-color-swatch-wrapper { padding: 2px; }
.aem-swatch::-webkit-color-swatch { border: none; border-radius: 4px; }
.aem-swatch:focus-visible {
	outline: none;
	border-color: rgba(255, 255, 255, 0.45);
	box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.12);
}
.aem-swatch:disabled { opacity: 0.35; cursor: not-allowed; }
.aem-toggle {
	display: inline-flex;
	align-items: center;
	gap: 0.382rem;
	font-size: 0.618rem;
	color: rgba(255, 255, 255, 0.55);
	cursor: pointer;
	user-select: none;
}
.aem-toggle input { accent-color: #86efac; cursor: pointer; }
.aem-transparent-toggle {
	font-size: 0.55rem;
	color: rgba(255, 255, 255, 0.35);
}
.aem-transparent-toggle input { accent-color: rgba(255, 255, 255, 0.6); }
.aem-preview {
	position: relative;
	border: 1px solid rgba(255, 255, 255, 0.08);
	border-radius: 8px;
	overflow: hidden;
	background:
		linear-gradient(45deg, rgba(255,255,255,0.03) 25%, transparent 25%) 0 0/16px 16px,
		linear-gradient(-45deg, rgba(255,255,255,0.03) 25%, transparent 25%) 0 8px/16px 16px,
		linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.03) 75%) 8px -8px/16px 16px,
		linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.03) 75%) -8px 0/16px 16px,
		#0a0a0a;
	aspect-ratio: 4 / 3;
	max-height: 220px;
}
.aem-preview iframe {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	border: 0;
	display: block;
}
.aem-preview-label {
	position: absolute;
	top: 0.382rem;
	left: 0.5rem;
	font-size: 0.55rem;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: rgba(255, 255, 255, 0.4);
	background: rgba(0, 0, 0, 0.45);
	padding: 0.1rem 0.4rem;
	border-radius: 4px;
	pointer-events: none;
	z-index: 2;
}
.aem-preview-empty {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	text-align: center;
	padding: 1rem;
	font-size: 0.618rem;
	color: rgba(255, 255, 255, 0.3);
	line-height: 1.5;
}
`;

function ensureWalkingStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = WALKING_STYLES;
	document.head.appendChild(el);
}

export class AgentEmbedModal {
	/**
	 * @param {string} agentId
	 */
	constructor(agentId) {
		this._id = agentId;
		this._modal = null;
		this._onKey = this._onKey.bind(this);
		this._w = 420;
		this._h = 520;
		// Which snippet kinds we've already reported for this agent : instance-level
		// so closing and reopening the modal doesn't re-fire EMBED_GENERATED.
		this._embeddedKinds = new Set();
		// Walking-mode options, mutated live by the option controls.
		this._walk = { ...WALK_DEFAULTS };
	}

	open() {
		if (this._modal) return;
		ensureWalkingStyles();
		this._build();
		document.body.appendChild(this._modal);
		document.addEventListener('keydown', this._onKey);
		requestAnimationFrame(() => this._modal.classList.add('aem-open'));
	}

	close() {
		if (!this._modal) return;
		document.removeEventListener('keydown', this._onKey);
		this._modal.remove();
		this._modal = null;
	}

	_onKey(e) {
		if (e.key === 'Escape') this.close();
	}

	// Build the /walk-embed query string from the current walking options. Only
	// non-default-ish params are dropped where the embed already defaults to them,
	// keeping the emitted URL readable; agent + autoplay + controls are always
	// explicit because they are the load-bearing intent of this snippet.
	_walkSrc(origin, id) {
		const q = new URLSearchParams();
		q.set('agent', id);
		q.set('controls', this._walk.controls);
		if (this._walk.autoplay) q.set('autoplay', 'true');
		if (this._walk.env && this._walk.env !== 'studio') q.set('env', this._walk.env);
		if (this._walk.bg && this._walk.bg !== 'transparent') q.set('bg', this._walk.bg);
		return `${origin}/walk-embed?${q.toString()}`;
	}

	_snippets(origin, id, w, h) {
		return {
			iframe:
				`<iframe\n` +
				`  src="${origin}/agents/${id}/embed"\n` +
				`  width="${w}" height="${h}"\n` +
				`  title="three.ws agent"\n` +
				`  style="border:0;border-radius:12px"\n` +
				`  allow="autoplay; xr-spatial-tracking"\n` +
				`  sandbox="allow-scripts allow-same-origin allow-popups"\n` +
				`  loading="lazy"\n` +
				`></iframe>`,
			webcomponent:
				`<script type="module"\n` +
				`  src="${origin}/dist-lib/agent-3d.js"\n` +
				`><\/script>\n` +
				`<agent-3d\n` +
				`  agent-id="${id}"\n` +
				`  style="width:${w}px;height:${h}px"\n` +
				`></agent-3d>`,
			sdk:
				`<script src="${origin}/embed-sdk.js"><\/script>\n` +
				`<iframe\n` +
				`  id="agent-frame"\n` +
				`  src="${origin}/agents/${id}/embed"\n` +
				`  width="${w}" height="${h}"\n` +
				`  title="three.ws agent"\n` +
				`  style="border:0;border-radius:12px"\n` +
				`  allow="autoplay; xr-spatial-tracking"\n` +
				`  sandbox="allow-scripts allow-same-origin allow-popups"\n` +
				`  loading="lazy"\n` +
				`></iframe>\n` +
				`<script>\n` +
				`const bridge = Agent3D.connect(\n` +
				`  document.getElementById('agent-frame'),\n` +
				`  {\n` +
				`    agentId: '${id}',\n` +
				`    onReady: (info) => console.log('ready', info),\n` +
				`    onAction: (action) => console.log('action', action),\n` +
				`  }\n` +
				`);\n\n` +
				`// Send a message once the agent is ready\n` +
				`bridge.ready.then(() => {\n` +
				`  bridge.send({ type: 'speak', payload: { text: 'Hello!' } });\n` +
				`});\n` +
				`<\/script>`,
			walking:
				`<iframe\n` +
				`  src="${this._walkSrc(origin, id)}"\n` +
				`  width="${w}" height="${h}"\n` +
				`  title="three.ws walking avatar"\n` +
				`  style="border:0;border-radius:12px"\n` +
				`  allow="autoplay; xr-spatial-tracking"\n` +
				`  sandbox="allow-scripts allow-same-origin allow-popups"\n` +
				`  loading="lazy"\n` +
				`></iframe>`,
		};
	}

	_build() {
		const origin = location.origin;
		const id = this._id;

		const overlay = document.createElement('div');
		overlay.className = 'aem-overlay';
		overlay.innerHTML = `
			<div class="aem-modal" role="dialog" aria-modal="true" aria-label="Embed this agent">
				<div class="aem-header">
					<span class="aem-title">Embed this agent</span>
					<button class="aem-close" aria-label="Close">&times;</button>
				</div>
				<div class="aem-body">
					<div class="aem-size-row">
						<label class="aem-size-label">
							Width
							<input class="aem-size-input" id="aem-width" type="number" min="100" max="2000" step="10" value="${this._w}" />
						</label>
						<span class="aem-size-sep">&times;</span>
						<label class="aem-size-label">
							Height
							<input class="aem-size-input" id="aem-height" type="number" min="100" max="2000" step="10" value="${this._h}" />
						</label>
						<span class="aem-size-unit">px</span>
					</div>
					<div class="aem-tabs" role="tablist" aria-label="Embed type">
						<button class="aem-tab active" role="tab" aria-selected="true" data-tab="iframe">iframe</button>
						<button class="aem-tab" role="tab" aria-selected="false" data-tab="webcomponent">&lt;agent-3d&gt;</button>
						<button class="aem-tab" role="tab" aria-selected="false" data-tab="sdk">SDK</button>
						<button class="aem-tab" role="tab" aria-selected="false" data-tab="walking">walking avatar</button>
					</div>
					<div class="aem-walk-panel" id="aem-walk-panel" hidden>
						<div class="aem-walk-options">
							<label class="aem-field">
								<span class="aem-field-label">Controls</span>
								<select class="aem-select" id="aem-walk-controls">
									${WALK_CONTROLS.map(
										(c) =>
											`<option value="${c.id}"${
												c.id === this._walk.controls ? ' selected' : ''
											}>${c.label}</option>`,
									).join('')}
								</select>
							</label>
							<label class="aem-field">
								<span class="aem-field-label">Environment</span>
								<select class="aem-select" id="aem-walk-env">
									${WALK_ENVIRONMENTS.map(
										(e) =>
											`<option value="${e.id}"${
												e.id === this._walk.env ? ' selected' : ''
											}>${e.label}</option>`,
									).join('')}
								</select>
							</label>
							<div class="aem-field">
								<span class="aem-field-label">Background</span>
								<div class="aem-swatch-row">
									<input class="aem-swatch" id="aem-walk-bg" type="color" value="#101820"
										aria-label="Background color"${
											this._walk.bg === 'transparent' ? ' disabled' : ''
										} />
									<label class="aem-toggle aem-transparent-toggle">
										<input type="checkbox" id="aem-walk-transparent"${
											this._walk.bg === 'transparent' ? ' checked' : ''
										} />
										transparent
									</label>
								</div>
							</div>
							<div class="aem-field">
								<span class="aem-field-label">Behavior</span>
								<label class="aem-toggle">
									<input type="checkbox" id="aem-walk-autoplay"${
										this._walk.autoplay ? ' checked' : ''
									} />
									auto-walk on load
								</label>
							</div>
						</div>
						<div class="aem-preview" id="aem-walk-preview">
							<span class="aem-preview-label">Live preview</span>
						</div>
					</div>
					<div class="aem-snippet-wrap">
						<pre class="aem-snippet" id="aem-snippet-text"></pre>
						<button class="aem-copy" id="aem-copy-btn">copy</button>
					</div>
					<p class="aem-note" id="aem-note">Free to embed : no wallet or on-chain deployment required.</p>
				</div>
			</div>
		`;

		let current = 'iframe';
		const snippetEl = overlay.querySelector('#aem-snippet-text');
		const copyBtn = overlay.querySelector('#aem-copy-btn');
		const widthInput = overlay.querySelector('#aem-width');
		const heightInput = overlay.querySelector('#aem-height');
		const walkPanel = overlay.querySelector('#aem-walk-panel');
		const previewWrap = overlay.querySelector('#aem-walk-preview');
		const noteEl = overlay.querySelector('#aem-note');

		const controlsSel = overlay.querySelector('#aem-walk-controls');
		const envSel = overlay.querySelector('#aem-walk-env');
		const bgSwatch = overlay.querySelector('#aem-walk-bg');
		const transparentChk = overlay.querySelector('#aem-walk-transparent');
		const autoplayChk = overlay.querySelector('#aem-walk-autoplay');

		// The live preview iframe is created once on first switch to the walking
		// tab and reused; only its src changes as options update, so each tweak is
		// a cheap navigation rather than a teardown/rebuild.
		let previewFrame = null;
		const renderPreview = () => {
			if (current !== 'walking') return;
			if (!previewFrame) {
				previewFrame = document.createElement('iframe');
				previewFrame.title = 'three.ws walking avatar preview';
				previewFrame.setAttribute('allow', 'autoplay; xr-spatial-tracking');
				previewFrame.setAttribute(
					'sandbox',
					'allow-scripts allow-same-origin allow-popups',
				);
				previewFrame.setAttribute('loading', 'eager');
				previewWrap.appendChild(previewFrame);
			}
			const next = this._walkSrc(origin, id);
			if (previewFrame.src !== next) previewFrame.src = next;
		};

		const renderSnippet = () => {
			snippetEl.textContent = this._snippets(origin, id, this._w, this._h)[current];
		};

		const renderNote = () => {
			noteEl.textContent =
				current === 'walking'
					? 'Drops a live, walking 3D avatar of this agent on any site. Free to embed.'
					: 'Free to embed : no wallet or on-chain deployment required.';
		};

		const setActiveTab = (kind) => {
			current = kind;
			overlay.querySelectorAll('.aem-tab').forEach((b) => {
				const on = b.dataset.tab === kind;
				b.classList.toggle('active', on);
				b.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			walkPanel.hidden = kind !== 'walking';
			renderSnippet();
			renderNote();
			renderPreview();
		};

		renderSnippet();

		const onSizeChange = () => {
			const w = parseInt(widthInput.value, 10);
			const h = parseInt(heightInput.value, 10);
			if (w >= 100 && w <= 2000) this._w = w;
			if (h >= 100 && h <= 2000) this._h = h;
			renderSnippet();
		};
		widthInput.addEventListener('input', onSizeChange);
		heightInput.addEventListener('input', onSizeChange);

		// Walking-option handlers: each mutates state, then re-renders both the
		// snippet and the live preview so the two never drift apart.
		const onWalkChange = () => {
			renderSnippet();
			renderPreview();
		};
		controlsSel.addEventListener('change', () => {
			this._walk.controls = controlsSel.value;
			onWalkChange();
		});
		envSel.addEventListener('change', () => {
			this._walk.env = envSel.value;
			onWalkChange();
		});
		bgSwatch.addEventListener('input', () => {
			if (!transparentChk.checked) {
				this._walk.bg = bgSwatch.value;
				onWalkChange();
			}
		});
		transparentChk.addEventListener('change', () => {
			if (transparentChk.checked) {
				this._walk.bg = 'transparent';
				bgSwatch.disabled = true;
			} else {
				this._walk.bg = bgSwatch.value;
				bgSwatch.disabled = false;
			}
			onWalkChange();
		});
		autoplayChk.addEventListener('change', () => {
			this._walk.autoplay = autoplayChk.checked;
			onWalkChange();
		});

		overlay.querySelectorAll('.aem-tab').forEach((btn) => {
			btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
		});

		copyBtn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(this._snippets(origin, id, this._w, this._h)[current]);
				copyBtn.textContent = 'copied!';
				copyBtn.classList.add('aem-copied');
				setTimeout(() => {
					copyBtn.textContent = 'copy';
					copyBtn.classList.remove('aem-copied');
				}, 1400);
				// Activation signal: developer took a real embed snippet. Dedupe per
				// kind so re-copying the same snippet doesn't double-fire.
				if (!this._embeddedKinds.has(current)) {
					this._embeddedKinds.add(current);
					track(ANALYTICS_EVENTS.EMBED_GENERATED, { agent_id: id, embed_kind: current });
				}
			} catch (err) {
				trackError('agent_embed.copy', err, { embed_kind: current });
			}
		});

		overlay.querySelector('.aem-close').addEventListener('click', () => this.close());
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) this.close();
		});

		this._modal = overlay;
	}
}
