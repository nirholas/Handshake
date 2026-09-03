// Daily Forge (/daily) — a new 3D creative challenge every day, with a streak.
//
// The retention loop the platform was missing for its anonymous majority: the
// logged-in streak system (api/_lib/streaks.js) needs an account, so the huge
// no-sign-up forge audience had no reason to come back. This surface gives them
// one — a deterministic daily theme (src/daily/daily-theme.js), a localStorage
// streak (src/daily/creator-streak.js), and a one-minute free generation that
// keeps the flame lit. Every creation also lands in the shared recents so it's
// one tap from AR and the AR Studio.
//
// Self-contained apart from the free forge lane (POST /api/forge, same contract
// as /ar) and the community gallery (/api/forge-gallery). model-viewer is loaded
// by the page via CDN.

import { seedForDate, themeForDate, utcDayKey } from './daily/daily-theme.js';
import {
	loadStreak, milestoneFor, recordDay, saveStreak, streakStatus,
} from './daily/creator-streak.js';
import { createLogger } from './shared/log.js';

const log = createLogger('daily');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The day's theme is live data, not copy. src/i18n.js applies its catalog after
// an async /api/locale fetch, which lands well after this module renders, so an
// annotated element it still owns gets reverted to its pre-render placeholder
// ("Today's theme", "Loading today's challenge…"). Claiming the element with
// data-i18n-owned="1" before writing is the platform-wide opt-out.
const own = (el) => { el?.setAttribute?.('data-i18n-owned', '1'); return el; };

// Copy this module writes itself still has to localize. The catalog is loaded by
// the time a user acts; a miss echoes the key back, so fall through to English.
function i18nText(key, fallback) {
	try {
		const v = window.threewsI18n?.t?.(key);
		return v && v !== key ? v : fallback;
	} catch { return fallback; }
}

const RECENT_KEY = 'twx_ar_forge_recent'; // shared with /ar + AR Studio
const POLL_MS = 3000;
const MAX_POLL_MS = 300000;

// Stable anonymous forge identity (same key /forge, /ar, and AR Studio use), so
// generations count toward this browser's gallery and streak consistently.
const CLIENT_ID = (() => {
	const KEY = 'forge:cid';
	try {
		let id = localStorage.getItem(KEY);
		if (!id) { id = crypto?.randomUUID?.() || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(KEY, id); }
		return id;
	} catch { return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
})();

const today = utcDayKey(new Date());
const theme = themeForDate(new Date());

// ── Render the day ─────────────────────────────────────────────────────────────
document.documentElement.style.setProperty('--theme', theme.accent);
own($('theme-day')).textContent = `Day ${theme.day} · Daily challenge`;
// The <h1> itself carries data-i18n-html, so an unowned catalog pass replaces its
// innerHTML wholesale and takes the emoji and title spans with it.
own(document.querySelector('.theme h1'));
$('theme-emoji').textContent = theme.emoji;
$('theme-title').textContent = theme.title;
own($('theme-hint')).textContent = theme.hint;
own(document.querySelector('title'));
document.title = `${theme.emoji} ${theme.title} · Daily Forge · three.ws`;

const input = $('prompt');
input.value = seedForDate(new Date());
input.placeholder = `Your take on "${theme.title}"…`;

// Seed chips (tap to fill).
const chips = $('chips');
for (const seed of theme.seeds) {
	const b = document.createElement('button');
	b.type = 'button'; b.className = 'chip'; b.textContent = seed;
	b.addEventListener('click', () => { input.value = seed; forge(seed); });
	chips.appendChild(b);
}

// ── Streak ─────────────────────────────────────────────────────────────────────
function renderStreak() {
	const st = streakStatus(loadStreak(), today);
	const pill = $('streak-pill');
	const pillN = $('streak-pill-n');
	const streakEl = $('streak');
	const n = $('streak-n');
	const sub = $('streak-sub');
	const best = $('streak-best');

	const shown = st.actedToday ? st.current : (st.atRisk ? st.current : 0);
	pillN.textContent = String(shown);
	pill.classList.toggle('zero', shown === 0);
	streakEl.classList.toggle('lit', shown > 0);
	best.textContent = st.best > 1 ? `Best: ${st.best}` : '';

	if (st.actedToday) {
		n.textContent = st.current === 1 ? 'Streak started — day 1' : `${st.current}-day streak 🔥`;
		sub.textContent = 'You forged today. Come back tomorrow to keep it going.';
	} else if (st.atRisk) {
		n.textContent = `${st.current}-day streak at risk`;
		sub.textContent = 'Forge today to keep your streak alive.';
	} else {
		n.textContent = 'Start your streak today';
		sub.textContent = st.best > 0 ? `Your best was ${st.best} days — forge today to begin again.` : 'Forge today’s theme to begin a daily streak.';
	}
}
renderStreak();

// Bump the streak after a real creation; celebrate a milestone.
function bumpStreak() {
	const { state, changed, milestone } = recordDay(loadStreak(), today);
	if (changed) saveStreak(state);
	renderStreak();
	if (milestone) celebrate(milestone, state.current);
}

let milestoneReturnFocus = null;
function celebrate(milestone, current) {
	const emoji = milestone >= 100 ? '👑' : milestone >= 30 ? '🌟' : milestone >= 7 ? '🔥' : '✨';
	$('ms-emoji').textContent = emoji;
	own($('ms-title')).textContent = `${milestone}-day streak!`;
	own($('ms-body')).textContent = milestone >= 30
		? `${current} days of daily creation. You are a machine, keep the flame burning.`
		: `You've forged something ${milestone} days running. That's a real habit forming.`;
	$('milestone').classList.remove('hidden');
	milestoneReturnFocus = document.activeElement;
	$('ms-close').focus();
	try { navigator.vibrate?.([12, 40, 12]); } catch {}
}
function closeMilestone() {
	if ($('milestone').classList.contains('hidden')) return;
	$('milestone').classList.add('hidden');
	const back = milestoneReturnFocus;
	milestoneReturnFocus = null;
	if (back && document.contains(back)) back.focus();
}
$('ms-close').addEventListener('click', closeMilestone);
$('milestone').addEventListener('click', (e) => { if (e.target === $('milestone')) closeMilestone(); });
// A modal dialog that only closes by mouse strands a keyboard visitor: Escape
// dismisses it, and Tab stays inside it (the card holds a single control).
document.addEventListener('keydown', (e) => {
	if ($('milestone').classList.contains('hidden')) return;
	if (e.key === 'Escape') { e.preventDefault(); closeMilestone(); }
	else if (e.key === 'Tab') { e.preventDefault(); $('ms-close').focus(); }
});

// ── Forge flow (free NVIDIA lane) ──────────────────────────────────────────────
const mv = $('mv');
let runSeq = 0;
let elapsedTimer = null;
let current = null; // { glb, prompt }

function overlay(el) {
	['idle', 'working', 'failed'].forEach((id) => $(id).classList.add('hidden'));
	if (el) $(el).classList.remove('hidden');
}
function setBusy(b) {
	const go = own($('go'));
	go.disabled = b;
	go.innerHTML = b ? `${esc(i18nText('daily.forging', 'Forging…'))}` : i18nText('daily.forge', 'Forge<span aria-hidden="true">✦</span>');
}
function startElapsed() {
	const t0 = Date.now();
	stopElapsed();
	elapsedTimer = setInterval(() => { $('elapsed').textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
}
function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } $('elapsed').textContent = ''; }
// A model link is safe to load if it is absolute https or a same-origin path.
// Requiring absolute https rejected the same-origin /r2-proxy/... links the dev
// server rewrites R2 assets to, which silently emptied the community rail.
function safeModelUrl(u) {
	try {
		const parsed = new URL(String(u), location.href);
		if (parsed.protocol === 'https:' || parsed.origin === location.origin) return parsed.href;
		return '';
	} catch { return ''; }
}

async function forge(prompt) {
	prompt = String(prompt || '').trim();
	if (prompt.length < 3) { input.focus(); return; }
	const seq = ++runSeq;
	setBusy(true);
	mv.classList.add('veiled');
	$('actions').classList.add('hidden');
	$('worktitle').textContent = `Forging "${prompt.length > 52 ? `${prompt.slice(0, 49)}…` : prompt}"`;
	$('workmsg').textContent = 'Sending your prompt to the forge.';
	overlay('working');
	startElapsed();

	try {
		const res = await fetch('/api/forge', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forge-client': CLIENT_ID },
			body: JSON.stringify({ prompt, backend: 'nvidia' }),
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 503 || data.error === 'unconfigured') throw new Error('The generator is offline right now. Try again in a few minutes.');
		if (res.status === 429 || data.error === 'rate_limited') {
			const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 15;
			throw new Error(data.message || `The forge is busy — try again in about ${secs}s.`);
		}
		if (!res.ok) throw new Error(data.message || `The generator returned ${res.status}.`);

		let done = data;
		if (!(data.status === 'done' && data.glb_url)) {
			if (!data.job_id) throw new Error('The forge did not accept the job. Try again.');
			$('workmsg').textContent = 'Queued. Sculpting starts in a moment.';
			done = await pollUntilDone(data.job_id, seq);
		}
		if (!done || seq !== runSeq) return;
		stopElapsed();
		remember(prompt, done.glb_url);
		showResult(done.glb_url, prompt);
	} catch (err) {
		if (seq !== runSeq) return;
		stopElapsed();
		setBusy(false);
		$('failmsg').textContent = friendlyError(err);
		overlay('failed');
	}
}

// A thrown fetch surfaces as "Failed to fetch"/"NetworkError", which tells a
// visitor nothing and no action. Everything this module throws itself is already
// written for a human, so only the transport failures need translating.
function friendlyError(err) {
	const raw = (err && err.message) || '';
	if (!raw || /failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
		return 'Could not reach the forge. Check your connection, then try again.';
	}
	return raw;
}

async function pollUntilDone(jobId, seq) {
	const deadline = Date.now() + MAX_POLL_MS;
	for (;;) {
		if (seq !== runSeq) return null;
		if (Date.now() > deadline) throw new Error('Generation timed out. Try a simpler, single-object prompt.');
		await new Promise((r) => setTimeout(r, POLL_MS));
		if (seq !== runSeq) return null;
		const res = await fetch(`/api/forge?job=${encodeURIComponent(jobId)}`, { headers: { 'x-forge-client': CLIENT_ID } })
			.catch(() => { throw new Error('Lost contact with the forge while it was working. Your creation may still finish, try again in a moment.'); });
		const data = await res.json().catch(() => ({}));
		if (data.status === 'done' && data.glb_url) return data;
		if (data.status === 'failed') throw new Error(data.error || 'Generation failed. Try rephrasing the prompt.');
		if (data.status === 'running') $('workmsg').textContent = 'Sculpting geometry and painting textures. Usually under a minute.';
	}
}

function showResult(glbUrl, prompt, { forged = true } = {}) {
	const src = safeModelUrl(glbUrl);
	if (!src) { $('failmsg').textContent = 'That model link is not one we can open. Forge a new one to continue.'; overlay('failed'); setBusy(false); return; }
	current = { glb: src, prompt, forged };
	overlay('working');
	$('worktitle').textContent = 'Loading your creation…';
	$('workmsg').textContent = 'Almost there.';
	if (!window.customElements?.get('model-viewer')) {
		previewUnavailable('The 3D preview could not load. Your model is ready below: download it or open it in AR.');
		return;
	}
	mv.setAttribute('alt', prompt ? `3D model: ${prompt}` : 'Your 3D creation');
	mv.setAttribute('src', src);
}

// Reveal the action bar with every link resolved. Both the success path and the
// preview-failed path run this: the failure copy tells the visitor to download
// the GLB, so its href has to be live there too, and an <a> with no href is not
// even keyboard reachable.
function wireActions() {
	$('meta').textContent = current.prompt || 'Your creation';
	$('meta').title = current.prompt || '';
	$('download').href = current.glb;
	$('download').setAttribute('download', `${fileName(current.prompt)}.glb`);
	$('studio-btn').href = `/ar/studio?src=${encodeURIComponent(current.glb)}&title=${encodeURIComponent((current.prompt || '').slice(0, 80))}`;
	own($('ar-btn')).textContent = mv.canActivateAR
		? i18nText('daily.view_in_your_room', '📱 View in your room')
		: '📱 Open AR on your phone';
	$('actions').classList.remove('hidden');
}

// The creation is real even when the preview is not: a model-viewer that never
// registered (CDN outage) or a GLB the renderer rejects still leaves a usable
// GLB, so hand over the links rather than stranding the visitor on a spinner.
function previewUnavailable(msg) {
	setBusy(false);
	$('failmsg').textContent = msg;
	overlay('failed');
	wireActions();
	if (current?.forged) bumpStreak();
}

mv.addEventListener('load', () => {
	if (!current || mv.getAttribute('src') !== current.glb) return;
	overlay(null);
	setBusy(false);
	mv.classList.remove('veiled');
	wireActions();
	// The creation itself is the qualifying action — light the streak now (but not
	// for a deep-linked model the viewer didn't forge themselves).
	if (current.forged) bumpStreak();
});
mv.addEventListener('error', () => {
	if (!current) return;
	previewUnavailable('The model was generated but could not be displayed. You can still download the GLB below.');
});

function arLink() {
	if (!current) return `${location.origin}/daily`;
	return `${location.origin}/api/ar?src=${encodeURIComponent(current.glb)}&title=${encodeURIComponent((current.prompt || '').slice(0, 80))}`;
}
function fileName(prompt) {
	const s = (prompt || 'daily-forge').replace(/[^a-z0-9]+/gi, '-').slice(0, 48).replace(/^-|-$/g, '');
	return s || 'daily-forge';
}

$('ar-btn').addEventListener('click', () => {
	if (mv.canActivateAR) { try { mv.activateAR(); return; } catch {} }
	window.open(arLink(), '_blank', 'noopener');
});
$('share').addEventListener('click', async () => {
	if (!current) return;
	const url = `${location.origin}/viewer?src=${encodeURIComponent(current.glb)}&title=${encodeURIComponent((current.prompt || '').slice(0, 80))}`;
	const payload = { title: `${theme.title} · Daily Forge`, text: `My take on today's Daily Forge theme: ${current.prompt}`, url };
	if (navigator.share) { try { await navigator.share(payload); } catch { /* the visitor dismissed the sheet */ } return; }
	const b = $('share');
	// navigator.clipboard is absent outside a secure context, so reading .writeText
	// off it throws synchronously: the try has to wrap the property access, not
	// just the promise, or Share dies with an uncaught TypeError.
	try {
		await navigator.clipboard.writeText(url);
		const label = b.textContent;
		b.textContent = 'Link copied ✓';
		setTimeout(() => { b.textContent = label; }, 1600);
	} catch {
		window.prompt('Copy this link:', url);
	}
});
$('retry').addEventListener('click', () => { overlay('idle'); if (input.value.trim().length >= 3) forge(input.value); else input.focus(); });

function remember(prompt, glb) {
	try {
		const list = (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).filter((e) => e && e.glb !== glb);
		list.unshift({ prompt: String(prompt).slice(0, 200), glb, ts: Date.now() });
		localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
	} catch {}
}

$('ask').addEventListener('submit', (e) => { e.preventDefault(); forge(input.value); });

// ── Community strip ────────────────────────────────────────────────────────────
(async function loadCommunity() {
	try {
		const res = await fetch('/api/forge-gallery?scope=community&limit=12');
		// The strip is a bonus, never a blocker: a gallery outage leaves the section
		// unrendered rather than showing a broken shelf, and the page still forges.
		if (!res.ok) { log.warn('community gallery returned', res.status); return; }
		const data = await res.json();
		const items = (data.creations || [])
			.map((c) => ({ src: safeModelUrl(c.glb_url || c.glbUrl || ''), title: c.prompt || c.title || '', poster: c.preview_image_url || c.previewImageUrl || '' }))
			.filter((c) => c.src)
			.slice(0, 12);
		if (!items.length) return;
		const rail = $('rail');
		rail.innerHTML = items.map((it) => `
			<a href="/viewer?src=${encodeURIComponent(it.src)}&title=${encodeURIComponent(it.title.slice(0, 80))}" title="${esc(it.title)}">
				<span class="thumb">${it.poster ? `<img src="${esc(it.poster)}" alt="" loading="lazy" />` : '<span aria-hidden="true">◆</span>'}</span>
				<span class="cap">${esc(it.title || 'Untitled')}</span>
			</a>`).join('');
		$('rail-wrap').classList.remove('hidden');
	} catch (err) { log.warn('community load failed', err); }
})();

// Deep link: /daily?src=<glb> reopens a shared creation.
(function fromQuery() {
	const q = new URLSearchParams(location.search);
	const src = q.get('src') || '';
	if (!src) return;
	if (safeModelUrl(src)) showResult(src, q.get('title') || q.get('prompt') || 'Shared creation', { forged: false });
	else { $('failmsg').textContent = 'That shared model link is not one we can open. Forge today’s theme instead.'; overlay('failed'); }
})();

// Re-render the labels this module owns when the visitor switches locale: an
// owned element is skipped by the catalog pass, so it has to refresh itself.
window.addEventListener('i18n:change', () => {
	if (!$('go').disabled) setBusy(false);
	if (!$('actions').classList.contains('hidden')) wireActions();
});
