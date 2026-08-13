// popup.js — controller for the Walk Avatar popup.
//
// Real three.ws API (no placeholders, no sample data):
//   GET  /api/me                  — signed-in identity (handle shown in the pill)
//   GET  /api/avatars/mine        — the caller's avatars (Bearer, avatars:read)
//   GET  /api/avatars/featured    — curated + popular public avatars
//   GET  /api/avatars/:id/thumb   — poster JPG/PNG (used directly as <img src>)
//
// Auth: the popup opens three.ws/login?next=/extension/auth-callback. The site
// mints a Bearer token there and the background worker captures it from the
// callback URL into chrome.storage.local.threews_session. The "Recent" tab is
// the avatars the user has picked here, kept in chrome.storage.local.

const THREEWS = 'https://three.ws';
const RECENT_KEY = 'recentAvatars';
const SELECTION_KEY = 'walk_selection';
const MAX_RECENT = 12;

const state = {
	session: null,
	settings: {},
	selectedAvatarId: '',
	currentTab: null,
	tabEnabled: false,
	activeTab: 'mine',
	// id -> avatar object, so the Recent tab and re-selection can render without
	// a refetch and we can snapshot picks into chrome.storage.local.
	cache: new Map(),
};

// ── API ─────────────────────────────────────────────────────────────────────
async function apiFetch(path) {
	const headers = { Accept: 'application/json' };
	if (state.session) headers['Authorization'] = `Bearer ${state.session}`;
	const res = await fetch(`${THREEWS}${path}`, { headers, credentials: 'include' });
	if (res.status === 401) {
		const err = new Error('session expired');
		err.status = 401;
		throw err;
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

function msg(type, data = {}) {
	return chrome.runtime.sendMessage({ type, ...data });
}

function openLogin() {
	chrome.tabs.create({
		url: `${THREEWS}/login?next=${encodeURIComponent('/extension/auth-callback')}`,
	});
}

function thumbUrl(av) {
	return av.thumb_url || `${THREEWS}/api/avatars/${av.id}/thumb`;
}

// ── Auth header ───────────────────────────────────────────────────────────────
async function renderAuth() {
	const pill = document.getElementById('auth-pill');
	const label = document.getElementById('auth-label');
	const avatarChip = document.getElementById('auth-avatar');
	const signInBtn = document.getElementById('sign-in-btn');

	if (state.session) {
		try {
			const body = await apiFetch('/api/me');
			const user = body?.user || {};
			pill.classList.add('signed-in');
			label.textContent =
				user.handle || (user.username ? `@${user.username}` : user.display_name || 'signed in');
			if (user.avatar_url) {
				avatarChip.src = user.avatar_url;
				avatarChip.onerror = () => avatarChip.removeAttribute('src');
			} else {
				avatarChip.removeAttribute('src');
			}
			signInBtn.textContent = 'Sign out';
			signInBtn.onclick = async () => {
				await msg('clear-session');
				state.session = null;
				avatarChip.removeAttribute('src');
				renderAuth();
				loadAvatars(state.activeTab);
			};
			return;
		} catch (err) {
			if (err.status === 401) {
				await msg('clear-session');
				state.session = null;
			}
		}
	}

	pill.classList.remove('signed-in');
	avatarChip.removeAttribute('src');
	label.textContent = 'not signed in';
	signInBtn.textContent = 'Sign in';
	signInBtn.onclick = openLogin;
}

// ── Avatar grids ──────────────────────────────────────────────────────────────
function skeleton(n = 6) {
	return Array.from(
		{ length: n },
		() => '<div class="avatar-thumb skeleton" aria-hidden="true"></div>',
	).join('');
}

function renderEmpty(gridEl, tab) {
	if (tab === 'mine') {
		gridEl.innerHTML = `
			<div class="empty-state" role="status">
				<div class="empty-emoji" aria-hidden="true">🚶</div>
				<div class="empty-title">No avatars yet</div>
				<p class="empty-sub">Create a 3D avatar from a selfie, then walk it on any site.</p>
				<button class="cta-btn" id="create-cta">Create your first avatar</button>
			</div>`;
		gridEl.querySelector('#create-cta')?.addEventListener('click', () => {
			chrome.tabs.create({ url: `${THREEWS}/create-selfie` });
		});
	} else if (tab === 'recent') {
		gridEl.innerHTML = `
			<div class="empty-state" role="status">
				<div class="empty-emoji" aria-hidden="true">🕘</div>
				<div class="empty-title">No recent picks</div>
				<p class="empty-sub">Avatars you choose here show up in this tab so you can switch back fast.</p>
			</div>`;
	} else {
		gridEl.innerHTML = `
			<div class="empty-state" role="status">
				<div class="empty-emoji" aria-hidden="true">✨</div>
				<div class="empty-title">No featured avatars right now</div>
				<p class="empty-sub">Check back soon, or browse the gallery.</p>
				<button class="cta-btn ghost" id="gallery-cta">Open gallery</button>
			</div>`;
		gridEl.querySelector('#gallery-cta')?.addEventListener('click', () => {
			chrome.tabs.create({ url: `${THREEWS}/gallery` });
		});
	}
}

function renderError(gridEl, errorEl, tab, message) {
	gridEl.innerHTML = '';
	errorEl.innerHTML = `
		<span class="err-text">Couldn't load avatars: ${message}</span>
		<button class="retry-btn" id="retry-${tab}">Retry</button>`;
	errorEl.style.display = 'flex';
	errorEl.querySelector(`#retry-${tab}`)?.addEventListener('click', () => loadAvatars(tab));
}

function fallbackGlyph(name) {
	const span = document.createElement('span');
	span.className = 'thumb-glyph';
	span.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
	return span;
}

function renderAvatarGrid(gridEl, avatars) {
	gridEl.innerHTML = '';
	for (const av of avatars) {
		state.cache.set(av.id, av);

		const thumb = document.createElement('button');
		thumb.className = 'avatar-thumb' + (av.id === state.selectedAvatarId ? ' selected' : '');
		thumb.type = 'button';
		thumb.title = av.name || 'Avatar';
		thumb.setAttribute('aria-label', `Select avatar ${av.name || ''}`.trim());
		thumb.setAttribute('aria-pressed', av.id === state.selectedAvatarId ? 'true' : 'false');

		if (av.featured) {
			const badge = document.createElement('span');
			badge.className = 'thumb-badge';
			badge.textContent = 'Featured';
			thumb.appendChild(badge);
		}

		// has_thumbnail === false means the poster endpoint would 404 — skip the
		// round trip and render the initial glyph straight away.
		if (av.has_thumbnail === false) {
			thumb.classList.add('no-thumb');
			thumb.appendChild(fallbackGlyph(av.name));
		} else {
			const img = document.createElement('img');
			img.src = thumbUrl(av);
			img.alt = av.name || 'avatar';
			img.loading = 'lazy';
			img.addEventListener('error', () => {
				img.remove();
				thumb.classList.add('no-thumb');
				thumb.appendChild(fallbackGlyph(av.name));
			});
			thumb.appendChild(img);
		}

		thumb.addEventListener('click', () => selectAvatar(av, thumb));
		gridEl.appendChild(thumb);
	}
}

// ── Selection ─────────────────────────────────────────────────────────────────
async function selectAvatar(av, thumbEl) {
	const avatarId = av.id;
	state.selectedAvatarId = avatarId;

	// Reflect selection across the whole popup (all three grids).
	for (const t of document.querySelectorAll('.avatar-thumb')) {
		const on = t === thumbEl;
		t.classList.toggle('selected', on);
		t.setAttribute('aria-pressed', on ? 'true' : 'false');
	}

	// 1) Persist the picker selection in the shape the rest of the extension reads.
	await persistSelection();

	// 2) Remember it as a "recent" pick for the Recent tab.
	await pushRecent(av);

	// 3) Background relay updates the synced default + broadcasts a live swap to
	//    every mounted tab; also message the current tab directly so the swap is
	//    instant even if the broadcast races.
	await msg('set-avatar', { avatarId });
	if (state.currentTab?.id != null) {
		chrome.tabs
			.sendMessage(state.currentTab.id, { type: 'walk:setAvatar', avatarId })
			.catch(() => {});
	}
}

// ── Recent tab (client-side, real picks) ───────────────────────────────────────
async function getRecent() {
	const out = await chrome.storage.local.get(RECENT_KEY).catch(() => ({}));
	return Array.isArray(out[RECENT_KEY]) ? out[RECENT_KEY] : [];
}

async function pushRecent(av) {
	const slim = {
		id: av.id,
		name: av.name || 'Avatar',
		thumb_url: thumbUrl(av),
		has_thumbnail: av.has_thumbnail !== false,
		featured: !!av.featured,
	};
	const existing = (await getRecent()).filter((a) => a && a.id && a.id !== av.id);
	const next = [slim, ...existing].slice(0, MAX_RECENT);
	await chrome.storage.local.set({ [RECENT_KEY]: next }).catch(() => {});
}

async function loadAvatars(tab) {
	state.activeTab = tab;
	const gridEl = document.getElementById(`grid-${tab}`);
	const errorEl = document.getElementById(`error-${tab}`);
	errorEl.style.display = 'none';

	// Recent is local — no network, no skeleton flash.
	if (tab === 'recent') {
		const recent = await getRecent();
		recent.forEach((a) => state.cache.set(a.id, a));
		if (recent.length === 0) return renderEmpty(gridEl, tab);
		return renderAvatarGrid(gridEl, recent);
	}

	gridEl.innerHTML = skeleton();

	try {
		if (tab === 'mine' && !state.session) {
			gridEl.innerHTML = `
				<div class="empty-state" role="status">
					<div class="empty-emoji" aria-hidden="true">🔑</div>
					<div class="empty-title">Sign in to see your avatars</div>
					<p class="empty-sub">Your three.ws avatars sync here once you sign in.</p>
					<button class="cta-btn" id="signin-cta">Sign in</button>
				</div>`;
			gridEl.querySelector('#signin-cta')?.addEventListener('click', openLogin);
			return;
		}

		const path =
			tab === 'mine' ? '/api/avatars/mine?limit=60' : '/api/avatars/featured?limit=48';
		const body = await apiFetch(path);
		const avatars = (body.avatars || []).filter((a) => a && a.id);

		if (avatars.length === 0) return renderEmpty(gridEl, tab);
		renderAvatarGrid(gridEl, avatars);
	} catch (err) {
		if (err.status === 401) {
			await msg('clear-session');
			state.session = null;
			renderAuth();
			loadAvatars(tab);
			return;
		}
		renderError(gridEl, errorEl, tab, err.message);
	}
}

// ── Current tab ────────────────────────────────────────────────────────────────
async function initCurrentTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	state.currentTab = tab;

	const siteEl = document.getElementById('current-site');
	const toggle = document.getElementById('enable-toggle');

	const restricted = !tab?.url || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url);
	if (restricted) {
		siteEl.textContent = 'unavailable on this page';
		toggle.disabled = true;
		toggle.closest('.footer')?.classList.add('disabled');
		return;
	}

	let host = tab.url;
	try {
		host = new URL(tab.url).hostname;
	} catch {}
	siteEl.textContent = host;

	// Per-tab enable state is kept in session storage, set when the popup toggles.
	const key = `tab_enabled_${tab.id}`;
	const stored = await chrome.storage.session.get(key).catch(() => ({}));
	state.tabEnabled = !!stored[key];
	toggle.checked = state.tabEnabled;

	// Surface allow/blocklist filtering so the user knows why a toggle is a no-op.
	const { allowed } = await msg('check-site', { url: tab.url }).catch(() => ({ allowed: true }));
	if (!allowed) {
		siteEl.innerHTML = `${host} <span class="filtered-tag">filtered</span>`;
	}
}

// ── Toggle ──────────────────────────────────────────────────────────────────────
document.getElementById('enable-toggle').addEventListener('change', async (e) => {
	const enabled = e.target.checked;
	if (!state.currentTab) return;

	const key = `tab_enabled_${state.currentTab.id}`;
	const res = await msg('toggle-tab', {
		tabId: state.currentTab.id,
		enabled,
		avatarId: state.selectedAvatarId || state.settings.avatarId,
	});

	if (enabled && res && res.ok === false) {
		// Site filtered or injection blocked — revert the switch and explain.
		e.target.checked = false;
		const siteEl = document.getElementById('current-site');
		siteEl.innerHTML = `${siteEl.textContent} <span class="filtered-tag">${res.reason || res.error}</span>`;
		await chrome.storage.session.set({ [key]: false }).catch(() => {});
		state.tabEnabled = false;
		await persistSelection();
		return;
	}

	state.tabEnabled = enabled;
	await chrome.storage.session.set({ [key]: enabled }).catch(() => {});
	await persistSelection();
});

// ── Speed slider ──────────────────────────────────────────────────────────────
const speedSlider = document.getElementById('speed-slider');
const speedVal = document.getElementById('speed-val');

function currentSpeed() {
	return parseFloat(speedSlider.value) || 1;
}

async function persistSelection() {
	await chrome.storage.local
		.set({
			[SELECTION_KEY]: {
				avatarId: state.selectedAvatarId || state.settings.avatarId || '',
				walkSpeed: currentSpeed(),
				enabled: state.tabEnabled,
			},
		})
		.catch(() => {});
}

// Throttle live speed broadcasts so dragging the slider stays smooth.
let speedThrottle = null;
speedSlider.addEventListener('input', () => {
	speedVal.textContent = currentSpeed().toFixed(1) + '×';
	if (speedThrottle) return;
	speedThrottle = setTimeout(() => {
		speedThrottle = null;
		msg('update-settings', { settings: { walkSpeed: currentSpeed() } });
	}, 150);
});

speedSlider.addEventListener('change', async () => {
	if (speedThrottle) {
		clearTimeout(speedThrottle);
		speedThrottle = null;
	}
	await msg('update-settings', { settings: { walkSpeed: currentSpeed() } });
	await persistSelection();
});

// ── Tab bar ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
	btn.addEventListener('click', () => {
		const tab = btn.dataset.tab;
		document.querySelectorAll('.tab-btn').forEach((b) => {
			const on = b === btn;
			b.classList.toggle('active', on);
			b.setAttribute('aria-selected', on ? 'true' : 'false');
		});
		document.querySelectorAll('.tab-panel').forEach((p) => {
			p.classList.toggle('active', p.id === `tab-${tab}`);
		});
		loadAvatars(tab);
	});
});

// Open the full settings page.
document.getElementById('settings-link').addEventListener('click', (e) => {
	e.preventDefault();
	chrome.runtime.openOptionsPage();
});

// React to the session token arriving from the auth-callback tab while the
// popup is still open.
chrome.runtime.onMessage.addListener((m) => {
	if (m.type === 'session-updated' && m.token) {
		state.session = m.token;
		renderAuth();
		loadAvatars(state.activeTab);
	}
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
	const { session, settings } = await msg('get-state');
	state.session = session;
	state.settings = settings || {};
	state.selectedAvatarId = state.settings.avatarId || '';

	const speed = state.settings.walkSpeed || 1;
	speedSlider.value = String(speed);
	speedVal.textContent = parseFloat(speed).toFixed(1) + '×';

	await Promise.all([renderAuth(), initCurrentTab(), loadAvatars('mine')]);
})();
