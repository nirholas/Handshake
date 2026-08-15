/**
 * Concierge: @three-ws/concierge
 * ===============================
 *
 * The embeddable AI concierge: a floating launcher that opens a chat panel
 * with a rigged 3D avatar bust (blinks, idles, lipsyncs), streaming answers
 * grounded in the live page, browser-native voice out, and push-to-talk voice
 * in. One class owns the whole lifecycle; `<three-concierge>` and the script
 * auto-init are thin wrappers over it.
 *
 * Design decisions that matter:
 *   - The WebGL stage is built lazily on FIRST OPEN. A closed widget costs the
 *     host page zero GPU and no GLB download.
 *   - Answers stream sentence-by-sentence into the voice channel, so the
 *     avatar starts speaking while the rest of the reply is still arriving.
 *   - The conversation persists in sessionStorage per origin, so a page
 *     navigation does not amnesia the thread.
 */

import { AvatarStage } from './stage.js';
import { SpeechNarrator } from './narrator.js';
import { AVATARS, DEFAULT_AVATAR_ID, DEFAULT_ASSET_BASE, getAvatar, avatarUrl, customAvatarEntry } from './catalog.js';
import { buildSitePayload } from './context.js';
import { askConcierge, DEFAULT_ENDPOINT, MAX_HISTORY_TURNS } from './client.js';
import { renderMarkdown, stripMarkdown, escapeHtml } from './markdown.js';
import { createMic, micSupported } from './mic.js';
import { ensureStyles } from './styles.js';
import {
	detectShop,
	normalizeShopDomain,
	shopOrigin,
	fetchCatalog,
	fetchPolicies,
	searchProducts,
	buildShoppingPayload,
	money,
	MAX_RECOMMENDATIONS,
} from './shopify.js';

const LS_AVATAR = 'tc:avatar';
const LS_MUTED = 'tc:muted';
const SS_THREAD = 'tc:thread';
const SS_TEASED = 'tc:teased';
const SS_CATALOG = 'tc:shop'; // per-store catalog cache key prefix
const CATALOG_TTL_MS = 30 * 60 * 1000; // re-fetch the catalog every 30 min

const ICONS = {
	spark:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/></svg>',
	close:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
	sound:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"/></svg>',
	soundOff:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"/></svg>',
	swap:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/></svg>',
	collapse:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5"/></svg>',
	mic:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"/></svg>',
	send:
		'<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>',
};

function storageGet(store, key) {
	try {
		return window[store].getItem(key);
	} catch {
		return null;
	}
}
function storageSet(store, key, value) {
	try {
		window[store].setItem(key, value);
	} catch {
		/* storage unavailable (private mode / blocked), degrade to in-memory */
	}
}

/** Split streamed text into complete sentences for the voice channel. */
export function drainSentences(buffer) {
	const sentences = [];
	let rest = buffer;
	let m;
	const re = /[^.!?\n]*[.!?\n]+["')\]]?\s*/g;
	let consumed = 0;
	while ((m = re.exec(rest)) !== null) {
		const s = m[0].trim();
		if (s) sentences.push(s);
		consumed = re.lastIndex;
	}
	return { sentences, rest: rest.slice(consumed) };
}

export class Concierge {
	/**
	 * @param {{
	 *  endpoint?: string, avatar?: string, avatars?: string[],
	 *  customAvatar?: string|object, assetBase?: string,
	 *  name?: string, siteName?: string, greeting?: string,
	 *  suggestions?: string[], knowledge?: string, persona?: string,
	 *  accent?: string, position?: 'bottom-right'|'bottom-left',
	 *  theme?: 'auto'|'dark'|'light', open?: boolean, muted?: boolean,
	 *  picker?: boolean, teaser?: boolean, zIndex?: number, lang?: string,
	 * }} [config]
	 */
	constructor(config = {}) {
		this.config = {
			endpoint: config.endpoint || DEFAULT_ENDPOINT,
			assetBase: config.assetBase || DEFAULT_ASSET_BASE,
			avatars: Array.isArray(config.avatars) && config.avatars.length
				? AVATARS.filter((a) => config.avatars.includes(a.id))
				: AVATARS,
			name: config.name || '',
			siteName: config.siteName || '',
			greeting: config.greeting || '',
			suggestions: Array.isArray(config.suggestions) ? config.suggestions.slice(0, 4) : [],
			knowledge: config.knowledge || '',
			persona: config.persona || '',
			accent: config.accent || '',
			position: config.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
			theme: ['dark', 'light'].includes(config.theme) ? config.theme : 'auto',
			open: !!config.open,
			muted: !!config.muted,
			picker: config.picker !== false,
			teaser: config.teaser !== false,
			zIndex: config.zIndex,
			lang: config.lang || '',
			shop: normalizeShopDomain(config.shop),
			shopping: config.shopping,
			currency: config.currency || '',
			maxProducts:
				Number.isFinite(config.maxProducts) && config.maxProducts > 0
					? Math.min(config.maxProducts, 8)
					: MAX_RECOMMENDATIONS,
		};

		// Shopping mode: explicit `shop` domain, or auto-detected when the widget
		// is embedded on a Shopify storefront (the Shopify global is present). The
		// host can force it off with `shopping: false`.
		const detected = detectShop();
		if (!this.config.shop && detected) this.config.shop = detected.shop;
		if (!this.config.currency && detected) this.config.currency = detected.currency;
		this.config.shopping =
			config.shopping === false ? false : !!(config.shopping || this.config.shop);
		// Add-to-cart only works same-origin on the store itself.
		this._onStore = !!(detected && this.config.shop && detected.shop === this.config.shop);
		this._catalog = null;
		this._policies = {};
		this._catalogPromise = null;

		this._custom = config.customAvatar ? customAvatarEntry(config.customAvatar) : null;
		const savedId = storageGet('localStorage', LS_AVATAR);
		this.avatar = this._custom || getAvatarFrom(this.config.avatars, config.avatar || savedId);

		this.open = false;
		this.busy = false;
		this.muted = this.config.muted || storageGet('localStorage', LS_MUTED) === '1';
		this.messages = this._restoreThread();
		this._listeners = new Map();
		this._stage = null;
		this._narrator = null;
		this._mic = null;
		this._abort = null;
		this._destroyed = false;

		if (typeof window === 'undefined' || typeof document === 'undefined') return;
		this._build();
		if (this.config.open) this.setOpen(true);
		else if (this.config.teaser) this._scheduleTeaser();
		this._emit('ready', { avatar: this.avatar.id });
	}

	// ── Events ────────────────────────────────────────────────────────────────
	on(event, fn) {
		if (!this._listeners.has(event)) this._listeners.set(event, new Set());
		this._listeners.get(event).add(fn);
		return () => this._listeners.get(event)?.delete(fn);
	}
	_emit(event, detail) {
		for (const fn of this._listeners.get(event) || []) {
			try {
				fn(detail);
			} catch {
				/* listener errors must not break the widget */
			}
		}
	}

	// ── DOM ───────────────────────────────────────────────────────────────────
	_build() {
		ensureStyles();
		const root = document.createElement('div');
		root.className = 'tc-root';
		root.setAttribute('data-three-concierge', '');
		root.setAttribute('data-tc-pos', this.config.position);
		if (this.config.zIndex) root.style.zIndex = String(this.config.zIndex);
		if (this.config.accent) root.style.setProperty('--tc-accent', this.config.accent);
		this._applyTheme(root);

		const name = this.config.name || this.avatar.name;
		root.innerHTML = `
			<section class="tc-panel" role="dialog" aria-modal="false" aria-label="${escapeHtml(name)}, site assistant" hidden>
				<header class="tc-head">
					<div class="tc-head-id">
						<span class="tc-head-dot" aria-hidden="true"></span>
						<div>
							<div class="tc-head-name"></div>
							<div class="tc-head-sub">// ai concierge</div>
						</div>
					</div>
					<div class="tc-head-actions">
						<button type="button" class="tc-icon-btn tc-btn-mute" aria-label="Toggle voice" aria-pressed="false">${ICONS.sound}</button>
						${this.config.picker && !this._custom ? `<button type="button" class="tc-icon-btn tc-btn-swap" aria-label="Choose a different avatar">${ICONS.swap}</button>` : ''}
						<button type="button" class="tc-icon-btn tc-btn-compact" aria-label="Toggle avatar view" aria-pressed="false">${ICONS.collapse}</button>
						<button type="button" class="tc-icon-btn tc-btn-close" aria-label="Close assistant">${ICONS.close}</button>
					</div>
				</header>
				<div class="tc-stage is-loading" aria-hidden="true">
					<div class="tc-stage-glow"></div>
					<div class="tc-stage-skel"></div>
					<div class="tc-stage-canvas"></div>
					<div class="tc-stage-caption"></div>
				</div>
				<div class="tc-thread" aria-live="polite"></div>
				<div class="tc-input">
					<textarea rows="1" maxlength="2000" placeholder="Ask anything…" aria-label="Your question"></textarea>
					${micSupported() ? `<button type="button" class="tc-mic" aria-label="Ask by voice" aria-pressed="false">${ICONS.mic}</button>` : ''}
					<button type="button" class="tc-send" aria-label="Send" disabled>${ICONS.send}</button>
				</div>
				<footer class="tc-foot"><a href="https://three.ws/concierge" target="_blank" rel="noopener noreferrer">powered by three.ws</a></footer>
				<div class="tc-picker" role="listbox" aria-label="Choose your concierge" hidden>
					<p class="tc-picker-title">// choose your concierge</p>
					<div class="tc-picker-grid"></div>
				</div>
			</section>
			<button type="button" class="tc-launcher" aria-label="Open site assistant" aria-expanded="false">
				<span class="tc-pulse" aria-hidden="true"></span>
				${ICONS.spark}
			</button>
		`;
		document.body.appendChild(root);
		this.root = root;

		this.$ = {
			panel: root.querySelector('.tc-panel'),
			launcher: root.querySelector('.tc-launcher'),
			headName: root.querySelector('.tc-head-name'),
			mute: root.querySelector('.tc-btn-mute'),
			swap: root.querySelector('.tc-btn-swap'),
			compact: root.querySelector('.tc-btn-compact'),
			close: root.querySelector('.tc-btn-close'),
			stage: root.querySelector('.tc-stage'),
			stageCanvas: root.querySelector('.tc-stage-canvas'),
			caption: root.querySelector('.tc-stage-caption'),
			thread: root.querySelector('.tc-thread'),
			textarea: root.querySelector('textarea'),
			mic: root.querySelector('.tc-mic'),
			send: root.querySelector('.tc-send'),
			picker: root.querySelector('.tc-picker'),
			pickerGrid: root.querySelector('.tc-picker-grid'),
		};

		this.$.headName.textContent = name;
		this._syncMuteButton();
		this._renderThread();

		// Wiring
		this.$.launcher.addEventListener('click', () => this.toggle());
		this.$.close.addEventListener('click', () => this.setOpen(false));
		this.$.mute.addEventListener('click', () => this.setMuted(!this.muted));
		this.$.swap?.addEventListener('click', () => this.togglePicker());
		this.$.compact.addEventListener('click', () => this._toggleCompact());
		this.$.send.addEventListener('click', () => this._submit());
		this.$.textarea.addEventListener('input', () => this._syncInput());
		this.$.textarea.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._submit();
			}
		});
		// Escape is bound on the document, not just the widget root: the panel is
		// an overlay on someone else's page, so focus is often outside it (the
		// visitor clicked the page behind, or a reset dropped focus to body) and
		// a root-scoped handler would leave the documented Escape-to-close dead.
		// Keydowns inside the widget bubble here too, so one listener covers both.
		this._onKeydown = (e) => {
			if (e.key === 'Escape' && this.open) {
				if (!this.$.picker.hidden) this.togglePicker(false);
				else this.setOpen(false);
			}
		};
		document.addEventListener('keydown', this._onKeydown);

		if (this.$.mic) {
			this._mic = createMic({
				lang: this.config.lang || undefined,
				onInterim: (t) => {
					this.$.textarea.value = t;
					this._syncInput();
				},
				onState: (s) => {
					this.$.mic.classList.toggle('is-live', s === 'listening');
					this.$.mic.setAttribute('aria-pressed', s === 'listening' ? 'true' : 'false');
				},
				onError: (err) => this._emit('error', err),
			});
			this.$.mic.addEventListener('click', () => this._toggleMic());
		}

		if (this.config.theme === 'auto') {
			if (window.matchMedia) {
				this._mq = window.matchMedia('(prefers-color-scheme: dark)');
				this._onScheme = () => this._applyTheme(root);
				this._mq.addEventListener?.('change', this._onScheme);
			}
			// Live-follow the host's theme toggle too (data-theme flips on <html>).
			this._themeObs = new MutationObserver(() => this._applyTheme(root));
			this._themeObs.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ['data-theme'],
			});
		}
	}

	_applyTheme(root) {
		// Auto mode prefers the HOST's own theme signal when it publishes one
		// (the common `data-theme="dark|light"` convention on <html>), because a
		// site pinned dark must not get a light widget just because the OS is
		// light. Falls back to prefers-color-scheme.
		let theme = this.config.theme;
		if (theme === 'auto') {
			const host = document.documentElement.getAttribute('data-theme');
			if (host === 'dark' || host === 'light') theme = host;
			else theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
		}
		root.setAttribute('data-tc-theme', theme);
	}

	// ── Open / close ──────────────────────────────────────────────────────────
	setOpen(open) {
		if (this._destroyed || open === this.open) return;
		this.open = open;
		this.root.classList.toggle('is-open', open);
		this.$.launcher.setAttribute('aria-expanded', String(open));
		this.$.launcher.setAttribute('aria-label', open ? 'Close site assistant' : 'Open site assistant');
		if (open) {
			this._killTeaser();
			this.$.panel.hidden = false;
			requestAnimationFrame(() => this.root.classList.add('is-open'));
			this._ensureStage();
			this._ensureCatalog(); // warm the store catalog so the first ask is instant
			this.$.textarea.focus({ preventScroll: true });
			this._scrollThread(false);
		} else {
			this._narrator?.cancel();
			this._mic?.stop();
			// Let the close transition play before hiding.
			const panel = this.$.panel;
			setTimeout(() => {
				if (!this.open) panel.hidden = true;
			}, 240);
			this.$.launcher.focus({ preventScroll: true });
		}
		this._emit(open ? 'open' : 'close', {});
	}
	toggle() {
		this.setOpen(!this.open);
	}

	_toggleCompact() {
		const compact = this.root.classList.toggle('is-compact');
		this.$.compact.setAttribute('aria-pressed', String(compact));
	}

	// ── Teaser ────────────────────────────────────────────────────────────────
	_scheduleTeaser() {
		if (storageGet('sessionStorage', SS_TEASED) === '1' || this.messages.length) return;
		this._teaserTimer = setTimeout(() => {
			if (this.open || this._destroyed) return;
			storageSet('sessionStorage', SS_TEASED, '1');
			const teaser = document.createElement('div');
			teaser.className = 'tc-teaser';
			teaser.setAttribute('role', 'status');
			teaser.innerHTML = `<span></span><button type="button" class="tc-teaser-close" aria-label="Dismiss">${ICONS.close}</button>`;
			teaser.querySelector('span').textContent = this._greetingText();
			this.root.insertBefore(teaser, this.$.launcher);
			requestAnimationFrame(() => teaser.classList.add('is-in'));
			teaser.addEventListener('click', (e) => {
				if (e.target.closest('.tc-teaser-close')) teaser.remove();
				else {
					teaser.remove();
					this.setOpen(true);
				}
			});
			this._teaser = teaser;
			this._teaserHide = setTimeout(() => this._killTeaser(), 12000);
		}, 6000);
	}
	_killTeaser() {
		clearTimeout(this._teaserTimer);
		clearTimeout(this._teaserHide);
		this._teaser?.remove();
		this._teaser = null;
	}

	_greetingText() {
		if (this.config.greeting) return this.config.greeting;
		const site = this.config.siteName || document.querySelector('meta[property="og:site_name"]')?.content || '';
		if (this.config.shopping) {
			return site
				? `Hi! I can help you find the right thing at ${site}. Ask away.`
				: 'Hi! Tell me what you\'re shopping for and I\'ll help you find it.';
		}
		return site ? `Hi! Ask me anything about ${site}.` : 'Hi! Ask me anything about this site.';
	}

	// ── Shopify catalog (lazy) ──────────────────────────────────────────────────
	/** Load the store catalog once, from session cache or the live storefront. */
	_ensureCatalog() {
		if (!this.config.shopping || !this.config.shop) return Promise.resolve(null);
		if (this._catalog) return Promise.resolve(this._catalog);
		if (this._catalogPromise) return this._catalogPromise;
		this._catalogPromise = this._loadCatalog().finally(() => {
			this._catalogPromise = null;
		});
		return this._catalogPromise;
	}

	async _loadCatalog() {
		const shop = this.config.shop;
		const cached = this._readCatalogCache(shop);
		if (cached) {
			this._catalog = cached.catalog;
			this._policies = cached.policies || {};
			return this._catalog;
		}
		this._catalogAbort = new AbortController();
		try {
			const [catalog, policies] = await Promise.all([
				fetchCatalog({
					shop,
					currency: this.config.currency || 'USD',
					signal: this._catalogAbort.signal,
				}),
				fetchPolicies({ shop, signal: this._catalogAbort.signal }).catch(() => ({})),
			]);
			if (this.config.currency) catalog.currency = this.config.currency;
			this._catalog = catalog;
			this._policies = policies || {};
			this._writeCatalogCache(shop, catalog, this._policies);
			this._emit('catalog', { store: catalog.store, products: catalog.products.length });
			return catalog;
		} catch (err) {
			// A store with a disabled public catalog: shopping cards go quiet, the
			// concierge still answers from the page + any curated knowledge.
			this._emit('error', err instanceof Error ? err : new Error(String(err)));
			this._catalog = { store: shop, origin: shopOrigin(shop), currency: this.config.currency || 'USD', products: [], collections: [] };
			return this._catalog;
		}
	}

	_readCatalogCache(shop) {
		try {
			const raw = storageGet('sessionStorage', `${SS_CATALOG}:${shop}`);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (!parsed || Date.now() - parsed.t > CATALOG_TTL_MS) return null;
			if (!parsed.catalog?.products?.length) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	_writeCatalogCache(shop, catalog, policies) {
		// Only worth caching a real catalog; keep it lean for the sessionStorage cap.
		if (!catalog?.products?.length) return;
		storageSet('sessionStorage', `${SS_CATALOG}:${shop}`, JSON.stringify({ t: Date.now(), catalog, policies }));
	}

	// ── 3D stage (lazy) ───────────────────────────────────────────────────────
	async _ensureStage() {
		if (this._stage || this._stageLoading) return;
		this._stageLoading = true;
		try {
			this._stage = new AvatarStage(this.$.stageCanvas, { background: 'transparent' });
			this._narrator = new SpeechNarrator(this._stage, {
				muted: this.muted,
				onCaption: (text) => this._setCaption(text),
				onError: () => {
					/* voice is an enhancement, a TTS engine fault must stay silent */
				},
			});
			this._narrator.setAgent(this.avatar);
			await this._stage.load(avatarUrl(this.avatar, this.config.assetBase), {
				framing: this.avatar.framing || 'bust',
			});
			this.$.stage.classList.remove('is-loading');
		} catch (err) {
			// No WebGL / GLB unreachable: hide the stage, keep the chat fully alive.
			this.root.classList.add('is-compact');
			this.$.compact.style.display = 'none';
			this._emit('error', err instanceof Error ? err : new Error(String(err)));
		} finally {
			this._stageLoading = false;
		}
	}

	_setCaption(text) {
		const el = this.$.caption;
		if (!el) return;
		if (text) {
			el.textContent = text;
			el.classList.add('is-in');
		} else {
			el.classList.remove('is-in');
		}
	}

	// ── Avatar switching ──────────────────────────────────────────────────────
	async setAvatar(id) {
		const entry = getAvatarFrom(this.config.avatars, id);
		if (!entry || entry.id === this.avatar.id) return;
		this.avatar = entry;
		storageSet('localStorage', LS_AVATAR, entry.id);
		if (!this.config.name) this.$.headName.textContent = entry.name;
		this._narrator?.cancel();
		this._narrator?.setAgent(entry);
		this._renderPicker();
		this._emit('agentchange', { avatar: entry.id });
		if (this._stage) {
			this.$.stage.classList.add('is-loading');
			try {
				await this._stage.load(avatarUrl(entry, this.config.assetBase), { framing: entry.framing || 'bust' });
			} catch (err) {
				this._emit('error', err instanceof Error ? err : new Error(String(err)));
			}
			this.$.stage.classList.remove('is-loading');
		}
	}

	togglePicker(force) {
		const show = force !== undefined ? force : this.$.picker.hidden;
		if (show) {
			this._renderPicker();
			this.$.picker.hidden = false;
			requestAnimationFrame(() => this.$.picker.classList.add('is-in'));
		} else {
			this.$.picker.classList.remove('is-in');
			setTimeout(() => {
				this.$.picker.hidden = true;
			}, 200);
		}
	}

	_renderPicker() {
		const grid = this.$.pickerGrid;
		if (!grid) return;
		grid.textContent = '';
		for (const a of this.config.avatars) {
			const card = document.createElement('button');
			card.type = 'button';
			card.className = 'tc-picker-card' + (a.id === this.avatar.id ? ' is-current' : '');
			card.setAttribute('role', 'option');
			card.setAttribute('aria-selected', String(a.id === this.avatar.id));
			card.innerHTML = `<span class="tc-picker-name"></span><span class="tc-picker-tag"></span>`;
			card.querySelector('.tc-picker-name').textContent = a.name;
			card.querySelector('.tc-picker-tag').textContent = a.tagline;
			card.addEventListener('click', () => {
				this.setAvatar(a.id);
				this.togglePicker(false);
			});
			grid.appendChild(card);
		}
	}

	// ── Voice ─────────────────────────────────────────────────────────────────
	setMuted(muted) {
		this.muted = !!muted;
		storageSet('localStorage', LS_MUTED, muted ? '1' : '0');
		this._narrator?.setMuted(this.muted);
		this._syncMuteButton();
	}
	_syncMuteButton() {
		const btn = this.$?.mute;
		if (!btn) return;
		btn.innerHTML = this.muted ? ICONS.soundOff : ICONS.sound;
		btn.setAttribute('aria-pressed', String(this.muted));
		btn.setAttribute('aria-label', this.muted ? 'Unmute voice' : 'Mute voice');
	}

	async _toggleMic() {
		if (!this._mic) return;
		if (this._mic.listening) {
			this._mic.stop();
			return;
		}
		this._narrator?.cancel();
		const transcript = await this._mic.start();
		if (transcript) {
			this.$.textarea.value = transcript;
			this._syncInput();
			this._submit();
		}
	}

	// ── Thread rendering ──────────────────────────────────────────────────────
	_restoreThread() {
		try {
			const raw = storageGet('sessionStorage', SS_THREAD);
			const arr = raw ? JSON.parse(raw) : [];
			return Array.isArray(arr)
				? arr.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
				: [];
		} catch {
			return [];
		}
	}
	_persistThread() {
		storageSet('sessionStorage', SS_THREAD, JSON.stringify(this.messages.slice(-MAX_HISTORY_TURNS * 2)));
	}

	_renderThread() {
		const thread = this.$.thread;
		thread.textContent = '';
		if (!this.messages.length) {
			const empty = document.createElement('div');
			empty.className = 'tc-empty';
			const title = document.createElement('p');
			title.className = 'tc-empty-title';
			title.textContent = this._greetingText();
			empty.appendChild(title);
			const suggestions = this.config.suggestions.length
				? this.config.suggestions
				: this.config.shopping
					? shoppingSuggestions()
					: defaultSuggestions(this.config.siteName);
			if (suggestions.length) {
				const chips = document.createElement('div');
				chips.className = 'tc-chips';
				for (const s of suggestions.slice(0, 4)) {
					const chip = document.createElement('button');
					chip.type = 'button';
					chip.className = 'tc-chip';
					chip.textContent = s;
					chip.addEventListener('click', () => this.ask(s));
					chips.appendChild(chip);
				}
				empty.appendChild(chips);
			}
			thread.appendChild(empty);
			return;
		}
		for (const m of this.messages) thread.appendChild(this._bubble(m.role, m.content, { products: m.products }));
		this._scrollThread(false);
	}

	_bubble(role, content, { error = false, products = null } = {}) {
		const el = document.createElement('div');
		el.className = `tc-msg is-${role === 'user' ? 'user' : 'bot'}${error ? ' is-error' : ''}`;
		if (role === 'user') el.textContent = content;
		else {
			el.innerHTML = renderMarkdown(content);
			if (Array.isArray(products) && products.length) this._renderProductCards(el, products);
		}
		return el;
	}

	/**
	 * Render product recommendation cards under an answer. The set comes from the
	 * widget's own retrieval, so image, price, and link are always real. On the
	 * store itself an "Add" button posts to Shopify's public /cart/add.js.
	 */
	_renderProductCards(afterEl, products) {
		const wrap = document.createElement('div');
		wrap.className = 'tc-products';
		wrap.setAttribute('role', 'list');
		wrap.setAttribute('aria-label', 'Recommended products');
		for (const p of products) {
			const priceLabel =
				p.priceMax > p.priceMin
					? `${money(p.priceMin, p.currency)} - ${money(p.priceMax, p.currency)}`
					: money(p.priceMin, p.currency);
			const card = document.createElement('div');
			card.className = 'tc-product';
			card.setAttribute('role', 'listitem');
			card.innerHTML = `
				<a class="tc-product-media" href="${escapeHtml(p.url)}" target="_top" rel="noopener" aria-label="${escapeHtml(p.title)}">
					${p.image ? `<img loading="lazy" src="${escapeHtml(p.image)}" alt="">` : '<span class="tc-product-noimg" aria-hidden="true"></span>'}
					${p.onSale ? '<span class="tc-product-badge">Sale</span>' : ''}
				</a>
				<div class="tc-product-body">
					<a class="tc-product-title" href="${escapeHtml(p.url)}" target="_top" rel="noopener">${escapeHtml(p.title)}</a>
					<div class="tc-product-meta">
						<span class="tc-product-price">${escapeHtml(priceLabel)}</span>
						${p.available ? '' : '<span class="tc-product-oos">Sold out</span>'}
					</div>
					<div class="tc-product-actions"></div>
				</div>`;
			const actions = card.querySelector('.tc-product-actions');
			const view = document.createElement('a');
			view.className = 'tc-product-view';
			view.href = p.url;
			view.target = '_top';
			view.rel = 'noopener';
			view.textContent = 'View';
			actions.appendChild(view);
			if (this._onStore && p.available && p.variantId) {
				const add = document.createElement('button');
				add.type = 'button';
				add.className = 'tc-product-add';
				add.textContent = 'Add to cart';
				add.addEventListener('click', () => this._addToCart(p, add));
				actions.appendChild(add);
			}
			wrap.appendChild(card);
		}
		afterEl.appendChild(wrap);
		this._scrollThread();
	}

	/** Add a variant to the Shopify cart via the store's public AJAX endpoint. */
	async _addToCart(product, btn) {
		if (!this._onStore || !product.variantId) return;
		const origin = shopOrigin(this.config.shop);
		btn.disabled = true;
		const original = btn.textContent;
		btn.textContent = 'Adding…';
		try {
			const res = await fetch(`${origin}/cart/add.js`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ items: [{ id: product.variantId, quantity: 1 }] }),
			});
			if (!res.ok) throw new Error(`cart/add → HTTP ${res.status}`);
			btn.textContent = 'Added ✓';
			btn.classList.add('is-added');
			this._emit('addtocart', { product });
			// Nudge Shopify themes that watch for cart changes to refresh their count.
			try {
				document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
			} catch {
				/* theme has no such hook: the item is still in the cart */
			}
			setTimeout(() => {
				if (!btn.isConnected) return;
				btn.textContent = original;
				btn.classList.remove('is-added');
				btn.disabled = false;
			}, 2400);
		} catch (err) {
			btn.textContent = 'Try again';
			btn.disabled = false;
			this._emit('error', err instanceof Error ? err : new Error(String(err)));
		}
	}

	_scrollThread(smooth = true) {
		const t = this.$.thread;
		t.scrollTo({ top: t.scrollHeight, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
	}

	_syncInput() {
		const ta = this.$.textarea;
		ta.style.height = 'auto';
		ta.style.height = Math.min(ta.scrollHeight, 110) + 'px';
		this.$.send.disabled = this.busy || !ta.value.trim();
	}

	// ── Ask flow ──────────────────────────────────────────────────────────────
	_submit() {
		const text = this.$.textarea.value.trim();
		if (!text || this.busy) return;
		this.$.textarea.value = '';
		this._syncInput();
		this.ask(text);
	}

	/**
	 * Ask the concierge a question programmatically. Renders the exchange in the
	 * panel, streams the answer, speaks it, persists the thread.
	 * @returns {Promise<string>} the full answer text ('' on failure)
	 */
	async ask(text) {
		const question = String(text || '').trim();
		if (!question || this.busy || this._destroyed) return '';
		this.setOpen(true);
		this._narrator?.cancel();

		if (!this.messages.length) this.$.thread.textContent = '';
		this.messages.push({ role: 'user', content: question });
		this.$.thread.appendChild(this._bubble('user', question));
		this._persistThread();
		this._emit('message', { role: 'user', content: question });
		this._scrollThread();

		this.busy = true;
		this.$.send.disabled = true;

		const typing = document.createElement('div');
		typing.className = 'tc-typing';
		typing.setAttribute('aria-label', 'Assistant is thinking');
		typing.innerHTML = '<i></i><i></i><i></i>';
		this.$.thread.appendChild(typing);
		this._scrollThread();

		const streamEl = document.createElement('div');
		streamEl.className = 'tc-msg is-bot';
		let streamed = '';
		let spoken = ''; // buffer of not-yet-spoken text
		let started = false;

		// Shopping mode: retrieve the products this question is about and ground
		// the answer in them. The cards are rendered from this same set, so prices
		// and links are always real, never model-invented.
		let shopping = null;
		let recommended = [];
		if (this.config.shopping) {
			try {
				const catalog = await this._ensureCatalog();
				if (catalog?.products?.length) {
					recommended = searchProducts(catalog.products, question, this.config.maxProducts);
					shopping = buildShoppingPayload(catalog, recommended, this._policies, question);
				}
			} catch {
				/* retrieval must never block the answer */
			}
		}

		this._abort = new AbortController();
		let answer = '';
		try {
			const result = await askConcierge({
				endpoint: this.config.endpoint,
				message: question,
				history: this.messages.slice(0, -1),
				site: buildSitePayload(document, {
					knowledge: this.config.knowledge,
					siteName: this.config.siteName,
				}),
				shopping: shopping || undefined,
				persona: this.config.persona || undefined,
				lang: this.config.lang || undefined,
				signal: this._abort.signal,
				onChunk: (chunk) => {
					if (!started) {
						started = true;
						typing.remove();
						this.$.thread.appendChild(streamEl);
					}
					streamed += chunk;
					streamEl.innerHTML = renderMarkdown(streamed) + '<span class="tc-caret" aria-hidden="true"></span>';
					this._scrollThread();
					// Speak completed sentences while the rest still streams.
					spoken += chunk;
					const { sentences, rest } = drainSentences(spoken);
					spoken = rest;
					for (const s of sentences) {
						const speakable = stripMarkdown(s);
						if (speakable) this._narrator?.speak(speakable);
					}
				},
			});
			answer = result.text.trim();
			const tail = stripMarkdown(spoken);
			if (tail) this._narrator?.speak(tail);

			typing.remove();
			if (!answer) {
				streamEl.remove();
				this._renderErrorBubble(question, 'I could not come up with an answer just now.');
			} else {
				if (!started) this.$.thread.appendChild(streamEl);
				streamEl.innerHTML = renderMarkdown(answer);
				if (recommended.length) this._renderProductCards(streamEl, recommended);
				this.messages.push({
					role: 'assistant',
					content: answer,
					products: recommended.length ? recommended.map(compactCard) : undefined,
				});
				this._persistThread();
				this._emit('message', { role: 'assistant', content: answer, products: recommended });
			}
		} catch (err) {
			typing.remove();
			streamEl.remove();
			if (err?.name !== 'AbortError') {
				const friendly =
					err?.status === 429
						? 'I am getting a lot of questions right now, give me a few seconds and try again.'
						: 'Something went wrong reaching my brain. Check your connection and try again.';
				this._renderErrorBubble(question, friendly);
				this._emit('error', err instanceof Error ? err : new Error(String(err)));
			}
		} finally {
			this.busy = false;
			this._abort = null;
			this._syncInput();
			this._scrollThread();
			this.$.textarea.focus({ preventScroll: true });
		}
		return answer;
	}

	_renderErrorBubble(question, message) {
		const errEl = this._bubble('assistant', message, { error: true });
		this.$.thread.appendChild(errEl);
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'tc-retry';
		retry.textContent = 'Try again';
		retry.addEventListener('click', () => {
			// Rewind the failed exchange (state + DOM) so the retry doesn't double it.
			retry.remove();
			errEl.remove();
			if (this.messages[this.messages.length - 1]?.role === 'user') {
				this.messages.pop();
				this._persistThread();
				const bubbles = this.$.thread.querySelectorAll('.tc-msg.is-user');
				bubbles[bubbles.length - 1]?.remove();
			}
			this.ask(question);
		});
		this.$.thread.appendChild(retry);
	}

	/** Clear the conversation (UI + persistence). */
	reset() {
		this._abort?.abort();
		this._narrator?.cancel();
		this.messages = [];
		this._persistThread();
		this._renderThread();
	}

	dispose() {
		if (this._destroyed) return;
		this._destroyed = true;
		this._abort?.abort();
		this._catalogAbort?.abort();
		this._killTeaser();
		document.removeEventListener('keydown', this._onKeydown);
		this._mq?.removeEventListener?.('change', this._onScheme);
		this._themeObs?.disconnect();
		this._mic?.dispose();
		this._narrator?.dispose();
		this._stage?.dispose();
		this.root?.remove();
		this._listeners.clear();
	}
}

function getAvatarFrom(list, id) {
	return list.find((a) => a.id === id) || list.find((a) => a.id === DEFAULT_AVATAR_ID) || list[0] || getAvatar(id);
}

function defaultSuggestions(siteName) {
	const site = siteName || 'this site';
	return [`What is ${site}?`, 'How do I get started?', 'What does it cost?'];
}

function shoppingSuggestions() {
	return ['What do you recommend?', 'Help me find a gift', "What's on sale?", 'Do you ship internationally?'];
}

/** Minimal product shape persisted on a message so cards survive a reload. */
function compactCard(p) {
	return {
		handle: p.handle,
		title: p.title,
		url: p.url,
		image: p.image,
		priceMin: p.priceMin,
		priceMax: p.priceMax,
		currency: p.currency,
		available: p.available,
		onSale: p.onSale,
		variantId: p.variantId,
	};
}
