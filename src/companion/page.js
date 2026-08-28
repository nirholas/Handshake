// /companion - the control room for the personal companion.
//
// What this page owns:
//   • the stage: the last delivery, performed by whoever it was from,
//   • the connections (BYOK: bridge token, Telegram bot, iCal URL, IMAP),
//   • the contacts, which decide whose body and voice a message arrives in,
//   • the feed of everything that came in, with the score and the reason,
//   • the settings that decide what is loud enough to interrupt for.
//
// Server truth lives behind /api/companion/* (see api/companion/). Nothing on
// this page is simulated: the "check now" button really polls the user's own
// providers, the test button really posts through the public bridge endpoint,
// and the stage speaks with the same TTS lanes the rest of the platform uses.

import { companionApi } from './api.js';
import { renderSources, esc } from './sources.js';
import { speak, stopSpeaking } from './speak.js';
import { toast } from '../shared/toast.js';
import { enablePush, disablePush, getPushState } from '../push-notifications.js';

const AUTH_HINT_KEY = '3dagent:auth-hint';
const DEFAULT_STAGE_GLB = '/avatars/michelle.glb';
const FEED_PAGE = 20;

const state = {
	settings: null,
	bridge: null,
	voices: [],
	sources: [],
	contacts: [],
	events: [],
	avatars: [],
	feedCursor: null,
	loudOnly: false,
	stageEvent: null,
};

const el = (id) => document.getElementById(id);

function isAuthed() {
	try {
		const raw = localStorage.getItem(AUTH_HINT_KEY);
		return raw ? JSON.parse(raw)?.authed === true : false;
	} catch {
		return false;
	}
}

function showError(message) {
	const box = el('page-error');
	box.textContent = message;
	box.hidden = false;
}

function clearError() {
	el('page-error').hidden = true;
}

// ── Stage ────────────────────────────────────────────────────────────────────

function avatarUrlFor(event) {
	return event?.contact_avatar_glb_url || state.settings?.avatar_glb_url || DEFAULT_STAGE_GLB;
}

function importanceClass(score) {
	if (score >= 80) return 'hot';
	if (score >= 50) return 'mid';
	return '';
}

function renderStage() {
	const event = state.stageEvent;
	const viewer = el('stage-viewer');
	const line = el('stage-line');
	const meta = el('stage-meta');
	const stats = el('stage-stats');
	const sayBtn = el('say-again');

	if (!event) {
		sayBtn.disabled = true;
		line.textContent = 'Waiting for something worth saying.';
		meta.innerHTML = '';
		stats.innerHTML = `
			<div class="hint">
				Once a source is connected, everything it hears is scored here: what it was, who it was from,
				how urgent it looked, and whether that cleared your bar.
			</div>`;
		return;
	}

	sayBtn.disabled = false;
	const url = avatarUrlFor(event);
	const existing = viewer.querySelector('agent-3d');
	if (existing) {
		if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
	} else {
		el('stage-empty')?.remove();
		const node = document.createElement('agent-3d');
		node.setAttribute('src', url);
		node.setAttribute('background', 'transparent');
		node.setAttribute('alt', `${event.contact_name || event.sender || 'Your companion'} delivering a message`);
		viewer.appendChild(node);
		guardStage(node);
	}
	renderStageFace(event);

	line.textContent = event.spoken_line || event.title;
	meta.innerHTML = `
		<span class="chip ${event.importance >= (state.settings?.threshold ?? 60) ? 'ok' : ''}">${event.importance} / 100</span>
		<span>${esc(event.contact_name || event.sender || 'Unknown sender')}</span>
		<span>·</span>
		<span>${esc(event.source_kind)}</span>
		<span>·</span>
		<span>${new Date(event.created_at).toLocaleString()}</span>
	`;
	stats.innerHTML = `
		<div class="hint" style="font-size:13px;line-height:1.6">
			<strong style="color:var(--text)">Why it scored ${event.importance}</strong><br />
			${esc(event.reason || 'no signals recorded')}
		</div>
		<div class="bubble-meta" style="margin-top:12px">
			<span class="meter"><span class="${importanceClass(event.importance)}" style="width:${Math.max(3, event.importance)}%"></span></span>
			<span>${event.triage_engine === 'rules' ? 'scored by rules' : `scored by ${esc(event.triage_engine)}`}</span>
		</div>
		${event.title && event.title !== event.spoken_line ? `<div class="hint" style="margin-top:12px">Original: ${esc(event.title)}</div>` : ''}
	`;
}

// A stage with no body in it is a void, and a void reads as broken. If the 3D
// element never defines (no WebGL, a blocked CDN, an extension that eats module
// scripts) the viewer shows who is speaking instead: their face if they have
// one, their initial if not. The delivery still reads, and still speaks.
const STAGE_ELEMENT_TIMEOUT_MS = 6000;
let stageGuarded = false;

function guardStage(node) {
	if (stageGuarded) return;
	stageGuarded = true;
	Promise.race([
		customElements.whenDefined('agent-3d'),
		new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), STAGE_ELEMENT_TIMEOUT_MS)),
	]).catch(() => {
		node.remove();
		el('stage-viewer').dataset.fallback = '1';
		renderStageFace(state.stageEvent);
	});
}

function renderStageFace(event) {
	const viewer = el('stage-viewer');
	if (viewer.dataset.fallback !== '1' || !event) return;
	const name = event.contact_name || event.sender || 'Your companion';
	viewer.innerHTML = event.contact_avatar_image_url
		? `<img class="stage-face" src="${esc(event.contact_avatar_image_url)}" alt="${esc(name)}" />`
		: `<div class="stage-face stage-face-initial" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</div>`;
	const caption = document.createElement('div');
	caption.className = 'stage-empty';
	caption.textContent = `${name} is speaking. The 3D stage could not start in this browser.`;
	viewer.appendChild(caption);
}

async function sayStage() {
	const event = state.stageEvent;
	if (!event) return;
	const btn = el('say-again');
	btn.disabled = true;
	btn.textContent = 'Speaking…';
	const how = await speak(event.spoken_line || event.title, {
		voice: event.contact_voice || state.settings?.voice || 'alloy',
	});
	btn.disabled = false;
	btn.textContent = 'Say it out loud';
	if (how === 'silent') toast('No voice lane could speak that right now.', { variant: 'error' });
	else if (how === 'browser') toast('Speaking with your browser voice: the hosted lanes were busy.', { variant: 'info' });
	if (how !== 'silent' && !event.delivered_at) {
		companionApi.markEvent(event.id, { delivered: true }).catch(() => {});
	}
}

// ── Feed ─────────────────────────────────────────────────────────────────────

const SOURCE_ICON = { telegram: '✈️', calendar: '📅', email: '✉️', bridge: '📱' };

function renderFeed() {
	const host = el('feed-list');
	if (!state.events.length) {
		host.innerHTML = `
			<div class="empty">
				<h3>Nothing has come in yet</h3>
				<p>Connect a source above, or press "Send a test" on the phone card, and the first delivery lands here within a minute.</p>
			</div>`;
		el('feed-more').hidden = true;
		return;
	}

	host.innerHTML = state.events.map((event) => `
		<div class="event" data-event="${esc(event.id)}">
			<div class="event-icon">${SOURCE_ICON[event.source_kind] || '📨'}</div>
			<div class="event-main">
				<div class="event-line">${esc(event.spoken_line || event.title)}</div>
				<div class="event-sub">
					<span>${esc(event.contact_name || event.sender || 'Unknown')}</span>
					<span class="meter" title="${esc(event.reason || '')}"><span class="${importanceClass(event.importance)}" style="width:${Math.max(3, event.importance)}%"></span></span>
					<span>${event.importance}</span>
					${event.delivered_at ? '<span class="chip ok">spoken</span>' : '<span class="chip">held</span>'}
					<span>${new Date(event.created_at).toLocaleString()}</span>
				</div>
			</div>
			<div class="event-actions">
				<button type="button" class="btn btn-sm" data-feed-action="stage" data-id="${esc(event.id)}">Replay</button>
				${event.dismissed_at ? '' : `<button type="button" class="btn btn-sm" data-feed-action="dismiss" data-id="${esc(event.id)}">Dismiss</button>`}
			</div>
		</div>
	`).join('');
	el('feed-more').hidden = state.events.length < FEED_PAGE;
}

async function loadFeed({ append = false } = {}) {
	const data = await companionApi.events({
		limit: FEED_PAGE,
		before: append ? state.feedCursor : null,
		loudOnly: state.loudOnly,
		threshold: state.settings?.threshold ?? 60,
	});
	state.events = append ? state.events.concat(data.events) : data.events;
	state.feedCursor = state.events.length ? state.events[state.events.length - 1].created_at : null;
	if (!append) {
		state.stageEvent = state.events[0] || null;
		renderStage();
	}
	renderFeed();
	el('feed-more').hidden = !data.has_more;
}

// ── Contacts ─────────────────────────────────────────────────────────────────

function renderContacts() {
	const host = el('contacts-list');
	if (!state.contacts.length) {
		host.innerHTML = `
			<div class="empty" style="padding:32px 12px">
				<h3>Nobody has a face yet</h3>
				<p>Add the people you always want to hear from. Their messages will be delivered by the avatar you give them, in the voice you pick.</p>
			</div>`;
		return;
	}
	host.innerHTML = `<div class="grid">${state.contacts.map((contact) => `
		<div class="contact">
			${contact.avatar_image_url
				? `<img class="contact-face" src="${esc(contact.avatar_image_url)}" alt="" loading="lazy" />`
				: `<div class="contact-face">${esc((contact.display_name || '?').slice(0, 1).toUpperCase())}</div>`}
			<div style="flex:1;min-width:0">
				<div class="contact-name">${esc(contact.display_name)}</div>
				<div class="contact-id">${esc(contact.identifier)}</div>
				<div class="connected-meta">
					${contact.avatar_glb_url ? 'own avatar' : 'default companion'}
					${contact.voice ? ` · ${esc(contact.voice)}` : ''}
					${contact.priority_boost ? ` · priority ${contact.priority_boost > 0 ? '+' : ''}${contact.priority_boost}` : ''}
				</div>
			</div>
			<button type="button" class="btn btn-sm btn-danger" data-contact-delete="${esc(contact.id)}" aria-label="Forget ${esc(contact.display_name)}">Forget</button>
		</div>
	`).join('')}</div>`;
}

function avatarOptions(selected) {
	const options = ['<option value="">Default companion</option>'];
	const urls = new Set();
	for (const avatar of state.avatars) {
		const url = `${location.origin}/api/avatars/${avatar.id}/glb`;
		urls.add(url);
		options.push(`<option value="${esc(url)}"${url === selected ? ' selected' : ''}>${esc(avatar.name || 'Untitled avatar')}</option>`);
	}
	// A body chosen elsewhere (another device, a GLB from the gallery) must not
	// silently read as "Default companion" in this picker.
	if (selected && !urls.has(selected)) {
		options.push(`<option value="${esc(selected)}" selected>Currently set avatar</option>`);
	}
	return options.join('');
}

function voiceOptions(selected, { allowDefault = false } = {}) {
	const options = allowDefault ? ['<option value="">Same as default</option>'] : [];
	for (const voice of state.voices) {
		options.push(`<option value="${esc(voice)}"${voice === selected ? ' selected' : ''}>${esc(voice)}</option>`);
	}
	return options.join('');
}

// ── Settings ─────────────────────────────────────────────────────────────────

function hourOptions(selected, label) {
	const options = [`<option value="">${label}</option>`];
	for (let hour = 0; hour < 24; hour += 1) {
		const text = `${String(hour).padStart(2, '0')}:00`;
		options.push(`<option value="${hour}"${selected === hour ? ' selected' : ''}>${text}</option>`);
	}
	return options.join('');
}

function renderSettings() {
	const settings = state.settings;
	el('threshold').value = String(settings.threshold);
	el('threshold-value').textContent = String(settings.threshold);
	el('quiet-start').innerHTML = hourOptions(settings.quiet_start, 'No quiet hours');
	el('quiet-end').innerHTML = hourOptions(settings.quiet_end, 'No quiet hours');
	el('default-avatar').innerHTML = avatarOptions(settings.avatar_glb_url);
	el('default-voice').innerHTML = voiceOptions(settings.voice);
	el('contact-avatar').innerHTML = avatarOptions(null);
	el('contact-voice').innerHTML = voiceOptions(null, { allowDefault: true });
	el('enabled').checked = settings.enabled;
	el('timezone').value = settings.timezone;
	el('quiet-hint').textContent = settings.quiet_start === null
		? 'Inside this window messages are stored, never spoken.'
		: `Between ${String(settings.quiet_start).padStart(2, '0')}:00 and ${String(settings.quiet_end).padStart(2, '0')}:00 in ${settings.timezone}, messages are stored and stay silent.`;
}

async function patchSettings(patch) {
	try {
		const data = await companionApi.updateSettings(patch);
		state.settings = data.settings;
		renderSettings();
		renderStage();
	} catch (err) {
		toast(err.message, { variant: 'error' });
	}
}

async function refreshPushState() {
	const hint = el('push-hint');
	const box = el('push-enabled');
	const push = await getPushState();
	box.checked = push.subscribed && state.settings.push_enabled;
	box.disabled = !push.supported;
	hint.textContent = !push.supported
		? 'This browser cannot receive push. Install three.ws to your home screen on iOS to enable it.'
		: push.permission === 'denied'
			? 'Notifications are blocked for this site in your browser settings.'
			: push.subscribed
				? 'This device is registered. Deliveries above your bar arrive as a push.'
				: 'Turn this on to get deliveries when this page is closed.';
}

// ── Connections ──────────────────────────────────────────────────────────────

function renderSourceCards() {
	renderSources(el('sources-grid'), { sources: state.sources, bridge: state.bridge });
}

async function reloadSources() {
	const data = await companionApi.sources();
	state.sources = data.sources;
	renderSourceCards();
}

async function connectSource(form) {
	const kind = form.dataset.connect;
	const values = Object.fromEntries(new FormData(form).entries());
	const button = form.querySelector('button[type=submit]');
	const original = button.textContent;
	button.disabled = true;
	button.textContent = 'Connecting…';
	try {
		const body = { kind };
		if (kind === 'telegram') body.bot_token = String(values.bot_token || '').trim();
		if (kind === 'calendar') {
			body.ics_url = String(values.ics_url || '').trim();
			body.lookahead_minutes = Number(values.lookahead_minutes) || 30;
		}
		if (kind === 'email') {
			body.host = String(values.host || '').trim();
			body.port = Number(values.port) || 993;
			body.user = String(values.user || '').trim();
			body.pass = String(values.pass || '');
			body.folder = String(values.folder || 'INBOX').trim() || 'INBOX';
		}
		const data = await companionApi.connect(body);
		toast(data.verification?.detail || 'Connected.', { variant: 'success', duration: 6000 });
		await reloadSources();
	} catch (err) {
		toast(err.message, { variant: 'error', duration: 7000 });
	} finally {
		button.disabled = false;
		button.textContent = original;
	}
}

async function handleSourceAction(action, id, button) {
	const original = button.textContent;
	button.disabled = true;
	try {
		if (action === 'poll') {
			button.textContent = 'Checking…';
			const result = await companionApi.pollSource(id);
			toast(result.ok
				? `Checked. ${result.ingested} new message${result.ingested === 1 ? '' : 's'}.`
				: result.error, { variant: result.ok ? 'success' : 'error', duration: 6000 });
			await Promise.all([reloadSources(), loadFeed()]);
			return;
		}
		if (action === 'toggle') {
			const enabled = button.dataset.enabled !== '1';
			await companionApi.updateSource(id, { enabled });
			await reloadSources();
			return;
		}
		if (action === 'disconnect') {
			if (!confirm('Disconnect this source? The stored credential is deleted.')) return;
			await companionApi.disconnect(id);
			toast('Disconnected.', { variant: 'info' });
			await reloadSources();
		}
	} catch (err) {
		toast(err.message, { variant: 'error', duration: 6000 });
	} finally {
		button.disabled = false;
		button.textContent = original;
	}
}

function curlSnippet() {
	return [
		`curl -X POST ${state.bridge.url} \\`,
		`  -H "Authorization: Bearer ${state.bridge.token}" \\`,
		'  -H "Content-Type: application/json" \\',
		`  -d '{"title":"Sarah is at the door","sender":"Sarah","app":"Messages","priority":"high"}'`,
	].join('\n');
}

async function copyText(text, label) {
	try {
		await navigator.clipboard.writeText(text);
		toast(`${label} copied.`, { variant: 'success' });
	} catch {
		toast('Your browser blocked the clipboard. Select the text and copy it.', { variant: 'error' });
	}
}

// The test really goes through the public bridge endpoint with the real token,
// so a green result here proves the exact path a phone will use.
async function sendBridgeTest(button) {
	const original = button.textContent;
	button.disabled = true;
	button.textContent = 'Sending…';
	try {
		const res = await fetch(state.bridge.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${state.bridge.token}` },
			body: JSON.stringify({
				title: 'Test from your companion setup page',
				body: 'If you can hear this, the bridge works. Anything your phone can forward reaches you the same way.',
				sender: 'three.ws',
				app: 'Companion',
				priority: 'high',
			}),
		});
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(data?.message || `bridge returned ${res.status}`);
		toast(data?.duplicate ? 'Already received that one.' : 'Delivered. It is on stage now.', { variant: 'success' });
		await loadFeed();
	} catch (err) {
		toast(err.message, { variant: 'error', duration: 6000 });
	} finally {
		button.disabled = false;
		button.textContent = original;
	}
}

async function rotateToken(button) {
	if (!confirm('Rotate the bridge token? Every device using the old one stops working until you update it.')) return;
	button.disabled = true;
	try {
		const data = await companionApi.rotateToken();
		state.bridge = data.bridge;
		renderSourceCards();
		toast('New token issued. Update your devices.', { variant: 'info', duration: 6000 });
	} catch (err) {
		toast(err.message, { variant: 'error' });
	} finally {
		button.disabled = false;
	}
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wireEvents() {
	el('check-now').addEventListener('click', async (e) => {
		const button = e.currentTarget;
		button.disabled = true;
		button.textContent = 'Checking…';
		try {
			const result = await companionApi.pollAll();
			const failed = result.sources.filter((s) => !s.ok);
			toast(
				result.sources.length === 0
					? 'Nothing is connected yet. Connect a source below.'
					: `${result.ingested} new message${result.ingested === 1 ? '' : 's'}${failed.length ? `, ${failed.length} source needs attention` : ''}.`,
				{ variant: failed.length ? 'error' : 'success', duration: 6000 },
			);
			await Promise.all([reloadSources(), loadFeed()]);
		} catch (err) {
			toast(err.message, { variant: 'error' });
		} finally {
			button.disabled = false;
			button.textContent = 'Check now';
		}
	});

	el('say-again').addEventListener('click', sayStage);

	el('sources-grid').addEventListener('submit', (e) => {
		const form = e.target.closest('form[data-connect]');
		if (!form) return;
		e.preventDefault();
		connectSource(form);
	});

	el('sources-grid').addEventListener('click', (e) => {
		const button = e.target.closest('button[data-action]');
		if (!button) return;
		const action = button.dataset.action;
		if (action === 'copy-token') return copyText(state.bridge.token, 'Token');
		if (action === 'copy-curl') return copyText(curlSnippet(), 'Example');
		if (action === 'send-test') return sendBridgeTest(button);
		if (action === 'rotate-token') return rotateToken(button);
		return handleSourceAction(action, button.dataset.id, button);
	});

	el('contact-form').addEventListener('submit', async (e) => {
		e.preventDefault();
		const button = e.target.querySelector('button[type=submit]');
		button.disabled = true;
		try {
			const glb = el('contact-avatar').value || null;
			await companionApi.saveContact({
				identifier: el('contact-identifier').value.trim(),
				display_name: el('contact-name').value.trim(),
				avatar_glb_url: glb,
				avatar_image_url: glb ? thumbnailFor(glb) : null,
				voice: el('contact-voice').value || null,
				priority_boost: Number(el('contact-priority').value) || 0,
			});
			el('contact-identifier').value = '';
			el('contact-name').value = '';
			state.contacts = (await companionApi.contacts()).contacts;
			renderContacts();
			toast('Contact saved.', { variant: 'success' });
		} catch (err) {
			toast(err.message, { variant: 'error', duration: 6000 });
		} finally {
			button.disabled = false;
		}
	});

	el('contacts-list').addEventListener('click', async (e) => {
		const button = e.target.closest('button[data-contact-delete]');
		if (!button) return;
		button.disabled = true;
		try {
			await companionApi.deleteContact(button.dataset.contactDelete);
			state.contacts = (await companionApi.contacts()).contacts;
			renderContacts();
		} catch (err) {
			toast(err.message, { variant: 'error' });
			button.disabled = false;
		}
	});

	el('feed-list').addEventListener('click', async (e) => {
		const button = e.target.closest('button[data-feed-action]');
		if (!button) return;
		const event = state.events.find((row) => row.id === button.dataset.id);
		if (!event) return;
		if (button.dataset.feedAction === 'stage') {
			state.stageEvent = event;
			renderStage();
			el('stage-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
			return sayStage();
		}
		button.disabled = true;
		try {
			await companionApi.markEvent(event.id, { dismissed: true });
			event.dismissed_at = new Date().toISOString();
			renderFeed();
		} catch (err) {
			toast(err.message, { variant: 'error' });
			button.disabled = false;
		}
	});

	el('feed-more').addEventListener('click', async (e) => {
		e.currentTarget.disabled = true;
		try {
			await loadFeed({ append: true });
		} finally {
			e.currentTarget.disabled = false;
		}
	});

	el('feed-loud-only').addEventListener('change', async (e) => {
		state.loudOnly = e.currentTarget.checked;
		state.feedCursor = null;
		await loadFeed();
	});

	let thresholdTimer = null;
	el('threshold').addEventListener('input', (e) => {
		const value = Number(e.currentTarget.value);
		el('threshold-value').textContent = String(value);
		clearTimeout(thresholdTimer);
		thresholdTimer = setTimeout(() => patchSettings({ threshold: value }), 400);
	});

	const quietChanged = () => {
		const start = el('quiet-start').value;
		const end = el('quiet-end').value;
		if (start === '' || end === '') return patchSettings({ quiet_start: null, quiet_end: null });
		return patchSettings({ quiet_start: Number(start), quiet_end: Number(end) });
	};
	el('quiet-start').addEventListener('change', quietChanged);
	el('quiet-end').addEventListener('change', quietChanged);

	el('default-avatar').addEventListener('change', (e) => patchSettings({ avatar_glb_url: e.currentTarget.value || null }));
	el('default-voice').addEventListener('change', (e) => patchSettings({ voice: e.currentTarget.value }));
	el('enabled').addEventListener('change', (e) => patchSettings({ enabled: e.currentTarget.checked }));

	el('push-enabled').addEventListener('change', async (e) => {
		const box = e.currentTarget;
		box.disabled = true;
		try {
			if (box.checked) {
				const result = await enablePush();
				if (!result.ok) {
					box.checked = false;
					toast(result.reason === 'denied'
						? 'Your browser is blocking notifications for this site.'
						: 'Push could not be enabled on this device.', { variant: 'error', duration: 6000 });
				} else {
					await patchSettings({ push_enabled: true });
				}
			} else {
				await disablePush();
				await patchSettings({ push_enabled: false });
			}
		} finally {
			box.disabled = false;
			await refreshPushState();
		}
	});

	window.addEventListener('pagehide', stopSpeaking);
}

// The avatar picker stores GLB URLs; the contact card wants a face to show.
// Both come off the same avatar row, so the thumbnail is derivable.
function thumbnailFor(glbUrl) {
	const match = /\/api\/avatars\/([^/]+)\/glb/.exec(glbUrl);
	if (!match) return null;
	const avatar = state.avatars.find((row) => row.id === match[1]);
	return avatar?.thumbnail_url || null;
}

// Signed out: the page becomes an explanation of itself rather than a locked
// door. The two buttons in the hero are for people who already have this set
// up, so they go with the control room.
function showPitch() {
	el('auth-wall').hidden = false;
	el('check-now').hidden = true;
	document.querySelector('.hero p').textContent =
		'A 3D character that walks on and tells you the things worth interrupting you for, from the accounts you already use.';
}

async function boot() {
	if (!isAuthed()) {
		showPitch();
		return;
	}

	try {
		const [settings, sources, contacts, avatars] = await Promise.all([
			companionApi.settings(),
			companionApi.sources(),
			companionApi.contacts(),
			companionApi.avatars().catch(() => ({ avatars: [] })),
		]);
		state.settings = settings.settings;
		state.bridge = settings.bridge;
		state.voices = settings.voices;
		state.sources = sources.sources;
		state.contacts = contacts.contacts;
		state.avatars = avatars.avatars || [];
	} catch (err) {
		if (err.status === 401) {
			showPitch();
			return;
		}
		showError(`Could not load your companion: ${err.message}`);
		return;
	}

	clearError();
	el('main').hidden = false;
	renderSettings();
	renderSourceCards();
	renderContacts();
	wireEvents();
	await Promise.all([loadFeed(), refreshPushState()]);

	// The browser knows the timezone; quiet hours are meaningless without it.
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (tz && tz !== state.settings.timezone) await patchSettings({ timezone: tz });
}

boot();
