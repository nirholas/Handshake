// Standalone "Launch a Coin" experience for /launch.
//
// Reuses the real, production launch flow from /studio/launch-panel.js
// (metadata upload → on-chain prep → wallet signing → confirmation polling,
// vanity-mint grinding, agent-wallet or connected-wallet funding). This page
// only adds the surrounding chrome: an agent picker that decides which avatar
// the coin is minted for, plus loading / empty / signed-out states. The panel
// owns everything else.
//
// A coin on three.ws is always launched *for* an agent, so the panel refuses
// to mint without a real (non-demo) avatar selected. When the visitor is
// signed out or has no avatars, getAvatar() returns null and the panel renders
// its own guided onboarding (which links to the agent builder).

import { mountLaunchPanel } from '/studio/launch-panel.js';

const PICKER_CSS = `
.lc-shell{display:grid;grid-template-columns:minmax(0,300px) minmax(0,440px);gap:1.5rem;
  align-items:start;justify-content:center;max-width:780px;margin:0 auto;padding:1rem}
@media (max-width:760px){.lc-shell{grid-template-columns:1fr;gap:1.1rem;padding:.5rem}}

.lc-col-h{font-size:.72rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:rgba(255,255,255,.4);margin:0 0 .65rem}
.lc-pick{display:flex;flex-direction:column;gap:.4rem;position:sticky;top:1rem}
@media (max-width:760px){.lc-pick{position:static}}

.lc-card{display:flex;align-items:center;gap:.7rem;padding:.55rem .65rem;border-radius:11px;
  cursor:pointer;text-align:left;width:100%;background:rgba(255,255,255,.025);
  border:1px solid rgba(255,255,255,.07);color:#fff;transition:all .15s;font:inherit}
.lc-card:hover:not(.on){background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.14)}
.lc-card.on{background:rgba(164,240,188,.08);border-color:rgba(164,240,188,.34);
  box-shadow:0 0 0 1px rgba(164,240,188,.12)}
.lc-card:focus-visible{outline:2px solid rgba(164,240,188,.6);outline-offset:2px}
.lc-thumb{width:42px;height:42px;border-radius:9px;object-fit:cover;flex-shrink:0;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08)}
.lc-thumb-ph{width:42px;height:42px;border-radius:9px;flex-shrink:0;display:flex;
  align-items:center;justify-content:center;font-size:1.15rem;font-weight:700;
  color:rgba(164,240,188,.7);background:rgba(164,240,188,.08);border:1px solid rgba(164,240,188,.16)}
.lc-meta{min-width:0;flex:1}
.lc-name{font-size:.86rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lc-sub{font-size:.68rem;color:rgba(255,255,255,.4);margin-top:.12rem;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.lc-coined{flex-shrink:0;font-size:.6rem;font-weight:600;letter-spacing:.04em;color:#a4f0bc;
  background:rgba(164,240,188,.1);border:1px solid rgba(164,240,188,.22);border-radius:6px;
  padding:.18rem .4rem}

.lc-skel{height:56px;border-radius:11px;background:linear-gradient(100deg,
  rgba(255,255,255,.03) 30%,rgba(255,255,255,.07) 50%,rgba(255,255,255,.03) 70%);
  background-size:200% 100%;animation:lc-shimmer 1.3s linear infinite}
@keyframes lc-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

.lc-pick-cta{margin-top:.35rem;display:flex;align-items:center;justify-content:center;
  min-height:44px;box-sizing:border-box;text-align:center;padding:.55rem;border-radius:9px;
  font-size:.78rem;text-decoration:none;color:rgba(255,255,255,.5);background:rgba(255,255,255,.025);
  border:1px dashed rgba(255,255,255,.12);transition:all .15s}
.lc-pick-cta:hover{color:rgba(164,240,188,.85);border-color:rgba(164,240,188,.3);
  background:rgba(164,240,188,.05)}
.lc-pick-cta:focus-visible,.lc-cta-primary:focus-visible{outline:2px solid rgba(164,240,188,.6);outline-offset:2px}

.lc-cta-primary{display:flex;align-items:center;justify-content:center;min-height:44px;
  box-sizing:border-box;padding:.6rem .8rem;border-radius:9px;font-size:.82rem;font-weight:500;
  text-decoration:none;text-align:center;color:rgba(164,240,188,.9);
  background:rgba(164,240,188,.08);border:1px solid rgba(164,240,188,.26);
  transition:background .15s,border-color .15s,color .15s}
.lc-cta-primary:hover{background:rgba(164,240,188,.14);border-color:rgba(164,240,188,.42);color:#c8f0d8}

.lc-count{margin-left:.45rem;font-weight:600;color:rgba(164,240,188,.6)}

.lc-signin{font-size:.74rem;color:rgba(255,255,255,.45);line-height:1.55;padding:.6rem .7rem;
  border-radius:9px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07)}
.lc-signin a{color:rgba(164,240,188,.8);text-decoration:none}
.lc-signin a:hover{color:#a4f0bc}

@media (prefers-reduced-motion:reduce){
  .lc-skel{animation:none;background:rgba(255,255,255,.045)}
  .lc-card,.lc-pick-cta,.lc-cta-primary{transition:none}
}
`;

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const state = { user: null, avatars: [], avatarId: null, loading: true };
let launchPanel = null;
let pickerEl = null;

function currentAvatar() {
	return state.avatars.find((a) => a.id === state.avatarId) || null;
}

async function fetchMe() {
	try {
		const res = await fetch('/api/auth/me', { credentials: 'include' });
		if (!res.ok) return null;
		const { user } = await res.json();
		return user || null;
	} catch {
		return null;
	}
}

async function fetchAvatars() {
	try {
		const res = await fetch('/api/avatars?limit=100', { credentials: 'include' });
		if (!res.ok) return [];
		const { avatars = [] } = await res.json();
		return avatars;
	} catch {
		return [];
	}
}

function renderPicker() {
	if (!pickerEl) return;

	if (state.loading) {
		pickerEl.innerHTML =
			'<p class="lc-col-h">Choose your agent</p>' +
			Array(3).fill('<div class="lc-skel"></div>').join('');
		return;
	}

	// Signed out, or signed in with no avatars: let the panel's guided state
	// lead; the picker names the exact next action with a real CTA.
	if (!state.avatars.length) {
		pickerEl.innerHTML =
			'<p class="lc-col-h">Choose your agent</p>' +
			(state.user
				? '<div class="lc-signin">No agents yet. A coin always launches for one of your agents, so create one first (it takes about a minute).</div>' +
				  '<a class="lc-cta-primary" href="/create-agent">+ Create your first agent</a>'
				: '<div class="lc-signin">A coin launches for one of your agents. Sign in to pick one, or create a new agent first.</div>' +
				  '<a class="lc-cta-primary" href="/login?next=/launch">Sign in to pick an agent</a>' +
				  '<a class="lc-pick-cta" href="/create-agent">+ Create an agent</a>');
		return;
	}

	const cards = state.avatars
		.map((a) => {
			const on = a.id === state.avatarId;
			const thumb = a.thumbnail_url
				? `<img class="lc-thumb" src="${esc(a.thumbnail_url)}" alt="" loading="lazy" />`
				: `<span class="lc-thumb-ph" aria-hidden="true">${esc((a.name || 'A').trim().charAt(0).toUpperCase())}</span>`;
			const sub = a.slug ? `@${esc(a.slug)}` : esc((a.description || '').slice(0, 40));
			return (
				`<button type="button" class="lc-card${on ? ' on' : ''}" data-id="${esc(a.id)}" ` +
				`aria-pressed="${on}">${thumb}` +
				`<span class="lc-meta"><span class="lc-name">${esc(a.name || 'Untitled agent')}</span>` +
				`<span class="lc-sub">${sub}</span></span></button>`
			);
		})
		.join('');

	pickerEl.innerHTML =
		`<p class="lc-col-h">Choose your agent<span class="lc-count">${state.avatars.length}</span></p>` +
		cards +
		'<a class="lc-pick-cta" href="/create-agent">+ New agent</a>';

	const cardEls = [...pickerEl.querySelectorAll('.lc-card')];
	cardEls.forEach((btn, i) => {
		btn.addEventListener('click', () => selectAvatar(btn.dataset.id));
		// Arrow-key movement between agent cards (wraps at the ends).
		btn.addEventListener('keydown', (e) => {
			let to = null;
			if (e.key === 'ArrowDown' || e.key === 'ArrowRight')    to = cardEls[(i + 1) % cardEls.length];
			else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')  to = cardEls[(i - 1 + cardEls.length) % cardEls.length];
			else if (e.key === 'Home')                              to = cardEls[0];
			else if (e.key === 'End')                               to = cardEls[cardEls.length - 1];
			if (to) { e.preventDefault(); to.focus(); }
		});
	});

	// A dead thumbnail URL must never show a broken-image icon: swap it for
	// the same initial placeholder the no-thumbnail case uses.
	for (const img of pickerEl.querySelectorAll('img.lc-thumb')) {
		img.addEventListener('error', () => {
			const name = img.closest('.lc-card')?.querySelector('.lc-name')?.textContent || 'A';
			const ph = document.createElement('span');
			ph.className = 'lc-thumb-ph';
			ph.setAttribute('aria-hidden', 'true');
			ph.textContent = (name.trim().charAt(0) || 'A').toUpperCase();
			img.replaceWith(ph);
		}, { once: true });
	}
}

function selectAvatar(id) {
	if (id === state.avatarId) return;
	// Re-rendering replaces the focused card; put focus back on the newly
	// selected one so keyboard flow is unbroken.
	const hadFocus = pickerEl?.contains(document.activeElement);
	state.avatarId = id;
	renderPicker();
	if (hadFocus) pickerEl.querySelector(`.lc-card[data-id="${CSS.escape(id)}"]`)?.focus();
	launchPanel?.avatarChanged();
}

export function mountLaunchCoin(root) {
	if (!document.getElementById('lc-css')) {
		const style = document.createElement('style');
		style.id = 'lc-css';
		style.textContent = PICKER_CSS;
		document.head.appendChild(style);
	}

	root.innerHTML =
		'<div class="lc-shell">' +
		'<aside class="lc-pick" id="lc-picker"></aside>' +
		'<div id="lc-panel"></div>' +
		'</div>';

	pickerEl = root.querySelector('#lc-picker');
	const panelEl = root.querySelector('#lc-panel');

	renderPicker();

	// Deep-link prefill — a token-launchpad page (/p/<slug>) hands the visitor
	// here with the coin's configured name, symbol, description, image, and
	// initial buy so the launch form opens ready to go instead of blank.
	const params = new URL(location.href).searchParams;
	// ?imageSession=1 pulls the token image out of sessionStorage instead of a
	// URL: the /viewer "Launch a coin" funnel snapshots the 3D model to a data
	// URL, which is far too long to survive as a query param. The key is left
	// in place so a refresh keeps the prefill (sessionStorage is tab-scoped).
	let prefillImage = params.get('image') || '';
	if (!prefillImage && params.get('imageSession')) {
		try {
			const stored = sessionStorage.getItem('twx.launch.image') || '';
			if (stored.startsWith('data:image/')) prefillImage = stored;
		} catch { /* storage blocked: launch still works, user uploads an image */ }
	}
	const prefill = {
		name: params.get('name') || '',
		symbol: params.get('symbol') || '',
		description: params.get('description') || '',
		imageUrl: prefillImage,
		initialBuy: params.get('initialBuy') || '',
	};
	const hasPrefill = Object.values(prefill).some(Boolean);

	launchPanel = mountLaunchPanel(panelEl, {
		getAvatar: () => currentAvatar(),
		getUser: () => state.user,
		context: 'launch',
		prefill: hasPrefill ? prefill : null,
	});

	(async function boot() {
		const user = await fetchMe();
		state.user = user;
		const avatars = user ? await fetchAvatars() : [];
		state.avatars = avatars;

		// Honor ?avatar=<id|slug> deep links (e.g. from an agent profile), else
		// default to the first agent so the form is immediately usable.
		const wanted = new URL(location.href).searchParams.get('avatar');
		const match =
			(wanted && avatars.find((a) => a.id === wanted || a.slug === wanted)) || avatars[0] || null;
		state.avatarId = match?.id || null;
		state.loading = false;

		renderPicker();
		launchPanel?.avatarChanged();
	})();

	return {
		teardown() {
			launchPanel?.teardown();
			launchPanel = null;
			root.innerHTML = '';
		},
	};
}
