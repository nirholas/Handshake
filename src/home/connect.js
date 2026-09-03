/**
 * The connect flow for /smart-home.
 *
 * Gets a stranger from "I have a Home Assistant somewhere" to "my agent is
 * connected", and designs every way that goes wrong. There are eleven states
 * and a missing one is what makes a product feel unfinished, so they are
 * enumerated in STATE rather than implied by whichever branch happened to run.
 *
 * Three rules this module holds and never bends:
 *
 *   1. The access token goes to the server exactly once and never comes back.
 *      It is never written to localStorage, never put in a URL, never logged,
 *      and never echoed by the API. The field is cleared the moment a connect
 *      succeeds.
 *   2. Reachability is decided in the browser, before the network. A
 *      192.168.x.x or .local address cannot be reached by three.ws no matter
 *      how long we wait, so we say so immediately instead of spending fifteen
 *      seconds arriving at a worse version of the same sentence.
 *   3. Every string that came from a house (a label, a room, an entity, an
 *      error) is rendered as text. Entity and area names are attacker
 *      influenced, they flow into a page and into a model prompt, and there is
 *      a physical actuator on the other end.
 */

// The `/url` subpath, not the package root: url.js is pure string handling, and
// importing it directly keeps the Home Assistant WebSocket client and the MCP
// SDK (both behind the root export) out of this page's bundle. The same
// functions the server validates with, so the two cannot disagree.
import { isPrivateHost, normalizeBaseUrl } from '@three-ws/home-bridge/url';

import { renderManage } from './manage.js';

/** The eleven states. Each one has a designed treatment; none falls through. */
export const STATE = Object.freeze({
	SIGNED_OUT: 'signed_out',
	EMPTY: 'empty',
	VALIDATING: 'validating',
	PRIVATE_HOST: 'private_host',
	VERIFYING: 'verifying',
	CONNECTED: 'connected',
	AUTH_FAILED: 'auth_failed',
	UNREACHABLE: 'unreachable',
	DEGRADED: 'degraded',
	REVOKED: 'revoked',
	MANY: 'many',
	/**
	 * Not in the original eleven: the plan ceiling. It surfaced the first time a
	 * second house was connected on a free account, and it needs its own
	 * treatment because the recovery is commercial, not technical: sending
	 * someone back to re-check a URL that was never wrong is the worst possible
	 * answer to "you have run out of homes".
	 */
	QUOTA_REACHED: 'quota_reached',
});

/** Where Home Assistant hides the token minting screen. Never make anyone hunt. */
const TOKEN_PATH = 'Profile, Security, Long-lived access tokens, Create token';

const root = document.getElementById('hm-root');

/** Session-lived only: never persisted, so a reload re-reads it from the server. */
let csrfToken = '';

boot();

async function boot() {
	if (!root) return;
	try {
		const homes = await listHomes();
		if (homes === null) return render(STATE.SIGNED_OUT);
		renderHomes(homes);
	} catch (err) {
		// The list failing is not the connect flow failing: offer the connect card
		// with the reason attached, so a stranger is never staring at a dead page.
		render(STATE.EMPTY, { notice: { tone: 'error', title: 'We could not load your homes.', body: messageOf(err) } });
	}
}

function renderHomes(homes) {
	if (!homes.length) return render(STATE.EMPTY);
	render(homes.length > 1 ? STATE.MANY : STATE.CONNECTED, { homes });
}

// ── The renderer ────────────────────────────────────────────────────────────

/**
 * Render one state. Every path in the flow ends in exactly one call to this, so
 * "which state am I in" is always answerable and never implicit.
 */
function render(state, data = {}) {
	root.setAttribute('aria-busy', state === STATE.VERIFYING ? 'true' : 'false');
	root.dataset.state = state;
	clear(root);

	switch (state) {
		case STATE.SIGNED_OUT: return root.append(signedOut());
		case STATE.EMPTY: return root.append(connectCard(data));
		case STATE.PRIVATE_HOST: return root.append(connectCard(data));
		case STATE.VERIFYING: return root.append(verifying(data));
		case STATE.AUTH_FAILED: return root.append(connectCard(data));
		case STATE.UNREACHABLE: return root.append(connectCard(data));
		case STATE.REVOKED: return root.append(connectCard(data));
		case STATE.QUOTA_REACHED: return root.append(quotaCard(data));
		case STATE.CONNECTED:
		case STATE.DEGRADED:
		case STATE.MANY:
			return root.append(renderManage({ homes: data.homes || [], notice: data.notice, onDisconnect: disconnect, onReconnect: showConnectCard }));
		default:
			return root.append(connectCard(data));
	}
}

// ── State 1: signed out ─────────────────────────────────────────────────────

/**
 * A disabled form is a worse answer than an explanation: it looks broken and it
 * tells a visitor nothing about why the feature is worth signing in for.
 */
function signedOut() {
	const panel = el('section', 'hm-panel');
	panel.append(
		el('h2', 'hm-panel-title', 'Sign in to connect a home'),
		el('p', 'hm-panel-sub', 'Your homes are tied to your three.ws account, because the credential that opens your house is stored encrypted against it and never in this browser.'),
	);

	const list = el('ul', 'hm-ol');
	list.style.listStyle = 'disc';
	for (const line of [
		'Your agent reads every room, light, lock and sensor your instance exposes.',
		'It runs the scenes and scripts you already built, by name.',
		'Locking up, closing and arming never prompt. Unlocking, opening and disarming always do.',
	]) list.append(el('li', '', line));
	panel.append(list);

	const actions = el('div', 'hm-actions');
	actions.style.marginTop = 'var(--space-md)';
	const signIn = el('a', 'hm-btn hm-btn-primary', 'Sign in');
	signIn.href = `/login?next=${encodeURIComponent('/smart-home')}`;
	const learn = el('a', 'hm-btn hm-btn-ghost', 'How it works');
	learn.href = '/docs/smart-home';
	actions.append(signIn, learn);
	panel.append(actions);
	return panel;
}

// ── States 2, 4, 7, 8, 10: the connect card and its failures ────────────────

/**
 * One card serves the empty state and every recoverable failure, because they
 * differ only in the notice above the fields and in which field takes focus.
 * Rebuilding a different card per failure is how the states drift apart.
 */
function connectCard({ notice, values = {}, focus } = {}) {
	const panel = el('section', 'hm-panel');
	const head = el('div', 'hm-panel-head');
	const heading = el('div');
	heading.append(
		el('h2', 'hm-panel-title', 'Connect a Home Assistant'),
		el('p', 'hm-panel-sub', 'Everything runs against your own instance. three.ws stores the address and an access token, encrypted, and nothing else about your house.'),
	);
	head.append(heading);
	panel.append(head);

	if (notice) panel.append(noticeEl(notice));

	const form = el('form', 'hm-form');
	form.noValidate = true;

	const label = field({
		id: 'hm-label',
		label: 'What do you call it?',
		hint: 'Shown in your agent and in the action log. "Home", "The office", anything.',
		value: values.label || '',
		attrs: { type: 'text', maxlength: '120', autocomplete: 'off', placeholder: 'Home' },
	});

	const url = field({
		id: 'hm-url',
		label: 'Your Home Assistant address',
		hint: 'The https URL you use from outside the house: Home Assistant Cloud, or your own reverse proxy.',
		value: values.baseUrl || '',
		attrs: { type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://your-home.ui.nabu.casa' },
	});

	const token = tokenField(values.token || '');

	form.append(label.wrap, url.wrap, token.wrap);

	const actions = el('div', 'hm-actions');
	const submit = el('button', 'hm-btn hm-btn-primary', 'Connect this home');
	submit.type = 'submit';
	actions.append(submit);
	form.append(actions);

	// State 3: validate as they type, before anything touches the network. The
	// message appears under the field the moment the address is unreachable in
	// principle, which is the only honest time to say it.
	const liveValidate = () => {
		const verdict = checkReachable(url.input.value);
		url.input.setAttribute('aria-invalid', verdict.ok || !url.input.value.trim() ? 'false' : 'true');
		setInlineError(url, verdict.ok ? '' : verdict.short);
	};
	url.input.addEventListener('input', liveValidate);
	url.input.addEventListener('blur', liveValidate);

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		submitConnect({ form, label: label.input, url: url.input, token: token.input, submit });
	});

	panel.append(form);
	panel.append(tokenHelp());

	// Focus lands on the field that has to change, not back at the top of the
	// form, so keyboard users are not made to walk the whole card again.
	queueMicrotask(() => {
		const target = focus === 'token' ? token.input : focus === 'url' ? url.input : focus === 'label' ? label.input : null;
		if (target) {
			target.focus();
			if (typeof target.select === 'function' && focus === 'token') target.select();
		}
	});

	return panel;
}

/**
 * The plan ceiling. No form: re-submitting the same house would hit the same
 * wall, so the card offers only the two actions that actually change the answer.
 */
function quotaCard({ notice, upgrade } = {}) {
	const panel = el('section', 'hm-panel');
	panel.append(el('h2', 'hm-panel-title', 'This account is at its home limit'));
	if (notice) panel.append(noticeEl(notice));

	const actions = el('div', 'hm-actions');
	const up = el('a', 'hm-btn hm-btn-primary', 'See the plans');
	up.href = typeof upgrade === 'string' && upgrade.startsWith('/') ? upgrade : '/pricing';
	const back = el('button', 'hm-btn hm-btn-ghost', 'Back to my homes');
	back.type = 'button';
	back.addEventListener('click', () => boot());
	actions.append(up, back);
	panel.append(actions);
	queueMicrotask(() => up.focus());
	return panel;
}

/** Where to get a token, inline, so nobody has to go and search for it. */
function tokenHelp() {
	const wrap = el('details', 'hm-panel');
	wrap.style.marginTop = 'var(--space-md)';
	wrap.style.background = 'transparent';
	const summary = el('summary', '', 'Where do I get an access token?');
	summary.style.cursor = 'pointer';
	summary.style.fontWeight = 'var(--weight-medium)';
	wrap.append(summary);

	const steps = el('ol', 'hm-ol');
	for (const step of [
		'Open your Home Assistant and click your user name at the bottom of the sidebar.',
		'Go to the Security tab.',
		'Scroll to Long-lived access tokens and choose Create token.',
		'Name it "three.ws" and copy the token. Home Assistant shows it once.',
	]) steps.append(el('li', '', step));
	wrap.append(steps);

	const note = el('p', 'hm-hint', 'The token is encrypted before it is stored and is never sent back to this page. Deleting it in Home Assistant revokes our access immediately, whatever we hold.');
	note.style.marginTop = 'var(--space-sm)';
	wrap.append(note);
	return wrap;
}

// ── State 5: verifying ──────────────────────────────────────────────────────

/**
 * Named steps, not a bare spinner and not a fake progress bar: each line flips
 * when that step actually completes, so the screen never claims progress it did
 * not make.
 */
function verifying({ steps = [], onCancel } = {}) {
	const panel = el('section', 'hm-panel');
	panel.append(
		el('h2', 'hm-panel-title', 'Opening a connection to your home'),
		el('p', 'hm-panel-sub', 'This runs against your instance directly. It usually takes a second or two.'),
	);

	const list = el('ul', 'hm-steps');
	for (const step of steps) {
		const li = el('li', 'hm-step');
		li.dataset.state = step.state;
		const mark = el('span', 'hm-step-mark', step.state === 'done' ? '✓' : '');
		mark.setAttribute('aria-hidden', 'true');
		li.append(mark, el('span', '', step.text));
		list.append(li);
	}
	panel.append(list);

	const actions = el('div', 'hm-actions');
	actions.style.marginTop = 'var(--space-md)';
	const cancel = el('button', 'hm-btn hm-btn-ghost', 'Cancel');
	cancel.type = 'button';
	cancel.addEventListener('click', () => onCancel && onCancel());
	actions.append(cancel);
	panel.append(actions);
	return panel;
}

// ── Submit ──────────────────────────────────────────────────────────────────

async function submitConnect({ form, label, url, token, submit }) {
	const values = { label: label.value.trim(), baseUrl: url.value.trim(), token: token.value };

	if (!values.baseUrl) {
		return render(STATE.EMPTY, {
			values: { label: values.label },
			focus: 'url',
			notice: { tone: 'error', title: 'Add your Home Assistant address.', body: 'It is the https URL you use to reach your house from outside it.' },
		});
	}
	if (!values.token) {
		return render(STATE.EMPTY, {
			values: { label: values.label, baseUrl: values.baseUrl },
			focus: 'token',
			notice: { tone: 'error', title: 'Add a long-lived access token.', body: `Create one in Home Assistant under ${TOKEN_PATH}.` },
		});
	}

	// State 4: the refusal that costs no network call at all.
	const verdict = checkReachable(values.baseUrl);
	if (!verdict.ok) {
		return render(STATE.PRIVATE_HOST, {
			values: { label: values.label, baseUrl: values.baseUrl },
			focus: 'url',
			notice: verdict.notice,
		});
	}

	submit.disabled = true;
	form.setAttribute('aria-busy', 'true');

	const controller = new AbortController();
	const steps = [
		{ text: 'Checking the address', state: 'done' },
		{ text: 'Opening a connection to your home', state: 'active' },
		{ text: 'Reading your rooms and devices', state: 'pending' },
		{ text: 'Checking for the Model Context Protocol server', state: 'pending' },
	];
	render(STATE.VERIFYING, { steps, onCancel: () => controller.abort() });

	try {
		const home = await connectHome(values, controller.signal);
		// The token has done its one job. Drop it before anything else can read it.
		values.token = '';
		const homes = await listHomes();
		renderHomes(homes && homes.length ? homes : [home]);
	} catch (err) {
		if (err?.name === 'AbortError') {
			return render(STATE.EMPTY, {
				values: { label: values.label, baseUrl: values.baseUrl },
				focus: 'url',
				notice: { tone: 'info', title: 'Cancelled.', body: 'Nothing was stored. Try again whenever you are ready.' },
			});
		}
		renderFailure(err, values);
	}
}

/** Maps the API error contract onto the designed failure states. */
function renderFailure(err, values) {
	const code = err?.code || 'call_failed';
	const carried = { label: values.label, baseUrl: values.baseUrl };

	// State 7: a wrong token is a specific, fixable thing. Say which thing.
	if (code === 'auth') {
		return render(STATE.AUTH_FAILED, {
			values: carried,
			focus: 'token',
			notice: {
				tone: 'error',
				title: 'Home Assistant rejected that token.',
				body: `Tokens are one per line and easy to truncate on copy. Create a fresh one under ${TOKEN_PATH}, then paste the whole string.`,
			},
		});
	}

	// State 8: distinguish "wrong address" from "the house is not answering".
	if (code === 'unreachable') {
		return render(STATE.UNREACHABLE, {
			values: carried,
			focus: 'url',
			notice: {
				tone: 'error',
				title: 'We could not reach that address.',
				body: messageOf(err),
				bullets: [
					'If the address is right, check the house is online and reachable from outside your network.',
					'If it is only reachable at home, three.ws cannot route to it. The add-on that dials out from inside your network is the path for that.',
				],
			},
		});
	}

	if (code === 'bad_url') {
		return render(STATE.EMPTY, {
			values: carried,
			focus: 'url',
			notice: { tone: 'error', title: 'That address does not look right.', body: messageOf(err) },
		});
	}

	// A plan ceiling is not a failure of the address or the token, so it must not
	// send the user back to re-check either. It is a decision with a price on it,
	// and the only useful next action is the upgrade or disconnecting a house.
	if (err?.quota) {
		return render(STATE.QUOTA_REACHED, {
			values: carried,
			notice: {
				tone: 'warn',
				title: quotaTitle(err.quota),
				body: messageOf(err),
				bullets: [
					'Disconnect a home you no longer use and this one will connect.',
					'Or move to a plan that carries more homes.',
				],
			},
			upgrade: err.quota.upgrade || '/pricing',
		});
	}

	return render(STATE.EMPTY, {
		values: carried,
		focus: 'url',
		notice: { tone: 'error', title: 'That did not work.', body: messageOf(err) },
	});
}

function quotaTitle(quota) {
	const limit = Number(quota?.limit);
	if (!Number.isFinite(limit)) return 'Your plan is at its limit for homes.';
	return `Your plan covers ${limit} ${limit === 1 ? 'home' : 'homes'}.`;
}

function showConnectCard(notice) {
	render(STATE.EMPTY, notice ? { notice } : {});
}

// ── Reachability, decided here, before the network ──────────────────────────

/**
 * The whole point of running this in the browser: a LAN address is unreachable
 * by definition, and telling someone that in the same keystroke beats timing out
 * fifteen seconds later with a vaguer version of the same sentence.
 */
export function checkReachable(input) {
	const raw = String(input || '').trim();
	if (!raw) return { ok: true, short: '' };

	let parsed;
	try {
		// requireSecure is the same flag api/home/index.js passes, so the browser
		// and the server agree on what is reachable instead of one of them
		// accepting an address the other will refuse. It exempts loopback, which
		// is how a developer running Home Assistant on this machine still works.
		parsed = normalizeBaseUrl(raw, { requireSecure: true });
	} catch (err) {
		const badScheme = /plain http/i.test(err?.message || '');
		return {
			ok: false,
			short: badScheme ? 'A plain http address cannot be reached from this page.' : 'That is not a web address we can use.',
			notice: badScheme
				? {
					tone: 'warn',
					title: 'That is a plain http address.',
					body: 'This page is served over https, and a browser will not open an unencrypted connection from it. Use the https address for your house.',
				}
				: { tone: 'error', title: 'That address does not look right.', body: err?.message || 'Use the full https URL of your Home Assistant.' },
		};
	}

	const host = new URL(parsed.http).hostname;
	if (isPrivateHost(host) && !parsed.loopback) {
		return {
			ok: false,
			short: `${host} is only on your home network.`,
			notice: {
				tone: 'warn',
				title: `${host} is an address on your home network.`,
				body: 'three.ws runs on the public internet, so it cannot reach an address that only exists inside your house. There are two real ways round it.',
				bullets: [
					'Use your remote https address instead. Home Assistant Cloud gives you one, and so does your own reverse proxy. That works today, with the token you already have.',
					'Or install the three.ws add-on inside your Home Assistant, which dials out to us so nothing has to be exposed to the internet.',
				],
			},
		};
	}

	return { ok: true, short: '' };
}

// ── API ─────────────────────────────────────────────────────────────────────

/** @returns {Promise<object[]|null>} null when there is no session at all. */
async function listHomes() {
	const res = await fetch('/api/home', { credentials: 'include', headers: { accept: 'application/json' } });
	if (res.status === 401) return null;
	const body = await readJson(res);
	if (!res.ok) throw apiError(body, res);
	return Array.isArray(body?.homes) ? body.homes : [];
}

async function connectHome({ label, baseUrl, token }, signal) {
	const res = await fetch('/api/home', {
		method: 'POST',
		credentials: 'include',
		signal,
		headers: { 'content-type': 'application/json', accept: 'application/json', ...(await csrfHeader()) },
		body: JSON.stringify({ label, baseUrl, token }),
	});
	const body = await readJson(res);
	if (!res.ok) throw apiError(body, res);
	return body?.home || body;
}

async function disconnect(home) {
	const res = await fetch(`/api/home/${encodeURIComponent(home.id)}`, {
		method: 'DELETE',
		credentials: 'include',
		headers: { accept: 'application/json', ...(await csrfHeader()) },
	});
	const body = await readJson(res);
	if (!res.ok) throw apiError(body, res);

	// State 10: say plainly what happened to the stored credential.
	const homes = await listHomes();
	const notice = {
		tone: 'ok',
		title: `${home.label} is disconnected.`,
		body: 'The access token we held has been erased. Delete the token in Home Assistant too if you want it gone on both sides, under ' + TOKEN_PATH + '.',
	};
	if (homes && homes.length) render(homes.length > 1 ? STATE.MANY : STATE.CONNECTED, { homes, notice });
	else render(STATE.REVOKED, { notice });
}

async function csrfHeader() {
	if (csrfToken) {
		const header = { 'x-csrf-token': csrfToken };
		csrfToken = '';
		return header;
	}
	try {
		const res = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!res.ok) return {};
		const body = await res.json();
		const token = body?.token || body?.data?.token;
		return token ? { 'x-csrf-token': token } : {};
	} catch {
		return {};
	}
}

async function readJson(res) {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

/**
 * The API's coded failure, as an Error the render layer can branch on. The
 * message is whatever the server said, because the server is the only thing
 * that knows whether the token was wrong or the house was asleep.
 */
function apiError(body, res) {
	const err = new Error(body?.message || body?.error_description || body?.error || `Request failed (${res.status}).`);
	err.code = body?.code || (res.status === 404 ? 'not_found' : 'call_failed');
	err.status = res.status;
	// A plan limit answers with a `quota` block naming the dimension, the ceiling
	// and where to lift it. Carrying it here is what lets the card offer the
	// upgrade instead of a dead end.
	if (body?.quota) err.quota = body.quota;
	return err;
}

function messageOf(err) {
	return err?.message || 'Something went wrong reaching your home.';
}

// ── DOM helpers: text only, never innerHTML ─────────────────────────────────

/**
 * Everything rendered through here is `textContent`. Entity names, area names
 * and labels are strings a stranger or a compromised integration can control,
 * and the other end of this page is a physical actuator.
 */
export function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text != null) node.textContent = String(text);
	return node;
}

export function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

export function noticeEl({ tone = 'info', title, body, bullets } = {}) {
	const wrap = el('div', `hm-notice hm-notice-${tone}`);
	wrap.setAttribute('role', tone === 'error' ? 'alert' : 'status');

	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	icon.setAttribute('class', 'hm-notice-icon');
	icon.setAttribute('viewBox', '0 0 16 16');
	icon.setAttribute('aria-hidden', 'true');
	icon.setAttribute('fill', 'currentColor');
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', tone === 'ok'
		? 'M8 0a8 8 0 100 16A8 8 0 008 0zm3.7 5.9l-4.2 5.3a.8.8 0 01-1.2.05L3.9 8.8a.8.8 0 111.2-1l1.8 2 3.6-4.6a.8.8 0 011.2 1z'
		: 'M8 0a8 8 0 100 16A8 8 0 008 0zm0 3.4a1 1 0 011 1v4.2a1 1 0 11-2 0V4.4a1 1 0 011-1zm0 7.3a1.1 1.1 0 110 2.2 1.1 1.1 0 010-2.2z');
	icon.append(path);

	const content = el('div');
	if (title) content.append(el('p', 'hm-notice-title', title));
	if (body) content.append(el('p', 'hm-notice-body', body));
	if (bullets?.length) {
		const ul = el('ul');
		for (const line of bullets) ul.append(el('li', '', line));
		content.append(ul);
	}
	wrap.append(icon, content);
	return wrap;
}

function field({ id, label, hint, value, attrs = {} }) {
	const wrap = el('div', 'hm-field');
	const labelEl = el('label', 'hm-label', label);
	labelEl.htmlFor = id;
	const input = el('input', 'hm-input');
	input.id = id;
	for (const [key, val] of Object.entries(attrs)) input.setAttribute(key, val);
	input.value = value || '';
	const hintEl = el('p', 'hm-hint', hint);
	hintEl.id = `${id}-hint`;
	input.setAttribute('aria-describedby', hintEl.id);
	wrap.append(labelEl, input, hintEl);
	return { wrap, input, hint: hintEl, baseHint: hint };
}

/** Inline, per-field validation text. Replaces the hint rather than stacking. */
function setInlineError(f, message) {
	f.hint.textContent = message || f.baseHint;
	f.hint.style.color = message ? 'var(--hm-down)' : '';
}

/**
 * The token field: a password input with a reveal toggle, no autocomplete, and
 * no path to storage. It is never read back from anywhere but this element.
 */
function tokenField(value) {
	const wrap = el('div', 'hm-field');
	const labelEl = el('label', 'hm-label', 'Long-lived access token');
	labelEl.htmlFor = 'hm-token';

	const shell = el('div', 'hm-secret');
	const input = el('input', 'hm-input');
	input.id = 'hm-token';
	input.type = 'password';
	input.value = value || '';
	input.setAttribute('autocomplete', 'off');
	input.setAttribute('autocapitalize', 'off');
	input.setAttribute('autocorrect', 'off');
	input.setAttribute('spellcheck', 'false');
	input.setAttribute('placeholder', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');

	const toggle = el('button', 'hm-reveal', 'Show');
	toggle.type = 'button';
	toggle.setAttribute('aria-pressed', 'false');
	toggle.addEventListener('click', () => {
		const revealed = input.type === 'text';
		input.type = revealed ? 'password' : 'text';
		toggle.textContent = revealed ? 'Show' : 'Hide';
		toggle.setAttribute('aria-pressed', String(!revealed));
		input.focus();
	});

	shell.append(input, toggle);
	const hintEl = el('p', 'hm-hint', 'Sent to three.ws once, encrypted at rest, and never returned to this page or saved in this browser.');
	hintEl.id = 'hm-token-hint';
	input.setAttribute('aria-describedby', hintEl.id);
	wrap.append(labelEl, shell, hintEl);
	return { wrap, input };
}
