// Coin lobby — the entry surface for /walk when no coin is chosen.
//
// Lists live coin-worlds from the proxy (real getTopCommunities data) as
// enterable cards. Picking one navigates to /walk?coin=<mint> (preserving any
// ?avatar / ?agent so the player keeps their identity into the world). Fully
// self-contained: injects its own styles, mounts over <body>, removes itself on
// enter. Designed loading / empty / error states.

import { fetchWorlds } from './town-client.js';

let _stylesInjected = false;

function injectStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const s = document.createElement('style');
	s.id = 'coin-lobby-styles';
	s.textContent = STYLES;
	document.head.appendChild(s);
}

function el(tag, cls, text) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
}

function compactNum(n) {
	n = Number(n) || 0;
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function initials(s) {
	return (s || '?').replace(/^\$/, '').slice(0, 2).toUpperCase();
}

/** Carry the player's chosen identity into the world they enter. */
function enterUrl(token) {
	const cur = new URLSearchParams(location.search);
	const next = new URLSearchParams();
	next.set('coin', token);
	for (const k of ['avatar', 'agent', 'name']) {
		const v = cur.get(k);
		if (v) next.set(k, v);
	}
	return `${location.pathname}?${next}`;
}

export class CoinLobby {
	constructor({ onEnter } = {}) {
		this.onEnter = onEnter; // optional override; defaults to navigation
		this.worlds = [];
		injectStyles();
		this._build();
		this._load();
	}

	_build() {
		const root = el('div', 'clobby');
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-label', 'Choose a coin world');
		this.root = root;

		const inner = el('div', 'clobby__inner');
		const head = el('header', 'clobby__head');
		const titles = el('div', 'clobby__titles');
		titles.appendChild(el('h1', 'clobby__h1', 'Enter a coin world'));
		titles.appendChild(
			el(
				'p',
				'clobby__sub',
				'Each coin is a live 3D world. Drop in, walk around, talk to its community.',
			),
		);
		head.appendChild(titles);

		const search = el('input', 'clobby__search');
		search.type = 'search';
		search.placeholder = 'Search worlds…';
		search.setAttribute('aria-label', 'Search worlds');
		search.addEventListener('input', () => this._filter(search.value));
		this.search = search;
		head.appendChild(search);
		inner.appendChild(head);

		this.grid = el('div', 'clobby__grid');
		inner.appendChild(this.grid);
		root.appendChild(inner);
		document.body.appendChild(root);
		this._renderSkeleton();
	}

	_renderSkeleton() {
		this.grid.innerHTML = '';
		for (let i = 0; i < 8; i++) {
			const c = el('div', 'cw cw--skel');
			c.appendChild(el('div', 'cw__img clobby__skel'));
			c.appendChild(el('div', 'clobby__skel clobby__skel--line'));
			c.appendChild(el('div', 'clobby__skel clobby__skel--line clobby__skel--short'));
			this.grid.appendChild(c);
		}
	}

	_renderState(emoji, title, sub, retry) {
		this.grid.innerHTML = '';
		const e = el('div', 'clobby__state');
		e.appendChild(el('div', 'clobby__state-emoji', emoji));
		e.appendChild(el('div', 'clobby__state-title', title));
		if (sub) e.appendChild(el('div', 'clobby__state-sub', sub));
		if (retry) {
			const b = el('button', 'clobby__retry', 'Try again');
			b.type = 'button';
			b.addEventListener('click', retry);
			e.appendChild(b);
		}
		this.grid.appendChild(e);
	}

	_card(w) {
		const card = el('button', 'cw');
		card.type = 'button';
		card.setAttribute('aria-label', `Enter ${w.symbol ? '$' + w.symbol : 'world'}`);
		const img = el('div', 'cw__img');
		if (w.image) {
			const i = el('img');
			i.src = w.image;
			i.alt = '';
			i.loading = 'lazy';
			i.onerror = () => {
				img.classList.add('cw__img--ph');
				img.textContent = initials(w.symbol);
				i.remove();
			};
			img.appendChild(i);
		} else {
			img.classList.add('cw__img--ph');
			img.textContent = initials(w.symbol);
		}
		card.appendChild(img);

		card.appendChild(el('div', 'cw__symbol', w.symbol ? `$${w.symbol}` : 'world'));
		const stats = el('div', 'cw__stats');
		stats.appendChild(el('span', null, `${compactNum(w.members)} members`));
		stats.appendChild(el('span', 'cw__dot', '·'));
		stats.appendChild(el('span', null, `${compactNum(w.posts)} posts`));
		card.appendChild(stats);

		const enter = el('span', 'cw__enter', 'Enter →');
		card.appendChild(enter);

		card.addEventListener('click', () => this._enter(w));
		return card;
	}

	_enter(w) {
		// Hand the chosen world's identity to Town across the navigation so it
		// shows the coin symbol/image/counts immediately instead of fetching.
		try {
			sessionStorage.setItem(
				`town:meta:${w.token}`,
				JSON.stringify({
					symbol: w.symbol,
					image: w.image,
					members: w.members,
					posts: w.posts,
				}),
			);
		} catch {
			/* private mode — Town enriches from /worlds instead */
		}
		if (this.onEnter) {
			this.onEnter(w);
			this.destroy();
		} else {
			location.href = enterUrl(w.token);
		}
	}

	_filter(q) {
		q = q.trim().toLowerCase();
		const cards = this.grid.querySelectorAll('.cw');
		let shown = 0;
		this.worlds.forEach((w, i) => {
			const hay = `${w.symbol || ''} ${w.token}`.toLowerCase();
			const match = !q || hay.includes(q);
			if (cards[i]) cards[i].style.display = match ? '' : 'none';
			if (match) shown++;
		});
		if (!shown && q) this._noMatch(q);
	}

	_noMatch(q) {
		let n = this.grid.querySelector('.clobby__nomatch');
		if (!n) {
			n = el('div', 'clobby__nomatch');
			this.grid.appendChild(n);
		}
		n.textContent = `No worlds matching “${q}”.`;
	}

	async _load() {
		try {
			this.worlds = await fetchWorlds();
		} catch (err) {
			if (err?.code === 'cc_unconfigured') {
				this._renderState(
					'🔌',
					'Worlds are coming online',
					'CoinCommunities isn’t connected on this deployment yet.',
					null,
				);
			} else {
				this._renderState('⚠️', 'Could not load worlds', err?.message || '', () => {
					this._renderSkeleton();
					this._load();
				});
			}
			return;
		}
		if (!this.worlds.length) {
			this._renderState(
				'🌌',
				'No live worlds yet',
				'Be the first — launch a coin to open its world.',
				null,
			);
			return;
		}
		this.grid.innerHTML = '';
		for (const w of this.worlds) this.grid.appendChild(this._card(w));
	}

	destroy() {
		this.root?.remove();
	}
}

export function mountLobby(opts) {
	return new CoinLobby(opts);
}

const STYLES = `
.clobby{position:fixed;inset:0;z-index:60;overflow-y:auto;
 background:radial-gradient(1200px 700px at 50% -10%,rgba(60,90,200,.22),transparent),
  linear-gradient(180deg,#0a0e1c,#070a16);
 color:#e8eefb;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.clobby__inner{max-width:1080px;margin:0 auto;padding:clamp(28px,6vw,72px) clamp(18px,4vw,40px) 64px}
.clobby__head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:28px}
.clobby__h1{font-size:clamp(26px,4vw,40px);font-weight:760;letter-spacing:-.5px;margin:0 0 6px;
 background:linear-gradient(120deg,#fff,#a9c2ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.clobby__sub{margin:0;color:#93a4cc;max-width:560px}
.clobby__search{flex:0 0 auto;width:min(260px,100%);padding:11px 15px;border-radius:12px;
 background:rgba(255,255,255,.05);border:1px solid rgba(120,150,220,.22);color:#eaf0ff;font:inherit;transition:border-color .2s}
.clobby__search:focus{outline:none;border-color:#5b8cff;background:rgba(255,255,255,.08)}
.clobby__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px}
.cw{position:relative;display:flex;flex-direction:column;gap:6px;padding:16px;border-radius:18px;cursor:pointer;
 text-align:left;color:inherit;font:inherit;
 background:linear-gradient(180deg,rgba(22,30,52,.7),rgba(13,18,34,.8));border:1px solid rgba(120,150,220,.16);
 transition:transform .22s cubic-bezier(.16,1,.3,1),border-color .22s,box-shadow .22s}
.cw:hover{transform:translateY(-4px);border-color:rgba(123,150,255,.5);box-shadow:0 18px 40px rgba(0,0,0,.4)}
.cw:focus-visible{outline:2px solid #5b8cff;outline-offset:3px}
.cw__img{width:100%;aspect-ratio:1;border-radius:13px;overflow:hidden;margin-bottom:4px;
 background:linear-gradient(135deg,#23304f,#16203a);border:1px solid rgba(120,150,220,.14)}
.cw__img img{width:100%;height:100%;object-fit:cover;display:block}
.cw__img--ph{display:grid;place-items:center;font-weight:800;font-size:34px;color:#7d93c8}
.cw__symbol{font-weight:720;font-size:16px;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw__stats{display:flex;align-items:center;gap:6px;font-size:12px;color:#8ea0c6;flex-wrap:wrap}
.cw__dot{opacity:.5}
.cw__enter{margin-top:6px;font-size:13px;font-weight:650;color:#9fc0ff;opacity:0;transform:translateX(-4px);
 transition:opacity .2s,transform .2s}
.cw:hover .cw__enter{opacity:1;transform:translateX(0)}
.clobby__skel{background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.11),rgba(255,255,255,.05));
 background-size:200% 100%;animation:clobby-shimmer 1.3s infinite;border-radius:8px}
.cw__img.clobby__skel{aspect-ratio:1;border-radius:13px}
.clobby__skel--line{height:13px;margin-top:8px;width:80%}.clobby__skel--short{width:50%}
.cw--skel{pointer-events:none}
@keyframes clobby-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.clobby__state,.clobby__nomatch{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;
 gap:8px;text-align:center;padding:64px 24px;color:#93a4cc}
.clobby__state-emoji{font-size:40px}
.clobby__state-title{font-size:19px;font-weight:680;color:#e2e9fb}
.clobby__state-sub{max-width:380px;color:#8093ba}
.clobby__retry{margin-top:10px;padding:10px 20px;border-radius:11px;border:1px solid rgba(120,150,220,.3);
 background:rgba(91,140,255,.16);color:#cfe0ff;cursor:pointer;font-weight:650;transition:background .2s}
.clobby__retry:hover{background:rgba(91,140,255,.28)}
@media (prefers-reduced-motion:reduce){.cw,.cw__enter,.clobby__skel{transition:none;animation:none}}
`;
