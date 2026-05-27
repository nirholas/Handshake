import * as THREE from 'three';
import WebGL from 'three/addons/capabilities/WebGL.js';
import { initWalletButton } from './wallet.js';
import { eagerConnectWallet } from './erc8004/agent-registry.js';
import { Viewer } from './viewer.js';
import { Editor } from './editor/index.js';
import { SimpleDropzone } from 'simple-dropzone';
import { Validator } from './validator.js';
import { Footer } from './components/footer';
import { startWidgetRpcServer } from './widget/rpc-server.js';
import { NichAgent } from './nich-agent.js';
import { AvatarCreator } from './avatar-creator.js';
import { resolveURI, isDecentralizedURI } from './ipfs.js';
import { saveRemoteGlbToAccount, getMe, readAuthHint } from './account.js';
import { getWidget } from './widgets.js';
import { mountAnimationGallery } from './widgets/animation-gallery.js';
import { mountTalkingAgent } from './widgets/talking-agent.js';
import { mountTurntable } from './widgets/turntable.js';
import { mountHotspotTour } from './widgets/hotspot-tour.js';
import { mountPumpfunFeed } from './widgets/pumpfun-feed.js';
import { mountKolTradesWidget } from './widgets/kol-trades.js';
import { mountLiveTradesCanvas } from './widgets/live-trades-canvas.js';
import { mountPassport } from './widgets/passport.js';
import queryString from 'query-string';
import { ScreenshotModal } from './components/screenshot-modal.js';
import { NextLayout } from './next-layout.js';

// Agent system — the new primitive layer
import { protocol, ACTION_TYPES } from './agent-protocol.js';
import { AgentIdentity } from './agent-identity.js';
import { AgentSkills } from './agent-skills.js';
import { AgentAvatar } from './agent-avatar.js';
import { AgentHome } from './agent-home.js';
import { setSceneViewer } from './agent-skills-scene.js';

// Runtime — LLM brain, scene control, file-based memory, skill bundles
import { SceneController } from './runtime/scene.js';
import { Runtime } from './runtime/index.js';
import { Memory } from './memory/index.js';
import { SkillRegistry } from './skills/index.js';

window.THREE = THREE;
window.VIEWER = {};

function _blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const s = reader.result;
			const comma = s.indexOf(',');
			resolve(comma >= 0 ? s.slice(comma + 1) : s);
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

function _base64ToFile(b64, name, type) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new File([bytes], name, { type });
}

function _fmtBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	const v = n / Math.pow(1024, i);
	return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Parse an on-chain agent URL path. Accepts:
 *   /a/<chainId>/<agentId>                       (canonical — registry inferred)
 *   /a/<chainId>/<agentId>/embed                 (chromeless iframe variant)
 *   /a/<chainId>/<registry>/<agentId>            (explicit registry, for non-canonical deployments)
 *   /a/<chainId>/<registry>/<agentId>/embed
 *   /a/eip155:<chainId>:<registry>/<agentId>     (full CAIP)
 */
function parseOnchainPath(pathname) {
	// Strip trailing /embed (capturing) then peel remaining segments.
	const embedMatch = pathname.match(/^(\/a\/.+?)\/embed\/?$/);
	const embed = !!embedMatch;
	const base = embed ? embedMatch[1] : pathname;
	const m = base.match(/^\/a\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/);
	if (!m) return null;
	const [, a, b, c] = m;

	// /a/eip155:chainId:registry/<agentId>
	const caipMatch = a.match(/^eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
	if (caipMatch && b && /^\d+$/.test(b) && !c) {
		return { chainId: Number(caipMatch[1]), registry: caipMatch[2], agentId: b, embed };
	}

	// /a/<chainId>/<registry>/<agentId>
	if (b && c && /^\d+$/.test(a) && /^0x[a-fA-F0-9]{40}$/.test(b) && /^\d+$/.test(c)) {
		return { chainId: Number(a), registry: b, agentId: c, embed };
	}

	// /a/<chainId>/<agentId> (canonical: registry inferred from REGISTRY_DEPLOYMENTS)
	if (b && !c && /^\d+$/.test(a) && /^\d+$/.test(b)) {
		return { chainId: Number(a), agentId: b, embed };
	}

	return null;
}

function escHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/** Parse #onchain=<chainId>:<agentId> for embed mode. */
function parseOnchainHash(value) {
	if (!value) return null;
	const m = String(value).match(/^(\d+):(\d+)$/);
	if (!m) return null;
	return { chainId: Number(m[1]), agentId: m[2] };
}

if (!(window.File && window.FileReader && window.FileList && window.Blob)) {
	console.error('The File APIs are not fully supported in this browser.');
} else if (!WebGL.isWebGL2Available()) {
	console.error('WebGL is not supported in this browser.');
}

class App {
	/**
	 * @param  {Element} el
	 * @param  {Location} location
	 */
	constructor(el, location) {
		const hash = location.hash ? queryString.parse(location.hash) : {};
		const qp = new URLSearchParams(location.search);
		// agentQuery: from ?agent= query param → editing mode (main UI with save-back)
		// agentHash:  from #agent= hash → legacy embed mode
		const agentQuery = qp.get('agent') || '';
		const agentHash = hash.agent || '';

		// On-chain CAIP-style route: /a/<chainId>/<agentId> [ /<registry> optional ]
		// Parses to { chainId, agentId, registry? } when matched. Renders the agent's
		// 3D avatar by resolving its registration file → `avatar` service endpoint.
		const onchain = parseOnchainPath(location.pathname) || parseOnchainHash(hash.onchain);

		this.options = {
			kiosk: Boolean(hash.kiosk) || !!(onchain && onchain.embed),
			model: hash.model || '',
			type: hash.type || '',
			preset: hash.preset || '',
			cameraPosition: hash.cameraPosition ? hash.cameraPosition.split(',').map(Number) : null,
			brain: hash.brain || 'none',
			proxyURL: hash.proxyURL || '',
			agent: agentHash, // hash-based agent keeps legacy embed behaviour
			agentEdit: agentQuery, // query-param agent → editing surface
			widget: hash.widget || '',
			deploy: hash.deploy !== undefined || location.pathname === '/deploy',
			onchain, // { chainId, agentId, registry? } | null
			showcase: location.pathname === '/showcase' || location.pathname === '/showcase/',
			// pending=1 signals a post-login save round-trip
			pending: qp.get('pending') === '1',
			// avatarSession: selfie pipeline passes a session URL here after processing photos
			avatarSession: hash.avatarSession ? decodeURIComponent(hash.avatarSession) : '',
			// Per-embed overrides (appended to iframe URL by Studio embed modal
			// and the public /widgets gallery customizer).
			noAnimations: Boolean(hash.noAnimations),
			noChat: Boolean(hash.noChat),
			noControls: Boolean(hash.noControls),
			avatarChatOff: hash['avatar-chat'] === 'off',
			// Live-customizer overrides — applied on top of the saved widget config.
			// Hash form is %23-encoded for color values (e.g. accent=%2300ff88).
			overrideAccent: hash.accent ? decodeURIComponent(hash.accent) : '',
			overrideBg: hash.bg ? decodeURIComponent(hash.bg) : '',
			overrideMint: hash.mint ? decodeURIComponent(hash.mint) : '',
			overrideKind: hash.kind || '',
			overrideMinTier: hash.minTier || '',
		};

		// Slim /widget shell — see pages/widget.html. The shell hides every
		// owner-mode surface and the viewer is the only thing on screen.
		// Several setup steps below (wallet reconnect, dropzone, selfie pipeline,
		// auth check, layout switch) are pure dead weight in that surface, so
		// we short-circuit them when the shell flag is present.
		this._widgetShell = Boolean(window.__WIDGET_SHELL);

		// Fire-and-forget silent wallet reconnect. Cheap (single `eth_accounts`
		// RPC), never throws, never prompts. If the user has previously authorized
		// the site, this populates the shared signer before any wallet UI mounts.
		// Skip in the slim widget shell — embeds don't need wallet state.
		if (!this._widgetShell) eagerConnectWallet();

		this.el = el;
		this.viewer = null;
		this.editor = null;
		this._previewMounted = false;
		this.viewerEl = null;
		this.spinnerEl = el.querySelector('.spinner');
		this.dropEl = el.querySelector('.wrap');
		this.inputEl = el.querySelector('#file-input');
		this.viewerContainerEl = el.querySelector('#viewer-container');
		this.validator = new Validator(el);

		// ── Agent System ──────────────────────────────────────────────────────
		this.identity = new AgentIdentity({ autoLoad: true });
		this.skills = null; // initialised after identity loads
		this.avatar = null; // initialised after viewer + content load
		this.agentHome = null;
		this.sceneCtrl = null; // SceneController — created when viewer is ready
		this.runtime = null; // LLM Runtime — created after identity + memory load
		this.fileMemory = null; // file-based Memory for LLM context
		this.skillRegistry = null; // external skill bundle loader

		// Wire validator results into the protocol
		this._hookValidator();

		// Viewer status overlay (loading / error UI) tied to LOAD_START / LOAD_END.
		this._wireViewerStatus();

		this._editingAgentId = this.options.agentEdit || null;

		// In the slim widget shell there's no dropzone, no selfie pipeline UI,
		// no sign-in link, no layout switch buttons. Skip those entirely so
		// we don't waste cycles attaching listeners + a network round-trip
		// (getMe) for an iframe that only renders a 3D canvas.
		// _applyViewerMode still runs — it sets `data-viewer-mode="embed"`
		// which CSS uses to hide ambient chrome on shared pages.
		if (!this._widgetShell) {
			this.createDropzone();
			this.setupAvatarCreator();
			if (this.options.avatarSession) {
				this.avatarCreator.open(this.options.avatarSession);
			}
		}
		this.hideSpinner();
		this._applyViewerMode();
		if (!this._widgetShell) {
			this._setupLayoutSwitch();
			this._setupNextLayout();
			this._updateSignInLink();
			this._setupSaveToAccount();
			this._setupMakeWidgetButton();
			this._setupScreenshotButton();
			this.screenshotModal = new ScreenshotModal(this.el);
		}

		const options = this.options;

		if (options.kiosk) {
			// In the slim widget shell there's no <header> in the DOM —
			// hide defensively only if it exists (legacy /app#kiosk=true URLs).
			const headerEl = document.querySelector('header');
			if (headerEl) headerEl.style.display = 'none';
			const footerEl = document.querySelector('footer');
			if (footerEl) footerEl.style.display = 'none';
		}

		// Check for deploy (ERC-8004 mint) page. We still load the default
		// avatar in the background so `_currentModelUrl` is populated for the
		// RegisterUI pre-fill — it reflects the viewer's current model.
		// Honor `?model=<url>` passed from the /app deploy button so an
		// unsaved viewer model still flows through instead of falling to CZ.
		if (options.deploy) {
			const qpModel = new URLSearchParams(location.search).get('model') || '';
			const model = options.model || qpModel || '/avatars/cz.glb';
			this.view(isDecentralizedURI(model) ? resolveURI(model) : model, '', new Map())
				.catch(() => {})
				.finally(() => this._showDeployPage());
			this._initAgentSystem();
			return;
		}

		// /showcase — browsable marketplace of every indexed three.ws.
		if (options.showcase) {
			this._showShowcasePage();
			this._initAgentSystem();
			return;
		}

		// /a/<chainId>/<agentId> — resolve an on-chain agent to its 3D avatar.
		if (options.onchain) {
			this._loadOnChainAgent(options.onchain);
			this._initAgentSystem();
			return;
		}

		// Load a specific agent by ID: /#agent=<uuid> (embed mode)
		if (options.agent) {
			this._loadAgent(options.agent);
			return;
		}

		// Load a saved widget by ID: /widget#widget=<wdgt_...> (slim shell,
		// canonical) or legacy /app#widget=<wdgt_...> (full SPA, still works).
		if (options.widget) {
			this._loadWidget(options.widget);
			this._initAgentSystem();
			this._initWidgetBridge();
			return;
		}

		// Editing an existing agent: ?agent=<uuid> (authenticated editing surface)
		if (options.agentEdit) {
			this._loadAgentForEdit(options.agentEdit).catch((err) => {
				// Defensive: _loadAgentForEdit handles its own failures and
				// always mounts the viewer up-front, but a truly unexpected
				// throw shouldn't leave the user with no UI to act on.
				console.warn('[3d-agent] agent-edit load failed', err);
				this._showViewerError("Couldn't load this agent.", () => this._retryAgentLoad());
				if (!this.viewer) this._maybeResumeOrLoad(this.options);
				if (!this._agentSystemBooted) this._initAgentSystem();
			});
		} else {
			// Resume a stashed editor session (post-login round-trip), else
			// load the model named in the URL or fall back to the CZ avatar.
			this._maybeResumeOrLoad(options);
		}

		// After sign-in redirect, check for a pending_save stash.
		if (options.pending) {
			this._maybePendingSave();
		}

		// Boot the agent system once identity is ready. When agentEdit is set,
		// _loadAgentForEdit calls _initAgentSystem itself after loading the
		// correct identity, so skip the early call to avoid a double-mount.
		if (!options.agentEdit) {
			this._initAgentSystem();
		}

		// Studio preview iframes use postMessage to live-update brand config.
		this._initWidgetBridge();

		// JSON-RPC 2.0 server for parents that want to drive the widget
		// programmatically (camera moves, animation playback, screenshots).
		// Always on — only the legacy bridge handlers had widget-scope checks,
		// because RPC is opt-in by the message envelope (jsonrpc: '2.0').
		startWidgetRpcServer(this);
	}

	/**
	 * If the URL carries ?resume=<token>, restore the stashed editor session
	 * (load source + replay edits + optionally auto-open Publish). Otherwise
	 * load the model from #model= or the default CZ avatar.
	 */
	async _maybeResumeOrLoad(options) {
		const params = new URLSearchParams(location.search);
		const resumeToken = params.get('resume');

		if (resumeToken) {
			try {
				const { restoreSession, clearStash } = await import('./editor/edit-persistence.js');
				const stashed = await restoreSession(resumeToken);
				if (stashed) {
					if (stashed.source.url) {
						await this.view(stashed.source.url, '', new Map());
					} else if (stashed.source.file) {
						const f = stashed.source.file;
						await this.load(new Map([[f.name, f]]));
					}

					if (this.editor && this.editor.session) {
						this.editor.session.restoreEdits(stashed.edits);
						// Panels snapshotted the original material values before
						// restoreEdits mutated them — rebuild so the GUI mirrors
						// the restored state.
						this.editor.materialEditor?.rebuild?.();
						this.editor.textureInspector?.rebuild?.();
						this.editor.sceneExplorer?.rebuild?.();
					}

					if (params.get('publish') === '1') {
						this.editor?._openPublishModal?.();
					}

					await clearStash(resumeToken);

					const clean = new URL(location.href);
					clean.searchParams.delete('resume');
					clean.searchParams.delete('publish');
					history.replaceState(null, '', clean.toString());
					return;
				}
			} catch (err) {
				console.warn('[3d-agent] resume failed', err);
			}
		}

		const model = options.model || '/avatars/cz.glb';
		const resolvedModel = isDecentralizedURI(model) ? resolveURI(model) : model;
		const isDefaultCz = !options.model;
		const loadPromise = this.view(resolvedModel, '', new Map());
		if (isDefaultCz) {
			loadPromise?.then?.(() => this._playDefaultLandingClip('taunt'));
		}
	}

	/**
	 * After the default CZ avatar loads on /app, stop the baked-in idle clip
	 * (which fights the manifest animations on the same skeleton and looks
	 * glitchy) and crossfade into a manifest clip once it's ready.
	 * @param {string} clipName
	 */
	_playDefaultLandingClip(clipName) {
		const viewer = this.viewer;
		if (!viewer) return;
		if (viewer.mixer) viewer.mixer.stopAllAction();
		const am = viewer.animationManager;
		if (!am) return;
		const start = performance.now();
		const tryPlay = () => {
			if (!this.viewer || this.viewer !== viewer) return;
			if (viewer.mixer) viewer.mixer.stopAllAction();
			const defs = am.getAnimationDefs();
			const hasDef = defs.some((d) => d.name === clipName);
			if (hasDef) {
				am.crossfadeTo(clipName).catch(() => {});
				return;
			}
			if (performance.now() - start > 8000) return;
			setTimeout(tryPlay, 200);
		};
		tryPlay();
	}

	// ── Agent System Init ─────────────────────────────────────────────────────

	async _initAgentSystem() {
		if (this._agentSystemBooted) return;
		this._agentSystemBooted = true;
		try {
			// Wait for identity to resolve (uses local storage immediately, backend async)
			await this.identity.load();

			// Skills need identity + memory
			this.skills = new AgentSkills(protocol, this.identity.memory);

			// File-based memory for LLM context injection
			this.fileMemory = await Memory.load({
				mode: 'local',
				namespace: this.identity.id,
			});

			// External skill bundle loader (empty initially — skills load on demand)
			this.skillRegistry = new SkillRegistry({ trust: 'owned-only' });

			// LLM Runtime — the agent's brain. Defaults to 'none' provider
			// (NichAgent pattern matching). Configure with #brain=anthropic&proxyURL=...
			this.runtime = new Runtime({
				manifest: {
					name: this.identity.name || 'Agent',
					instructions: [
						`You are ${this.identity.name || 'Agent'}, an AI agent embedded in a 3D model viewer at three.ws.`,
						'You can control the 3D scene, remember things, and help users with their 3D work.',
						'Be concise, clear, and helpful. You are present and embodied — act like it.',
					].join(' '),
					brain: {
						provider: this.options.brain,
						proxyURL: this.options.proxyURL || undefined,
					},
					tools: ['wave', 'lookAt', 'play_clip', 'setExpression', 'speak', 'remember'],
				},
				viewer: this.sceneCtrl, // null until viewer loads
				memory: this.fileMemory,
				skills: this.skillRegistry,
			});

			// Bridge Runtime assistant messages to the protocol bus
			this.runtime.addEventListener('brain:message', (e) => {
				if (e.detail.role === 'assistant' && e.detail.content) {
					protocol.emit({
						type: ACTION_TYPES.SPEAK,
						payload: { text: e.detail.content, sentiment: 0 },
						agentId: this.identity.id,
					});
				}
			});

			this.runtime.addEventListener('brain:action', (e) => {
				if (this.viewer && e.detail.tool_name === 'setCameraTarget') {
					this.viewer.setCameraTarget(e.detail.tool_input.boneName);
				}
			});

			// Expose agent on window for debugging
			window.VIEWER.agent_protocol = protocol;
			window.VIEWER.agent_identity = this.identity;
			window.VIEWER.agent_skills = this.skills;
			window.VIEWER.agent_runtime = this.runtime;

			// Announce presence
			protocol.emit({
				type: ACTION_TYPES.PRESENCE,
				payload: { status: 'online', agentId: this.identity.id },
				agentId: this.identity.id,
			});

			// Render the agent home panel (identity card + timeline). Idempotent —
			// if a previous boot already rendered, tear it down before re-mounting
			// so we never stack multiple cards in the sidebar.
			// Skip entirely in kiosk/embed — the panel belongs to owner/edit views.
			const homeEl = document.getElementById('agent-home-container');
			if (homeEl && !this.options.kiosk) {
				if (this.agentHome) this.agentHome.destroy();
				homeEl.innerHTML = '';
				this.agentHome = new AgentHome(homeEl, this.identity, protocol, this.avatar, {
					skills: this.agent_skills || window.VIEWER?.agent_skills,
					memory: this.agent_memory || window.VIEWER?.agent_memory,
				});
				await this.agentHome.render();
			}

			// Boot the voice/chat agent with skills and runtime wired in.
			// Skip in widget-embed mode — each widget type mounts its own UI
			// (talking-agent uses its own embedded NichAgent; others need no chat).
			// Also skip in any kiosk surface (slim /widget shell, public embed
			// snippets) so the "Agent" pill doesn't leak across an iframe
			// boundary that's meant to be branded by the embedder.
			if (!this.options.widget && !this.options.kiosk && !this._widgetShell) {
				this._initNichAgent();
			}

			// Log all significant actions to identity history (fire-and-forget)
			protocol.on('*', (action) => {
				if (
					[
						ACTION_TYPES.SPEAK,
						ACTION_TYPES.REMEMBER,
						ACTION_TYPES.SIGN,
						ACTION_TYPES.SKILL_DONE,
						ACTION_TYPES.VALIDATE,
						ACTION_TYPES.LOAD_END,
					].includes(action.type)
				) {
					this.identity.recordAction(action);
				}
			});
		} catch (err) {
			console.warn('[3d-agent] Agent system init failed:', err.message);
		}
	}

	_applyViewerMode() {
		const { kiosk, widget, agent, deploy } = this.options;
		let mode = 'main';
		if (kiosk || widget || agent) mode = 'embed';
		else if (deploy) mode = 'deploy';
		document.body.dataset.viewerMode = mode;
		if (mode === 'main') {
			// Only use 'pending' (hide gate, hide sidebar) when we have a stored 'true' hint —
			// i.e. the user was last seen logged in and may still be. For everyone else (no hint
			// or a 'false' hint) show the auth gate immediately so it never appears after the
			// CZ model renders (which is instant when the GLB is cached from the homepage).
			document.body.dataset.authed = readAuthHint() === 'true' ? 'pending' : 'false';
		}
		this._applyViewerLayout();
	}

	_applyViewerLayout() {
		let stored = null;
		try {
			stored = localStorage.getItem('3dagent:viewer-layout');
		} catch {
			/* ignore — storage may be unavailable in private mode */
		}
		const layout = stored === 'next' ? 'next' : 'classic';
		document.body.dataset.layout = layout;
	}

	_setupNextLayout() {
		// Skip in embed/widget/kiosk/deploy contexts — Next chrome is owner-only.
		if (document.body.dataset.viewerMode !== 'main') return;
		this._nextLayout = new NextLayout(this);
		this._nextLayout.mount();
	}

	_setupLayoutSwitch() {
		const root = document.getElementById('layout-switch');
		if (!root) return;
		if (document.body.dataset.viewerMode !== 'main') return;
		root.hidden = false;

		const buttons = Array.from(root.querySelectorAll('[data-layout-value]'));
		const sync = () => {
			const current = document.body.dataset.layout || 'classic';
			for (const btn of buttons) {
				const active = btn.dataset.layoutValue === current;
				btn.setAttribute('aria-pressed', String(active));
				btn.classList.toggle('layout-switch__btn--active', active);
			}
		};
		sync();

		for (const btn of buttons) {
			btn.addEventListener('click', () => {
				const value = btn.dataset.layoutValue === 'next' ? 'next' : 'classic';
				if (document.body.dataset.layout === value) return;
				document.body.dataset.layout = value;
				try {
					localStorage.setItem('3dagent:viewer-layout', value);
				} catch {
					/* ignore */
				}
				sync();
			});
		}
	}

	async _updateSignInLink() {
		const link = document.getElementById('nav-sign-in');
		try {
			const user = await getMe();
			if (link && user) link.classList.add('signed-in');
			if (user) this._initUserMenu(user);
			if (document.body.dataset.viewerMode === 'main') {
				document.body.dataset.authed = user ? 'true' : 'false';
			}
		} catch {
			if (document.body.dataset.viewerMode === 'main') {
				document.body.dataset.authed = 'false';
			}
		}
	}

	_initUserMenu(user) {
		const wrap = document.getElementById('nav-user-wrap');
		const btn = document.getElementById('nav-user-btn');
		const menu = document.getElementById('nav-user-menu');
		const label = document.getElementById('nav-user-label');
		const profileLink = document.getElementById('nav-my-profile-link');
		const signOutBtn = document.getElementById('nav-sign-out-btn');
		if (!wrap || !btn || !menu) return;

		if (label) label.textContent = user.email || user.username || 'Account';
		if (profileLink && user.address) profileLink.href = `/u/${user.address}`;

		wrap.hidden = false;

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const open = menu.hidden === false;
			menu.hidden = open;
			btn.setAttribute('aria-expanded', String(!open));
		});

		document.addEventListener('click', () => {
			if (!menu.hidden) {
				menu.hidden = true;
				btn.setAttribute('aria-expanded', 'false');
			}
		});

		menu.addEventListener('click', (e) => e.stopPropagation());

		if (signOutBtn) {
			signOutBtn.addEventListener('click', () => {
				fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).finally(
					() => {
						try {
							localStorage.removeItem('3dagent:auth-hint');
						} catch {
							/* ignore */
						}
						location.href = '/';
					},
				);
			});
		}
	}

	_refreshMakeWidgetButton() {
		const btn = document.getElementById('make-widget-btn');
		if (!btn) return;
		const url = this._currentModelUrl;
		if (!url && !this._hasLocalGlb) {
			btn.hidden = true;
			return;
		}
		if (url) {
			btn.href = `/studio?model=${encodeURIComponent(url)}`;
		}
		btn.hidden = false;
	}

	_refreshSaveToAccountButton() {
		const btn = document.getElementById('save-to-account-btn');
		if (!btn) return;
		const hasModel = this._currentModelUrl || this._hasLocalGlb;
		btn.hidden = !hasModel;
	}

	// Build a `&model=<url>` suffix for the deploy button when the viewer is
	// currently showing a hosted GLB. blob:/data: URLs aren't carryable across
	// a navigation, so we drop them and let /deploy fall back to its defaults.
	_deployModelParam() {
		const url = this._currentModelUrl || '';
		if (!url) return '';
		if (url.startsWith('blob:') || url.startsWith('data:')) return '';
		return `&model=${encodeURIComponent(url)}`;
	}

	// Surface the right deploy CTA next to the public-profile link in /app:
	//   • "Deploy on-chain" → /deploy?avatar=<id>   (un-registered agent)
	//   • "Deployed ✓"      → block-explorer URL    (already on-chain)
	// Falls back to the bare /deploy page if we can't read the agent record
	// (fetch error, anonymous, etc.) so the affordance never disappears once
	// we know there's an agent in scope.
	async _refreshDeployButton(agentId) {
		const btn = document.getElementById('deploy-onchain-btn');
		if (!btn || !agentId) return;

		const label = btn.querySelector('[data-state-label]');
		btn.classList.remove('is-deployed');
		btn.removeAttribute('target');
		btn.removeAttribute('rel');
		if (label) label.textContent = 'Deploy on-chain';
		btn.setAttribute('aria-label', 'Publish this agent on-chain');
		btn.setAttribute('title', 'Publish this agent on-chain (ERC-8004)');
		// Carry the viewer's current model URL across so /deploy doesn't fall
		// back to the CZ avatar when the agent hasn't been saved yet. Skip
		// blob:/data: URLs — they don't survive a navigation.
		const modelParam = this._deployModelParam();
		btn.href = `/deploy?agent=${encodeURIComponent(agentId)}${modelParam}`;
		btn.hidden = false;

		try {
			const resp = await fetch(`/api/agents/${agentId}`, { credentials: 'include' });
			if (!resp.ok) return;
			const { agent } = await resp.json();
			if (!agent) return;

			if (agent.avatar_id && !btn.dataset.avatarPrefilled) {
				btn.href = `/deploy?avatar=${encodeURIComponent(agent.avatar_id)}`;
				btn.dataset.avatarPrefilled = '1';
			}

			const isDeployed = agent.erc8004_agent_id && agent.chain_id;
			if (!isDeployed) return;

			const { CHAIN_META, addressExplorerUrl, tokenExplorerUrl } = await import(
				'./erc8004/chain-meta.js'
			);
			const chainName = CHAIN_META[agent.chain_id]?.name || `chain ${agent.chain_id}`;
			let url = '';
			if (agent.erc8004_registry) {
				url = tokenExplorerUrl(
					agent.chain_id,
					agent.erc8004_registry,
					agent.erc8004_agent_id,
				);
			}
			if (!url && agent.erc8004_registry) {
				url = addressExplorerUrl(agent.chain_id, agent.erc8004_registry);
			}
			if (!url) url = `/agent/${agentId}`;

			btn.classList.add('is-deployed');
			btn.href = url;
			btn.target = '_blank';
			btn.rel = 'noopener';
			if (label) label.textContent = `Deployed ✓ ${chainName}`;
			btn.setAttribute(
				'aria-label',
				`This agent is registered on ${chainName}. Open block explorer in a new tab.`,
			);
			btn.setAttribute('title', `On-chain on ${chainName} — view on explorer`);
		} catch {
			/* keep the un-deployed CTA */
		}
	}

	_setupSaveToAccount() {
		const btn = document.getElementById('save-to-account-btn');
		if (!btn) return;
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			this._triggerSaveToAccount();
		});
	}

	_setupMakeWidgetButton() {
		// No auth gate — /studio handles anonymous users gracefully.
	}

	_setupScreenshotButton() {
		const btn = document.getElementById('screenshot-btn');
		if (!btn) return;
		btn.addEventListener('click', async (e) => {
			e.preventDefault();
			if (this.viewer) {
				const blob = await this.viewer.captureScreenshot();
				if (blob) {
					this.screenshotModal.show(blob);
				}
			}
		});
	}

	async _triggerSaveToAccount() {
		const user = await getMe();
		if (!user) {
			await this._stashAndRedirectToLogin();
			return;
		}
		await this._performSave(user);
	}

	async _stashAndRedirectToLogin() {
		const btn = document.getElementById('save-to-account-btn');
		if (btn) {
			btn.setAttribute('disabled', '');
			btn.querySelector('span').textContent = 'Preparing…';
		}

		const stash = {
			glbUrl: this._currentModelUrl || null,
			fileName: this._currentLocalFile?.name || null,
			fileB64: null,
			returnTo: '/app',
			agentId: this._editingAgentId || null,
			ts: Date.now(),
		};

		// Local file drops can't be re-hydrated from a blob URL after reload.
		// Encode as base64 and stash — sessionStorage quota is ~5MB, so this
		// fails gracefully for oversized GLBs (user re-drops after sign-in).
		if (this._currentLocalFile) {
			try {
				stash.fileB64 = await _blobToBase64(this._currentLocalFile);
				stash.contentType = this._currentLocalFile.type || 'model/gltf-binary';
			} catch {
				/* fall through without file data */
			}
		}

		try {
			sessionStorage.setItem('pending_save', JSON.stringify(stash));
		} catch {
			// Quota exceeded — drop the file payload and retry with just metadata
			delete stash.fileB64;
			try {
				sessionStorage.setItem('pending_save', JSON.stringify(stash));
			} catch {
				/* storage disabled — proceed without stash */
			}
		}
		location.href = '/login?next=' + encodeURIComponent('/app?pending=1');
	}

	async _performSave(user) {
		if (!user) return;
		const btn = document.getElementById('save-to-account-btn');
		if (btn) {
			btn.setAttribute('disabled', '');
			btn.querySelector('span').textContent = 'Saving…';
		}
		try {
			let avatarId;
			const source = this._currentLocalFile || this._currentModelUrl;
			if (!source) {
				// Nothing to save — reset UI and bail
				if (btn) {
					btn.removeAttribute('disabled');
					btn.querySelector('span').textContent = 'Save to account';
				}
				return;
			}
			const avatar = await saveRemoteGlbToAccount(source, {
				source: this._currentLocalFile ? 'upload' : 'import',
				name: this._currentLocalFile?.name,
				source_meta: this._currentLocalFile
					? { original_filename: this._currentLocalFile.name }
					: undefined,
			});
			avatarId = avatar.id;

			if (this._editingAgentId) {
				// Update existing agent's avatar
				if (avatarId) {
					await fetch(`/api/agents/${this._editingAgentId}`, {
						method: 'PUT',
						credentials: 'include',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ avatar_id: avatarId }),
					});
				}
				location.href = `/agent/${this._editingAgentId}`;
			} else {
				// Create a new agent linked to the uploaded avatar
				const res = await fetch('/api/agents/me', {
					method: 'GET',
					credentials: 'include',
				});
				const data = res.ok ? await res.json() : null;
				let agentId = data?.agent?.id;

				if (!agentId) {
					const created = await fetch('/api/agents', {
						method: 'POST',
						credentials: 'include',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ name: 'My Agent' }),
					});
					const createdData = created.ok ? await created.json() : null;
					agentId = createdData?.agent?.id;
				}

				if (agentId && avatarId) {
					await fetch(`/api/agents/${agentId}`, {
						method: 'PUT',
						credentials: 'include',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ avatar_id: avatarId }),
					});
				}

				if (agentId) {
					location.href = `/agent/${agentId}`;
				} else {
					this._flashSaved({ name: 'your account' });
					if (btn) {
						btn.removeAttribute('disabled');
						btn.querySelector('span').textContent = 'Save to account';
					}
				}
			}
		} catch (err) {
			console.warn('[3d-agent] save failed:', err.message);
			if (btn) {
				btn.removeAttribute('disabled');
				btn.querySelector('span').textContent = 'Save to account';
			}
		}
	}

	async _maybePendingSave() {
		let stash;
		try {
			const raw = sessionStorage.getItem('pending_save');
			if (!raw) return;
			stash = JSON.parse(raw);
		} catch {
			return;
		}

		// Stale stashes (older than 1 hour) are discarded — the user likely
		// abandoned the sign-in flow and we shouldn't silently replay old work.
		if (!stash || !stash.ts || Date.now() - stash.ts > 60 * 60 * 1000) {
			sessionStorage.removeItem('pending_save');
			return;
		}

		const user = await getMe();
		if (!user) return; // still not authed — leave stash intact

		sessionStorage.removeItem('pending_save');

		// Restore the editing context from the stash
		if (stash.agentId) this._editingAgentId = stash.agentId;

		// Re-hydrate the model: local file (base64) takes priority over remote URL
		if (stash.fileB64 && stash.fileName) {
			const file = _base64ToFile(
				stash.fileB64,
				stash.fileName,
				stash.contentType || 'model/gltf-binary',
			);
			await this.load(new Map([[stash.fileName, file]]));
		} else if (stash.glbUrl && stash.glbUrl !== this._currentModelUrl) {
			await this.view(stash.glbUrl, '', new Map());
		}

		// Strip ?pending from URL before saving
		const clean = new URL(location.href);
		clean.searchParams.delete('pending');
		history.replaceState(null, '', clean.toString());

		await this._performSave(user);
	}

	async _loadAgent(agentId) {
		this.identity = new AgentIdentity({ agentId, autoLoad: false });
		await this.identity.load();

		let glbUrl = '/avatars/cz.glb';
		this._currentUsdzUrl = null;
		this._currentHalfbodyUrl = null;
		if (this.identity.avatarId) {
			try {
				const resp = await fetch(`/api/avatars/${this.identity.avatarId}`, {
					credentials: 'include',
				});
				if (resp.ok) {
					const { avatar } = await resp.json();
					if (avatar?.url) glbUrl = avatar.url;
					this._currentUsdzUrl = avatar?.usdz_url || null;
					this._currentHalfbodyUrl = avatar?.halfbody_url || null;
				}
			} catch {
				/* fall through to default */
			}
		}

		this.view(glbUrl, '', new Map());
		this._initAgentSystem();
	}

	async _loadAgentForEdit(agentId) {
		// Reset onboarding gate so a retry can re-fire it once the GLB actually
		// loads. The localStorage gate inside _maybeShowOnboarding still
		// guarantees once-per-agent in steady state.
		this._onboardingFired = false;

		// Mount the canvas up-front so the loading/error overlay has a parent
		// and the page layout never collapses around an empty container.
		if (!this.viewer) this.createViewer();

		// Surface a loading state immediately — the identity name lookup
		// below may take a moment, and the user shouldn't see an empty stage.
		this._showViewerLoading('Loading your avatar…');

		// Swap this.identity to the agent being edited so AgentHome (and the
		// Solana wallet card) render for *this* agent rather than the viewer's
		// default identity.
		this.identity = new AgentIdentity({ agentId, autoLoad: false });
		try {
			await this.identity.load();
		} catch {
			/* fall through; identity getter still returns _agentId */
		}

		// Refresh the loading label now that we know the agent's name.
		if (this.identity?.name) {
			this._showViewerLoading(`Loading ${this.identity.name}…`);
		}

		// Fetch the agent record and resolve its GLB URL.
		let glbUrl = null;
		let fetchFailed = false;
		let thumbnailUrl = null;
		this._currentUsdzUrl = null;
		this._currentHalfbodyUrl = null;
		this._currentAvatarId = null;
		this._avatarNeedsThumbnail = false;
		try {
			const resp = await fetch(`/api/agents/${agentId}`, { credentials: 'include' });
			if (resp.ok) {
				const { agent } = await resp.json();
				if (agent?.avatar_id) {
					const avatarResp = await fetch(`/api/avatars/${agent.avatar_id}`, {
						credentials: 'include',
					});
					if (avatarResp.ok) {
						const { avatar } = await avatarResp.json();
						if (avatar?.url) glbUrl = avatar.url;
						this._currentUsdzUrl = avatar?.usdz_url || null;
						this._currentHalfbodyUrl = avatar?.halfbody_url || null;
						this._currentAvatarId = avatar?.id || null;
						thumbnailUrl = avatar?.thumbnail_url || null;
						// Flag for the LOAD_END(success) listener to capture
						// and upload a thumbnail once the avatar is rendered.
						this._avatarNeedsThumbnail = !thumbnailUrl && !!glbUrl;
					} else {
						fetchFailed = true;
					}
				}
			} else {
				fetchFailed = true;
			}
		} catch {
			fetchFailed = true;
		}

		// Show the thumbnail as a poster behind the canvas so a 4-5 MB GLB
		// stream isn't a black void. Crossfades out on LOAD_END(success).
		if (thumbnailUrl) this._showPoster(thumbnailUrl);

		// Three outcomes:
		//   1. GLB URL found       → load it. Success/error overlay is driven
		//      by the LOAD_END protocol listener.
		//   2. Agent has no avatar → load the default CZ avatar so the editor
		//      is usable; no error overlay (this is a legitimate state).
		//   3. Agent fetch failed  → show error overlay with Retry. Still
		//      load the default CZ so the editor canvas isn't empty.
		if (glbUrl) {
			this.view(glbUrl, '', new Map());
		} else if (fetchFailed) {
			// Don't trigger a fallback load — its LOAD_START would clobber
			// the error overlay. The renderer is already mounted from
			// createViewer() above; the user sees the error message on top
			// of an empty 3D scene, which honestly reflects the state.
			this._showViewerError("Couldn't load your avatar.", () => this._retryAgentLoad());
		} else {
			// Agent has no avatar attached yet — load the default so the
			// editor is usable. LOAD_END will hide the overlay normally.
			this._maybeResumeOrLoad(this.options);
		}

		// Restore + auto-save per-agent scene preferences (background, env,
		// exposure, auto-rotate) so the editor feels like coming back to
		// "your studio" rather than a generic default each time.
		if (this.viewer && this.viewer.attachScenePrefs) {
			this.viewer.attachScenePrefs(agentId);
		}

		const publicLink = document.getElementById('view-public-profile-btn');
		if (publicLink) {
			publicLink.href = `/agent/${agentId}`;
			publicLink.hidden = false;
		}

		this._refreshDeployButton(agentId);

		// Onboarding is fired from the LOAD_END(success) listener so the
		// "ready" popup only appears once the avatar is actually on screen.

		this._initAgentSystem();
		this._initWidgetBridge();
	}

	// First-time orientation overlay for a freshly created (or freshly loaded)
	// agent. Localstorage-keyed per agent so it never reappears once dismissed.
	_maybeShowOnboarding(agentId) {
		if (typeof window === 'undefined' || !agentId) return;
		const key = `3dagent:onboarded:${agentId}`;
		try {
			if (localStorage.getItem(key)) return;
		} catch {
			return;
		}

		const banner = document.getElementById('agent-onboarding');
		if (!banner) return;

		const closeBtn = document.getElementById('agent-onboarding-close');
		const deployLink = document.getElementById('agent-onboarding-deploy');
		const shareLink = document.getElementById('agent-onboarding-share');

		if (deployLink) deployLink.href = `/deploy?agent=${agentId}`;
		if (shareLink) shareLink.href = `/agent/${agentId}`;

		const dismiss = () => {
			banner.hidden = true;
			try {
				localStorage.setItem(key, '1');
			} catch {}
		};

		if (closeBtn) closeBtn.addEventListener('click', dismiss);
		// Auto-dismiss when the user clicks any of the CTAs — they've engaged.
		[deployLink, shareLink].forEach((el) => {
			if (el) el.addEventListener('click', dismiss);
		});

		banner.hidden = false;
	}

	async _loadWidget(widgetId) {
		let widget;
		try {
			widget = await getWidget(widgetId);
		} catch (err) {
			this._showWidgetError(`Widget not found: ${widgetId}`);
			return;
		}
		window.VIEWER.widget = widget;

		// Fire-and-forget view beacon for analytics. Skip three cases:
		//   • owner previews (Studio + dashboard pass &preview=1) — creator
		//     QA cycles shouldn't pollute stats
		//   • script-embed iframes (embed.js passes &embedded=1) — embed.js
		//     fires its own visibility-triggered beacon, this would double-count
		//   • the host page already counted (no flag) — direct visits to
		//     /w/:id or /app#widget=… always fire here
		try {
			const qs = new URLSearchParams(location.search);
			const hash = new URLSearchParams((location.hash || '#').slice(1));
			const isPreview = qs.get('preview') === '1' || hash.get('preview') === '1';
			const fromEmbed = hash.get('embedded') === '1';
			if (!isPreview && !fromEmbed) {
				const url = `/api/widgets/${encodeURIComponent(widgetId)}/view`;
				if (navigator.sendBeacon) {
					navigator.sendBeacon(url, new Blob([''], { type: 'text/plain' }));
				} else {
					fetch(url, {
						method: 'POST',
						keepalive: true,
						credentials: 'omit',
						mode: 'no-cors',
					});
				}
			}
		} catch {
			/* best-effort */
		}

		const cfg = { ...(widget.config || {}) };
		const modelUrl = widget.avatar?.model_url || '/avatars/cz.glb';

		// Apply per-embed URL overrides (set by Studio embed modal checkboxes).
		if (this.options.noAnimations) cfg.showClipPicker = false;
		if (this.options.noChat) cfg._noChat = true;
		if (this.options.noControls) cfg.showControls = false;
		if (this.options.avatarChatOff) cfg.avatarChatOff = true;

		// Live-customizer hash overrides (validated lightly — bad input is ignored).
		const HEX = /^#[0-9a-fA-F]{3,8}$/;
		if (this.options.overrideAccent && HEX.test(this.options.overrideAccent)) {
			cfg.accent = this.options.overrideAccent;
		}
		if (this.options.overrideBg && HEX.test(this.options.overrideBg)) {
			cfg.background = this.options.overrideBg;
			cfg.bg = this.options.overrideBg;
		}
		if (this.options.overrideMint) cfg.mint = this.options.overrideMint;
		if (
			this.options.overrideKind &&
			['all', 'claims', 'graduations'].includes(this.options.overrideKind)
		) {
			cfg.kind = this.options.overrideKind;
		}
		if (
			this.options.overrideMinTier &&
			['', 'notable', 'influencer', 'mega'].includes(this.options.overrideMinTier)
		) {
			cfg.minTier = this.options.overrideMinTier;
		}

		// Apply config to options BEFORE creating the viewer so first frame is right.
		if (Array.isArray(cfg.cameraPosition) && cfg.cameraPosition.length === 3) {
			this.options.cameraPosition = cfg.cameraPosition;
		}
		if (cfg.envPreset && cfg.envPreset !== 'none') {
			this.options.preset = cfg.envPreset;
		}

		// Kiosk + showControls drive the chrome.
		if (cfg.showControls === false || this.options.kiosk) {
			document.querySelector('header')?.style.setProperty('display', 'none');
		}

		const resolved = isDecentralizedURI(modelUrl) ? resolveURI(modelUrl) : modelUrl;
		this.view(resolved, '', new Map());

		// Apply post-create brand bits once viewer exists.
		queueMicrotask(() => this._applyWidgetConfig(cfg));

		// Type-specific mount (runs after viewer + content come up).
		queueMicrotask(() => this._mountWidgetByType(widget.type, cfg, widget.id));

		// Caption overlay — render once, simple.
		if (cfg.caption) this._renderWidgetCaption(cfg.caption);

		// Notify parent (script embed / Studio) that we're up.
		this._postToParent({ type: 'widget:ready', id: widget.id, widgetType: widget.type });
	}

	async _mountWidgetByType(type, cfg, widgetId) {
		try {
			if (type === 'animation-gallery') {
				const container = document.body;
				const ctl = await mountAnimationGallery(this.viewer, cfg, container);
				this._widgetController = ctl;
			} else if (type === 'talking-agent' && !cfg._noChat) {
				const ctl = await mountTalkingAgent(this.viewer, cfg, document.body, {
					widgetId,
					getSceneCtrl: () => this.sceneCtrl || window.VIEWER?.scene_ctrl || null,
					protocol,
					identity: this.identity,
					onMessage: (turn) => {
						this._postToParent({
							type: 'widget:chat:message',
							id: widgetId,
							role: turn.role,
							content: turn.content,
						});
					},
				});
				this._widgetController = ctl;
			} else if (type === 'turntable') {
				const ctl = await mountTurntable(this.viewer, cfg);
				this._widgetController = ctl;
			} else if (type === 'hotspot-tour') {
				const ctl = await mountHotspotTour(this.viewer, cfg, document.body, {
					onOpen: (hotspot) => {
						this._postToParent({
							type: 'widget:hotspot:open',
							id: hotspot?.id ?? null,
							label: hotspot?.label ?? null,
							widgetId,
						});
					},
				});
				this._widgetController = ctl;
			} else if (type === 'pumpfun-feed') {
				const ctl = await mountPumpfunFeed(this.viewer, cfg, document.body, { protocol });
				this._widgetController = ctl;
			} else if (type === 'kol-trades') {
				const host = document.createElement('div');
				host.className = 'kol-trades-host';
				host.style.cssText =
					'position:absolute;top:16px;right:16px;width:min(360px,calc(100% - 32px));max-height:calc(100% - 32px);overflow-y:auto;background:rgba(14,14,22,0.86);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:8px 10px;z-index:5';
				document.body.appendChild(host);
				const inner = mountKolTradesWidget(host, {
					mint: cfg.mint,
					limit: cfg.limit,
					refreshMs: cfg.refreshMs,
				});
				this._widgetController = {
					destroy() {
						inner?.destroy?.();
						host.remove();
					},
				};
			} else if (type === 'live-trades-canvas') {
				const ctl = mountLiveTradesCanvas(document.body, {
					mint: cfg.mint,
					chain: cfg.chain,
					bg: cfg.bg || cfg.background,
					minUsd: cfg.minUsd,
				});
				this._widgetController = ctl;
			} else if (type === 'passport') {
				const ctl = await mountPassport(this.viewer, cfg, document.body, widgetId);
				this._widgetController = ctl;
			}
		} catch (e) {
			console.warn('[widget] mount failed', type, e?.message);
		}
	}

	_applyWidgetConfig(cfg) {
		if (!this.viewer) return;
		try {
			if (cfg.background) this.viewer.setBackgroundColor(cfg.background);
			if (cfg.accent) {
				document.documentElement.style.setProperty('--accent', cfg.accent);
				const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(cfg.accent);
				if (m) {
					document.documentElement.style.setProperty(
						'--accent-soft',
						`rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},0.18)`,
					);
				}
			}
			if (typeof cfg.autoRotate === 'boolean' && this.viewer.controls) {
				this.viewer.controls.autoRotate = cfg.autoRotate;
				if (typeof cfg.rotationSpeed === 'number') {
					this.viewer.controls.autoRotateSpeed = cfg.rotationSpeed;
				}
			}
			if (cfg.envPreset && this.viewer.setEnvironment) {
				this.viewer.setEnvironment(cfg.envPreset);
			}
		} catch (e) {
			console.warn('[widget] applyConfig failed', e?.message);
		}
	}

	_renderWidgetCaption(text) {
		let el = document.getElementById('widget-caption');
		if (!el) {
			el = document.createElement('div');
			el.id = 'widget-caption';
			el.style.cssText =
				'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);padding:8px 18px;background:rgba(0,0,0,0.55);color:#fff;font-family:Inter,system-ui,sans-serif;font-size:14px;border-radius:999px;backdrop-filter:blur(8px);z-index:5;pointer-events:none;max-width:90vw;text-align:center';
			document.body.appendChild(el);
		}
		el.textContent = text;
	}

	_showWidgetError(message) {
		const el = document.createElement('div');
		el.style.cssText =
			'position:fixed;inset:0;display:grid;place-items:center;background:#0a0a0a;color:#e0e0e0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:2rem;z-index:9999';
		el.innerHTML = `<div><h1 style="font-weight:300;margin:0 0 0.5rem">Widget unavailable</h1><p style="opacity:0.7;margin:0">${message.replace(/[<>&"]/g, '')}</p><p style="margin-top:1.5rem"><a href="/" style="color:#ffffff">Open viewer</a> · <a href="/widgets" style="color:#ffffff">Browse gallery</a></p></div>`;
		document.body.appendChild(el);
	}

	_initWidgetBridge() {
		// MintScene bridge: { id, action, input } envelope from any parent frame.
		// Handles exportGLB and takeScreenshot (returning base64 data to caller).
		window.addEventListener('message', (event) => {
			const data = event.data;
			if (
				!data ||
				typeof data !== 'object' ||
				typeof data.id !== 'string' ||
				typeof data.action !== 'string'
			)
				return;
			// Only handle our specific action verbs to avoid intercepting unrelated messages.
			if (data.action !== 'exportGLB' && data.action !== 'takeScreenshot') return;
			if (!event.origin || event.origin === 'null') return;
			if (!this._parentOrigin) this._parentOrigin = event.origin;
			const replyOrigin = event.origin;
			const replyTo = event.source || window.parent;
			const reply = (result, err) => {
				try {
					replyTo.postMessage(
						err ? { id: data.id, error: err } : { id: data.id, result },
						replyOrigin,
					);
				} catch (_) {}
			};
			const viewer = this.viewer || window.VIEWER?.app?.viewer;
			if (!viewer) return reply(null, 'viewer not ready');
			if (data.action === 'takeScreenshot') {
				try {
					viewer.renderer.render(viewer.scene, viewer.activeCamera);
					const dataUrl = viewer.renderer.domElement.toDataURL('image/png');
					reply(dataUrl.replace('data:image/png;base64,', ''));
				} catch (e) {
					reply(null, e.message);
				}
				return;
			}
			if (data.action === 'exportGLB') {
				const scene = viewer.scene;
				const content = viewer.content;
				if (!content) return reply(null, 'no model loaded');
				import('three/addons/exporters/GLTFExporter.js')
					.then(({ GLTFExporter }) => {
						const exporter = new GLTFExporter();
						exporter.parse(
							content,
							(result) => {
								const bytes =
									result instanceof ArrayBuffer ? result : result.buffer;
								let binary = '';
								const arr = new Uint8Array(bytes);
								for (let i = 0; i < arr.length; i++)
									binary += String.fromCharCode(arr[i]);
								reply(btoa(binary));
							},
							(err) => {
								reply(null, String(err?.message || err));
							},
							{ binary: true },
						);
					})
					.catch((e) => {
						reply(null, 'GLTFExporter load failed: ' + e.message);
					});
				return;
			}
		});

		// Studio sends live config updates without a full reload. Also handles
		// runtime commands (play_clip, wave) for parent-driven embeds.
		window.addEventListener('message', (event) => {
			if (event.origin !== location.origin) return;
			const data = event.data;
			if (!data || typeof data !== 'object') return;

			if (data.type === 'widget:config' && data.config) {
				this._applyWidgetConfig(data.config);
				if (typeof data.config.caption === 'string') {
					this._renderWidgetCaption(data.config.caption);
				}
				// Preview mode (#model= + type=): mount widget runtime on first config message.
				if (this.options.type && !this._previewMounted) {
					this._previewMounted = true;
					this._mountWidgetByType(this.options.type, data.config, null).catch(() => {});
				}
				return;
			}

			if (data.type === 'widget:command' && data.command) {
				this._handleWidgetCommand(data.command, data.args || {});
			}

			// Forward pumpfun-feed focus changes from the parent frame to the
			// mounted widget overlay (which listens on document.body).
			if (data.type === 'pumpfun-feed:focus-mint') {
				document.body.dispatchEvent(
					new CustomEvent('pumpfun-feed:focus-mint', {
						detail: { mint: data.mint || null },
						bubbles: true,
					}),
				);
			}
			if (data.type === 'pumpfun-feed:set-narrate') {
				document.body.dispatchEvent(
					new CustomEvent('pumpfun-feed:set-narrate', {
						detail: { on: !!data.on },
						bubbles: true,
					}),
				);
			}
			if (data.type === 'pumpfun-feed:set-mood') {
				document.body.dispatchEvent(
					new CustomEvent('pumpfun-feed:set-mood', {
						detail: { mood: data.mood },
						bubbles: true,
					}),
				);
			}

			// Host-page reaction bridge: when the parent /pumpfun.html page
			// observes a feed event, it can ask the avatar to emote/dance
			// without having to mount the full widget overlay.
			if (data.type === 'pumpfun-feed:react' && data.reaction) {
				try {
					const proto = window.VIEWER?.agent_protocol || protocol;
					const r = data.reaction;
					if (proto && r.emote) proto.emit({ type: 'emote', payload: r.emote });
					if (proto && r.lookAt)
						proto.emit({ type: 'look-at', payload: { target: r.lookAt } });
					if (proto && r.gesture) proto.emit({ type: 'gesture', payload: r.gesture });
					if (proto && r.speak && data.speak !== false) {
						proto.emit({ type: 'speak', payload: r.speak });
					}
				} catch {}
			}
		});
	}

	_handleWidgetCommand(command, args) {
		const sceneCtrl = this.sceneCtrl || window.VIEWER?.scene_ctrl;
		if (!sceneCtrl) return;
		try {
			switch (command) {
				case 'play_clip':
					sceneCtrl.playClipByName?.(args.name);
					break;
				case 'lookAt':
					sceneCtrl.lookAt?.(args.target);
					break;
				case 'setExpression':
					sceneCtrl.setExpression?.(args.name, args.weight);
					break;
			}
		} catch (e) {
			console.warn('[widget] command failed', command, e?.message);
		}
	}

	_postToParent(msg) {
		if (!window.parent || window.parent === window) return;
		if (!this._parentOrigin) {
			try {
				if (document.referrer) this._parentOrigin = new URL(document.referrer).origin;
			} catch {}
		}
		if (!this._parentOrigin) {
			console.warn('[widget] parent origin unknown; dropping', msg?.type);
			return;
		}
		window.parent.postMessage(msg, this._parentOrigin);
	}

	_initNichAgent() {
		const agent = new NichAgent(
			document.body,
			protocol,
			this.skills,
			this.identity,
			this.runtime,
		);
		window.VIEWER.agent = agent;
		// Greet on first open
		agent.onFirstOpen = () => {
			this.skills.perform('greet', {}, { identity: this.identity });
		};
	}

	// ── Viewer setup + Avatar attachment ────────────────────────────────────

	/**
	 * Sets up the view manager.
	 * @return {Viewer}
	 */
	createViewer() {
		if (this.viewer) this.viewer.dispose();
		this.viewerEl = this.viewerContainerEl;
		this.viewer = new Viewer(this.viewerEl, this.options);
		initWalletButton();

		if (!this.options.kiosk) {
			this.editor = new Editor(this.viewer);
			this.editor.attach();
			window.VIEWER.editor = this.editor;
		}
		window.VIEWER.viewer = this.viewer;
		return this.viewer;
	}

	// ── Dropzone ─────────────────────────────────────────────────────────────

	createDropzone() {
		const dropCtrl = new SimpleDropzone(this.dropEl, this.inputEl);
		dropCtrl.on('drop', ({ files }) => this.load(files));
		dropCtrl.on('dropstart', () => this.showSpinner());
		dropCtrl.on('droperror', () => this.hideSpinner());

		// Reflect drag state on <body> so the dropzone bar can highlight.
		let dragDepth = 0;
		const wrap = this.dropEl;
		wrap.addEventListener('dragenter', (e) => {
			if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files'))
				return;
			dragDepth += 1;
			document.body.classList.add('is-dragover');
		});
		wrap.addEventListener('dragleave', () => {
			dragDepth = Math.max(0, dragDepth - 1);
			if (dragDepth === 0) document.body.classList.remove('is-dragover');
		});
		wrap.addEventListener('drop', () => {
			dragDepth = 0;
			document.body.classList.remove('is-dragover');
		});
	}

	// ── Avatar Creator ────────────────────────────────────────────────────────

	setupAvatarCreator() {
		this.avatarCreator = new AvatarCreator(document.body, async (glbSource) => {
			this.view(glbSource, '', new Map());
			try {
				const avatar = await saveRemoteGlbToAccount(glbSource, {
					source: 'avaturn',
					source_meta: { provider: 'avaturn' },
				});
				this._flashSaved(avatar);
			} catch (err) {
				if (err.code !== 'not_signed_in') {
					console.warn('[3d-agent] save to account failed:', err.message);
				}
			}
		});
	}

	// ── File Loading ──────────────────────────────────────────────────────────

	/**
	 * @param  {Map<string, File>} fileMap
	 */
	load(fileMap) {
		let rootFile, rootPath;
		Array.from(fileMap).forEach(([path, file]) => {
			if (file.name.match(/\.(gltf|glb)$/)) {
				rootFile = file;
				rootPath = path.replace(file.name, '');
			}
		});

		if (!rootFile) {
			this.onError('No .gltf or .glb asset found.');
		}

		return this.view(rootFile, rootPath, fileMap);
	}

	/**
	 * @param  {File|string} rootFile
	 * @param  {string} rootPath
	 * @param  {Map<string, File>} fileMap
	 */
	view(rootFile, rootPath, fileMap) {
		if (this.viewer) this.viewer.clear();

		const viewer = this.viewer || this.createViewer();
		const fileURL = typeof rootFile === 'string' ? rootFile : URL.createObjectURL(rootFile);

		this._currentModelUrl = typeof rootFile === 'string' ? rootFile : null;
		this._hasLocalGlb = typeof rootFile !== 'string';
		this._currentLocalFile = typeof rootFile !== 'string' ? rootFile : null;
		this._refreshMakeWidgetButton();
		this._refreshSaveToAccountButton();

		// Emit load start
		protocol.emit({
			type: ACTION_TYPES.LOAD_START,
			payload: { url: typeof rootFile === 'string' ? rootFile : rootFile.name },
			agentId: this.identity?.id || 'default',
		});

		const cleanup = () => {
			this.hideSpinner();
			if (typeof rootFile === 'object') URL.revokeObjectURL(fileURL);
		};

		return viewer
			.load(fileURL, rootPath, fileMap, (xhr) => {
				// Emit download progress. `total` is 0 when Content-Length
				// is missing (blob URLs, some CDNs) — the overlay falls back
				// to an indeterminate spinner in that case.
				const total = xhr?.total > 0 ? xhr.total : 0;
				const loaded = xhr?.loaded || 0;
				protocol.emit({
					type: ACTION_TYPES.LOAD_PROGRESS,
					payload: { loaded, total, indeterminate: total === 0 },
					agentId: this.identity?.id || 'default',
				});
			})
			.catch((e) => {
				// Emit load error
				protocol.emit({
					type: ACTION_TYPES.LOAD_END,
					payload: { error: e?.message || String(e), errorObj: e },
					agentId: this.identity?.id || 'default',
				});
				this.onError(e);
			})
			.then((gltf) => {
				if (!gltf) return;

				// Emit load success
				protocol.emit({
					type: ACTION_TYPES.LOAD_END,
					payload: { success: true },
					agentId: this.identity?.id || 'default',
				});

				// Attach the avatar empathy system to the newly loaded content
				this._attachAvatar(viewer);

				// Notify the editor of the new model so it can rebuild panels
				if (this.editor) {
					const isString = typeof rootFile === 'string';
					this.editor.onContentChanged({
						url: isString ? rootFile : null,
						file: isString ? null : rootFile,
						name: isString ? rootFile.split('/').pop().split('?')[0] : rootFile.name,
					});
				}

				// Configure external animations (Mixamo-style) for skinned models
				this._configureAnimations(viewer);

				// Update AR button target. iOS Quick Look uses the USDZ companion
				// when present; Android/WebXR fall back to the GLB URL. Both come
				// from the avatar record fetched before view() (_currentUsdzUrl).
				if (viewer.setARTarget) {
					const glbUrl = typeof rootFile === 'string' ? fileURL : null;
					viewer.setARTarget(glbUrl, this._currentUsdzUrl || null);
				}

				if (!this.options.kiosk) {
					this.validator.validate(fileURL, rootPath, fileMap, gltf);
				}
				cleanup();
			});
	}

	/** Attach (or reattach) the AgentAvatar to the viewer after content loads */
	_attachAvatar(viewer) {
		if (this.avatar) this.avatar.detach();
		this.avatar = new AgentAvatar(viewer, protocol, this.identity);
		this.avatar.attach();

		// Create (or replace) the SceneController for agent scene operations
		this.sceneCtrl = new SceneController(viewer);
		if (this.runtime) this.runtime.viewer = this.sceneCtrl;

		// Update agent-home with the live avatar reference
		if (this.agentHome) this.agentHome.avatar = this.avatar;

		window.VIEWER.agent_avatar = this.avatar;
		window.VIEWER.scene_ctrl = this.sceneCtrl;

		// Let the skills system access the viewer
		if (this.skills) {
			window.VIEWER.agent_skills = this.skills;
		}

		// Wire ElevenLabs frequency-based lipsync to the avatar.
		// onStart fires when audio is actually playing (analyserNode already wired).
		// BrowserTTS has no analyserNode, so it skips connectLipSync and continues
		// using the text-based startLipsync path already in speech.js.
		if (this.runtime?.tts) {
			const tts = this.runtime.tts;
			const avatar = this.avatar;
			tts.onStart = () => {
				if (tts.analyserNode) avatar.connectLipSync(tts.analyserNode);
			};
			tts.onEnd = () => {
				avatar.disconnectLipSync();
			};
		}
	}

	/**
	 * Configure Mixamo-style external animations for the viewer.
	 * Looks for animation GLBs in /animations/ and registers them.
	 * Each GLB should contain a single animation clip exported from Mixamo
	 * (downloaded as GLB with "Without Skin" checked).
	 */
	_configureAnimations(viewer) {
		// Check if model has a skeleton
		let hasSkeleton = false;
		if (viewer.content) {
			viewer.content.traverse((node) => {
				if (node.isSkinnedMesh) hasSkeleton = true;
			});
		}
		if (!hasSkeleton) return;

		// Fetch the animation manifest
		fetch('/animations/manifest.json')
			.then((r) => {
				if (!r.ok) throw new Error('No animation manifest');
				return r.json();
			})
			.then((manifest) => {
				if (Array.isArray(manifest) && manifest.length > 0) {
					viewer.setAnimationDefs(manifest);
				}
			})
			.catch(() => {
				// No manifest — use sensible defaults if files exist
				const defaults = [
					{ name: 'idle', url: '/animations/idle.glb', label: 'Idle' },
					{ name: 'walking', url: '/animations/walking.glb', label: 'Walking' },
					{ name: 'running', url: '/animations/running.glb', label: 'Running' },
					{ name: 'waving', url: '/animations/waving.glb', label: 'Waving' },
					{ name: 'dancing', url: '/animations/dancing.glb', label: 'Dancing' },
					{ name: 'sitting', url: '/animations/sitting.glb', label: 'Sitting' },
					{ name: 'jumping', url: '/animations/jumping.glb', label: 'Jumping' },
				];

				// Probe which files actually exist (HEAD requests)
				Promise.all(
					defaults.map((def) =>
						fetch(def.url, { method: 'HEAD' })
							.then((r) => (r.ok ? def : null))
							.catch(() => null),
					),
				).then((results) => {
					const available = results.filter(Boolean);
					if (available.length > 0) {
						viewer.setAnimationDefs(available);
					}
				});
			});
	}

	// ── Validator hook ────────────────────────────────────────────────────────

	_hookValidator() {
		// In the slim widget shell the validator overlay never renders (the
		// `.validate()` call is gated on `!options.kiosk`), so a tree-wide
		// MutationObserver here is pure CPU waste. Skip it entirely in that
		// surface — saves a 60Hz-ish observer on the embedder's parent paint.
		if (this._widgetShell) return;

		// Intercept the validator toggle DOM node to emit validation results
		const observer = new MutationObserver(() => {
			const el = document.querySelector('.validator-toggle');
			if (!el) return;

			const errors = parseInt(el.dataset.errors || '0', 10);
			const warnings = parseInt(el.dataset.warnings || '0', 10);
			const hints = parseInt(el.dataset.hints || '0', 10);

			protocol.emit({
				type: ACTION_TYPES.VALIDATE,
				payload: { errors, warnings, hints },
				agentId: this.identity?.id || 'default',
			});
		});
		observer.observe(document.body, { childList: true, subtree: true, attributes: true });
	}

	// ── Viewer status overlay ────────────────────────────────────────────────
	// Reflects load state inside #viewer-container so the user never sees a
	// black canvas with no explanation. Wired to the protocol load events,
	// not the spinner — so it stays honest even when the load fails silently.

	_wireViewerStatus() {
		protocol.on(ACTION_TYPES.LOAD_START, () => {
			const name = this._editingAgentId ? this.identity?.name : null;
			this._showViewerLoading(
				this._editingAgentId ? `Loading ${name || 'your avatar'}…` : 'Loading model…',
			);
		});

		protocol.on(ACTION_TYPES.LOAD_PROGRESS, (action) => {
			const { loaded = 0, total = 0, indeterminate = false } = action?.payload || {};
			this._updateLoadProgress(loaded, total, indeterminate);
		});

		protocol.on(ACTION_TYPES.LOAD_END, (action) => {
			const success = action?.payload?.success === true;
			if (success) {
				this._fadeOutPoster();
				this._hideViewerStatus();
				// Signal the slim /widget shell that the canvas has pixels.
				// The shell starts the body invisible to avoid chrome/canvas
				// FOUC bleeding into the parent iframe; flips to visible on
				// this event.
				if (!this._firstFrameSignalled) {
					this._firstFrameSignalled = true;
					try {
						window.dispatchEvent(new CustomEvent('three-ws:first-frame'));
					} catch {
						/* CustomEvent ctor missing only on retired browsers — ignore */
					}
				}
				// Fire the first-time-onboarding popup only after the GLB is
				// actually visible on the canvas — otherwise the "ready"
				// label lies during a slow or failing load.
				if (this._editingAgentId && !this._onboardingFired) {
					this._onboardingFired = true;
					this._maybeShowOnboarding(this._editingAgentId);
				}
				// Backfill a thumbnail for this agent's avatar if it doesn't
				// have one — captures the freshly-rendered canvas to PNG and
				// uploads it so the next visit shows a poster instead of a
				// black screen during the multi-MB GLB stream.
				if (this._editingAgentId && this._avatarNeedsThumbnail) {
					this._avatarNeedsThumbnail = false;
					this._captureAndUploadThumbnail().catch((err) =>
						console.warn('[3d-agent] thumbnail upload failed', err),
					);
				}
			} else {
				const err = action?.payload?.errorObj;
				const msg = this._classifyLoadError(err, action?.payload?.error);
				this._showViewerError(
					msg,
					this._editingAgentId ? () => this._retryAgentLoad() : null,
				);
				// Notify the host page that the GLB failed — paired with the
				// `widget:ready` event so script-tag embeds can show their own
				// fallback or retry UI instead of staring at a blank iframe.
				this._postToParent({
					type: 'widget:load:error',
					id: this.options?.widget || null,
					url: this._currentModelUrl || null,
					error: msg,
				});
			}
		});
	}

	// Map a thrown load error into a clear, actionable message. Three.js
	// surfaces XHR errors as ProgressEvent or Error, so we inspect the
	// message string plus the underlying request when present.
	_classifyLoadError(err, msgFallback) {
		const text = String(err?.message || msgFallback || '');
		const status = err?.target?.status ?? err?.status ?? null;
		if (status === 404 || /\b404\b/.test(text)) {
			return 'Avatar file not found. It may have been moved or deleted.';
		}
		if (status === 403 || /\b403\b/.test(text)) {
			return "You don't have permission to view this avatar.";
		}
		if (status && status >= 500) {
			return 'Avatar storage is unavailable right now. Try again shortly.';
		}
		if (/Failed to fetch|NetworkError|net::|ERR_INTERNET_DISCONNECTED/i.test(text)) {
			return 'Network error. Check your connection and try again.';
		}
		if (/JSON|parse|invalid|magic|version|chunk|corrupt/i.test(text)) {
			return "This avatar file looks corrupted and couldn't be decoded.";
		}
		return this._editingAgentId ? "Couldn't load your avatar." : "Couldn't load the model.";
	}

	_ensureViewerStatusEl() {
		if (this._viewerStatusEl) return this._viewerStatusEl;
		const el = document.createElement('div');
		el.className = 'viewer-status';
		el.hidden = true;
		this.viewerContainerEl.appendChild(el);
		this._viewerStatusEl = el;
		return el;
	}

	_showViewerLoading(label) {
		const el = this._ensureViewerStatusEl();
		el.dataset.state = 'loading';
		el.innerHTML = `
			<div class="viewer-status__card" role="status" aria-live="polite">
				<div class="viewer-status__spinner" aria-hidden="true"></div>
				<div class="viewer-status__label" data-label>${escHtml(label)}</div>
				<div class="viewer-status__progress" data-progress hidden>
					<div class="viewer-status__progress-track">
						<div class="viewer-status__progress-fill" data-progress-fill
							role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
							style="width:0%"></div>
					</div>
					<div class="viewer-status__progress-meta" data-progress-meta></div>
				</div>
			</div>
		`;
		el.hidden = false;
	}

	// Update bytes/percent. Called from the LOAD_PROGRESS listener — only
	// reveals the progress bar once we know the total (Content-Length),
	// otherwise the indeterminate spinner stays solo.
	_updateLoadProgress(loaded, total, indeterminate) {
		const el = this._viewerStatusEl;
		if (!el || el.dataset.state !== 'loading') return;
		const progressEl = el.querySelector('[data-progress]');
		if (!progressEl) return;
		if (indeterminate || !total) {
			progressEl.hidden = true;
			return;
		}
		const pct = Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
		const fill = el.querySelector('[data-progress-fill]');
		const meta = el.querySelector('[data-progress-meta]');
		if (fill) {
			fill.style.width = pct + '%';
			fill.setAttribute('aria-valuenow', String(pct));
		}
		if (meta) meta.textContent = `${pct}% · ${_fmtBytes(loaded)} / ${_fmtBytes(total)}`;
		progressEl.hidden = false;
	}

	_showViewerError(label, onRetry) {
		const el = this._ensureViewerStatusEl();
		el.dataset.state = 'error';
		el.innerHTML = `
			<div class="viewer-status__card viewer-status__card--error" role="alert">
				<div class="viewer-status__icon" aria-hidden="true">!</div>
				<div class="viewer-status__label" data-label>${escHtml(label)}</div>
				${onRetry ? '<button class="viewer-status__btn" type="button" data-retry>Retry</button>' : ''}
			</div>
		`;
		el.hidden = false;
		if (onRetry) {
			el.querySelector('[data-retry]')?.addEventListener('click', () => {
				this._showViewerLoading('Retrying…');
				Promise.resolve(onRetry()).catch(() => {});
			});
		}
	}

	_hideViewerStatus() {
		if (!this._viewerStatusEl) return;
		this._viewerStatusEl.hidden = true;
		this._viewerStatusEl.dataset.state = '';
	}

	// ── Poster image (model-viewer–style) ───────────────────────────────────
	// Renders the avatar's thumbnail behind the WebGL canvas while the GLB
	// streams in, then fades out on LOAD_END(success). For 4-5MB avatars on
	// a slow connection this turns 5+ seconds of black void into 5 seconds
	// of "your avatar, just not interactive yet."

	_showPoster(url) {
		if (!url) return;
		this._fadeOutPoster(); // remove any previous
		const img = document.createElement('img');
		img.className = 'viewer-poster';
		img.alt = '';
		img.setAttribute('aria-hidden', 'true');
		img.src = url;
		// Insert UNDER the WebGL canvas so the canvas paints over it. The
		// canvas is transparent by default until content renders, so the
		// poster shows through.
		this.viewerContainerEl.insertBefore(img, this.viewerContainerEl.firstChild);
		this._posterEl = img;
	}

	_fadeOutPoster() {
		if (!this._posterEl) return;
		const el = this._posterEl;
		this._posterEl = null;
		el.classList.add('viewer-poster--fading');
		setTimeout(() => el.remove(), 600);
	}

	// ── Auto-thumbnail capture ──────────────────────────────────────────────
	// Reads the WebGL canvas pixels, downsamples to a 512² PNG, and POSTs
	// to /api/avatars/thumbnail. Fire-and-forget — the only consequence of
	// failure is that the next page load runs through this path again.

	async _captureAndUploadThumbnail() {
		const avatarId = this._currentAvatarId;
		if (!avatarId || !this.viewer?.renderer) return;

		// Give the renderer one extra frame so the first idle pose is on
		// screen, not the canonical T-pose / default expression.
		await new Promise((r) => setTimeout(r, 800));

		const src = this.viewer.renderer.domElement;
		const out = document.createElement('canvas');
		const size = 512;
		out.width = out.height = size;
		const ctx = out.getContext('2d');
		if (!ctx) return;
		// Fit-to-canvas, preserving aspect with letterboxing on a
		// transparent background.
		const ar = src.width / src.height || 1;
		let dw = size,
			dh = size;
		if (ar > 1) dh = Math.round(size / ar);
		else dw = Math.round(size * ar);
		ctx.drawImage(src, (size - dw) / 2, (size - dh) / 2, dw, dh);

		const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
		if (!blob) return;
		const dataUrl = await _blobToBase64(blob);

		const resp = await fetch('/api/avatars/thumbnail', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				avatar_id: avatarId,
				png_base64: `data:image/png;base64,${dataUrl}`,
			}),
		});
		if (!resp.ok) {
			throw new Error(`thumbnail upload HTTP ${resp.status}`);
		}
	}

	async _retryAgentLoad() {
		if (!this._editingAgentId) return;
		await this._loadAgentForEdit(this._editingAgentId);
	}

	// ── UI Helpers ────────────────────────────────────────────────────────────

	_flashSaved(avatar) {
		const el = document.createElement('div');
		el.className = 'save-toast';
		el.innerHTML = `Saved to your account · <a href="/dashboard/#avatars">${avatar.name}</a>`;
		document.body.appendChild(el);
		setTimeout(() => el.remove(), 5000);
	}

	/**
	 * @param  {Error} error
	 */
	onError(error) {
		// The viewer-status overlay (driven by LOAD_END payload) is the
		// user-facing error surface now — see _classifyLoadError above.
		// onError is kept as a console-only fallback for diagnostics.
		console.error('[3d-agent] load error:', error);
	}

	/**
	 * Resolve an on-chain ERC-8004 agent to its 3D avatar and render it.
	 * Public — works for anyone, no wallet required.
	 *
	 * @param {{ chainId: number, agentId: string, registry?: string }} onchain
	 */
	async _loadOnChainAgent(onchain) {
		try {
			const [
				{ getAgentOnchain, fetchAgentMetadata, findAvatar3D },
				{ REGISTRY_DEPLOYMENTS },
			] = await Promise.all([import('./erc8004/queries.js'), import('./erc8004/abi.js')]);

			if (!REGISTRY_DEPLOYMENTS[onchain.chainId]) {
				this._showOnChainError(`Unsupported chain: ${onchain.chainId}`);
				return;
			}

			const { uri } = await getAgentOnchain({
				chainId: onchain.chainId,
				agentId: onchain.agentId,
				ethProvider: window.ethereum,
			});
			if (!uri) {
				this._showOnChainError(`Agent #${onchain.agentId} has no agentURI set.`);
				return;
			}

			const meta = await fetchAgentMetadata(uri);
			if (!meta.ok) {
				this._showOnChainError(`Could not fetch registration JSON: ${meta.error}`);
				return;
			}

			this._onchainMetadata = meta.data;
			this._updateOnChainCard(onchain, meta.data);

			const glbUri = findAvatar3D(meta.data);
			if (!glbUri) {
				this._showOnChainError(
					`Agent #${onchain.agentId} has no 3D avatar — no <code>avatar</code> service entry and <code>image</code> is not a GLB.`,
				);
				return;
			}

			const resolvedGlb = isDecentralizedURI(glbUri) ? resolveURI(glbUri) : glbUri;
			await this.view(resolvedGlb, '', new Map());
		} catch (err) {
			console.warn('[3d-agent] on-chain load failed:', err);
			this._showOnChainError(err.message || String(err));
		}
	}

	_showOnChainError(msg) {
		this._updateOnChainCard(this.options.onchain, null, msg);
		this.dropEl?.classList.add('hidden');
	}

	/**
	 * Render a small info card overlaying the viewer so users know whose agent
	 * they're looking at. Hidden in kiosk mode.
	 */
	_updateOnChainCard(onchain, metadata, errorMsg = '') {
		if (this.options.kiosk) return;
		let card = this.el.querySelector('.onchain-card');
		if (!card) {
			card = document.createElement('div');
			card.className = 'onchain-card';
			this.el.appendChild(card);
		}
		const chainLabel = `chainId ${onchain.chainId}`;
		if (errorMsg) {
			card.innerHTML = `<div class="onchain-card__err">⚠ ${escHtml(errorMsg)}</div>
				<div class="onchain-card__sub">Agent #${escHtml(onchain.agentId)} · ${escHtml(chainLabel)}</div>`;
			return;
		}
		const name = metadata?.name ? String(metadata.name) : `Agent #${onchain.agentId}`;
		const desc = metadata?.description ? String(metadata.description) : '';
		card.innerHTML = `
			<div class="onchain-card__name">${escHtml(name)}</div>
			<div class="onchain-card__sub">#${escHtml(onchain.agentId)} · ${escHtml(chainLabel)}</div>
			${desc ? `<div class="onchain-card__desc">${escHtml(desc)}</div>` : ''}
		`;
	}

	async _showShowcasePage() {
		try {
			const main = this.el.querySelector('main.wrap') || this.el;
			this.dropEl?.classList.add('hidden');
			const dropzone = this.el.querySelector('.dropzone');
			if (dropzone) dropzone.style.display = 'none';
			if (this.viewerContainerEl) this.viewerContainerEl.style.display = 'none';
			const authGate = this.el.querySelector('#auth-gate');
			if (authGate) authGate.style.display = 'none';
			const presence = this.el.querySelector('.agent-presence-sidebar');
			if (presence) presence.style.display = 'none';

			const page = document.createElement('section');
			page.className = 'showcase-page';
			main.appendChild(page);

			const { renderShowcasePage } = await import('./erc8004/showcase.js');
			renderShowcasePage(page);
		} catch (err) {
			console.error('[3d-agent] showcase page load failed', err);
		}
	}

	async _showDeployPage() {
		// Render /deploy as a normal page inside the app.html shell (header +
		// footer stay visible). We hide the viewer + dropzone + auth gate and
		// replace them with the ERC-8004 wizard, pre-filled from the user's
		// current avatar so Step 5 flows from Steps 1–4.
		//
		// Deep-link support: `/deploy?avatar=<id>` pre-fills from a previously
		// saved avatar (dashboard "Deploy on-chain" per row). That prefill
		// overrides the viewer's current model.
		try {
			const main = this.el.querySelector('main.wrap') || this.el;
			this.dropEl?.classList.add('hidden');
			const dropzone = this.el.querySelector('.dropzone');
			if (dropzone) dropzone.style.display = 'none';
			if (this.viewerContainerEl) this.viewerContainerEl.style.display = 'none';
			const authGate = this.el.querySelector('#auth-gate');
			if (authGate) authGate.style.display = 'none';
			const presence = this.el.querySelector('.agent-presence-sidebar');
			if (presence) presence.style.display = 'none';

			const page = document.createElement('section');
			page.className = 'deploy-page';
			main.appendChild(page);

			this._upgradeToHorizonFooter();

			const initial = await this._resolveDeployInitial();

			const { RegisterUI } = await import('./erc8004/register-ui.js');
			new RegisterUI(
				page,
				(result) => {
					console.info('[ERC-8004] Agent registered:', result);
				},
				{ mode: 'page', initial, viewer: this.viewer, avatarId: initial.avatarId },
			);
		} catch (err) {
			console.error('[3d-agent] deploy page load failed', err);
		}
	}

	/**
	 * Resolve the initial state passed to RegisterUI. Honors:
	 *   ?avatar=<id>       — fetch a saved avatar from the backend
	 *   ?name=             — prefill identity name
	 *   ?description=      — prefill description
	 *   ?image=            — prefill image URL
	 *   ?network=          — preselect chain (mainnet-beta/devnet/base/bsc/…)
	 * Avatar lookup wins over the viewer's current model when both exist;
	 * direct query params override either as last-step "manual" entries.
	 */
	async _resolveDeployInitial() {
		const qp = new URLSearchParams(location.search);
		const avatarId = qp.get('avatar');
		const qpName = qp.get('name') || '';
		const qpDesc = qp.get('description') || '';
		const qpImage = qp.get('image') || '';
		const qpNetwork = qp.get('network') || '';
		const qpModel = qp.get('model') || '';
		const base = { glbUrl: qpModel || this._currentModelUrl || '' };
		let resolved = base;
		if (avatarId) {
			try {
				const res = await fetch(`/api/avatars/${encodeURIComponent(avatarId)}`, {
					credentials: 'include',
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const { avatar } = await res.json();
				if (!avatar) throw new Error('empty avatar payload');
				resolved = {
					name: avatar.name || '',
					description: avatar.description || '',
					imageUrl: avatar.thumbnail_url || '',
					glbUrl: avatar.url || avatar.model_url || '',
				};
			} catch (err) {
				console.warn('[deploy] avatar prefill failed; falling back to viewer model', err);
			}
		}
		return {
			...resolved,
			name: qpName || resolved.name || '',
			description: qpDesc || resolved.description || '',
			imageUrl: qpImage || resolved.imageUrl || '',
			network: qpNetwork || '',
			avatarId: avatarId || null,
		};
	}

	_upgradeToHorizonFooter() {
		const existing = document.querySelector('footer');
		if (!existing) return;
		existing.outerHTML = `<footer class="h-footer h-footer-horizon">
			<div class="h-footer-glow-line" aria-hidden="true"></div>
			<div class="h-footer-floor" aria-hidden="true"></div>
			<div class="h-footer-haze" aria-hidden="true"></div>
			<div class="h-footer-watermark" aria-hidden="true">three.ws</div>
			<div class="h-footer-inner">
				<div class="h-footer-brand-col">
					<div class="h-footer-brand">
						<span class="wordmark-dot" aria-hidden="true"></span>
						<span>three.ws</span>
					</div>
					<p class="h-footer-tagline">Give your AI a body.</p>
				</div>
				<nav class="h-footer-links" aria-label="Footer">
					<a href="https://github.com/nirholas/three.ws" target="_blank" rel="noopener">GitHub</a>
					<a href="/create">Create</a>
					<a href="/studio">Studio</a>
					<a href="/widgets">Widgets</a>
					<a href="/discover">Discover</a>
					<a href="/docs">Docs</a>
					<a href="https://eips.ethereum.org/EIPS/eip-8004" target="_blank" rel="noopener">ERC-8004</a>
				</nav>
			</div>
			<div class="h-footer-bottom">
				<p class="h-footer-legal">© 2026 three.ws — All rights reserved.</p>
				<div class="h-footer-badges">
					<span class="h-footer-badge" aria-label="System status">
						<span class="h-footer-status-dot" aria-hidden="true"></span>
						<span>All systems normal</span>
					</span>
					<a class="h-footer-badge" href="https://github.com/nirholas/three.ws" target="_blank" rel="noopener" aria-label="View source on GitHub">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
						<span>Open source</span>
					</a>
				</div>
			</div>
		</footer>`;
	}

	showSpinner() {
		this.spinnerEl.style.display = '';
	}
	hideSpinner() {
		this.spinnerEl.style.display = 'none';
	}
}

// The slim /widget shell (pages/widget.html) sets `window.__WIDGET_SHELL`
// before this module parses, signalling that no site chrome should be
// injected. Without this guard the marketing footer flashes inside every
// embed iframe before kiosk JS hides it.
if (!window.__WIDGET_SHELL) {
	document.body.innerHTML += Footer();
} else {
	// Tell the shell that the bundle has started executing. The shell uses
	// this to arm its 6s "still no first frame" fallback — without it, an
	// interaction-mode widget would fire the fallback during idle and break
	// the play-to-load promise.
	try {
		window.dispatchEvent(new CustomEvent('three-ws:boot-started'));
	} catch {
		/* CustomEvent ctor missing only on retired browsers — ignore */
	}
}

function _bootApp() {
	const app = new App(document.body, location);
	window.VIEWER.app = app;
	console.info('[three.ws] Debugging data exported as `window.VIEWER`.');
}
// The slim /widget shell injects this script after DOMContentLoaded (the
// reveal state machine dynamically appends it), so a plain
// `addEventListener('DOMContentLoaded')` would attach a listener that never
// fires. Cover both timings.
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', _bootApp);
} else {
	_bootApp();
}
