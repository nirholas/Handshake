// options.js — full settings page for the Walk Avatar extension.
//
// Every control auto-saves through the background service worker
// (`update-settings`), which persists to chrome.storage.sync (roams across the
// user's Chrome installs) and broadcasts `walk:applySettings` to every tab with
// a mounted avatar — so a change here is live everywhere immediately.
//
// Real APIs:
//   GET  /api/tts/voices   — voices the narrator can actually synthesize
//   GET  /api/avatars      — the signed-in user's avatars (+ featured/public)
//   GET  /api/threews/me   — session identity for the diagnostics panel

const THREEWS = 'https://three.ws';

const state = {
	session: null,
	settings: {},
	avatarTab: 'mine',
	avatarCache: { mine: null, featured: null },
};

// ── Messaging ────────────────────────────────────────────────────────────────
function msg(type, data = {}) {
	return chrome.runtime.sendMessage({ type, ...data });
}

async function persist(partial) {
	await msg('update-settings', { settings: partial });
	state.settings = { ...state.settings, ...partial };
	toast('Saved');
}

async function apiFetch(path) {
	const headers = { Accept: 'application/json' };
	if (state.session) headers['Authorization'] = `Bearer ${state.session}`;
	const res = await fetch(`${THREEWS}${path}`, { headers, credentials: 'include' });
	if (res.status === 401) {
		const err = new Error('unauthorized');
		err.status = 401;
		throw err;
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

function openLogin() {
	chrome.tabs.create({
		url: `${THREEWS}/login?next=${encodeURIComponent('/extension/auth-callback')}`,
	});
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(text, isError = false) {
	const el = document.getElementById('toast');
	document.getElementById('toast-text').textContent = text;
	el.classList.toggle('error', isError);
	el.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

// ── Segmented controls ──────────────────────────────────────────────────────────
function wireSegment(groupId, attr, onChange) {
	const group = document.getElementById(groupId);
	group.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-' + attr + ']');
		if (!btn) return;
		setSegment(groupId, attr, btn.dataset[attr]);
		onChange(btn.dataset[attr]);
	});
}

function setSegment(groupId, attr, value) {
	const group = document.getElementById(groupId);
	for (const btn of group.querySelectorAll('button')) {
		btn.setAttribute('aria-pressed', btn.dataset[attr] === value ? 'true' : 'false');
	}
}

// ── Voices ───────────────────────────────────────────────────────────────────────
async function loadVoices() {
	const select = document.getElementById('opt-voice');
	const sub = document.getElementById('voice-sub');
	try {
		const data = await apiFetch('/api/tts/voices');
		const voices = Array.isArray(data.voices) ? data.voices : [];
		if (voices.length === 0) {
			select.innerHTML = '<option value="">No voices available</option>';
			sub.textContent = 'No synthesis provider is configured right now.';
			return;
		}
		select.innerHTML = '';
		for (const v of voices) {
			const opt = document.createElement('option');
			opt.value = v.id;
			opt.textContent = v.name + (v.description ? ` · ${v.description}` : '');
			select.appendChild(opt);
		}
		select.value = state.settings.voice || data.default || voices[0].id;
		const providers = data.providers || {};
		sub.textContent = data.enabled
			? `${voices.length} voices · ${providers.nvidia ? 'NVIDIA' : 'OpenAI'} synthesis`
			: 'Narration audio is currently unavailable.';
	} catch (err) {
		select.innerHTML = '<option value="">Couldn’t load voices</option>';
		sub.textContent = 'Could not reach the voice catalog. Check your connection.';
	}
}

// ── Avatar picker ────────────────────────────────────────────────────────────────
function avSkeleton(n = 5) {
	return Array.from({ length: n }, () => '<div class="av-thumb skeleton" aria-hidden="true"></div>').join('');
}

function renderAvatarMessage(html) {
	document.getElementById('av-grid').innerHTML = `<div class="av-msg" role="status">${html}</div>`;
}

function renderAvatars(avatars) {
	const grid = document.getElementById('av-grid');
	grid.innerHTML = '';
	for (const av of avatars) {
		const thumb = document.createElement('button');
		thumb.type = 'button';
		thumb.className = 'av-thumb' + (av.id === state.settings.avatarId ? ' selected' : '');
		thumb.title = av.name || 'Avatar';
		thumb.setAttribute('role', 'option');
		thumb.setAttribute('aria-label', `Set default avatar ${av.name || ''}`.trim());
		thumb.setAttribute('aria-selected', av.id === state.settings.avatarId ? 'true' : 'false');

		if (av.thumbnail_url) {
			const img = document.createElement('img');
			img.src = av.thumbnail_url;
			img.alt = av.name || 'avatar';
			img.loading = 'lazy';
			img.addEventListener('error', () => {
				img.remove();
				thumb.classList.add('no-thumb');
				thumb.prepend(glyph(av.name));
			});
			thumb.appendChild(img);
		} else {
			thumb.classList.add('no-thumb');
			thumb.appendChild(glyph(av.name));
		}

		const check = document.createElement('span');
		check.className = 'check';
		check.textContent = '✓';
		thumb.appendChild(check);

		thumb.addEventListener('click', () => selectAvatar(av.id));
		grid.appendChild(thumb);
	}
}

function glyph(name) {
	const span = document.createElement('span');
	span.className = 'glyph';
	span.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
	return span;
}

async function selectAvatar(avatarId) {
	state.settings.avatarId = avatarId;
	// set-avatar persists avatarId and live-swaps it in any mounted iframe.
	await msg('set-avatar', { avatarId });
	// Re-render current tab from cache to refresh the selection ring.
	const cached = state.avatarCache[state.avatarTab];
	if (cached) renderAvatars(cached);
	toast('Default avatar set');
}

async function loadAvatars(tab) {
	state.avatarTab = tab;
	const grid = document.getElementById('av-grid');
	grid.innerHTML = avSkeleton();

	if (!state.session) {
		renderAvatarMessage(`
			<div class="emoji" aria-hidden="true">🔑</div>
			<div class="title">Sign in to choose an avatar</div>
			<p>Your three.ws avatars sync here once you sign in.</p>
			<button class="btn" id="av-signin">Sign in</button>`);
		document.getElementById('av-signin')?.addEventListener('click', openLogin);
		return;
	}

	try {
		const path = tab === 'mine'
			? '/api/avatars?limit=60'
			: '/api/avatars/public?limit=60';
		const body = await apiFetch(path);
		const avatars = (body.avatars || []).filter((a) => a && a.id);
		state.avatarCache[tab] = avatars;

		if (avatars.length === 0) {
			if (tab === 'mine') {
				renderAvatarMessage(`
					<div class="emoji" aria-hidden="true">🚶</div>
					<div class="title">No avatars yet</div>
					<p>Create a 3D avatar from a selfie, then set it as your default companion.</p>
					<button class="btn" id="av-create">Create your first avatar</button>`);
				document.getElementById('av-create')?.addEventListener('click', () => {
					chrome.tabs.create({ url: `${THREEWS}/create-selfie` });
				});
			} else {
				renderAvatarMessage(`
					<div class="emoji" aria-hidden="true">✨</div>
					<div class="title">No featured avatars right now</div>
					<p>Check back soon, or browse the gallery.</p>
					<button class="btn ghost" id="av-gallery">Open gallery</button>`);
				document.getElementById('av-gallery')?.addEventListener('click', () => {
					chrome.tabs.create({ url: `${THREEWS}/gallery` });
				});
			}
			return;
		}
		renderAvatars(avatars);
	} catch (err) {
		if (err.status === 401) {
			await msg('clear-session');
			state.session = null;
			renderDiagnostics();
			loadAvatars(tab);
			return;
		}
		renderAvatarMessage(`
			<div class="emoji" aria-hidden="true">⚠️</div>
			<div class="title">Couldn’t load avatars</div>
			<p>${err.message}</p>
			<button class="btn ghost" id="av-retry">Retry</button>`);
		document.getElementById('av-retry')?.addEventListener('click', () => loadAvatars(tab));
	}
}

// ── Diagnostics ──────────────────────────────────────────────────────────────────
async function renderDiagnostics() {
	const sessionEl = document.getElementById('diag-session');
	const accountEl = document.getElementById('diag-account');
	const signOutBtn = document.getElementById('sign-out-btn');

	if (!state.session) {
		sessionEl.textContent = 'not signed in';
		sessionEl.className = 'diag-value offline';
		accountEl.textContent = 'none';
		signOutBtn.classList.add('hidden');
		return;
	}

	sessionEl.textContent = 'signed in';
	sessionEl.className = 'diag-value online';
	signOutBtn.classList.remove('hidden');

	try {
		const body = await apiFetch('/api/threews/me');
		const user = body?.data?.user || body?.user || {};
		accountEl.textContent = user.username ? `@${user.username}` : (user.display_name || 'signed in');
	} catch (err) {
		if (err.status === 401) {
			await msg('clear-session');
			state.session = null;
			renderDiagnostics();
			return;
		}
		accountEl.textContent = 'unavailable';
	}
}

// ── Populate controls from stored settings ──────────────────────────────────────
function applySettingsToUI(s) {
	document.getElementById('opt-position').value = s.position || 'bottom-right';

	const sizePreset = s.sizePreset || 'medium';
	setSegment('opt-size', 'size', sizePreset);
	document.getElementById('custom-size-row').classList.toggle('hidden', sizePreset !== 'custom');
	document.getElementById('opt-width').value = String(s.width || 180);
	document.getElementById('opt-height').value = String(s.height || 260);

	const speed = s.walkSpeed || 1;
	document.getElementById('opt-speed').value = String(speed);
	document.getElementById('opt-speed-val').textContent = parseFloat(speed).toFixed(1) + '×';

	setSegment('opt-theme', 'theme', s.theme || 'auto');

	document.getElementById('opt-narration').checked = !!s.narrationEnabled;
	if (s.voice) document.getElementById('opt-voice').value = s.voice;

	document.getElementById('opt-allowlist').value = (s.siteAllowlist || []).join('\n');
	document.getElementById('opt-blocklist').value = (s.siteBlocklist || []).join('\n');
	updateFiltersNote();
}

function parseDomainList(textareaId) {
	return document.getElementById(textareaId).value
		.split('\n')
		.map((l) => l.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
		.filter(Boolean);
}

function updateFiltersNote() {
	const allow = parseDomainList('opt-allowlist');
	const block = parseDomainList('opt-blocklist');
	const note = document.getElementById('filters-note');
	if (allow.length === 0 && block.length === 0) {
		note.textContent = 'Avatar can appear on every site.';
	} else if (allow.length > 0) {
		note.textContent = `Restricted to ${allow.length} site${allow.length > 1 ? 's' : ''}` +
			(block.length ? `, ${block.length} blocked.` : '.');
	} else {
		note.textContent = `${block.length} site${block.length > 1 ? 's' : ''} blocked.`;
	}
}

// ── Wiring ───────────────────────────────────────────────────────────────────────
function wireControls() {
	// Position
	document.getElementById('opt-position').addEventListener('change', (e) => {
		persist({ position: e.target.value });
	});

	// Size preset
	wireSegment('opt-size', 'size', (size) => {
		document.getElementById('custom-size-row').classList.toggle('hidden', size !== 'custom');
		persist({ sizePreset: size });
	});

	// Custom dimensions
	const clampDim = (v, lo, hi, dflt) => {
		const n = parseInt(v, 10);
		if (Number.isNaN(n)) return dflt;
		return Math.max(lo, Math.min(hi, n));
	};
	document.getElementById('opt-width').addEventListener('change', (e) => {
		const w = clampDim(e.target.value, 80, 600, 180);
		e.target.value = String(w);
		persist({ width: w });
	});
	document.getElementById('opt-height').addEventListener('change', (e) => {
		const h = clampDim(e.target.value, 120, 800, 260);
		e.target.value = String(h);
		persist({ height: h });
	});

	// Walk speed — live label on input, persist on release
	const speed = document.getElementById('opt-speed');
	speed.addEventListener('input', () => {
		document.getElementById('opt-speed-val').textContent = parseFloat(speed.value).toFixed(1) + '×';
	});
	speed.addEventListener('change', () => persist({ walkSpeed: parseFloat(speed.value) }));

	// Theme
	wireSegment('opt-theme', 'theme', (theme) => persist({ theme }));

	// Narration toggle
	document.getElementById('opt-narration').addEventListener('change', (e) => {
		persist({ narrationEnabled: e.target.checked });
	});

	// Voice
	document.getElementById('opt-voice').addEventListener('change', (e) => {
		if (e.target.value) persist({ voice: e.target.value });
	});

	// Site filters — live note, explicit apply (so a half-typed domain isn't saved)
	document.getElementById('opt-allowlist').addEventListener('input', updateFiltersNote);
	document.getElementById('opt-blocklist').addEventListener('input', updateFiltersNote);
	document.getElementById('save-filters-btn').addEventListener('click', () => {
		const siteAllowlist = parseDomainList('opt-allowlist');
		const siteBlocklist = parseDomainList('opt-blocklist');
		document.getElementById('opt-allowlist').value = siteAllowlist.join('\n');
		document.getElementById('opt-blocklist').value = siteBlocklist.join('\n');
		persist({ siteAllowlist, siteBlocklist });
		updateFiltersNote();
	});

	// Avatar tabs
	document.querySelectorAll('.av-tab').forEach((btn) => {
		btn.addEventListener('click', () => {
			document.querySelectorAll('.av-tab').forEach((b) => {
				const on = b === btn;
				b.classList.toggle('active', on);
				b.setAttribute('aria-selected', on ? 'true' : 'false');
			});
			loadAvatars(btn.dataset.tab);
		});
	});

	// Reset
	document.getElementById('reset-btn').addEventListener('click', async () => {
		const ok = confirm('Reset all Walk Avatar settings to their defaults? Your sign-in stays active.');
		if (!ok) return;
		const res = await msg('reset-settings');
		state.settings = res?.settings || {};
		applySettingsToUI(state.settings);
		if (state.settings.voice) document.getElementById('opt-voice').value = state.settings.voice;
		// Refresh the avatar selection ring (avatarId is cleared by reset).
		const cached = state.avatarCache[state.avatarTab];
		if (cached) renderAvatars(cached);
		toast('Settings reset to defaults');
	});

	// Sign out
	document.getElementById('sign-out-btn').addEventListener('click', async () => {
		await msg('clear-session');
		state.session = null;
		state.avatarCache = { mine: null, featured: null };
		renderDiagnostics();
		loadAvatars(state.avatarTab);
		toast('Signed out');
	});

	// Docs / version
	document.getElementById('diag-version').textContent = chrome.runtime.getManifest().version;
}

// React to a sign-in completing in another tab while this page is open.
chrome.runtime.onMessage.addListener((m) => {
	if (m.type === 'session-updated' && m.token) {
		state.session = m.token;
		state.avatarCache = { mine: null, featured: null };
		renderDiagnostics();
		loadAvatars(state.avatarTab);
	}
});

// ── Boot ─────────────────────────────────────────────────────────────────────────
(async () => {
	wireControls();

	const { session, settings } = await msg('get-state');
	state.session = session || null;
	state.settings = settings || {};

	applySettingsToUI(state.settings);

	await Promise.all([
		loadVoices(),
		loadAvatars('mine'),
		renderDiagnostics(),
	]);
})();
