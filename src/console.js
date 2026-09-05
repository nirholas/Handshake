// Agent Console (/console): a handheld with a live 3D agent inside the screen.
//
// The screen is a real /walk-embed iframe, so the body walking around in there
// is the same renderer, retargeting and animation library the rest of the
// platform uses. This module is the console around it: it owns the cartridge
// (which screen is mounted), the roster (which public agent is loaded), the
// physical controls, and the share/embed surface.
//
// Everything the device sends into the screen goes over the typed walk-embed
// contract documented in src/walk-embed-events.js:
//   walk:move   { x, y, run }   held analog vector from the D-pad
//   walk:gesture{ gesture }     one-shot wave / jump from A and B
//   walk:avatar { avatarId }    slotting a different agent's body
//   walk:env    { env }         SELECT cycles the scene
//   walk:say    { text }        the agent introduces itself when slotted
// and the screen answers with walk:ready / walk:avatarChanged / walk:error,
// which is what drives the boot overlay. Nothing here fakes a loading state.
//
// URL params:
//   ?agent=<uuid>   boot straight into that agent
//   ?shell=graphite|bone|clear|indigo
//   ?env=studio|void|beach|sunset|night|grid
//   ?cart=play|stats|select
//   ?chrome=off     device only, transparent background (this is the embed mode)

const WALK_CHANNEL = 'three-walk';
const ROSTER_URL = '/api/agents/public?limit=24';
const ROSTER_LIMIT = 24;
const SHELLS = ['graphite', 'bone', 'clear', 'indigo'];
const ENVS = ['night', 'studio', 'sunset', 'grid'];
const CARTS = ['play', 'stats', 'select'];
const BOOT_TIMEOUT_MS = 25000;
const SWAP_TIMEOUT_MS = 20000;
const TILT_MAX_DEG = 7;

const params = new URLSearchParams(location.search);
const chromeOff = (params.get('chrome') || '').toLowerCase() === 'off';
const reduceMotion =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover =
	typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

const el = {
	device: document.getElementById('cn-device'),
	screenPlay: document.getElementById('cn-cart-play'),
	boot: document.getElementById('cn-boot'),
	bootText: document.getElementById('cn-boot-text'),
	bootRetry: document.getElementById('cn-boot-retry'),
	hudName: document.getElementById('cn-hud-name'),
	hudCart: document.getElementById('cn-hud-cart'),
	modelLine: document.getElementById('cn-model-line'),
	statsId: document.getElementById('cn-stats-id'),
	statsList: document.getElementById('cn-stats-list'),
	statsNote: document.getElementById('cn-stats-note'),
	roster: document.getElementById('cn-roster'),
	selectCount: document.getElementById('cn-select-count'),
	carts: document.getElementById('cn-carts'),
	embedCode: document.getElementById('cn-embed-code'),
	gamepadPill: document.getElementById('cn-gamepad'),
	toast: document.getElementById('cn-toast'),
	live: document.getElementById('cn-live'),
};

const state = {
	agents: [],
	index: -1,
	detail: null,
	detailFor: null,
	cart: CARTS.includes(params.get('cart')) ? params.get('cart') : 'play',
	env: ENVS.includes(params.get('env')) ? params.get('env') : 'night',
	shell: SHELLS.includes(params.get('shell')) ? params.get('shell') : 'graphite',
	power: true,
	ready: false,
	rosterCursor: 0,
	frame: null,
	swapTimer: 0,
	bootTimer: 0,
};

const held = { up: false, down: false, left: false, right: false, run: false };
let lastVector = { x: 0, y: 0, run: false };

// ── screen plumbing ───────────────────────────────────────────────────────

// The screen is framed tighter than a full-bleed walk embed (?zoom) and the
// body is addressed by avatar id whenever we know it: that route streams the
// GLB through the same-origin proxy, so the console renders identically on
// three.ws and inside somebody else's page, where R2's own CORS would refuse
// the raw model URL.
function frameSrc(agentId) {
	const q = new URLSearchParams({
		controls: 'none',
		orbit: 'false',
		badge: 'false',
		click: 'false',
		gestures: 'false',
		zoom: '0.74',
		env: state.env,
	});
	const avatarId = agentId && state.detailFor === agentId ? state.detail?.avatar_id : null;
	if (avatarId) q.set('avatar', avatarId);
	else if (agentId) q.set('agent', agentId);
	return `/walk-embed?${q.toString()}`;
}

function mountFrame(agentId) {
	unmountFrame();
	const frame = document.createElement('iframe');
	frame.src = frameSrc(agentId);
	frame.title = 'Live 3D agent';
	frame.loading = 'eager';
	frame.allow = 'xr-spatial-tracking';
	el.screenPlay.appendChild(frame);
	state.frame = frame;
	state.ready = false;
	showBoot('Booting agent');
	clearTimeout(state.bootTimer);
	state.bootTimer = setTimeout(() => {
		if (!state.ready) failBoot('Screen did not answer');
	}, BOOT_TIMEOUT_MS);
}

function unmountFrame() {
	clearTimeout(state.bootTimer);
	clearTimeout(state.swapTimer);
	if (state.frame) state.frame.remove();
	state.frame = null;
	state.ready = false;
}

function post(type, payload = {}) {
	if (!state.frame || !state.frame.contentWindow) return;
	state.frame.contentWindow.postMessage({ channel: WALK_CHANNEL, v: 1, type, ...payload }, '*');
}

function showBoot(text) {
	el.bootText.textContent = text;
	el.bootRetry.hidden = true;
	el.boot.hidden = false;
}

function hideBoot() {
	el.boot.hidden = true;
}

function failBoot(message) {
	el.bootText.textContent = message;
	el.bootRetry.hidden = false;
	el.boot.hidden = false;
}

window.addEventListener('message', (event) => {
	if (!state.frame || event.source !== state.frame.contentWindow) return;
	const data = event.data;
	if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
	if (data.channel && data.channel !== WALK_CHANNEL) return;

	if (data.type === 'walk:ready' || data.type === 'walk:loaded') {
		state.ready = true;
		clearTimeout(state.bootTimer);
		hideBoot();
		post('walk:env', { env: state.env });
		greet();
		return;
	}
	if (data.type === 'walk:avatarChanged') {
		clearTimeout(state.swapTimer);
		hideBoot();
		greet();
		return;
	}
	if (data.type === 'walk:error') {
		clearTimeout(state.swapTimer);
		failBoot(data.message ? String(data.message).slice(0, 90) : 'Screen error');
	}
});

el.bootRetry.addEventListener('click', () => {
	const agent = currentAgent();
	mountFrame(agent ? agent.id : null);
});

function greet() {
	const agent = currentAgent();
	if (!agent) return;
	post('walk:say', { text: agent.name, durationMs: 2600 });
}

// ── roster ────────────────────────────────────────────────────────────────

function currentAgent() {
	return state.index >= 0 ? state.agents[state.index] || null : null;
}

async function loadRoster() {
	el.carts.setAttribute('aria-busy', 'true');
	renderCartSkeletons();
	try {
		const res = await fetch(ROSTER_URL, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		const list = Array.isArray(body?.agents) ? body.agents : [];
		state.agents = list.filter((a) => a && a.id && a.name).slice(0, ROSTER_LIMIT);
		if (!state.agents.length) throw new Error('empty roster');
		el.carts.setAttribute('aria-busy', 'false');
		renderCarts();
		renderRoster();
		const wanted = params.get('agent');
		const at = wanted ? state.agents.findIndex((a) => a.id === wanted) : -1;
		if (wanted && at < 0) {
			await loadUnlistedAgent(wanted);
			return;
		}
		selectAgent(at >= 0 ? at : 0, { boot: true });
	} catch (err) {
		el.carts.setAttribute('aria-busy', 'false');
		renderRosterError(err?.message || 'could not reach the agent index');
	}
}

// A shared /console?agent=<id> link can name an agent outside the first page of
// the public index. Pull that one record directly and put it at the head of the
// roster so the link always boots the agent it promised.
async function loadUnlistedAgent(id) {
	try {
		const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
			headers: { accept: 'application/json' },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		const rec = body?.agent || body;
		if (!rec?.id) throw new Error('agent not found');
		state.agents.unshift({
			id: rec.id,
			name: rec.name || 'Agent',
			description: rec.description || '',
			skills: rec.skills || [],
			avatar_thumbnail: rec.avatar_thumbnail_url || rec.avatar_thumbnail || null,
			chat_count: rec.chat_count || 0,
			created_at: rec.created_at || null,
			is_registered: !!rec.is_registered,
		});
		state.detail = rec;
		state.detailFor = rec.id;
		renderCarts();
		renderRoster();
		selectAgent(0, { boot: true });
	} catch {
		toast('That agent is not public. Booting the first cartridge instead.');
		selectAgent(0, { boot: true });
	}
}

function renderCartSkeletons() {
	el.carts.replaceChildren();
	for (let i = 0; i < 5; i += 1) {
		const chip = document.createElement('div');
		chip.className = 'cn-chip cn-chip-skeleton';
		el.carts.appendChild(chip);
	}
}

function renderRosterError(reason) {
	el.carts.replaceChildren();
	const box = document.createElement('div');
	box.className = 'cn-rail-error';
	const text = document.createElement('span');
	text.textContent = `The cartridge shelf is unreachable (${reason}). The console still runs on its default body.`;
	const retry = document.createElement('button');
	retry.type = 'button';
	retry.className = 'cn-btn';
	retry.textContent = 'Try again';
	retry.addEventListener('click', loadRoster);
	box.append(text, retry);
	el.carts.appendChild(box);

	el.roster.replaceChildren();
	const line = document.createElement('p');
	line.className = 'cn-panel-note';
	line.textContent = 'NO SIGNAL. The agent index did not answer.';
	el.roster.appendChild(line);
	el.selectCount.textContent = '0';

	el.hudName.textContent = 'default body';
	el.statsNote.textContent = 'No agent loaded. Pick one from the shelf once the index answers.';
	mountFrame(null);
}

function renderCarts() {
	el.carts.replaceChildren();
	state.agents.forEach((agent, i) => {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = 'cn-chip';
		chip.setAttribute('aria-pressed', String(i === state.index));
		chip.dataset.index = String(i);

		const thumb = document.createElement('img');
		thumb.className = 'cn-chip-thumb';
		thumb.alt = '';
		thumb.loading = 'lazy';
		thumb.decoding = 'async';
		if (agent.avatar_thumbnail) thumb.src = agent.avatar_thumbnail;

		const text = document.createElement('span');
		text.className = 'cn-chip-text';
		const name = document.createElement('span');
		name.className = 'cn-chip-name';
		name.textContent = agent.name;
		const meta = document.createElement('span');
		meta.className = 'cn-chip-meta';
		meta.textContent = cartMeta(agent);
		text.append(name, meta);

		chip.append(thumb, text);
		chip.addEventListener('click', () => selectAgent(i));
		el.carts.appendChild(chip);
	});
}

function cartMeta(agent) {
	const skills = Array.isArray(agent.skills) ? agent.skills.length : 0;
	const chats = Number(agent.chat_count) || 0;
	return `${skills} skills · ${chats} chats`;
}

function renderRoster() {
	el.roster.replaceChildren();
	state.agents.forEach((agent, i) => {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'cn-roster-item';
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', String(i === state.rosterCursor));
		const name = document.createElement('span');
		name.className = 'cn-roster-name';
		name.textContent = agent.name;
		const meta = document.createElement('span');
		meta.className = 'cn-roster-meta';
		meta.textContent = i === state.index ? 'LOADED' : `${Number(agent.chat_count) || 0}`;
		row.append(name, meta);
		row.addEventListener('click', () => {
			state.rosterCursor = i;
			selectAgent(i);
		});
		el.roster.appendChild(row);
	});
	el.selectCount.textContent = String(state.agents.length);
}

function moveRosterCursor(delta) {
	if (!state.agents.length) return;
	const next = (state.rosterCursor + delta + state.agents.length) % state.agents.length;
	state.rosterCursor = next;
	const rows = el.roster.querySelectorAll('.cn-roster-item');
	rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === next)));
	rows[next]?.scrollIntoView({ block: 'nearest' });
	announce(`${state.agents[next].name} highlighted`);
}

// ── agent selection ───────────────────────────────────────────────────────

function selectAgent(index, { boot = false } = {}) {
	if (!state.agents.length) return;
	const i = ((index % state.agents.length) + state.agents.length) % state.agents.length;
	const changed = i !== state.index;
	state.index = i;
	state.rosterCursor = i;
	const agent = state.agents[i];

	el.carts.querySelectorAll('.cn-chip').forEach((chip) => {
		chip.setAttribute('aria-pressed', String(Number(chip.dataset.index) === i));
	});
	renderRoster();
	el.hudName.textContent = agent.name;
	el.modelLine.textContent = `cartridge ${String(i + 1).padStart(2, '0')}`;
	announce(`${agent.name} loaded`);
	syncUrl();
	renderEmbed();
	loadDetail(agent.id);

	if (boot || !state.frame) {
		bootBody(agent);
		return;
	}
	if (!changed) return;
	swapBody(agent);
}

// First mount for an agent: read its record first so the screen can be handed
// the avatar id (same-origin GLB proxy) instead of the agent id (raw R2 URL).
// A failed read still boots, just through the server-side resolve.
async function bootBody(agent) {
	showBoot(`Loading ${agent.name}`);
	try {
		await detailFor(agent.id);
	} catch {
		state.detailFor = null;
	}
	if (currentAgent()?.id !== agent.id) return;
	mountFrame(agent.id);
}

// Swap the body without reloading the screen when we know the avatar id; fall
// back to a full remount (which resolves the agent server-side) when we do not.
async function swapBody(agent) {
	showBoot(`Loading ${agent.name}`);
	clearTimeout(state.swapTimer);
	let avatarId = null;
	try {
		avatarId = (await detailFor(agent.id))?.avatar_id || null;
	} catch {
		avatarId = null;
	}
	if (!avatarId) {
		mountFrame(agent.id);
		return;
	}
	el.hudName.textContent = agent.name;
	if (currentAgent()?.id !== agent.id) return;
	post('walk:avatar', { avatarId });
	state.swapTimer = setTimeout(() => {
		if (currentAgent()?.id === agent.id) mountFrame(agent.id);
	}, SWAP_TIMEOUT_MS);
}

// One request per agent, shared by the stats cartridge and the body swap that
// happen in the same tick; a failed read is not cached so Retry can refetch.
const detailCache = new Map();

function detailFor(id) {
	if (state.detailFor === id && state.detail) return Promise.resolve(state.detail);
	const pending = detailCache.get(id);
	if (pending) return pending;
	const req = fetch(`/api/agents/${encodeURIComponent(id)}`, {
		headers: { accept: 'application/json' },
	})
		.then(async (res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			const rec = body?.agent || body;
			state.detail = rec;
			state.detailFor = id;
			return rec;
		})
		.catch((err) => {
			detailCache.delete(id);
			throw err;
		});
	detailCache.set(id, req);
	return req;
}

async function loadDetail(id) {
	el.statsId.textContent = id.slice(0, 8);
	el.statsNote.textContent = 'Reading the agent record…';
	el.statsList.replaceChildren();
	try {
		const rec = await detailFor(id);
		if (currentAgent()?.id !== id) return;
		renderStats(rec);
	} catch (err) {
		if (currentAgent()?.id !== id) return;
		el.statsList.replaceChildren();
		el.statsNote.textContent = `Could not read this agent (${err?.message || 'network error'}).`;
	}
}

function renderStats(rec) {
	const skills = Array.isArray(rec.skills) ? rec.skills : [];
	const paid = rec.skill_prices ? Object.keys(rec.skill_prices).length : 0;
	const rows = [
		['name', rec.name || 'unnamed'],
		['builder', rec.author_name || 'anonymous'],
		['skills', skills.length ? `${skills.length}` : 'none'],
		['paid skills', paid ? `${paid} · x402` : 'free'],
		['chats', String(rec.chat_count ?? 0)],
		['body', rec.avatar_id ? 'rigged 3D' : 'default'],
		['on-chain', rec.erc8004_agent_id ? `#${rec.erc8004_agent_id}` : 'off-chain'],
		['born', rec.created_at ? new Date(rec.created_at).toISOString().slice(0, 10) : 'unknown'],
	];
	el.statsList.replaceChildren();
	for (const [label, value] of rows) {
		const row = document.createElement('div');
		row.className = 'cn-stat-row';
		const dt = document.createElement('dt');
		dt.textContent = label;
		const dd = document.createElement('dd');
		dd.textContent = value;
		row.append(dt, dd);
		el.statsList.appendChild(row);
	}
	const desc = (rec.description || '').trim();
	el.statsNote.textContent = desc
		? desc.length > 220
			? `${desc.slice(0, 217)}...`
			: desc
		: 'This agent shipped without a description.';
}

// ── cartridges, scene, shell, power ───────────────────────────────────────

function setCart(cart) {
	if (!CARTS.includes(cart)) return;
	state.cart = cart;
	el.device.querySelectorAll('.cn-panel').forEach((panel) => {
		panel.dataset.active = panel.dataset.cart === cart ? '1' : '0';
	});
	el.screenPlay.style.display = cart === 'play' ? '' : 'none';
	el.hudCart.textContent = cart;
	document.querySelectorAll('[data-cart]').forEach((tab) => {
		if (tab.classList.contains('cn-tab')) {
			tab.setAttribute('aria-pressed', String(tab.dataset.cart === cart));
		}
	});
	if (cart !== 'play') releaseAll();
	announce(`${cart} cartridge`);
	syncUrl();
}

function setEnv(env) {
	if (!ENVS.includes(env)) return;
	state.env = env;
	post('walk:env', { env });
	document.querySelectorAll('[data-env]').forEach((tab) => {
		tab.setAttribute('aria-pressed', String(tab.dataset.env === env));
	});
	announce(`${env} scene`);
	syncUrl();
	renderEmbed();
}

function setShell(shell) {
	if (!SHELLS.includes(shell)) return;
	state.shell = shell;
	el.device.dataset.shell = shell;
	document.querySelectorAll('[data-shell].cn-tab').forEach((tab) => {
		tab.setAttribute('aria-pressed', String(tab.dataset.shell === shell));
	});
	syncUrl();
	renderEmbed();
}

function setPower(on) {
	state.power = on;
	el.device.dataset.power = on ? 'on' : 'off';
	if (!on) {
		releaseAll();
		hideBoot();
		// A screen that is off must actually stop rendering, so the WebGL
		// context goes away with the frame rather than idling behind an opacity.
		setTimeout(() => {
			if (!state.power) unmountFrame();
		}, 300);
		announce('console off');
		return;
	}
	const agent = currentAgent();
	mountFrame(agent ? agent.id : null);
	announce('console on');
}

// ── input ─────────────────────────────────────────────────────────────────

function pushVector() {
	let x = (held.right ? 1 : 0) - (held.left ? 1 : 0);
	let y = (held.up ? 1 : 0) - (held.down ? 1 : 0);
	const mag = Math.hypot(x, y);
	if (mag > 1) {
		x /= mag;
		y /= mag;
	}
	const run = held.run && mag > 0;
	if (x === lastVector.x && y === lastVector.y && run === lastVector.run) return;
	lastVector = { x, y, run };
	post('walk:move', { x, y, run });
}

function setDir(dir, down) {
	if (!(dir in held)) return;
	if (state.cart === 'select') {
		if (!down) return;
		if (dir === 'up') moveRosterCursor(-1);
		if (dir === 'down') moveRosterCursor(1);
		return;
	}
	if (state.cart !== 'play' || !state.power) return;
	held[dir] = down;
	paintDir(dir, down);
	pushVector();
}

function paintDir(dir, down) {
	const btn = el.device.querySelector(`.cn-dir[data-dir="${dir}"]`);
	if (btn) btn.dataset.held = down ? '1' : '0';
}

function releaseAll() {
	for (const key of ['up', 'down', 'left', 'right']) {
		held[key] = false;
		paintDir(key, false);
	}
	held.run = false;
	pushVector();
}

function pressFace(btn) {
	if (!state.power) return;
	if (btn === 'a') {
		if (state.cart === 'select') {
			selectAgent(state.rosterCursor);
			setCart('play');
			return;
		}
		post('walk:gesture', { gesture: 'wave' });
		announce('wave');
		return;
	}
	if (btn === 'b') {
		if (state.cart !== 'play') {
			setCart('play');
			return;
		}
		post('walk:gesture', { gesture: 'jump' });
		announce('jump');
	}
}

function flash(selector) {
	const node = el.device.querySelector(selector);
	if (!node) return;
	node.dataset.held = '1';
	setTimeout(() => {
		node.dataset.held = '0';
	}, 140);
}

function nextCart() {
	setCart(CARTS[(CARTS.indexOf(state.cart) + 1) % CARTS.length]);
}

function nextEnv() {
	setEnv(ENVS[(ENVS.indexOf(state.env) + 1) % ENVS.length]);
}

// Pointer: press and hold anywhere on a control.
el.device.querySelectorAll('.cn-dir').forEach((btn) => {
	const dir = btn.dataset.dir;
	btn.addEventListener('pointerdown', (e) => {
		btn.setPointerCapture(e.pointerId);
		setDir(dir, true);
	});
	const up = () => setDir(dir, false);
	btn.addEventListener('pointerup', up);
	btn.addEventListener('pointercancel', up);
	btn.addEventListener('pointerleave', up);
	btn.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			setDir(dir, true);
		}
	});
	btn.addEventListener('keyup', (e) => {
		if (e.key === 'Enter' || e.key === ' ') setDir(dir, false);
	});
});

el.device.querySelectorAll('.cn-face-btn').forEach((btn) => {
	btn.addEventListener('click', () => pressFace(btn.dataset.btn));
});

el.device.querySelectorAll('.cn-menu-btn').forEach((btn) => {
	btn.addEventListener('click', () => {
		if (btn.dataset.btn === 'start') nextCart();
		else nextEnv();
	});
});

document.getElementById('cn-l').addEventListener('click', () => selectAgent(state.index - 1));
document.getElementById('cn-r').addEventListener('click', () => selectAgent(state.index + 1));

// The power LED doubles as the power switch, the way the real thing does.
el.device.querySelector('.cn-power-led')?.addEventListener('click', () => setPower(!state.power));

const KEY_DIRS = {
	arrowup: 'up',
	w: 'up',
	arrowdown: 'down',
	s: 'down',
	arrowleft: 'left',
	a: 'left',
	arrowright: 'right',
	d: 'right',
};

function typingTarget(target) {
	if (!target) return false;
	const tag = target.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

window.addEventListener('keydown', (e) => {
	if (e.metaKey || e.ctrlKey || e.altKey || typingTarget(e.target)) return;
	const key = e.key.toLowerCase();
	const dir = KEY_DIRS[key];
	if (dir) {
		e.preventDefault();
		setDir(dir, true);
		return;
	}
	if (key === 'shift') {
		held.run = true;
		pushVector();
		return;
	}
	if (key === 'k') {
		flash('.cn-face-btn[data-btn="a"]');
		pressFace('a');
		return;
	}
	if (key === 'j') {
		flash('.cn-face-btn[data-btn="b"]');
		pressFace('b');
		return;
	}
	if (key === 'enter') {
		e.preventDefault();
		flash('.cn-menu-btn[data-btn="start"]');
		nextCart();
		return;
	}
	if (key === ' ') {
		e.preventDefault();
		flash('.cn-menu-btn[data-btn="select"]');
		nextEnv();
		return;
	}
	if (key === 'q') {
		flash('#cn-l');
		selectAgent(state.index - 1);
		return;
	}
	if (key === 'e') {
		flash('#cn-r');
		selectAgent(state.index + 1);
		return;
	}
	if (key === 'p') setPower(!state.power);
});

window.addEventListener('keyup', (e) => {
	const key = e.key.toLowerCase();
	const dir = KEY_DIRS[key];
	if (dir) setDir(dir, false);
	if (key === 'shift') {
		held.run = false;
		pushVector();
	}
});

window.addEventListener('blur', releaseAll);

// ── gamepad ───────────────────────────────────────────────────────────────
// Polled only while a pad is actually connected, so an unused page costs no
// frames. Standard mapping: sticks + D-pad walk, A/B gesture, triggers run,
// shoulders change cartridge, start/select mirror the console's own buttons.

const padPrev = new Map();
let padRaf = 0;

function pollPads() {
	const pads = navigator.getGamepads ? navigator.getGamepads() : [];
	let live = false;
	for (const pad of pads) {
		if (!pad) continue;
		live = true;
		const prev = padPrev.get(pad.index) || {};
		const now = {};
		const ax = pad.axes[0] || 0;
		const ay = pad.axes[1] || 0;
		const dead = 0.22;
		const dpad = {
			up: pad.buttons[12]?.pressed || ay < -dead,
			down: pad.buttons[13]?.pressed || ay > dead,
			left: pad.buttons[14]?.pressed || ax < -dead,
			right: pad.buttons[15]?.pressed || ax > dead,
		};
		for (const dir of ['up', 'down', 'left', 'right']) {
			now[dir] = dpad[dir];
			if (dpad[dir] !== !!prev[dir]) setDir(dir, dpad[dir]);
		}
		const run = !!(pad.buttons[6]?.pressed || pad.buttons[7]?.pressed);
		if (run !== !!prev.run && state.cart === 'play') {
			held.run = run;
			pushVector();
		}
		now.run = run;

		const edge = (i, fn) => {
			const pressed = !!pad.buttons[i]?.pressed;
			now[`b${i}`] = pressed;
			if (pressed && !prev[`b${i}`]) fn();
		};
		edge(0, () => {
			flash('.cn-face-btn[data-btn="a"]');
			pressFace('a');
		});
		edge(1, () => {
			flash('.cn-face-btn[data-btn="b"]');
			pressFace('b');
		});
		edge(4, () => {
			flash('#cn-l');
			selectAgent(state.index - 1);
		});
		edge(5, () => {
			flash('#cn-r');
			selectAgent(state.index + 1);
		});
		edge(8, () => {
			flash('.cn-menu-btn[data-btn="select"]');
			nextEnv();
		});
		edge(9, () => {
			flash('.cn-menu-btn[data-btn="start"]');
			nextCart();
		});
		padPrev.set(pad.index, now);
	}
	el.gamepadPill.dataset.on = live ? '1' : '0';
	padRaf = live ? requestAnimationFrame(pollPads) : 0;
}

window.addEventListener('gamepadconnected', () => {
	el.gamepadPill.dataset.on = '1';
	announce('controller connected');
	if (!padRaf) padRaf = requestAnimationFrame(pollPads);
});

window.addEventListener('gamepaddisconnected', (e) => {
	padPrev.delete(e.gamepad?.index);
	releaseAll();
});

// ── tilt ──────────────────────────────────────────────────────────────────

if (canHover && !reduceMotion) {
	const stage = el.device.parentElement;
	stage.addEventListener('pointermove', (e) => {
		const rect = el.device.getBoundingClientRect();
		const px = (e.clientX - rect.left) / rect.width - 0.5;
		const py = (e.clientY - rect.top) / rect.height - 0.5;
		el.device.style.transform = `rotateX(${(-py * TILT_MAX_DEG).toFixed(2)}deg) rotateY(${(px * TILT_MAX_DEG).toFixed(2)}deg)`;
	});
	stage.addEventListener('pointerleave', () => {
		el.device.style.transform = '';
	});
}

// ── share, embed, url state ───────────────────────────────────────────────

function shareUrl() {
	const agent = currentAgent();
	const q = new URLSearchParams();
	if (agent) q.set('agent', agent.id);
	q.set('shell', state.shell);
	q.set('env', state.env);
	return `${location.origin}/console?${q.toString()}`;
}

function embedCode() {
	const url = new URL(shareUrl());
	url.searchParams.set('chrome', 'off');
	const agent = currentAgent();
	const title = agent ? `${agent.name} on three.ws` : 'three.ws Agent Console';
	return `<iframe src="${url.toString()}" width="440" height="700" title="${title}" style="border:0;background:transparent" allow="xr-spatial-tracking" loading="lazy"></iframe>`;
}

function renderEmbed() {
	if (el.embedCode) el.embedCode.textContent = embedCode();
}

function syncUrl() {
	if (chromeOff) return;
	const url = new URL(location.href);
	const agent = currentAgent();
	if (agent) url.searchParams.set('agent', agent.id);
	url.searchParams.set('shell', state.shell);
	url.searchParams.set('env', state.env);
	if (state.cart !== 'play') url.searchParams.set('cart', state.cart);
	else url.searchParams.delete('cart');
	history.replaceState(null, '', url);
}

async function copy(text, message) {
	try {
		await navigator.clipboard.writeText(text);
		toast(message);
	} catch {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand('copy');
		area.remove();
		toast(ok ? message : 'Copy failed. Select the text and copy it manually.');
	}
}

let toastTimer = 0;
function toast(message) {
	el.toast.textContent = message;
	el.toast.dataset.on = '1';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.toast.dataset.on = '0';
	}, 2600);
}

function announce(message) {
	el.live.textContent = message;
}

document.getElementById('cn-share')?.addEventListener('click', () => {
	copy(shareUrl(), 'Share link copied.');
});

document.getElementById('cn-copy-embed')?.addEventListener('click', () => {
	copy(embedCode(), 'Embed code copied.');
});

document.getElementById('cn-post')?.addEventListener('click', () => {
	const agent = currentAgent();
	const who = agent ? agent.name : 'My agent';
	const text = `${who} lives in a handheld now. Real 3D, the D-pad actually works, built on @trythreews`;
	const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl())}`;
	window.open(url, '_blank', 'noopener');
});

document.querySelectorAll('.cn-tab[data-shell]').forEach((tab) => {
	tab.addEventListener('click', () => setShell(tab.dataset.shell));
});
document.querySelectorAll('.cn-tab[data-cart]').forEach((tab) => {
	tab.addEventListener('click', () => setCart(tab.dataset.cart));
});
document.querySelectorAll('.cn-tab[data-env]').forEach((tab) => {
	tab.addEventListener('click', () => setEnv(tab.dataset.env));
});

// ── boot ──────────────────────────────────────────────────────────────────

if (chromeOff) document.body.dataset.chrome = 'off';
setShell(state.shell);
setCart(state.cart);
setEnv(state.env);
renderEmbed();
loadRoster();
