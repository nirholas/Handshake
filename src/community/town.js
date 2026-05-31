// Town — the in-world social layer for a coin world.
//
// Each coin on /walk is its own CoinCommunities community. Town renders that
// community's persisted feed (a collapsible rail on desktop, a bottom sheet on
// mobile) and turns incoming realtime posts into speech bubbles that drift over
// the 3D scene — so the world feels inhabited even by people who aren't walking
// right now. Reads + realtime work with just the proxy's API key; posting is
// capability-gated and renders a designed locked state when unavailable.
//
// Self-contained: styles are injected once, nothing here depends on the build
// pipeline's CSS handling, and it appends to <body> without touching walk.js.

import { fetchCapabilities, fetchMessages, connectRealtime } from './town-client.js';
import { getSession, signInWithX, ensureSolanaWallet, postAsUser, logout } from './town-auth.js';

const MAX_BUBBLES = 4;
const BUBBLE_TTL_MS = 7000;
const MAX_RENDERED = 80; // cap the rail DOM so a busy world never bloats memory

let _stylesInjected = false;

function injectStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'town-styles';
	style.textContent = STYLES;
	document.head.appendChild(style);
}

function el(tag, cls, text) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
}

function timeAgo(iso) {
	const t = typeof iso === 'string' ? Date.parse(iso) : iso;
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 60) return `${s | 0}s`;
	if (s < 3600) return `${(s / 60) | 0}m`;
	if (s < 86400) return `${(s / 3600) | 0}h`;
	return `${(s / 86400) | 0}d`;
}

function compactNum(n) {
	n = Number(n) || 0;
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function initials(name) {
	return (name || '?').replace(/^@/, '').slice(0, 2).toUpperCase();
}

export class Town {
	/**
	 * @param {object} opts
	 * @param {string} opts.token   community mint
	 * @param {object} [opts.meta]  { symbol, image, members, posts }
	 */
	constructor({ token, meta = {} }) {
		this.token = token;
		this.meta = meta;
		this.messages = [];
		this.seen = new Set();
		this.caps = null;
		this.dispose = null;
		this.collapsed = matchMedia('(max-width: 768px)').matches;
		this._bubbleCount = 0;

		injectStyles();
		this._build();
		this._load();
	}

	// ── DOM ──────────────────────────────────────────────────────────────
	_build() {
		const root = el('aside', 'town');
		root.setAttribute('aria-label', `${this.meta.symbol || 'Coin'} community`);
		if (this.collapsed) root.classList.add('town--collapsed');
		this.root = root;

		// Header — coin identity, live status, counts, collapse toggle.
		const header = el('header', 'town__header');
		const badge = el('div', 'town__badge');
		if (this.meta.image) {
			const img = el('img', 'town__coin-img');
			img.src = this.meta.image;
			img.alt = '';
			img.loading = 'lazy';
			img.onerror = () => img.remove();
			badge.appendChild(img);
		} else {
			badge.appendChild(
				el('div', 'town__coin-img town__coin-img--ph', initials(this.meta.symbol)),
			);
		}
		const idCol = el('div', 'town__idcol');
		const title = el('div', 'town__title');
		title.appendChild(
			el('span', 'town__symbol', this.meta.symbol ? `$${this.meta.symbol}` : 'Coin world'),
		);
		this.statusDot = el('span', 'town__dot', '');
		this.statusDot.setAttribute('aria-label', 'connecting');
		title.appendChild(this.statusDot);
		idCol.appendChild(title);
		this.countsEl = el('div', 'town__counts', '');
		this._renderCounts();
		idCol.appendChild(this.countsEl);
		badge.appendChild(idCol);
		header.appendChild(badge);

		const toggle = el('button', 'town__toggle');
		toggle.type = 'button';
		toggle.setAttribute('aria-label', 'Toggle community panel');
		toggle.innerHTML = '<span></span>';
		toggle.addEventListener('click', () => this.toggle());
		header.appendChild(toggle);
		root.appendChild(header);

		// Body — message list (role=log for assistive tech).
		this.list = el('div', 'town__list');
		this.list.setAttribute('role', 'log');
		this.list.setAttribute('aria-live', 'polite');
		root.appendChild(this.list);
		this._renderSkeleton();

		// Composer — capability-gated; built after caps load.
		this.composer = el('div', 'town__composer');
		root.appendChild(this.composer);

		// Floating bubbles over the scene.
		this.bubbles = document.getElementById('town-bubbles') || el('div', 'town-bubbles');
		this.bubbles.id = 'town-bubbles';
		if (!this.bubbles.isConnected) document.body.appendChild(this.bubbles);

		document.body.appendChild(root);
	}

	_renderCounts() {
		const m = this.meta;
		const parts = [];
		if (m.members != null) parts.push(`${compactNum(m.members)} members`);
		if (m.posts != null) parts.push(`${compactNum(m.posts)} posts`);
		this.countsEl.textContent = parts.join(' · ');
	}

	_renderSkeleton() {
		this.list.innerHTML = '';
		for (let i = 0; i < 6; i++) {
			const row = el('div', 'town__msg town__msg--skel');
			row.appendChild(el('div', 'town__avatar town__skel'));
			const b = el('div', 'town__body');
			b.appendChild(el('div', 'town__skel town__skel--line'));
			b.appendChild(el('div', 'town__skel town__skel--line town__skel--short'));
			row.appendChild(b);
			this.list.appendChild(row);
		}
	}

	_renderEmpty() {
		this.list.innerHTML = '';
		const e = el('div', 'town__state');
		e.appendChild(el('div', 'town__state-emoji', '🌱'));
		e.appendChild(el('div', 'town__state-title', 'No posts yet'));
		e.appendChild(el('div', 'town__state-sub', 'Be the first voice in this world.'));
		this.list.appendChild(e);
	}

	_renderError(msg, retry) {
		this.list.innerHTML = '';
		const e = el('div', 'town__state');
		e.appendChild(el('div', 'town__state-emoji', '⚠️'));
		e.appendChild(el('div', 'town__state-title', 'Could not load the feed'));
		e.appendChild(el('div', 'town__state-sub', msg || 'Something went wrong.'));
		const btn = el('button', 'town__retry', 'Try again');
		btn.type = 'button';
		btn.addEventListener('click', retry);
		e.appendChild(btn);
		this.list.appendChild(e);
	}

	_msgRow(m) {
		const row = el('div', 'town__msg');
		row.dataset.id = m.id;
		const av = el('a', 'town__avatar');
		av.href = m.twitterUrl || '#';
		if (m.twitterUrl) {
			av.target = '_blank';
			av.rel = 'noopener';
		}
		if (m.avatar) {
			const img = el('img');
			img.src = m.avatar;
			img.alt = '';
			img.loading = 'lazy';
			img.onerror = () => {
				av.textContent = initials(m.username);
			};
			av.appendChild(img);
		} else {
			av.textContent = initials(m.username);
		}
		row.appendChild(av);

		const body = el('div', 'town__body');
		const meta = el('div', 'town__meta');
		const name = el('span', 'town__name', m.username || 'anon');
		meta.appendChild(name);
		if (m.followers > 0)
			meta.appendChild(el('span', 'town__followers', `${compactNum(m.followers)} followers`));
		meta.appendChild(el('span', 'town__time', timeAgo(m.createdAt)));
		body.appendChild(meta);
		body.appendChild(el('div', 'town__text', m.content));
		if (m.mediaUrl) {
			const img = el('img', 'town__media');
			img.src = m.mediaUrl;
			img.alt = '';
			img.loading = 'lazy';
			img.onerror = () => img.remove();
			body.appendChild(img);
		}
		const foot = el('div', 'town__foot');
		if (m.likes > 0) foot.appendChild(el('span', 'town__stat', `♥ ${compactNum(m.likes)}`));
		if (m.replies > 0) foot.appendChild(el('span', 'town__stat', `↩ ${compactNum(m.replies)}`));
		if (foot.childNodes.length) body.appendChild(foot);
		row.appendChild(body);
		return row;
	}

	_renderList() {
		if (!this.messages.length) return this._renderEmpty();
		this.list.innerHTML = '';
		for (const m of this.messages.slice(0, MAX_RENDERED)) {
			this.list.appendChild(this._msgRow(m));
		}
	}

	_prepend(m) {
		if (this.seen.has(m.id)) return;
		this.seen.add(m.id);
		this.messages.unshift(m);
		if (this.messages.length > MAX_RENDERED) this.messages.length = MAX_RENDERED;

		// Replace empty-state on first arrival.
		if (this.list.querySelector('.town__state')) this.list.innerHTML = '';
		const row = this._msgRow(m);
		row.classList.add('town__msg--enter');
		this.list.prepend(row);
		requestAnimationFrame(() => row.classList.remove('town__msg--enter'));
		while (this.list.children.length > MAX_RENDERED) this.list.lastChild.remove();
	}

	// ── Composer ─────────────────────────────────────────────────────────
	_buildComposer() {
		this.composer.innerHTML = '';
		if (!this.caps?.canPost) {
			// Designed locked state — only when the deployment has no CoinCommunities
			// credentials at all. The live feed above stays open regardless.
			const lock = el('div', 'town__locked');
			lock.appendChild(el('span', 'town__lock-icon', '🔒'));
			const t = el('div', 'town__lock-text');
			t.appendChild(el('strong', null, 'Posting opens soon'));
			t.appendChild(
				el(
					'span',
					null,
					'This world isn’t connected for posting yet. The live feed stays open to everyone.',
				),
			);
			lock.appendChild(t);
			this.composer.appendChild(lock);
			return;
		}

		const form = el('form', 'town__form');
		const ta = el('textarea', 'town__input');
		ta.placeholder = `Say something in $${this.meta.symbol || 'this world'}…`;
		ta.maxLength = 2000;
		ta.rows = 1;
		ta.setAttribute('aria-label', 'Write a message');
		ta.addEventListener('input', () => {
			ta.style.height = 'auto';
			ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
		});
		ta.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this._submit(ta, this.sendBtn);
			}
		});
		const send = el('button', 'town__send', 'Post');
		send.type = 'submit';
		this.sendBtn = send;
		form.appendChild(ta);
		form.appendChild(send);
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			this._submit(ta, send);
		});
		this.composer.appendChild(form);

		// Identity row — sign-in CTA when signed out, user chip when signed in.
		this.authRow = el('div', 'town__auth');
		this.composer.appendChild(this.authRow);
		this._renderAuthRow();
	}

	_renderAuthRow() {
		if (!this.authRow) return;
		this.authRow.innerHTML = '';
		const user = this.session?.user;
		if (user) {
			const chip = el('span', 'town__userchip');
			if (user.avatar) {
				const img = el('img');
				img.src = user.avatar;
				img.alt = '';
				chip.appendChild(img);
			}
			chip.appendChild(el('span', 'town__uname', `@${user.username}`));
			this.authRow.appendChild(el('span', 'town__authnote', 'posting as'));
			this.authRow.appendChild(chip);
			const out = el('button', 'town__signout', 'sign out');
			out.type = 'button';
			out.addEventListener('click', async () => {
				await logout();
				this.session = { user: null };
				this._renderAuthRow();
			});
			this.authRow.appendChild(out);
		} else {
			this.authRow.appendChild(el('span', 'town__authnote', 'Sign in to post —'));
			const btn = el('button', 'town__xbtn', 'Sign in with 𝕏');
			btn.type = 'button';
			btn.addEventListener('click', () => this._ensureSignedIn(btn));
			this.authRow.appendChild(btn);
		}
	}

	async _ensureSignedIn(trigger) {
		if (this.session?.user) return this.session;
		const label = trigger?.textContent;
		if (trigger) {
			trigger.disabled = true;
			trigger.textContent = 'Opening 𝕏…';
		}
		try {
			await signInWithX();
			this.session = await getSession();
			this._renderAuthRow();
			return this.session;
		} catch (err) {
			this._composerError(err.message || 'Sign-in failed.');
			throw err;
		} finally {
			if (trigger) {
				trigger.disabled = false;
				trigger.textContent = label;
			}
		}
	}

	async _submit(ta, send) {
		const content = ta.value.trim();
		if (!content) return;
		send.disabled = true;
		ta.disabled = true;
		const restore = () => {
			send.disabled = false;
			ta.disabled = false;
		};
		try {
			// 1. Signed in with X?
			let session = this.session;
			if (!session?.user) session = await this._ensureSignedIn();
			// 2. Linked Solana wallet? (connects Phantom + links on first post)
			send.textContent = 'Linking wallet…';
			const walletAddress = await ensureSolanaWallet(session);
			this.session = { ...session, solWallet: walletAddress };
			// 3. Post.
			send.textContent = 'Posting…';
			const posted = await postAsUser(this.token, content, walletAddress);
			ta.value = '';
			ta.style.height = 'auto';
			if (posted) this._prepend(posted); // realtime dedupes by id
		} catch (err) {
			this._composerError(err.message || 'Could not post.');
		} finally {
			restore();
			send.textContent = 'Post';
		}
	}

	_composerError(msg) {
		let e = this.composer.querySelector('.town__cerr');
		if (!e) {
			e = el('div', 'town__cerr');
			this.composer.appendChild(e);
		}
		e.textContent = msg;
		clearTimeout(this._cerrTimer);
		this._cerrTimer = setTimeout(() => e.remove(), 5000);
	}

	// ── Bubbles ──────────────────────────────────────────────────────────
	_bubble(m) {
		if (this._bubbleCount >= MAX_BUBBLES) return;
		this._bubbleCount++;
		const b = el('div', 'town-bubble');
		const av = el('span', 'town-bubble__av');
		if (m.avatar) {
			const img = el('img');
			img.src = m.avatar;
			img.alt = '';
			img.onerror = () => {
				av.textContent = initials(m.username);
			};
			av.appendChild(img);
		} else {
			av.textContent = initials(m.username);
		}
		b.appendChild(av);
		const txt = el('span', 'town-bubble__txt');
		txt.appendChild(el('b', null, m.username || 'anon'));
		txt.appendChild(
			document.createTextNode(
				' ' + (m.content.length > 90 ? m.content.slice(0, 88) + '…' : m.content),
			),
		);
		b.appendChild(txt);
		this.bubbles.appendChild(b);
		requestAnimationFrame(() => b.classList.add('town-bubble--in'));
		setTimeout(() => {
			b.classList.remove('town-bubble--in');
			b.classList.add('town-bubble--out');
			setTimeout(() => {
				b.remove();
				this._bubbleCount--;
			}, 600);
		}, BUBBLE_TTL_MS);
	}

	// ── Status ───────────────────────────────────────────────────────────
	_setStatus(state) {
		const labels = { live: 'live', offline: 'offline', connecting: 'connecting' };
		this.statusDot.className = `town__dot town__dot--${state}`;
		this.statusDot.setAttribute('aria-label', labels[state] || state);
	}

	toggle() {
		this.collapsed = !this.collapsed;
		this.root.classList.toggle('town--collapsed', this.collapsed);
	}

	/** Merge in coin metadata that arrived after mount (e.g. enriched from /worlds). */
	updateMeta(meta = {}) {
		this.meta = { ...this.meta, ...meta };
		const sym = this.root.querySelector('.town__symbol');
		if (sym && this.meta.symbol) sym.textContent = `$${this.meta.symbol}`;
		const ph = this.root.querySelector('.town__coin-img--ph');
		if (ph && this.meta.image) {
			const img = el('img', 'town__coin-img');
			img.src = this.meta.image;
			img.alt = '';
			img.loading = 'lazy';
			img.onerror = () => img.remove();
			ph.replaceWith(img);
		}
		this._renderCounts();
		this.root.setAttribute('aria-label', `${this.meta.symbol || 'Coin'} community`);
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────
	async _load() {
		this._setStatus('connecting');
		// Capabilities, first page of messages, and any existing session — all in
		// parallel so the composer renders the right identity state immediately.
		const [caps, msgs, sess] = await Promise.allSettled([
			fetchCapabilities(),
			fetchMessages(this.token, { limit: 50 }),
			getSession(),
		]);

		this.caps = caps.status === 'fulfilled' ? caps.value : null;
		this.session = sess.status === 'fulfilled' ? sess.value : { user: null };
		this._buildComposer();

		if (msgs.status === 'rejected') {
			const err = msgs.reason;
			if (err?.code === 'cc_unconfigured') {
				this._renderError('This deployment has no CoinCommunities key yet.', () =>
					this._load(),
				);
			} else {
				this._renderError(err?.message, () => this._load());
			}
			this._setStatus('offline');
			return;
		}

		this.messages = msgs.value;
		for (const m of this.messages) this.seen.add(m.id);
		this._renderList();

		// Realtime — needs the CC origin from capabilities.
		if (this.caps?.baseUrl) this._connectRealtime();
		else this._setStatus('offline');
	}

	async _connectRealtime() {
		try {
			this.dispose = await connectRealtime(this.token, this.caps.baseUrl, {
				onConnect: () => this._setStatus('live'),
				onDisconnect: () => this._setStatus('offline'),
				onGap: () => this._refetch(),
				onMessage: (evt) => {
					const m = normalizeRealtime(evt, this.token);
					if (!m) return;
					this._prepend(m);
					// Floating bubble only when the panel is collapsed — the user
					// can't see the docked feed, so surface new activity ambiently.
					// When it's open the message is already in the list, so a bubble
					// would just be noise.
					if (this.collapsed) this._bubble(m);
				},
				onLike: (evt) => this._applyLike(evt),
			});
		} catch (err) {
			console.warn('[town] realtime unavailable:', err?.message ?? err);
			this._setStatus('offline');
		}
	}

	async _refetch() {
		try {
			const latest = await fetchMessages(this.token, { limit: 50 });
			for (const m of latest.reverse()) this._prepend(m);
		} catch {
			/* transient — realtime will catch up */
		}
	}

	_applyLike(evt) {
		const id = evt?.messageId || evt?.message_id || evt?.id;
		if (!id) return;
		const msg = this.messages.find((m) => m.id === id);
		if (msg && typeof evt.likeCount === 'number') {
			msg.likes = evt.likeCount;
			const row = this.list.querySelector(`[data-id="${CSS.escape(id)}"] .town__foot`);
			if (row) {
				const stat = row.querySelector('.town__stat');
				if (stat) stat.textContent = `♥ ${compactNum(msg.likes)}`;
			}
		}
	}

	destroy() {
		try {
			this.dispose?.();
		} catch {
			/* already gone */
		}
		this.dispose = null;
		this.root?.remove();
		this.bubbles?.remove();
	}
}

/**
 * Realtime envelopes carry the persisted message under a few possible keys
 * depending on event shape — normalize to Town's row model defensively.
 */
function normalizeRealtime(evt, token) {
	const m = evt?.message || evt?.data || evt;
	if (!m || !m.id || !(m.content ?? '').toString().trim()) return null;
	return {
		id: m.id,
		token,
		content: m.content,
		mediaUrl: m.mediaUrl || null,
		username: m.username || 'anon',
		avatar: m.profileImageUrl || m.avatar || null,
		twitterUrl: m.userTwitterUrl || m.twitterUrl || null,
		followers: m.followerCount ?? 0,
		likes: m.likeCount ?? 0,
		replies: m.replyCount ?? 0,
		createdAt: m.createdAt || Date.now(),
	};
}

export function mountTown(opts) {
	return new Town(opts);
}

// ── Styles ───────────────────────────────────────────────────────────────
const STYLES = `
.town{position:fixed;top:0;right:0;height:100dvh;width:360px;max-width:88vw;z-index:40;
 display:flex;flex-direction:column;color:#e8eefb;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
 background:linear-gradient(180deg,rgba(13,18,34,.92),rgba(9,12,24,.96));
 backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
 border-left:1px solid rgba(120,150,220,.16);box-shadow:-18px 0 50px rgba(0,0,0,.35);
 transform:translateX(0);transition:transform .32s cubic-bezier(.16,1,.3,1)}
.town--collapsed{transform:translateX(calc(100% - 56px))}
.town__header{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;
 border-bottom:1px solid rgba(120,150,220,.12);flex:0 0 auto}
.town__badge{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.town__coin-img{width:38px;height:38px;border-radius:11px;object-fit:cover;flex:0 0 auto;
 background:#16203a;border:1px solid rgba(120,150,220,.22)}
.town__coin-img--ph{display:grid;place-items:center;font-weight:700;font-size:13px;color:#9fb4e6;
 background:linear-gradient(135deg,#23304f,#16203a)}
.town__idcol{min-width:0}
.town__title{display:flex;align-items:center;gap:7px}
.town__symbol{font-weight:700;font-size:15px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.town__dot{width:8px;height:8px;border-radius:50%;background:#6b7689;flex:0 0 auto;transition:background .3s,box-shadow .3s}
.town__dot--connecting{background:#e6b04a;box-shadow:0 0 0 0 rgba(230,176,74,.5);animation:town-pulse 1.4s infinite}
.town__dot--live{background:#3fd07f;box-shadow:0 0 8px rgba(63,208,127,.8)}
.town__dot--offline{background:#e5564b}
@keyframes town-pulse{0%{box-shadow:0 0 0 0 rgba(230,176,74,.45)}70%{box-shadow:0 0 0 7px rgba(230,176,74,0)}100%{box-shadow:0 0 0 0 rgba(230,176,74,0)}}
.town__counts{font-size:11.5px;color:#8ea0c6;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.town__toggle{flex:0 0 auto;width:30px;height:30px;border-radius:9px;border:1px solid rgba(120,150,220,.2);
 background:rgba(255,255,255,.04);cursor:pointer;display:grid;place-items:center;transition:background .2s}
.town__toggle:hover{background:rgba(255,255,255,.1)}
.town__toggle:focus-visible{outline:2px solid #5b8cff;outline-offset:2px}
.town__toggle span{display:block;width:9px;height:9px;border-right:2px solid #cdd9f5;border-bottom:2px solid #cdd9f5;
 transform:rotate(-45deg);transition:transform .3s;margin-right:2px}
.town--collapsed .town__toggle span{transform:rotate(135deg);margin:0 0 0 3px}
.town__list{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:8px 10px;display:flex;flex-direction:column;gap:2px;
 scrollbar-width:thin;scrollbar-color:rgba(120,150,220,.3) transparent}
.town__list::-webkit-scrollbar{width:7px}.town__list::-webkit-scrollbar-thumb{background:rgba(120,150,220,.3);border-radius:4px}
.town__msg{display:flex;gap:10px;padding:9px 8px;border-radius:12px;transition:background .15s;align-items:flex-start}
.town__msg:hover{background:rgba(255,255,255,.035)}
.town__msg--enter{opacity:0;transform:translateY(-8px)}
.town__msg{opacity:1;transform:none;transition:opacity .35s ease,transform .35s cubic-bezier(.16,1,.3,1),background .15s}
.town__avatar{width:36px;height:36px;border-radius:50%;flex:0 0 auto;overflow:hidden;display:grid;place-items:center;
 background:linear-gradient(135deg,#2b3a5e,#18233e);color:#a9bbe6;font-weight:700;font-size:13px;text-decoration:none;
 border:1px solid rgba(120,150,220,.18)}
.town__avatar img{width:100%;height:100%;object-fit:cover}
.town__body{min-width:0;flex:1}
.town__meta{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.town__name{font-weight:650;color:#f0f4ff;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.town__followers{font-size:11px;color:#8093ba}
.town__time{font-size:11px;color:#6f7fa3;margin-left:auto}
.town__text{margin-top:2px;color:#d7e0f4;word-wrap:break-word;overflow-wrap:anywhere;white-space:pre-wrap}
.town__media{margin-top:7px;max-width:100%;border-radius:10px;display:block;border:1px solid rgba(120,150,220,.14)}
.town__foot{display:flex;gap:14px;margin-top:6px}
.town__stat{font-size:11.5px;color:#8aa0cf}
.town__state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;
 text-align:center;padding:40px 24px;color:#9aabd0}
.town__state-emoji{font-size:30px}
.town__state-title{font-weight:650;color:#dde6fb}
.town__state-sub{font-size:12.5px;color:#8093ba;max-width:230px}
.town__retry{margin-top:8px;padding:8px 16px;border-radius:9px;border:1px solid rgba(120,150,220,.3);
 background:rgba(91,140,255,.16);color:#cfe0ff;cursor:pointer;font-weight:600;transition:background .2s}
.town__retry:hover{background:rgba(91,140,255,.28)}
.town__skel{background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.11),rgba(255,255,255,.05));
 background-size:200% 100%;animation:town-shimmer 1.3s infinite;border-radius:7px}
.town__msg--skel{pointer-events:none}
.town__skel--line{height:11px;margin:5px 0;width:90%}
.town__skel--short{width:55%}
.town__avatar.town__skel{border-radius:50%}
@keyframes town-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.town__composer{flex:0 0 auto;padding:10px 12px;border-top:1px solid rgba(120,150,220,.12);background:rgba(8,11,22,.5)}
.town__form{display:flex;gap:8px;align-items:flex-end}
.town__input{flex:1;resize:none;background:rgba(255,255,255,.05);border:1px solid rgba(120,150,220,.2);
 border-radius:11px;color:#eaf0ff;padding:9px 11px;font:inherit;line-height:1.4;max-height:120px;transition:border-color .2s}
.town__input:focus{outline:none;border-color:#5b8cff;background:rgba(255,255,255,.08)}
.town__send{flex:0 0 auto;padding:9px 16px;border-radius:11px;border:0;cursor:pointer;font-weight:650;
 background:linear-gradient(135deg,#5b8cff,#7c5bff);color:#fff;transition:filter .2s,opacity .2s}
.town__send:hover{filter:brightness(1.1)}.town__send:disabled{opacity:.5;cursor:default}
.town__locked{display:flex;gap:11px;align-items:center;padding:11px 12px;border-radius:12px;
 background:rgba(255,255,255,.035);border:1px dashed rgba(120,150,220,.22)}
.town__lock-icon{font-size:17px;flex:0 0 auto;opacity:.85}
.town__lock-text{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#9fb0d4}
.town__lock-text strong{color:#dde6fb;font-size:12.5px}
.town__cerr{margin-top:8px;font-size:12px;color:#ffb4ad}
.town__auth{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:12px;color:#8093ba;flex-wrap:wrap}
.town__authnote{opacity:.85}
.town__xbtn{padding:6px 12px;border-radius:9px;border:1px solid rgba(120,150,220,.28);
 background:rgba(255,255,255,.06);color:#eaf0ff;cursor:pointer;font-weight:650;font-size:12px;transition:background .2s}
.town__xbtn:hover{background:rgba(255,255,255,.13)}.town__xbtn:disabled{opacity:.6;cursor:default}
.town__userchip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px 3px 3px;border-radius:999px;
 background:rgba(91,140,255,.16);border:1px solid rgba(120,150,220,.25);color:#cfe0ff;font-weight:650}
.town__userchip img{width:18px;height:18px;border-radius:50%;object-fit:cover}
.town__uname{font-size:12px}
.town__signout{background:none;border:0;color:#7f8db0;cursor:pointer;font-size:11.5px;text-decoration:underline;padding:0;margin-left:2px}
.town__signout:hover{color:#aab8db}
.town-bubbles{position:fixed;top:84px;left:50%;transform:translateX(-50%);z-index:35;
 display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:min(560px,92vw)}
.town-bubble{display:flex;gap:9px;align-items:center;max-width:100%;padding:8px 14px 8px 8px;border-radius:999px;
 background:linear-gradient(180deg,rgba(20,27,47,.92),rgba(13,18,34,.94));border:1px solid rgba(120,150,220,.22);
 box-shadow:0 8px 28px rgba(0,0,0,.4);color:#e8eefb;font-size:13px;
 opacity:0;transform:translateY(-12px) scale(.96);transition:opacity .4s,transform .4s cubic-bezier(.16,1,.3,1)}
.town-bubble--in{opacity:1;transform:translateY(0) scale(1)}
.town-bubble--out{opacity:0;transform:translateY(-10px) scale(.97)}
.town-bubble__av{width:28px;height:28px;border-radius:50%;flex:0 0 auto;overflow:hidden;display:grid;place-items:center;
 background:linear-gradient(135deg,#2b3a5e,#18233e);color:#a9bbe6;font-weight:700;font-size:11px}
.town-bubble__av img{width:100%;height:100%;object-fit:cover}
.town-bubble__txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.town-bubble__txt b{color:#9fc0ff;margin-right:3px}
@media (max-width:768px){
 .town{top:auto;bottom:0;right:0;left:0;width:100%;max-width:100%;height:62dvh;border-left:0;
  border-top:1px solid rgba(120,150,220,.16);border-radius:18px 18px 0 0;
  transform:translateY(0);transition:transform .32s cubic-bezier(.16,1,.3,1)}
 .town--collapsed{transform:translateY(calc(100% - 58px))}
 .town__toggle span{transform:rotate(45deg)}
 .town--collapsed .town__toggle span{transform:rotate(-135deg);margin:3px 0 0}
 .town-bubbles{top:64px}
}
@media (prefers-reduced-motion:reduce){
 .town,.town__msg,.town-bubble{transition:none}
 .town__dot--connecting,.town__skel{animation:none}
}
`;
