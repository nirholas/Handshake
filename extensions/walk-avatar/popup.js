// popup.js — popup controller for the Walk Avatar extension.

const THREEWS = 'https://three.ws';

let state = {
	session: null,
	settings: {},
	selectedAvatarId: '',
	currentTab: null,
	tabEnabled: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
	const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
	if (state.session) headers['Authorization'] = `Bearer ${state.session}`;
	const res = await fetch(`${THREEWS}${path}`, { ...opts, headers });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

function msg(type, data = {}) {
	return chrome.runtime.sendMessage({ type, ...data });
}

// ── Auth ──────────────────────────────────────────────────────────────────
async function renderAuth() {
	const pill = document.getElementById('auth-pill');
	const label = document.getElementById('auth-label');
	const signInBtn = document.getElementById('sign-in-btn');

	if (state.session) {
		try {
			const { user } = await apiFetch('/api/me');
			pill.classList.add('signed-in');
			label.textContent = `@${user.handle || user.email}`;
			signInBtn.textContent = 'Sign out';
			signInBtn.onclick = async () => {
				await msg('clear-session');
				state.session = null;
				renderAuth();
				loadAvatars('mine');
			};
		} catch {
			// Token invalid — clear it
			await msg('clear-session');
			state.session = null;
			renderAuth();
		}
	} else {
		pill.classList.remove('signed-in');
		label.textContent = 'not signed in';
		signInBtn.textContent = 'Sign in';
		signInBtn.onclick = () => {
			chrome.tabs.create({ url: `${THREEWS}/login?redirect=extension` });
		};
	}
}

// ── Avatar grids ──────────────────────────────────────────────────────────
function renderAvatarGrid(gridEl, errorEl, avatars) {
	gridEl.innerHTML = '';
	errorEl.style.display = 'none';

	if (!avatars || avatars.length === 0) {
		gridEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
			No avatars yet. <a href="${THREEWS}/create-selfie" target="_blank">Create one →</a>
		</div>`;
		return;
	}

	avatars.forEach((av) => {
		const thumb = document.createElement('div');
		thumb.className = 'avatar-thumb' + (av.id === state.selectedAvatarId ? ' selected' : '');
		thumb.title = av.name || av.id;

		const img = document.createElement('img');
		img.src = av.thumbnail_url || `${THREEWS}/api/avatars/${av.id}/thumb`;
		img.alt = av.name || 'avatar';
		img.onerror = () => { img.src = `${THREEWS}/public/og-image.png`; };

		thumb.appendChild(img);
		thumb.addEventListener('click', () => {
			state.selectedAvatarId = av.id;
			gridEl.querySelectorAll('.avatar-thumb').forEach(t => t.classList.remove('selected'));
			thumb.classList.add('selected');
			// Persist selection and update active tab
			msg('set-avatar', { avatarId: av.id });
		});

		gridEl.appendChild(thumb);
	});
}

async function loadAvatars(tab) {
	const gridEl = document.getElementById(`grid-${tab}`);
	const errorEl = document.getElementById(`error-${tab}`);

	// Show skeletons
	gridEl.innerHTML = Array.from({ length: 3 }, () =>
		'<div class="avatar-thumb skeleton"></div>'
	).join('');

	try {
		if (tab === 'mine') {
			if (!state.session) {
				gridEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
					<a href="#" id="sign-in-link">Sign in</a> to see your avatars.
				</div>`;
				document.getElementById('sign-in-link')?.addEventListener('click', (e) => {
					e.preventDefault();
					chrome.tabs.create({ url: `${THREEWS}/login?redirect=extension` });
				});
				return;
			}
			const { avatars } = await apiFetch('/api/avatars/mine');
			renderAvatarGrid(gridEl, errorEl, avatars);
		} else {
			const { avatars } = await apiFetch('/api/avatars/featured');
			renderAvatarGrid(gridEl, errorEl, avatars);
		}
	} catch (err) {
		gridEl.innerHTML = '';
		errorEl.textContent = `Failed to load avatars: ${err.message}`;
		errorEl.style.display = 'block';
	}
}

// ── Current tab ───────────────────────────────────────────────────────────
async function initCurrentTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	state.currentTab = tab;

	const siteEl = document.getElementById('current-site');
	if (tab?.url) {
		try {
			siteEl.textContent = new URL(tab.url).hostname;
		} catch {
			siteEl.textContent = tab.url.slice(0, 40);
		}
	}

	// Restore toggle state from session storage (per-tab)
	const stored = await chrome.storage.session.get(`tab_enabled_${tab?.id}`).catch(() => ({}));
	state.tabEnabled = !!stored[`tab_enabled_${tab?.id}`];
	document.getElementById('enable-toggle').checked = state.tabEnabled;
}

// ── Toggle ────────────────────────────────────────────────────────────────
document.getElementById('enable-toggle').addEventListener('change', async (e) => {
	const enabled = e.target.checked;
	state.tabEnabled = enabled;

	if (!state.currentTab) return;

	const key = `tab_enabled_${state.currentTab.id}`;
	chrome.storage.session.set({ [key]: enabled }).catch(() => {});

	await msg('toggle-tab', {
		tabId: state.currentTab.id,
		enabled,
		avatarId: state.selectedAvatarId || state.settings.avatarId,
	});
});

// ── Speed slider ──────────────────────────────────────────────────────────
const speedSlider = document.getElementById('speed-slider');
const speedVal = document.getElementById('speed-val');

speedSlider.addEventListener('input', () => {
	const v = parseFloat(speedSlider.value);
	speedVal.textContent = v.toFixed(1) + '×';
});

speedSlider.addEventListener('change', async () => {
	const v = parseFloat(speedSlider.value);
	await msg('update-settings', { settings: { walkSpeed: v } });
	// Send live update to active tab
	if (state.currentTab) {
		chrome.tabs.sendMessage(state.currentTab.id, {
			type: 'walk:setSpeed',
			speed: v,
		}).catch(() => {});
	}
});

// ── Tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
	btn.addEventListener('click', () => {
		const tab = btn.dataset.tab;
		document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
		document.querySelectorAll('.tab-panel').forEach(p => {
			p.classList.toggle('active', p.id === `tab-${tab}`);
		});
		loadAvatars(tab);
	});
});

// ── Boot ──────────────────────────────────────────────────────────────────
(async () => {
	const { session, settings } = await msg('get-state');
	state.session = session;
	state.settings = settings || {};
	state.selectedAvatarId = state.settings.avatarId || '';

	if (state.settings.walkSpeed) {
		speedSlider.value = String(state.settings.walkSpeed);
		speedVal.textContent = parseFloat(state.settings.walkSpeed).toFixed(1) + '×';
	}

	await Promise.all([
		renderAuth(),
		initCurrentTab(),
		loadAvatars('mine'),
	]);
})();
