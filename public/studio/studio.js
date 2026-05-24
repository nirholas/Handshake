// Widget Studio — three-column UI for creating + editing widgets.
// Native DOM, no framework. Uses /api/widgets and /api/avatars.
//
// Type registry is inlined here (rather than imported from /src/) because
// /public/* is served verbatim by Vercel — the build doesn't transform it.
// Keep this list in sync with src/widget-types.js as new types light up.

import { mountLaunchPanel } from './launch-panel.js';
import { mountKnowledgePanel } from './knowledge-panel.js';

const WIDGET_TYPES = {
	turntable: {
		label: 'Turntable Showcase',
		desc: 'Hero banner — auto-rotate, no UI, just the avatar.',
		status: 'ready',
		icon: '◎',
	},
	'animation-gallery': {
		label: 'Animation Gallery',
		desc: 'Click through every clip on a rigged avatar.',
		status: 'ready',
		icon: '▶',
	},
	'talking-agent': {
		label: 'Talking Agent',
		desc: 'Embodied chat — your agent on your site.',
		status: 'ready',
		icon: '◐',
	},
	passport: {
		label: 'ERC-8004 Passport',
		desc: 'On-chain identity card for any agent.',
		status: 'ready',
		icon: '◊',
	},
	'hotspot-tour': {
		label: 'Hotspot Tour',
		desc: 'Annotated 3D scene with clickable POIs.',
		status: 'ready',
		icon: '⌖',
	},
	'pumpfun-feed': {
		label: 'Pump.fun Live Feed',
		desc: 'Solana agent narrates live pump.fun claims and graduations.',
		status: 'ready',
		icon: '✦',
	},
};

const DEMO_AVATAR = Object.freeze({
	id: '__demo__',
	name: 'Demo agent (CZ)',
	model_url: '/avatars/cz.glb',
	thumbnail_url: null,
	is_demo: true,
});

// Maps studio widget types to the baked-in demo fixtures in
// /api/widgets/_demo-fixtures.js — lets the demo avatar emit a real
// embeddable URL without requiring a DB row.
const DEMO_WIDGET_IDS = Object.freeze({
	turntable: 'wdgt_demo_turntab',
	'animation-gallery': 'wdgt_demo_animgal',
	'talking-agent': 'wdgt_demo_talking',
	passport: 'wdgt_demo_passprt',
	'hotspot-tour': 'wdgt_demo_hotspot',
	'pumpfun-feed': 'wdgt_demo_pumpfun',
});

const BRAND_DEFAULTS = Object.freeze({
	background: '#0a0a0a',
	accent: '#8b5cf6',
	caption: '',
	showControls: true,
	autoRotate: true,
	envPreset: 'neutral',
	cameraPosition: null,
});

const TYPE_DEFAULTS = {
	turntable: { rotationSpeed: 0.5 },
	'animation-gallery': { defaultClip: '', loopAll: false, showClipPicker: true },
	'talking-agent': {
		agentName: '',
		agentTitle: 'AI Agent',
		avatar: 'embedded',
		brainProvider: 'anthropic',
		proxyURL: '',
		systemPrompt: '',
		greeting: 'Hi! Ask me anything.',
		temperature: 0.7,
		maxTurns: 20,
		skills: { speak: true, wave: true, lookAt: true, playClip: true, remember: false },
		showChatHistory: true,
		voiceInput: true,
		voiceOutput: true,
		chatPosition: 'right',
		poweredByBadge: true,
		visitorRateLimit: { msgsPerMinute: 8, msgsPerSession: 50 },
	},
	passport: {
		chain: 'base-sepolia',
		agentId: null,
		wallet: null,
		showReputation: true,
		showRecentFeedback: true,
		layout: 'portrait',
		rotationSpeed: 0.6,
	},
	'hotspot-tour': { hotspots: [] },
	'pumpfun-feed': { kind: 'all', minTier: '', autoNarrate: true, maxCards: 8 },
};

function defaultConfig(type) {
	return { ...BRAND_DEFAULTS, ...(TYPE_DEFAULTS[type] || {}) };
}

const $ = (sel, root = document) => root.querySelector(sel);

const layoutEl = $('#studio-layout');
const formEl = $('#config-form');
const errEl = $('#form-error');
const previewIfr = $('#preview-iframe');
const previewSt = $('#preview-status');
const captureBtn = $('#capture-camera-btn');
const saveBtn = $('#save-draft-btn');
const generateBtn = $('#generate-btn');
const toastEl = $('#toast');

let launchPanel = null; // set in wireButtons, used in selectAvatar

const state = {
	user: null,
	avatars: [],
	publicAvatars: [],
	avatarId: null,
	type: 'turntable',
	editingId: null,
	config: defaultConfig('turntable'),
	name: '',
	is_public: true,
	preselectedModel: null,
};

const params = new URLSearchParams(location.search);
const editId = params.get('edit');
const tplId = params.get('template');
const pickType = params.get('type');
const preModel = params.get('model');
const preAvatarId = params.get('avatar');

if (pickType && WIDGET_TYPES[pickType]) state.type = pickType;
if (preModel) state.preselectedModel = preModel;

(async function boot() {
	const me = await fetchMe();
	state.user = me || null;
	layoutEl.hidden = false;

	renderTypeGrid();
	renderTypeFields();
	wireForm();
	wireButtons();

	await loadAvatars();

	if (editId) await loadForEdit(editId);
	else if (tplId) await cloneTemplate(tplId);
	else if (preAvatarId) await selectByAvatarId(preAvatarId);
	else if (state.preselectedModel) selectByModelUrl(state.preselectedModel);
	else if (!state.avatarId) selectAvatar(DEMO_AVATAR.id);

	// Re-send config after every iframe navigation so brand settings apply on load.
	previewIfr.addEventListener('load', postConfigToPreview);

	updatePreview(true);
})();

// ── user menu ────────────────────────────────────────────────────────────────
function userDisplayName(u) {
	if (!u) return '';
	return u.display_name || u.username || (u.email ? u.email.split('@')[0] : 'Account');
}

function userInitial(u) {
	const name = userDisplayName(u);
	return name ? name.trim().charAt(0).toUpperCase() : '?';
}

async function signOut() {
	await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
	try {
		localStorage.removeItem('3dagent:auth-hint');
	} catch {
		/* ignore */
	}
	location.href = '/';
}

function renderUserMenu() {
	const root = $('#user-menu');
	if (!root) return;
	root.innerHTML = '';

	if (!state.user) {
		root.dataset.state = 'signed-out';
		const a = document.createElement('a');
		a.className = 'user-menu-signin';
		a.href = '/login?next=/studio';
		a.textContent = 'Sign in';
		root.appendChild(a);
		return;
	}

	root.dataset.state = 'signed-in';
	const u = state.user;
	const name = userDisplayName(u);

	const trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.className = 'user-menu-trigger';
	trigger.setAttribute('aria-haspopup', 'menu');
	trigger.setAttribute('aria-expanded', 'false');

	const av = document.createElement('span');
	av.className = 'user-menu-avatar';
	if (u.avatar_url) {
		const img = document.createElement('img');
		img.src = u.avatar_url;
		img.alt = '';
		av.appendChild(img);
	} else {
		av.textContent = userInitial(u);
	}

	const label = document.createElement('span');
	label.className = 'user-menu-label';
	label.textContent = name;

	const caret = document.createElement('span');
	caret.className = 'user-menu-caret';
	caret.setAttribute('aria-hidden', 'true');
	caret.textContent = '▾';

	trigger.append(av, label, caret);

	const menu = document.createElement('div');
	menu.className = 'user-menu-pop';
	menu.setAttribute('role', 'menu');
	menu.hidden = true;

	const header = document.createElement('div');
	header.className = 'user-menu-header';
	const headerName = document.createElement('div');
	headerName.className = 'user-menu-header-name';
	headerName.textContent = name;
	header.appendChild(headerName);
	if (u.email) {
		const headerEmail = document.createElement('div');
		headerEmail.className = 'user-menu-header-email';
		headerEmail.textContent = u.email;
		header.appendChild(headerEmail);
	}
	menu.appendChild(header);

	const items = [
		{ href: '/my-agents', label: 'My Agents' },
		{ href: '/dashboard', label: 'Dashboard' },
		{ href: '/dashboard/avatars', label: 'My Avatars' },
	];
	for (const it of items) {
		const a = document.createElement('a');
		a.className = 'user-menu-item';
		a.href = it.href;
		a.setAttribute('role', 'menuitem');
		a.textContent = it.label;
		menu.appendChild(a);
	}

	const divider = document.createElement('div');
	divider.className = 'user-menu-divider';
	menu.appendChild(divider);

	const out = document.createElement('button');
	out.type = 'button';
	out.className = 'user-menu-item user-menu-signout';
	out.setAttribute('role', 'menuitem');
	out.textContent = 'Sign out';
	out.addEventListener('click', signOut);
	menu.appendChild(out);

	root.append(trigger, menu);

	function close() {
		menu.hidden = true;
		trigger.setAttribute('aria-expanded', 'false');
	}
	function open() {
		menu.hidden = false;
		trigger.setAttribute('aria-expanded', 'true');
	}
	trigger.addEventListener('click', (e) => {
		e.stopPropagation();
		menu.hidden ? open() : close();
	});
	document.addEventListener('click', (e) => {
		if (!root.contains(e.target)) close();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') close();
	});
}

// ── data ─────────────────────────────────────────────────────────────────────
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

async function loadAvatars() {
	const list = $('#avatar-list');
	list.removeAttribute('aria-busy');
	state.avatars = [DEMO_AVATAR];
	if (!state.user) {
		renderAvatarList();
		return;
	}
	try {
		const res = await fetch('/api/avatars?limit=100', { credentials: 'include' });
		if (!res.ok) throw new Error(`avatars: ${res.status}`);
		const { avatars = [] } = await res.json();
		state.avatars = [DEMO_AVATAR, ...avatars];
		renderAvatarList();
	} catch (err) {
		renderAvatarList();
		const note = document.createElement('div');
		note.className = 'empty';
		note.textContent = `Couldn't load your avatars: ${err.message}`;
		list.appendChild(note);
	}
}

async function loadForEdit(id) {
	try {
		const res = await fetch(`/api/widgets/${encodeURIComponent(id)}`, {
			credentials: 'include',
		});
		if (!res.ok) return;
		const { widget } = await res.json();
		state.editingId = widget.id;
		state.preselectedModel = null;
		state.type = widget.type;
		state.avatarId = widget.avatar_id;
		state.name = widget.name || '';
		state.config = { ...defaultConfig(widget.type), ...(widget.config || {}) };
		state.is_public = widget.is_public;
		hydrateForm();
		renderTypeGrid();
		renderAvatarList();
		renderTypeFields();
	} catch (err) {
		console.warn('[studio] edit load failed', err);
	}
}

async function cloneTemplate(id) {
	try {
		const res = await fetch(`/api/widgets/${encodeURIComponent(id)}`);
		if (!res.ok) return;
		const { widget } = await res.json();
		state.type = widget.type;
		state.config = { ...defaultConfig(widget.type), ...(widget.config || {}) };
		state.name = `Copy of ${widget.name}`;
		// avatarId stays unset — user must pick their own
		hydrateForm();
		renderTypeGrid();
		renderTypeFields();
	} catch {
		toast("Couldn't load template");
	}
}

// ── rendering ────────────────────────────────────────────────────────────────
function renderAvatarList() {
	const list = $('#avatar-list');
	if (!state.avatars.length) {
		list.innerHTML = `<div class="empty">No avatars yet. <a href="/dashboard#upload" target="_blank" rel="noopener">Upload one →</a></div>`;
		return;
	}
	list.innerHTML = '';
	for (const a of state.avatars) appendAvatarCard(list, a);
	if (!state.user) {
		const loginHref = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
		const note = document.createElement('div');
		note.className = 'empty';
		note.innerHTML = `<a href="${attr(loginHref)}">Sign in</a> to use your own avatars.`;
		list.appendChild(note);
	}
}

function appendAvatarCard(list, a) {
	const card = document.createElement('button');
	card.type = 'button';
	card.className =
		'avatar-card' +
		(a.id === state.avatarId ? ' selected' : '') +
		(a.is_demo ? ' is-demo' : '') +
		(a.is_public_browse ? ' is-public' : '');
	card.dataset.id = a.id;
	card.setAttribute('aria-pressed', String(a.id === state.avatarId));
	if (a.is_demo) {
		card.dataset.tooltip =
			'A built-in demo so you can try the studio without uploading. Sign in and pick one of your own avatars to save and embed.';
	} else if (a.is_public_browse) {
		card.dataset.tooltip = `Public avatar by another creator — you can embed it in your own widget.`;
	}
	const thumb = a.thumbnail_url
		? `<div class="thumb"><img src="${attr(a.thumbnail_url)}" alt="" loading="lazy"></div>`
		: `<div class="thumb">◎</div>`;
	const badge = a.is_demo
		? '<span class="badge-demo">Demo</span>'
		: a.is_public_browse
			? '<span class="badge-public">Public</span>'
			: '';
	card.innerHTML = `${thumb}<span class="name">${escapeHtml(a.name || a.slug || a.id)}</span>${badge}`;
	card.addEventListener('click', () => selectAvatar(a.id));
	list.appendChild(card);
}

function renderPublicAvatarList() {
	const list = $('#public-avatar-list');
	if (!state.publicAvatars.length) {
		list.hidden = true;
		list.innerHTML = '';
		return;
	}
	list.hidden = false;
	list.innerHTML = '';
	for (const a of state.publicAvatars) appendAvatarCard(list, a);
}

async function searchPublicAvatars(q) {
	const status = $('#public-search-status');
	const list = $('#public-avatar-list');
	status.hidden = false;
	status.textContent = 'Searching…';
	try {
		const url = new URL('/api/avatars/public', location.origin);
		if (q) url.searchParams.set('q', q);
		url.searchParams.set('limit', '24');
		const res = await fetch(url, { credentials: 'include' });
		if (!res.ok) throw new Error(`search: ${res.status}`);
		const { avatars = [] } = await res.json();
		// Filter out avatars already in the user's own list (avoid duplicates).
		const ownIds = new Set(state.avatars.map((a) => a.id));
		state.publicAvatars = avatars
			.filter((a) => !ownIds.has(a.id))
			.map((a) => ({
				id: a.id,
				name: a.name,
				slug: a.slug,
				model_url: a.model_url,
				thumbnail_url: a.thumbnail_url || null,
				is_public_browse: true,
			}));
		renderPublicAvatarList();
		status.textContent = state.publicAvatars.length
			? `${state.publicAvatars.length} public avatar${state.publicAvatars.length === 1 ? '' : 's'}`
			: 'No public avatars match that search.';
	} catch (err) {
		list.hidden = true;
		status.textContent = `Couldn't search: ${err.message}`;
	}
}

function renderTypeGrid() {
	const grid = $('#type-grid');
	grid.innerHTML = '';
	for (const [key, t] of Object.entries(WIDGET_TYPES)) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'type-card' + (key === state.type ? ' selected' : '');
		card.setAttribute('aria-pressed', String(key === state.type));
		card.innerHTML = `
			<span class="icon" aria-hidden="true">${t.icon}</span>
			<span class="label">${escapeHtml(t.label)}</span>
			<span class="desc">${escapeHtml(t.desc)}</span>
			${t.status === 'pending' ? '<span class="pending">Coming soon</span>' : ''}
		`;
		card.addEventListener('click', () => selectType(key));
		grid.appendChild(card);
	}
}

function renderTypeFields() {
	const wrap = $('#type-fields');
	wrap.innerHTML = '';
	const t = WIDGET_TYPES[state.type];
	if (t.status === 'pending') {
		const banner = document.createElement('div');
		banner.className = 'pending-banner';
		banner.textContent = `${t.label} runtime ships in a later prompt. You can still save the config; it'll light up when the runtime lands.`;
		wrap.appendChild(banner);
		return;
	}
	if (state.type === 'turntable') {
		wrap.appendChild(
			numberField('rotationSpeed', 'Rotation speed', state.config.rotationSpeed ?? 0.5, {
				min: 0,
				max: 10,
				step: 0.1,
			}),
		);
	}
	if (state.type === 'talking-agent') {
		mountTalkingAgentExtras(wrap);
	}
	if (state.type === 'pumpfun-feed') {
		wrap.appendChild(
			selectField('kind', 'Event kind', state.config.kind ?? 'all', [
				['all', 'All events'],
				['claims', 'Claims only'],
				['graduations', 'Graduations only'],
			]),
		);
		wrap.appendChild(
			selectField('minTier', 'Minimum tier (claims)', state.config.minTier ?? '', [
				['', 'Any'],
				['notable', 'Notable+'],
				['influencer', 'Influencer+'],
				['mega', 'Mega only'],
			]),
		);
		wrap.appendChild(
			boolField('autoNarrate', 'Avatar narrates events', state.config.autoNarrate !== false),
		);
		wrap.appendChild(
			numberField('maxCards', 'Max cards on screen', state.config.maxCards ?? 8, {
				min: 1,
				max: 50,
				step: 1,
			}),
		);
	}
}

function mountTalkingAgentExtras(wrap) {
	wrap.appendChild(
		textField('agentName', 'Agent name', state.config.agentName || '', {
			max: 80,
			placeholder: 'e.g. "Ada"',
		}),
	);
	wrap.appendChild(
		textField('agentTitle', 'Agent title', state.config.agentTitle || 'AI Agent', {
			max: 80,
			placeholder: 'e.g. "Support bot"',
		}),
	);
	wrap.appendChild(
		textField('greeting', 'Greeting', state.config.greeting || 'Hi! Ask me anything.', {
			max: 280,
			placeholder: 'First message visitors see',
		}),
	);
	wrap.appendChild(
		textareaField('systemPrompt', 'System prompt', state.config.systemPrompt || '', {
			max: 4000,
			placeholder: 'Describe how the agent should behave — tone, topics, what to avoid.',
			rows: 4,
		}),
	);
	wrap.appendChild(
		selectField('brainProvider', 'LLM provider', state.config.brainProvider || 'auto', [
			['auto', 'Auto (first configured)'],
			['anthropic', 'Anthropic (Claude)'],
			['openai', 'OpenAI'],
			['groq', 'Groq'],
			['openrouter', 'OpenRouter'],
		]),
	);

	const knowledgeMount = document.createElement('div');
	knowledgeMount.id = 'studio-knowledge';
	wrap.appendChild(knowledgeMount);

	const transcriptsLink = document.createElement('div');
	transcriptsLink.className = 'kp-transcripts-link';
	transcriptsLink.innerHTML = state.editingId
		? `<a href="/dashboard/widgets?w=${encodeURIComponent(state.editingId)}#transcripts" target="_blank" rel="noopener">View chat transcripts →</a>`
		: '<span class="muted">Save the widget to see chat transcripts in the dashboard.</span>';
	wrap.appendChild(transcriptsLink);

	if (_knowledgePanel) _knowledgePanel.destroy?.();
	_knowledgePanel = mountKnowledgePanel(knowledgeMount, {
		getWidgetId: () => state.editingId || null,
		getCanEdit: () => !!state.user && !!state.editingId,
	});
}

let _knowledgePanel = null;

function selectField(name, label, value, options) {
	const f = document.createElement('label');
	f.className = 'field';
	const opts = options
		.map(
			([v, l]) =>
				`<option value="${attr(v)}"${v === value ? ' selected' : ''}>${escapeHtml(l)}</option>`,
		)
		.join('');
	f.innerHTML = `<span>${escapeHtml(label)}</span><select name="${attr(name)}">${opts}</select>`;
	f.querySelector('select').addEventListener('change', (e) => {
		state.config[name] = e.target.value;
		schedulePreview();
	});
	return f;
}

function boolField(name, label, checked) {
	const f = document.createElement('label');
	f.className = 'field';
	f.innerHTML = `<input type="checkbox" name="${attr(name)}"${checked ? ' checked' : ''}>
		<span>${escapeHtml(label)}</span>`;
	f.querySelector('input').addEventListener('change', (e) => {
		state.config[name] = e.target.checked;
		schedulePreview();
	});
	return f;
}

function textField(name, label, value, { max = 200, placeholder = '' } = {}) {
	const f = document.createElement('label');
	f.className = 'field';
	f.innerHTML = `<span>${escapeHtml(label)}</span>
		<input type="text" name="${attr(name)}" maxlength="${max}"
			placeholder="${attr(placeholder)}" value="${attr(String(value || ''))}">`;
	f.querySelector('input').addEventListener('input', (e) => {
		state.config[name] = e.target.value;
		schedulePreview();
	});
	return f;
}

function textareaField(name, label, value, { max = 4000, placeholder = '', rows = 4 } = {}) {
	const f = document.createElement('label');
	f.className = 'field';
	f.innerHTML = `<span>${escapeHtml(label)}</span>
		<textarea name="${attr(name)}" maxlength="${max}" rows="${rows}"
			placeholder="${attr(placeholder)}">${escapeHtml(String(value || ''))}</textarea>`;
	f.querySelector('textarea').addEventListener('input', (e) => {
		state.config[name] = e.target.value;
		schedulePreview();
	});
	return f;
}

function numberField(name, label, value, { min, max, step }) {
	const f = document.createElement('label');
	f.className = 'field';
	f.innerHTML = `<span>${escapeHtml(label)}</span>
		<input type="number" name="${attr(name)}" value="${attr(String(value))}" min="${min}" max="${max}" step="${step}">`;
	f.querySelector('input').addEventListener('input', (e) => {
		const v = parseFloat(e.target.value);
		if (!isNaN(v)) {
			state.config[name] = v;
			schedulePreview();
		}
	});
	return f;
}

// ── interaction ──────────────────────────────────────────────────────────────
function selectAvatar(id) {
	state.avatarId = id;
	renderAvatarList();
	renderPublicAvatarList();
	updatePreview(true);
	captureBtn.disabled = false;
	launchPanel?.avatarChanged();
}

function findAvatar(id) {
	return (
		state.avatars.find((a) => a.id === id) ||
		state.publicAvatars.find((a) => a.id === id) ||
		null
	);
}

async function selectByAvatarId(id) {
	const existing = findAvatar(id);
	if (existing) return selectAvatar(existing.id);
	try {
		const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`, {
			credentials: 'include',
		});
		if (!res.ok) throw new Error(`avatar ${id}: ${res.status}`);
		const { avatar } = await res.json();
		if (!avatar?.model_url) throw new Error('avatar missing model_url');
		const ownIds = new Set(state.avatars.map((a) => a.id));
		if (!ownIds.has(avatar.id)) {
			state.publicAvatars = [
				{
					id: avatar.id,
					name: avatar.name,
					slug: avatar.slug,
					description: avatar.description,
					tags: avatar.tags || [],
					visibility: avatar.visibility,
					model_url: avatar.model_url,
					thumbnail_url: avatar.thumbnail_url || null,
				},
				...state.publicAvatars.filter((a) => a.id !== avatar.id),
			];
			renderPublicAvatarList();
		}
		selectAvatar(avatar.id);
	} catch (err) {
		console.warn('[studio] selectByAvatarId failed', err);
		toast('Pre-selected avatar not available');
		if (!state.avatarId) selectAvatar(DEMO_AVATAR.id);
	}
}

function selectByModelUrl(url) {
	const urlPath = (() => {
		try {
			return new URL(url, location.origin).pathname;
		} catch {
			return url;
		}
	})();

	// Search by model_url (public/unlisted avatars) and by storage_key path
	// (private avatars where model_url is null but storage_key is available).
	const found = state.avatars.find((a) => {
		if (a.model_url) {
			if (a.model_url === url) return true;
			try {
				if (new URL(a.model_url).pathname === urlPath) return true;
			} catch {}
		}
		if (a.storage_key) {
			const keyPath = '/' + a.storage_key.split('/').map(encodeURIComponent).join('/');
			if (keyPath === urlPath) return true;
		}
		return false;
	});
	if (found) return selectAvatar(found.id);

	// Not in the local list — try to auto-register if this is the user's own R2 file.
	if (state.user) {
		const storageKey = extractOwnStorageKey(url, state.user.id);
		if (storageKey) {
			autoRegisterAndSelect(url, storageKey);
			return;
		}
	}

	toast('Pre-selected model not found in your avatar library');
}

// Returns the storage_key if url is an R2 object under this user's prefix,
// otherwise null.
function extractOwnStorageKey(url, userId) {
	let pathname;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return null;
	}
	// Decode percent-encoded segments so the storage_key is clean.
	const key = pathname.replace(/^\//, '').split('/').map(decodeURIComponent).join('/');
	if (!key.startsWith(`u/${userId}/`)) return null;
	if (!key.endsWith('.glb')) return null;
	return key;
}

async function autoRegisterAndSelect(url, storageKey) {
	toast('Registering model…');
	try {
		// HEAD the object to get its size — required by the avatar creation endpoint.
		const head = await fetch(url, { method: 'HEAD' });
		if (!head.ok) throw new Error(`HEAD ${head.status}`);
		const sizeBytes = Number(head.headers.get('content-length'));
		if (!sizeBytes) throw new Error('content-length missing');

		// Derive a name from the URL path (last meaningful segment before the file).
		const segments = storageKey.split('/');
		const namePart = segments[segments.length - 2] || segments[segments.length - 1];
		const name = namePart.replace(/[-_]/g, ' ').slice(0, 80) || 'Uploaded model';

		const res = await fetch('/api/avatars', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				storage_key: storageKey,
				size_bytes: sizeBytes,
				name,
				visibility: 'public',
				source: 'direct-upload',
			}),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.message || `${res.status}`);
		}
		const { avatar } = await res.json();
		// Add to state and select.
		const ownIds = new Set(state.avatars.map((a) => a.id));
		if (!ownIds.has(avatar.id)) {
			state.avatars = [
				state.avatars[0], // keep DEMO_AVATAR first
				{ ...avatar, model_url: url },
				...state.avatars.slice(1),
			];
			renderAvatarList();
		}
		selectAvatar(avatar.id);
	} catch (err) {
		console.warn('[studio] autoRegisterAndSelect failed', err);
		toast('Could not register model — pick one from your library');
	}
}

function selectType(key) {
	if (state.type === key) return;
	state.type = key;
	state.config = { ...defaultConfig(key), ...pickBrand(state.config) };
	renderTypeGrid();
	renderTypeFields();
	updatePreview(true);
}

function pickBrand(cfg) {
	const out = {};
	for (const k of Object.keys(BRAND_DEFAULTS)) {
		if (cfg[k] !== undefined) out[k] = cfg[k];
	}
	return out;
}

function wireForm() {
	hydrateForm();
	formEl.addEventListener('input', (e) => {
		const t = e.target;
		if (!t.name) return;
		const val = t.type === 'checkbox' ? t.checked : t.value;
		if (t.name === 'name') state.name = val;
		else if (t.name === 'is_public') state.is_public = val;
		else state.config[t.name] = val;
		schedulePreview();
	});
}

function hydrateForm() {
	for (const el of formEl.elements) {
		if (!el.name) continue;
		if (el.name === 'name') el.value = state.name || '';
		else if (el.name === 'is_public') el.checked = !!state.is_public;
		else if (el.type === 'checkbox') el.checked = !!state.config[el.name];
		else if (state.config[el.name] !== undefined) el.value = state.config[el.name];
	}
}

function wireButtons() {
	renderUserMenu();

	captureBtn.addEventListener('click', () => {
		try {
			const w = previewIfr.contentWindow;
			const cam = w?.VIEWER?.viewer?.activeCamera;
			if (!cam) return toast('Preview not ready');
			state.config.cameraPosition = [cam.position.x, cam.position.y, cam.position.z];
			toast('Camera captured');
			updatePreview(true);
		} catch {
			toast('Could not read camera');
		}
	});

	saveBtn.addEventListener('click', () => save({ generate: false }));
	generateBtn.addEventListener('click', () => save({ generate: true }));

	$('#embed-modal-close').addEventListener('click', () => {
		$('#embed-modal').hidden = true;
	});

	// Right-column tab switching: Brand ↔ Launch
	const tabBrand = $('#tab-brand');
	const tabLaunch = $('#tab-launch');
	const panelBrand = $('#panel-brand');
	const panelLaunch = $('#panel-launch');
	const actionRow = $('.action-row');
	const formError = $('#form-error');

	launchPanel = mountLaunchPanel(panelLaunch, {
		getAvatar: () => findAvatar(state.avatarId),
		getUser: () => state.user,
		getPreviewViewer: () => {
			try {
				return previewIfr?.contentWindow?.VIEWER?.viewer || null;
			} catch {
				return null;
			}
		},
	});

	function switchTab(active) {
		const toBrand = active === 'brand';
		tabBrand.setAttribute('aria-selected', String(toBrand));
		tabLaunch.setAttribute('aria-selected', String(!toBrand));
		panelBrand.hidden = !toBrand;
		panelLaunch.hidden = toBrand;
		// Hide save/generate buttons and errors when on Launch tab
		if (actionRow) actionRow.hidden = !toBrand;
		if (formError) formError.hidden = true;
	}

	tabBrand.addEventListener('click', () => switchTab('brand'));
	tabLaunch.addEventListener('click', () => switchTab('launch'));

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('#embed-modal').hidden) {
			$('#embed-modal').hidden = true;
		}
	});

	for (const btn of document.querySelectorAll('[data-copy]')) {
		btn.addEventListener('click', () => copyFromSelector(btn.dataset.copy, btn));
	}

	const publicSearch = $('#public-search');
	const publicSearchBtn = $('#public-search-btn');
	const runPublicSearch = () => searchPublicAvatars(publicSearch.value.trim());
	publicSearchBtn.addEventListener('click', runPublicSearch);
	publicSearch.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			runPublicSearch();
		}
	});

	$('#embed-width').addEventListener('input', _refreshEmbedSnippet);
	$('#embed-height').addEventListener('input', _refreshEmbedSnippet);

	for (const id of ['embed-include-animations', 'embed-include-chat', 'embed-include-controls']) {
		$(`#${id}`).addEventListener('change', _refreshEmbedSnippet);
	}
}

// ── preview ──────────────────────────────────────────────────────────────────
let previewTimer = null;
let previewSrcKey = '';

function schedulePreview() {
	clearTimeout(previewTimer);
	previewTimer = setTimeout(() => updatePreview(false), 200);
}

function updatePreview(forceReload) {
	if (!state.avatarId && !state.preselectedModel) {
		previewSt.textContent = 'Pick an avatar to preview';
		return;
	}
	const avatar = findAvatar(state.avatarId);
	const modelUrl = avatar?.model_url || state.preselectedModel;
	if (!modelUrl) {
		previewSt.textContent = 'Avatar has no public URL — make it public/unlisted to preview';
		return;
	}
	previewSt.textContent = state.avatarId
		? 'Live preview'
		: 'Preview only — pick an avatar from your library to save';
	if (!state.avatarId) captureBtn.disabled = false;

	const camStr = Array.isArray(state.config.cameraPosition)
		? `&cameraPosition=${state.config.cameraPosition.map((n) => n.toFixed(3)).join(',')}`
		: '';
	const presetStr =
		state.config.envPreset && state.config.envPreset !== 'none'
			? `&preset=${encodeURIComponent(state.config.envPreset)}`
			: '';
	const hashStr = `model=${encodeURIComponent(modelUrl)}&kiosk=true&type=${encodeURIComponent(state.type)}${camStr}${presetStr}`;
	const key = hashStr;
	if (forceReload || key !== previewSrcKey) {
		previewSrcKey = key;
		previewSt.textContent = 'Loading preview…';
		// Cache-buster query forces a full reload. Without it, hash-only
		// changes (e.g. switching avatars) trigger fragment navigation in
		// the iframe — and the widget shell reads `model`/`type` from the
		// hash only on boot, so the preview wouldn't update.
		// /widget is the slim viewer shell — same /src/app.js bundle, but
		// without site nav/footer/auth chrome in the DOM, so the preview
		// doesn't flash the marketing site before the model renders.
		previewIfr.src = `/widget?_=${Date.now()}#${hashStr}`;
	}
	postConfigToPreview();
}

function postConfigToPreview() {
	if (!previewIfr.contentWindow) return;
	try {
		previewIfr.contentWindow.postMessage(
			{ type: 'widget:config', config: { ...state.config } },
			location.origin,
		);
	} catch {
		/* iframe may not be ready yet — full reload covers it */
	}
}

// ── save / generate ──────────────────────────────────────────────────────────
async function save({ generate }) {
	errEl.hidden = true;

	if (!state.avatarId) return showError('Pick an avatar first');
	if (!WIDGET_TYPES[state.type]) return showError('Pick a widget type');

	// Demo avatar: no DB row, just open the embed modal pointed at the
	// canonical demo fixture for this widget type. Studio tweaks aren't
	// persisted (there's nowhere to store them) — the modal flags this.
	if (state.avatarId === DEMO_AVATAR.id) {
		if (!generate) {
			return showError(
				'The demo avatar can be embedded but not saved — sign in and upload your own avatar to save drafts.',
			);
		}
		const demoId = DEMO_WIDGET_IDS[state.type];
		if (!demoId) return showError('No demo embed available for this widget type yet.');
		openEmbedModal({ id: demoId, type: state.type, is_demo: true });
		return;
	}

	if (!state.user) {
		location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
		return;
	}
	if (!state.name?.trim()) return showError('Name is required');

	const body = {
		type: state.type,
		name: state.name.trim(),
		avatar_id: state.avatarId,
		is_public: state.is_public,
		config: state.config,
	};

	const url = state.editingId
		? `/api/widgets/${encodeURIComponent(state.editingId)}`
		: '/api/widgets';
	const method = state.editingId ? 'PATCH' : 'POST';
	const sendBody = state.editingId
		? {
				name: body.name,
				avatar_id: body.avatar_id,
				is_public: body.is_public,
				config: body.config,
			}
		: body;

	saveBtn.disabled = true;
	generateBtn.disabled = true;
	try {
		const res = await fetch(url, {
			method,
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(sendBody),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error_description || `save failed: ${res.status}`);
		}
		const { widget } = await res.json();
		const wasNew = !state.editingId;
		state.editingId = widget.id;
		const newUrl = new URL(location.href);
		newUrl.searchParams.set('edit', widget.id);
		newUrl.searchParams.delete('template');
		newUrl.searchParams.delete('model');
		history.replaceState(null, '', newUrl);

		// Re-render type fields so the Knowledge panel picks up the new id
		// (it was disabled until the widget had a row to attach docs to).
		if (wasNew && state.type === 'talking-agent') renderTypeFields();

		if (generate) openEmbedModal(widget);
		else toast('Saved');
	} catch (err) {
		showError(err.message);
	} finally {
		saveBtn.disabled = false;
		generateBtn.disabled = false;
	}
}

let _currentEmbedUrl = '';
let _currentWidgetType = '';

function _buildEmbedUrl(baseUrl) {
	const params = [];
	if ($('#embed-opt-animations')?.hidden === false && !$('#embed-include-animations').checked)
		params.push('noAnimations=1');
	if ($('#embed-opt-chat')?.hidden === false && !$('#embed-include-chat').checked)
		params.push('noChat=1');
	if ($('#embed-opt-controls')?.hidden === false && !$('#embed-include-controls').checked)
		params.push('noControls=1');
	return params.length ? `${baseUrl}&${params.join('&')}` : baseUrl;
}

function _refreshEmbedSnippet() {
	if (!_currentEmbedUrl) return;
	const url = _buildEmbedUrl(_currentEmbedUrl);
	const w = parseInt($('#embed-width').value) || 600;
	const h = parseInt($('#embed-height').value) || 600;
	$('#embed-iframe-snippet').value =
		`<iframe src="${url}" width="${w}" height="${h}" style="border:0;border-radius:12px" allow="autoplay; xr-spatial-tracking" loading="lazy"></iframe>`;
	$('#embed-preview-iframe').src = url;
}

function openEmbedModal(widget) {
	const origin = location.origin;
	const shareUrl = `${origin}/w/${widget.id}`;
	_currentEmbedUrl = `${origin}/widget#widget=${widget.id}&kiosk=true`;
	_currentWidgetType = widget.type || state.type;

	const demoNote = $('#embed-demo-note');
	if (demoNote) demoNote.hidden = !widget.is_demo;

	// Show relevant embed-option checkboxes for this widget type, reset to checked.
	const hasAnimations = _currentWidgetType === 'animation-gallery';
	const hasChat = _currentWidgetType === 'talking-agent';
	const hasControls = ['turntable', 'animation-gallery', 'passport'].includes(_currentWidgetType);
	$('#embed-opt-animations').hidden = !hasAnimations;
	$('#embed-opt-chat').hidden = !hasChat;
	$('#embed-opt-controls').hidden = !hasControls;
	const anyOption = hasAnimations || hasChat || hasControls;
	$('#embed-options').hidden = !anyOption;
	// Reset checkboxes to "include everything" each time modal opens.
	$('#embed-include-animations').checked = true;
	$('#embed-include-chat').checked = true;
	$('#embed-include-controls').checked = true;

	$('#embed-share-url').value = shareUrl;
	_refreshEmbedSnippet();
	$('#embed-script-snippet').value =
		`<script async src="${origin}/embed.js" data-widget="${widget.id}"></` + 'script>';
	$('#embed-modal').hidden = false;
}

function copyFromSelector(sel, btn) {
	const el = $(sel);
	if (!el) return;
	el.select?.();
	navigator.clipboard.writeText(el.value).then(
		() => {
			const o = btn.textContent;
			btn.textContent = 'Copied';
			setTimeout(() => (btn.textContent = o), 1200);
		},
		() => toast('Copy failed'),
	);
}

function showError(msg) {
	errEl.textContent = msg;
	errEl.hidden = false;
}

let toastTimer = null;
function toast(msg) {
	toastEl.textContent = msg;
	toastEl.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (toastEl.hidden = true), 1800);
}

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
function attr(s) {
	return escapeHtml(s);
}
