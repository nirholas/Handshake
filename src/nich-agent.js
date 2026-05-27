/**
 * NichAgent — Voice + Chat Interface
 * ------------------------------------
 * The conversational surface of the three.ws.
 * Now protocol-aware: responses go through the AgentProtocol bus,
 * which drives the avatar's Empathy Layer and action timeline.
 *
 * Skills-aware: routes recognised intents to AgentSkills.perform()
 * so the avatar performs them visibly, not just textually.
 */

import { ACTION_TYPES } from './agent-protocol.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * @typedef {Object} NichAgentOptions
 * @property {'floating'|'embedded'} [layout]    'floating' (default) = legacy fixed-position toggle button + panel.
 *                                                'embedded' = panel mounts directly inside containerEl, no toggle button.
 * @property {'right'|'bottom'|'overlay'} [position]  Layout hint applied as a CSS class. Embedded only.
 * @property {string}  [greeting]               First agent message shown on open / mount.
 * @property {string}  [title]                  Override identity.name in the panel header.
 * @property {{accent?:string, background?:string, caption?:string}} [theme]
 *                                              CSS custom-property overrides (--nich-accent, --nich-bg, --nich-fg).
 * @property {boolean} [voiceInput]             Enable mic button (default true).
 * @property {boolean} [voiceOutput]            Speak replies via speechSynthesis (default true).
 * @property {(text:string)=>Promise<{reply?:string,actions?:any[]}>} [onSend]
 *                                              Override the default chat dispatch. Used by the talking-agent widget
 *                                              to route through /api/widgets/:id/chat instead of /api/chat.
 * @property {boolean} [skipDefaultListeners]   Skip wiring SPEAK / LOAD_START / PERFORM_SKILL bus handlers.
 *                                              Widgets manage their own greeting + history.
 */

export class NichAgent {
	/**
	 * @param {HTMLElement}                                        containerEl
	 * @param {import('./agent-protocol.js').AgentProtocol}        [protocol]
	 * @param {import('./agent-skills.js').AgentSkills}            [skills]
	 * @param {import('./agent-identity.js').AgentIdentity}        [identity]
	 * @param {import('./runtime/index.js').Runtime}               [runtime]
	 * @param {NichAgentOptions}                                   [options]
	 */
	constructor(
		containerEl,
		protocol = null,
		skills = null,
		identity = null,
		runtime = null,
		options = {},
	) {
		this.container = containerEl;
		this.protocol = protocol;
		this.skills = skills;
		this.identity = identity;
		this.runtime = runtime;
		this.options = options || {};
		this.layout = this.options.layout || 'floating';
		this.position = this.options.position || 'right';
		this.voiceInput = this.options.voiceInput !== false;
		this.voiceOutput = this.options.voiceOutput !== false;
		this.isSpeaking = false;
		this.isListening = false;
		this.recognition = null;
		this.synth = window.speechSynthesis;
		this.messages = [];
		this.onFirstOpen = null;
		this._hasOpened = false;
		this._apiDisabled = false;
		this._storageKey = `nich-agent:history:${this.identity?.id || 'default'}`;
		this._modelKey = `nich-agent:model:${this.identity?.id || 'default'}`;
		this._loadHistory();
		this._loadModelChoice();

		this._buildUI();
		if (this.voiceInput) this._initSpeechRecognition();

		// Listen for SPEAK actions to render them in the chat
		if (this.protocol && !this.options.skipDefaultListeners) {
			this.protocol.on(ACTION_TYPES.SPEAK, (action) => {
				const text = action.payload?.text;
				if (text) {
					if (!action.payload._rendered) this._addMessage('agent', text);
					this._speak(text);
				}
			});

			// Show skill status in chat
			this.protocol.on(ACTION_TYPES.PERFORM_SKILL, (action) => {
				const skill = action.payload?.skill;
				if (skill && skill !== 'greet') {
					this._addMessage('agent', `[performing: ${skill}]`, 'status');
				}
			});

			// Clear chat history on model change so context stays relevant
			this.protocol.on(ACTION_TYPES.LOAD_START, () => this._resetHistory());
		}
	}

	// ── Speech Recognition ────────────────────────────────────────────────────

	_initSpeechRecognition() {
		if (!SpeechRecognition) return;

		this.recognition = new SpeechRecognition();
		this.recognition.continuous = false;
		this.recognition.interimResults = false;
		this.recognition.lang = 'en-US';

		this.recognition.onresult = (event) => {
			const text = event.results[0][0].transcript;
			this._addMessage('user', text);
			this._handleInput(text);
		};

		this.recognition.onend = () => {
			this.isListening = false;
			this.panel.querySelector('.nich-mic').classList.remove('active');
		};

		this.recognition.onerror = () => {
			this.isListening = false;
			this.panel.querySelector('.nich-mic').classList.remove('active');
		};
	}

	// ── UI ────────────────────────────────────────────────────────────────────

	_buildUI() {
		const titleText = this.options.title || this.identity?.name || 'Agent';
		const greeting =
			this.options.greeting ||
			(this.layout === 'embedded'
				? 'Hi! Ask me anything.'
				: `I'm here. Drop a model, ask me anything, or say "help".`);

		this.panel = document.createElement('div');
		this.panel.className =
			'nich-panel' +
			(this.layout === 'embedded'
				? ' nich-panel--embedded nich-position--' + this.position
				: '');
		this.panel.innerHTML = `
			<div class="nich-header">
				<span class="nich-title">${_escapeHTML(titleText)}</span>
				<div class="nich-header-right">
					<select class="nich-model-select" aria-label="Choose model" title="Choose model">
						${MODEL_OPTIONS.map(
							(opt) =>
								`<option value="${opt.id}"${opt.id === this._modelChoice ? ' selected' : ''}>${_escapeHTML(opt.label)}</option>`,
						).join('')}
					</select>
					<span class="nich-emotion-dot" id="nich-emotion-dot" title="Agent emotional state"></span>
					${this.layout === 'embedded' ? '' : '<button class="nich-close" aria-label="Close">&times;</button>'}
				</div>
			</div>
			<div class="nich-messages" id="agent-messages">
				<div class="nich-message agent">${_escapeHTML(greeting)}</div>
			</div>
			<div class="nich-controls">
				<input type="text" class="nich-input" placeholder="Ask the agent…" autocomplete="off" maxlength="4000" />
				<button class="nich-send" aria-label="Send">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
				</button>
			</div>
			${
				this.voiceInput
					? `
				<div class="nich-mic-row">
					<button class="nich-mic" aria-label="Toggle microphone">
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
					</button>
					<span class="nich-mic-hint">${SpeechRecognition ? 'or press mic to speak' : 'voice unavailable in this browser'}</span>
				</div>
			`
					: ''
			}
		`;

		// Apply theme overrides via CSS custom properties scoped to the panel.
		if (this.options.theme) {
			const t = this.options.theme;
			if (t.accent) this.panel.style.setProperty('--nich-accent', t.accent);
			if (t.background) this.panel.style.setProperty('--nich-bg', t.background);
			if (t.caption) this.panel.style.setProperty('--nich-fg', t.caption);
		}

		if (this.layout === 'embedded') {
			// Embedded: panel is always open inside its container, no toggle.
			this.container.appendChild(this.panel);
		} else {
			// Floating: original behaviour — fixed-position panel + toggle button on body.
			this.panel.style.display = 'none';
			this.container.appendChild(this.panel);
			this.toggleBtn = document.createElement('button');
			this.toggleBtn.className = 'nich-toggle';
			this.toggleBtn.setAttribute('aria-label', 'Talk to three.ws');
			this.toggleBtn.title = 'Talk to Agent';
			this.toggleBtn.innerHTML = `
				<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
					<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
					<path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/>
				</svg>
				<span class="nich-toggle-label">Agent</span>
			`;
			this.container.appendChild(this.toggleBtn);
			this.toggleBtn.addEventListener('click', () => this._togglePanel());
			this.panel
				.querySelector('.nich-close')
				?.addEventListener('click', () => this._togglePanel());
		}

		this.panel.querySelector('.nich-send').addEventListener('click', () => this._send());
		this.panel.querySelector('.nich-input').addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this._send();
		});
		this.panel.querySelector('.nich-mic')?.addEventListener('click', () => this._toggleMic());
		this.panel.querySelector('.nich-model-select')?.addEventListener('change', (e) => {
			this._modelChoice = e.target.value;
			try {
				localStorage.setItem(this._modelKey, this._modelChoice);
			} catch {}
			this._apiDisabled = false;
		});
	}

	// ── Panel Toggle ──────────────────────────────────────────────────────────

	_togglePanel() {
		const visible = this.panel.style.display !== 'none';
		this.panel.style.display = visible ? 'none' : 'flex';
		this.toggleBtn.classList.toggle('active', !visible);
		if (!visible) {
			this.panel.querySelector('.nich-input').focus();
			// First open triggers a greeting skill
			if (!this._hasOpened) {
				this._hasOpened = true;
				if (this.onFirstOpen) this.onFirstOpen();
				else if (this.skills) {
					this.skills.perform('greet', {}, { identity: this.identity });
				}
			}
		}
	}

	// ── Input Handling ────────────────────────────────────────────────────────

	_send() {
		const input = this.panel.querySelector('.nich-input');
		const text = input.value.trim();
		if (!text) return;
		input.value = '';
		this._addMessage('user', text);
		this._handleInput(text);
	}

	async _handleInput(text) {
		// Custom dispatch (talking-agent widget routes through /api/widgets/:id/chat)
		if (typeof this.options.onSend === 'function') {
			const typing = this._startTyping();
			try {
				const result = await this.options.onSend(text);
				if (result?.reply) {
					this._addMessage('agent', result.reply);
					this._pushHistory('user', text);
					this._pushHistory('assistant', result.reply);
					if (this.protocol) {
						this.protocol.emit({
							type: ACTION_TYPES.SPEAK,
							payload: { text: result.reply, sentiment: 0, _rendered: true },
							agentId: this.identity?.id || 'default',
						});
					} else {
						this._speak(result.reply);
					}
				} else if (result?.error) {
					this._addMessage('agent', result.error, 'status');
				}
			} finally {
				typing();
			}
			return;
		}

		const lower = text.toLowerCase();

		// Route to skills first (high-precision pattern matching)
		if (this.skills) {
			const skillName = this._matchSkill(lower);
			if (skillName) {
				await this.skills.perform(skillName, { query: text }, { identity: this.identity });
				return;
			}
		}

		// Preferred path: call the /api/chat LLM endpoint with viewer context.
		if (!this._apiDisabled) {
			const apiResult = await this._callChatAPI(text);
			if (apiResult.ok) {
				await this._applyApiReply(apiResult);
				return;
			}
			if (apiResult.disable) this._apiDisabled = true;
		}

		// Secondary: the client-side Runtime (only meaningful if a provider
		// was configured via #brain=anthropic&proxyURL=... — NullProvider returns '').
		if (this.runtime) {
			try {
				const { text: reply } = await this.runtime.send(text);
				if (reply) {
					this._addMessage('agent', reply);
					this._speak(reply);
					this._pushHistory('user', text);
					this._pushHistory('assistant', reply);
					return;
				}
			} catch (err) {
				console.warn('[NichAgent] Runtime error, falling back:', err.message);
			}
		}

		// Final fallback: offline pattern match so the agent still responds.
		const response = this._generateResponse(text);
		this._addMessage('agent', response);

		if (this.protocol) {
			this.protocol.emit({
				type: ACTION_TYPES.SPEAK,
				payload: { text: response, sentiment: 0, _rendered: true },
				agentId: this.identity?.id || 'default',
			});
		} else {
			this._speak(response);
		}
	}

	// ── Chat API ─────────────────────────────────────────────────────────────

	async _callChatAPI(message) {
		const messagesEl = this.panel.querySelector('#agent-messages');
		const streamEl = document.createElement('div');
		streamEl.className = 'nich-message agent';
		streamEl.textContent = '…';
		messagesEl.appendChild(streamEl);
		messagesEl.scrollTop = messagesEl.scrollHeight;

		const choice = MODEL_OPTIONS.find((o) => o.id === this._modelChoice);
		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					message,
					context: this._buildContext(),
					history: this._history.slice(-10),
					...(choice?.provider ? { provider: choice.provider, model: choice.model } : {}),
				}),
			});

			if (res.status === 401) {
				streamEl.remove();
				return { ok: false, disable: true, reason: 'unauthorized' };
			}
			if (res.status === 503) {
				streamEl.remove();
				return { ok: false, disable: true, reason: 'unconfigured' };
			}
			if (res.status === 429) {
				streamEl.remove();
				const data = await res.json().catch(() => ({}));
				return { ok: false, rateLimited: true, retryAfter: data.retry_after };
			}
			if (!res.ok) {
				streamEl.remove();
				return { ok: false, reason: `http_${res.status}` };
			}

			const contentType = res.headers.get('content-type') || '';
			if (!contentType.includes('text/event-stream')) {
				streamEl.remove();
				const data = await res.json();
				return { ok: true, message, reply: (data.reply || '').trim(), actions: data.actions || [] };
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			let streaming = false;

			outer: while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop();
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					let evt;
					try {
						evt = JSON.parse(line.slice(6));
					} catch {
						continue;
					}
					if (evt.type === 'chunk') {
						if (!streaming) {
							streamEl.textContent = '';
							streaming = true;
						}
						streamEl.textContent += evt.text;
						messagesEl.scrollTop = messagesEl.scrollHeight;
					} else if (evt.type === 'done') {
						if (!streaming) streamEl.remove();
						return { ok: true, message, reply: evt.reply || '', actions: evt.actions || [], streamEl: streaming ? streamEl : null };
					} else if (evt.type === 'error') {
						streamEl.remove();
						return { ok: false, reason: evt.code || 'upstream_error' };
					}
				}
			}

			streamEl.remove();
			return { ok: false, reason: 'stream_incomplete' };
		} catch (err) {
			streamEl.remove();
			console.warn('[NichAgent] /api/chat failed:', err.message);
			return { ok: false, reason: 'network' };
		}
	}

	async _applyApiReply({ message, reply, actions, streamEl }) {
		this._pushHistory('user', message);

		if (reply) {
			if (!streamEl) this._addMessage('agent', reply);
			this._pushHistory('assistant', reply);
			if (this.protocol) {
				this.protocol.emit({
					type: ACTION_TYPES.SPEAK,
					payload: { text: reply, sentiment: 0, _rendered: true },
					agentId: this.identity?.id || 'default',
				});
			} else {
				this._speak(reply);
			}
		}

		for (const action of actions || []) {
			try {
				await this._executeAction(action);
			} catch (err) {
				console.warn('[NichAgent] action failed:', action?.type, err.message);
			}
		}
	}

	_buildContext() {
		const viewer = window.VIEWER?.app?.viewer;
		const validator = window.VIEWER?.app?.validator;
		const state = viewer?.state || {};
		const ctx = {
			wireframe: !!state.wireframe,
			skeleton: !!state.skeleton,
			grid: !!state.grid,
			autoRotate: !!state.autoRotate,
			transparentBg: !!state.transparentBg,
			bgColor: state.bgColor,
			currentEnvironment: state.environment,
		};
		if (viewer?.content) {
			if (viewer.content.name) ctx.modelName = viewer.content.name;
			const stats = this._countStats(viewer.content);
			ctx.vertices = stats.vertices;
			ctx.triangles = stats.triangles;
			ctx.materials = stats.materials;
			ctx.animations = viewer.clips?.length || 0;
		}
		if (validator?.report) {
			ctx.validationErrors = validator.report.errors?.length || 0;
			ctx.validationWarnings = validator.report.warnings?.length || 0;
		}
		return ctx;
	}

	_countStats(root) {
		let vertices = 0,
			triangles = 0;
		const materials = new Set();
		root.traverse((node) => {
			if (node.isMesh || node.isPoints || node.isLine) {
				const geo = node.geometry;
				if (geo) {
					if (geo.index) triangles += geo.index.count / 3;
					else if (geo.attributes.position)
						triangles += geo.attributes.position.count / 3;
					if (geo.attributes.position) vertices += geo.attributes.position.count;
				}
				const mats = Array.isArray(node.material) ? node.material : [node.material];
				for (const m of mats) if (m) materials.add(m.uuid);
			}
		});
		return { vertices, triangles: Math.round(triangles), materials: materials.size };
	}

	async _executeAction(action) {
		const viewer = window.VIEWER?.app?.viewer;
		const app = window.VIEWER?.app;
		if (!action || typeof action.type !== 'string') return;

		switch (action.type) {
			case 'setWireframe':
				if (viewer) {
					viewer.state.wireframe = !!action.value;
					viewer.updateDisplay();
				}
				break;
			case 'setSkeleton':
				if (viewer) {
					viewer.state.skeleton = !!action.value;
					viewer.updateDisplay();
				}
				break;
			case 'setGrid':
				if (viewer) {
					viewer.state.grid = !!action.value;
					viewer.updateDisplay();
				}
				break;
			case 'setAutoRotate':
				if (viewer) {
					viewer.state.autoRotate = !!action.value;
					viewer.updateDisplay();
				}
				break;
			case 'setBgColor':
				if (viewer && typeof action.value === 'string') {
					viewer.state.bgColor = action.value;
					viewer.updateBackground();
				}
				break;
			case 'setTransparentBg':
				if (viewer) {
					viewer.state.transparentBg = !!action.value;
					viewer.updateBackground();
				}
				break;
			case 'setEnvironment':
				if (viewer && typeof action.value === 'string') {
					viewer.state.environment = action.value;
					viewer.updateEnvironment();
				}
				break;
			case 'takeScreenshot':
				viewer?.takeScreenshot?.();
				break;
			case 'loadModel':
				if (typeof action.url === 'string' && app?.view) {
					app.view(action.url, '', new Map());
				}
				break;
			case 'runValidation':
				// Open/focus the validation report panel so the user sees current results.
				document.querySelector('.validator-toggle')?.click?.();
				break;
			case 'showMaterialEditor':
				app?.editor?.sceneExplorer?.toggle?.();
				break;
			case 'setCameraTarget':
				if (viewer && typeof action.boneName === 'string') {
					viewer.setCameraTarget(action.boneName);
				}
				break;
			case 'getPumpFunTrades':
				if (viewer) {
					viewer.showPumpFunTrades();
				}
				break;
			default:
				console.warn('[NichAgent] unknown action:', action.type);
		}
	}

	// ── Typing indicator ─────────────────────────────────────────────────────

	_startTyping() {
		const messagesEl = this.panel.querySelector('#agent-messages');
		const el = document.createElement('div');
		el.className = 'nich-message agent typing';
		el.textContent = '…';
		messagesEl.appendChild(el);
		messagesEl.scrollTop = messagesEl.scrollHeight;
		return () => el.remove();
	}

	// ── Conversation history (sessionStorage) ────────────────────────────────

	_loadHistory() {
		this._history = [];
		try {
			const raw = sessionStorage.getItem(this._storageKey);
			if (raw) this._history = JSON.parse(raw).slice(-20);
		} catch {
			this._history = [];
		}
	}

	_loadModelChoice() {
		this._modelChoice = 'auto';
		try {
			const stored = localStorage.getItem(this._modelKey);
			if (stored && MODEL_OPTIONS.some((o) => o.id === stored)) {
				this._modelChoice = stored;
			}
		} catch {}
	}

	_pushHistory(role, content) {
		this._history.push({ role, content });
		if (this._history.length > 20) this._history = this._history.slice(-20);
		try {
			sessionStorage.setItem(this._storageKey, JSON.stringify(this._history));
		} catch {}
	}

	_resetHistory() {
		this._history = [];
		try {
			sessionStorage.removeItem(this._storageKey);
		} catch {}
	}

	/**
	 * Map user input to a skill name.
	 * Returns null if no skill matches.
	 */
	_matchSkill(lower) {
		if (lower.match(/\b(present|describe|tell me about|what.*model|show me)\b/))
			return 'present-model';
		if (lower.match(/\b(validate|check|errors|warnings|valid)\b/)) return 'validate-model';
		if (lower.match(/\b(remember|save|store|note|don't forget)\b/)) return 'remember';
		if (lower.match(/\b(sign|signature|wallet|verify|prove)\b/)) return 'sign-action';
		if (lower.match(/\b(think|recall|what do you know|context)\b/)) return 'think';
		if (lower.match(/\b(help|what can you|commands|skills|abilities)\b/)) return 'help';
		return null;
	}

	// ── Response Generation (fallback) ────────────────────────────────────────

	_generateResponse(input) {
		const lower = input.toLowerCase();
		const viewer = window.VIEWER?.app?.viewer;

		if (lower.match(/\b(hello|hi|hey|sup|yo)\b/)) {
			return 'Hey! Drop a 3D model in or ask me about the controls.';
		}
		if (lower.match(/\b(how|what).*(upload|load|open|import)\b/)) {
			return 'Drag and drop any glTF or GLB file onto the viewer, or click the upload button. The model loads instantly in your browser.';
		}
		if (lower.match(/\b(rotate|spin|orbit)\b/)) {
			return 'Click and drag to orbit. Enable auto-rotate in the Display controls panel on the right.';
		}
		if (lower.match(/\b(zoom)\b/)) {
			return 'Scroll wheel to zoom. On mobile, pinch.';
		}
		if (lower.match(/\b(pan|move)\b/)) {
			return 'Right-click and drag to pan. Two fingers on mobile.';
		}
		if (lower.match(/\b(wireframe)\b/)) {
			return 'Toggle wireframe in the Display controls panel — shows mesh topology.';
		}
		if (lower.match(/\b(light|lighting|dark|bright|exposure)\b/)) {
			return 'Open the Lighting folder in the controls panel. Change the environment map, adjust exposure, toggle punctual lights.';
		}
		if (lower.match(/\b(animation|animate|play|clip)\b/)) {
			return viewer?.clips?.length
				? `This model has ${viewer.clips.length} animation clip${viewer.clips.length !== 1 ? 's' : ''}. Find them in the Animation folder.`
				: 'No animations on this model, or load a model first.';
		}
		if (lower.match(/\b(background|bg|color)\b/)) {
			return 'Change the background colour in the Display controls using the bgColor picker.';
		}
		if (lower.match(/\b(format|gltf|glb|supported|file)\b/)) {
			return 'Supports glTF 2.0 (.gltf) and GLB (.glb). Convert other formats with Blender.';
		}
		if (lower.match(/\b(skeleton|bones|rig)\b/)) {
			return 'Enable skeleton helper in the Display panel to visualise bone structure.';
		}
		if (lower.match(/\b(screenshot|capture|photo)\b/)) {
			return 'Press P to take a screenshot. It downloads as a PNG automatically.';
		}
		if (lower.match(/\b(performance|fps|stats)\b/)) {
			return 'Open the Performance folder in the controls panel for live FPS/MS/MB stats.';
		}
		if (lower.match(/\b(who|what).*(you|this|agent)\b/)) {
			return `I'm ${this.identity?.name || 'three.ws'} — present, embodied, and here to help with your 3D work.`;
		}
		if (lower.match(/\b(memory|remember|memories)\b/)) {
			const stats = this.identity?.memory?.stats;
			if (stats?.total) {
				return `I have ${stats.total} memories: ${stats.user || 0} about you, ${stats.project || 0} project notes, ${stats.feedback || 0} feedback entries.`;
			}
			return 'No memories yet. Tell me something worth remembering.';
		}

		return 'Try asking me to present or validate the loaded model, or drop a glTF/GLB file to get started.';
	}

	// ── Speech Synthesis ─────────────────────────────────────────────────────

	_speak(text) {
		if (!this.voiceOutput) return;
		if (!this.synth) return;
		this.synth.cancel();

		const utterance = new SpeechSynthesisUtterance(text);
		utterance.rate = 1.0;
		utterance.pitch = 1.0;
		utterance.volume = 0.8;
		utterance.onstart = () => {
			this.isSpeaking = true;
		};
		utterance.onend = () => {
			this.isSpeaking = false;
		};

		this.synth.speak(utterance);
	}

	// ── Mic Toggle ────────────────────────────────────────────────────────────

	_toggleMic() {
		if (!this.recognition) {
			this._addMessage('agent', 'Speech recognition not supported here. Try Chrome or Edge.');
			return;
		}
		if (this.isListening) {
			this.recognition.stop();
			this.isListening = false;
			this.panel.querySelector('.nich-mic').classList.remove('active');
		} else {
			this.recognition.start();
			this.isListening = true;
			this.panel.querySelector('.nich-mic').classList.add('active');
		}
	}

	// ── Message Rendering ────────────────────────────────────────────────────

	_addMessage(role, text, type = '') {
		if (role !== 'status') {
			this.messages.push({ role, text });
		}
		const messagesEl = this.panel.querySelector('#agent-messages');
		const msgEl = document.createElement('div');
		msgEl.className = `nich-message ${role}${type ? ' ' + type : ''}`;
		msgEl.textContent = text;
		messagesEl.appendChild(msgEl);
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	// ── Dispose ───────────────────────────────────────────────────────────────

	dispose() {
		if (this.recognition) {
			try {
				this.recognition.stop();
			} catch {}
		}
		try {
			this.synth?.cancel();
		} catch {}
		this.panel?.remove();
		this.toggleBtn?.remove();
	}
}

function _escapeHTML(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Model choices surfaced in the header dropdown. `auto` lets the server pick
// based on which keys are configured (Anthropic → OpenRouter → Groq → OpenAI).
// Free OpenRouter entries are tool-call capable; Gemma/Qwen omitted because
// their tool-calling is unreliable.
const MODEL_OPTIONS = [
	{ id: 'auto', label: 'Auto', provider: null, model: null },
	{ id: 'anthropic:sonnet', label: 'Claude Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
	{
		id: 'openrouter:llama-70b',
		label: 'Llama 3.3 70B (free)',
		provider: 'openrouter',
		model: 'meta-llama/llama-3.3-70b-instruct:free',
	},
	{
		id: 'openrouter:gpt-oss',
		label: 'GPT-OSS 120B (free)',
		provider: 'openrouter',
		model: 'openai/gpt-oss-120b:free',
	},
	{
		id: 'openrouter:hermes',
		label: 'Hermes 3 405B (free)',
		provider: 'openrouter',
		model: 'nousresearch/hermes-3-llama-3.1-405b:free',
	},
	{
		id: 'groq:llama-70b',
		label: 'Groq Llama 3.3 70B',
		provider: 'groq',
		model: 'llama-3.3-70b-versatile',
	},
	{ id: 'openai:gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai', model: 'gpt-4o-mini' },
];
